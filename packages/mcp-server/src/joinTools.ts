/**
 * "Join several videos" over MCP: `join_videos` makes ONE project from
 * several files joined in order (the app's POST /join/check, then POST
 * /projects/join) and follows the join; `get_join` follows it further;
 * `retry_join` joins again after a failure or a cancel.
 *
 * WHY: the 27.8-hour series was five Bilibili files that the agent had to join
 * itself with ffmpeg in its own shell (claude-dubber report, 2026-11-23):
 * invisible to the user ("muxing video with joined audio" only in the chat),
 * and that join garbled P3/P4. The app now does it, as a job the user sees.
 */
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { projectOutputVideoPath, type JoinCheck, type JoinProjectResult, type JoinStatus, type ProjectSettings } from '@videodubber/shared';

import type { VideoDubberApi } from './api.js';
import { clock } from './format.js';

type Handler<A> = (args: A, ctx: ServerContext) => Promise<CallToolResult>;

export interface JoinToolsDeps {
  api: VideoDubberApi;
  /** createVideoDubberServer's wrapper: starts the app if needed, turns failures into readable errors. */
  guarded: <A>(fn: Handler<A>) => Handler<A>;
  /** The settings create_project and update_settings take. */
  settingsSchema: z.ZodType<Record<string, unknown>>;
  progress: (ctx: ServerContext, done: number, total: number | undefined, message: string) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  settingsSummary: (s: ProjectSettings) => string;
  seriesGateNote: (autoStart: boolean) => string;
  pollMs: number;
  workBudgetMs: number;
}

const text = (body: string): CallToolResult => ({ content: [{ type: 'text', text: body }] });
const refusal = (body: string): CallToolResult => ({ content: [{ type: 'text', text: body }], isError: true });
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** A duration in words: "about 2 h 10 min", "about 4 min", "under a minute". */
export function aboutDuration(sec: number): string {
  if (sec < 60) return 'under a minute';
  const min = Math.round(sec / 60);
  return min < 60 ? `about ${min} min` : `about ${Math.floor(min / 60)} h ${min % 60} min`;
}

const FIELD_WORDS: Record<JoinCheck['mismatches'][number]['field'], string> = {
  codec: 'video codec',
  profile: 'codec profile',
  resolution: 'picture size',
  'frame-rate': 'frame rate',
  'pixel-format': 'pixel format',
  encoding: 'encoder settings',
};

/** What the check found, in lines for the agent. */
export function describeCheck(check: JoinCheck): string[] {
  const lines = [`${check.files.length} videos, ${clock(check.totalDurationMs)} in all:`];
  check.files.forEach((f, i) => {
    const v = f.video ? `${f.video.width}×${f.video.height} ${f.video.fps} fps ${f.video.codec}${f.video.profile ? ` ${f.video.profile}` : ''}` : 'no picture';
    const a = f.audio ? `${f.audio.codec} ${f.audio.sampleRate / 1000} kHz` : 'no sound';
    lines.push(`  ${i + 1}. ${f.name} (${clock(f.durationMs)}, ${gb(f.sizeBytes)}): ${f.error ? `CANNOT BE JOINED: ${f.error.message}` : `${v}, ${a}`}`);
  });
  for (const m of check.mismatches) {
    lines.push(`- ${check.files[m.index]?.name ?? `file ${m.index + 1}`}: ${FIELD_WORDS[m.field]} ${m.value}, the first file ${m.expected}`);
  }
  if (check.mixedSampleRates) lines.push('Their sound mixes sample rates: each file is converted to 48 kHz and re-timed to its own picture (nothing drifts).');
  return lines;
}

/** Where a join stands, in lines for the agent. */
export function describeJoin(s: JoinStatus): string[] {
  const n = s.files.length;
  const head =
    s.state === 'done'
      ? `Joined ${n} videos${s.result ? ` (${clock(s.result.durationMs)}, ${gb(s.result.sizeBytes)})` : ''}: the project's video is ready.`
      : s.state === 'running'
        ? `Joining ${n} videos: ${s.percent !== null ? `${Math.floor(s.percent)}%` : 'starting'}${s.etaSec !== undefined ? `, ${aboutDuration(s.etaSec)} left` : ''}${s.currentFile !== undefined ? ` (file ${s.currentFile + 1} of ${n}: ${s.files[s.currentFile]?.name ?? ''})` : ''}.`
        : s.state === 'waiting'
          ? `Waiting to join ${n} videos: another join runs first (one at a time).`
          : s.state === 'failed'
            ? `The join FAILED: ${s.error?.message ?? 'unknown error'}${s.error?.remediation ? `\nHow to fix: ${s.error.remediation}` : ''}`
            : s.state === 'cancelled'
              ? 'The join was cancelled: the project has no video yet (retry_join, or delete_project).'
              : 'The join was interrupted when VideoDubber stopped: it starts again when the app starts (or retry_join).';
  const lines = [head];
  lines.push(
    s.mode === 'copy'
      ? 'Picture: copied as it is (the files were encoded alike).'
      : `Picture: encoded again to one size and frame rate${s.result?.encoder ? ` (${s.result.encoder})` : ''}.`,
  );
  lines.push('Files, where each starts in the joined video:');
  s.files.forEach((f, i) => lines.push(`  ${i + 1}. ${f.name} at ${clock(f.startMs)} (${clock(f.durationMs)})`));
  if (s.started?.error) lines.push(`The dub did not start after the join: ${s.started.error.message}`);
  else if (s.started?.waiting) lines.push('The dub starts once the models it needs have downloaded.');
  else if (s.started?.queued) lines.push('The dub is queued behind other dubs.');
  else if (s.started?.started) lines.push('The dub has started.');
  return lines;
}

const FINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export function registerJoinTools(server: McpServer, deps: JoinToolsDeps): void {
  const { api, guarded, progress, sleep } = deps;

  /** Follow a join until it ends or the time is up; its last status either way. */
  async function followJoin(projectId: string, ctx: ServerContext, budgetMs: number): Promise<JoinStatus> {
    const signal = ctx.mcpReq.signal;
    const id = encodeURIComponent(projectId);
    let status = await api.get<JoinStatus>(`/projects/${id}/join`, { signal });
    const deadline = Date.now() + budgetMs;
    while (!FINAL.has(status.state) && Date.now() < deadline && !signal.aborted) {
      await sleep(deps.pollMs, signal);
      status = await api.get<JoinStatus>(`/projects/${id}/join`, { signal });
      void progress(ctx, status.percent ?? 0, 100, describeJoin(status)[0]!);
    }
    return status;
  }

  /** What to do next, after a join was followed. */
  const nextStep = (s: JoinStatus, projectId: string): string => {
    if (s.state === 'done') {
      return s.startWhenDone ? 'Follow the dub with get_project(waitSeconds=50).' : 'Next: start_dubbing.';
    }
    if (FINAL.has(s.state)) return `retry_join with projectId "${projectId}" joins again.`;
    return `It goes on in the app (the user sees it in the activity list). Follow it with get_join(projectId="${projectId}", waitSeconds=50)${
      s.startWhenDone ? '; the dub starts by itself once the videos are joined.' : ', then start_dubbing.'
    }`;
  };

  server.registerTool(
    'join_videos',
    {
      title: 'Make one project from several videos',
      description:
        'Make ONE dubbing project from several local video files joined in the order given (P1, P2, …), e.g. the parts of a series split into several uploads, so they are transcribed, cast and split into parts as one (part numbers run across all of them). The app checks that they fit together: when they were encoded alike the picture is copied as it is (fast, about the files\' total size on disk); otherwise it must be encoded again, and this tool only reports the cost: call it again with reencode=true to accept. Each file\'s sound is re-timed to its own picture and cut to exactly its length, so nothing drifts at the joins (mixed 44.1/48 kHz is fine). The join runs in the app as a job the user sees; this call follows it for up to ~45 s, then get_join follows it further. Same options as create_project; start=true starts dubbing as soon as the join is done.',
      inputSchema: z.object({
        videoPaths: z.array(z.string()).min(2).max(100).describe('Absolute paths of the video files, in the order they play.'),
        targetLanguage: z.string().describe('Dub language, e.g. "vi-VN".'),
        sourceLanguage: z
          .string()
          .optional()
          .describe('Spoken language, e.g. "zh" (Bilibili and Douyin videos are usually "zh"). Needed: the app does not detect it.'),
        name: z.string().optional().describe('Project name; default what the file names share ("持械入大宋" from "持械入大宋 P1" … "P5").'),
        saveTo: z.string().optional().describe('Absolute folder for the finished video and subtitles; omit to keep them in the project\'s own folder.'),
        settings: deps.settingsSchema.optional(),
        series: z
          .object({
            minMinutes: z.number().min(5).max(120).default(15),
            maxMinutes: z.number().min(5).max(180).default(20),
            ai: z.string().optional().describe('anthropic | openai | gemini | llama-cpp-chat; default Claude through Mother Claude when set up, else the first AI set up.'),
            recapSec: z.number().min(0).max(8).default(4),
            autoStart: z.boolean().default(true).describe('Make and dub the parts without stopping for a review of the cuts.'),
            nameTemplate: z
              .string()
              .max(200)
              .optional()
              .describe(
                'How the parts (and their files in saveTo) are named, as in create_project: {series}, {n}, {nn} (two digits), {total}, {title}. Needs {n} or {nn}.',
              ),
          })
          .optional()
          .describe('Dub the joined video as a series of parts, as create_project does; the files\' boundaries are recorded with the project.'),
        reencode: z.boolean().default(false).describe('Accept encoding the picture again when the files differ (call without it first to see the cost).'),
        start: z.boolean().default(false).describe('Start dubbing as soon as the join is done.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ videoPaths, targetLanguage, sourceLanguage, name, saveTo, settings, series, reencode, start }, ctx) => {
      const signal = ctx.mcpReq.signal;
      // The same starting point as create_project: the app's defaults, then Claude's choices.
      const q = new URLSearchParams({ targetLanguage, sourceLanguage: sourceLanguage ?? '' });
      const defaults = await api.get<{ settings: ProjectSettings; notes?: string[] }>(`/project-defaults?${q}`, { signal });
      const chosen = (settings ?? {}) as Partial<ProjectSettings>;
      const merged: ProjectSettings = {
        ...defaults.settings,
        ...chosen,
        sourceLanguage: chosen.sourceLanguage ?? sourceLanguage ?? '',
        targetLanguage: chosen.targetLanguage ?? targetLanguage,
      };
      let seriesBody: Record<string, unknown> | undefined;
      if (series) {
        const options = await api.get<{ id: string; ready: boolean; viaMotherClaude?: boolean }[]>('/series/ai-options', { signal });
        const ready = options.filter((o) => o.ready);
        const ai = series.ai ?? (ready.find((o) => o.viaMotherClaude) ?? ready[0])?.id;
        seriesBody = {
          minMinutes: series.minMinutes,
          maxMinutes: Math.max(series.minMinutes, series.maxMinutes),
          ...(ai ? { aiProviderId: ai } : {}),
          recapSec: series.recapSec,
          autoStart: series.autoStart,
          ...(series.nameTemplate?.trim() ? { nameTemplate: series.nameTemplate.trim() } : {}),
        };
      }

      // What the join takes, before anything is made.
      void progress(ctx, 0, undefined, 'Checking the videos');
      const check = await api.post<JoinCheck>(
        '/join/check',
        { videoPaths, ...(merged.renderQuality ? { renderQuality: merged.renderQuality } : {}) },
        { signal, timeoutMs: 300_000 },
      );
      if (!check.ok) return refusal(['Nothing was made: these videos cannot be joined.', ...describeCheck(check)].join('\n'));
      if (!check.disk.enough) {
        return refusal(
          [
            `Nothing was made: joining needs about ${gb(check.disk.needBytes)} free in ${check.disk.folder} (the joined video is about as big as the files together); ${gb(check.disk.freeBytes ?? 0)} is free.`,
            'Ask the user to free space there, or to move the projects to a bigger drive (Settings → Projects folder).',
          ].join('\n'),
        );
      }
      if (check.mode === 'reencode' && !reencode) {
        const r = check.reencode;
        return refusal(
          [
            'Nothing was made yet: these videos differ, so joining them means encoding the picture again.',
            ...describeCheck(check),
            r
              ? `It would make them all ${r.target.width}×${r.target.height} at ${r.target.fps} fps${r.encoder ? ` with ${r.encoder}` : ''}: ${r.estimatedSec !== undefined ? `${aboutDuration(r.estimatedSec)} on this computer` : 'the time could not be measured'}${r.estimatedBytes !== undefined ? `, about ${gb(r.estimatedBytes)}` : ''}.`
              : '',
            'Tell the user the cost; if they agree, call join_videos again with the same arguments and reencode=true.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      const made = await api.post<JoinProjectResult>(
        '/projects/join',
        {
          name: name?.trim() ?? '',
          videoPaths,
          settings: merged,
          ...(saveTo?.trim() ? { outputDir: saveTo.trim() } : {}),
          ...(seriesBody ? { series: seriesBody } : {}),
          reencode,
          start,
        },
        { signal, timeoutMs: 300_000 },
      );
      const project = made.project;
      const id = encodeURIComponent(project.id);
      // The models the project needs download while it joins.
      const ensured = await api
        .post<{ installing: boolean; enginePacks?: string[] }>(`/projects/${id}/ensure-resources`, {}, { signal })
        .catch(() => undefined);
      const status = await followJoin(project.id, ctx, deps.workBudgetMs);

      const lines = [
        `Created "${project.name}" (${project.id}) from ${videoPaths.length} videos.`,
        `Saves to: ${projectOutputVideoPath(project)}`,
        `Settings: ${deps.settingsSummary(merged)}`,
        ...(defaults.notes ?? []).map((n) => `Note: ${n}`),
        ...describeJoin(status),
      ];
      const downloading = [...(ensured?.installing ? ['language models'] : []), ...(ensured?.enginePacks ?? [])];
      if (downloading.length > 0) lines.push(`Downloading in the background: ${downloading.join(', ')}. start_dubbing waits for them.`);
      if (series) lines.push(deps.seriesGateNote(series.autoStart));
      lines.push(nextStep(status, project.id));
      return status.state === 'failed' ? refusal(lines.join('\n')) : text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'get_join',
    {
      title: 'Where a join of videos stands',
      description:
        'The join of a project made with join_videos: waiting, running (percent, time left, which file), done, failed (why, how to fix), cancelled or interrupted, with where each file starts in the joined video. With waitSeconds > 0 it waits (up to 50 s) for the join to end. To abandon a join, delete_project deletes the project and stops its join.',
      inputSchema: z.object({ projectId: z.string(), waitSeconds: z.number().min(0).max(50).default(0) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, waitSeconds }, ctx) => {
      const status = await followJoin(projectId, ctx, waitSeconds * 1000);
      const lines = [...describeJoin(status), nextStep(status, projectId)];
      return status.state === 'failed' ? refusal(lines.join('\n')) : text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'retry_join',
    {
      title: 'Join a project\'s videos again',
      description:
        'Join the videos of a join_videos project again after it failed, was cancelled, or was interrupted three times in a row. reencode=true accepts encoding the picture again if the files now need it. Follows the join for up to ~45 s, like join_videos.',
      inputSchema: z.object({ projectId: z.string(), reencode: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, reencode }, ctx) => {
      await api.post<JoinStatus>(`/projects/${encodeURIComponent(projectId)}/join/restart`, { reencode }, { signal: ctx.mcpReq.signal });
      const status = await followJoin(projectId, ctx, deps.workBudgetMs);
      const lines = [...describeJoin(status), nextStep(status, projectId)];
      return status.state === 'failed' ? refusal(lines.join('\n')) : text(lines.join('\n'));
    }),
  );
}

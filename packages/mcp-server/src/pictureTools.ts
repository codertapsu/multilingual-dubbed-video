/**
 * MCP tools of the picture options (docs/plans/production-requests-2026-11-23.md
 * 4.2 / 4.3): finding a watermark and the band of the source's own subtitles,
 * so an agent can propose them, look at the preview, and apply them with
 * update_settings (applyToParts for a series).
 */
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { BlurRegion, PictureDetectionJob } from '@videodubber/shared';

import type { VideoDubberApi } from './api.js';

export interface PictureToolDeps {
  api: VideoDubberApi;
  guarded: <A>(fn: (args: A, ctx: ServerContext) => Promise<CallToolResult>) => (args: A, ctx: ServerContext) => Promise<CallToolResult>;
  text: (body: string) => CallToolResult;
  /** How long one call may keep working before it reports and returns. */
  workBudgetMs: number;
}

const pct = (n: number): string => `${Math.round(n * 100)} %`;

/** What a picture detection found (or how far it got), for the agent. Pure. */
export function formatPictureJob(job: PictureDetectionJob, tool = 'detect_watermark'): { text: string; isError: boolean } {
  if (job.state === 'running') {
    return {
      text: `Still looking (${job.percent ?? 0} %${job.message ? `: ${job.message}` : ''}). Call ${tool} again in a minute: it continues this detection.`,
      isError: false,
    };
  }
  if (job.state === 'failed' || !job.result) {
    const e = job.error;
    return {
      text: job.state === 'failed' ? `The detection failed: ${e?.message ?? 'no reason given'}${e?.remediation ? `\nHow to fix: ${e.remediation}` : ''}` : 'Nothing was looked at yet.',
      isError: job.state === 'failed',
    };
  }
  const r = job.result;
  const lines: string[] = [`Looked at ${r.frames} frames of the ${r.videoWidth}×${r.videoHeight} picture.`];
  lines.push('Watermarks (proposed settings.blurRegions):');
  if (r.regions.length === 0) lines.push('- none stood out in the corners');
  for (const m of r.regions) {
    const when = m.startMs !== undefined || m.endMs !== undefined ? `, ${m.startMs ?? 0}–${m.endMs ?? 'end'} ms` : '';
    lines.push(`- ${m.corner}: x=${m.x} y=${m.y} w=${m.w} h=${m.h}${when}${m.fileName ? ` (${m.fileName})` : ''}, confidence ${m.confidence}`);
  }
  if (r.band) {
    const two = r.band.twoLineShare ? `; ${pct(r.band.twoLineShare)} of the frames with text had two lines` : '';
    lines.push(
      `Source subtitles (proposed burnSubtitleStyle.coverBand): y=${r.band.y} h=${r.band.h} (${pct(r.band.y)}–${pct(r.band.y + r.band.h)} of the height), ` +
        `${r.band.method === 'speech' ? 'from frames during speech against silence' : 'from the picture alone (no transcript to compare with)'}, confidence ${r.band.confidence}${two}.`,
    );
  } else {
    lines.push('Source subtitles: no band of burned-in subtitles was found.');
  }
  if (r.previewPath) lines.push(`Preview (boxes red, band yellow): ${r.previewPath} — look at it before applying.`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  const regions: BlurRegion[] = r.regions.map((m) => ({
    x: m.x,
    y: m.y,
    w: m.w,
    h: m.h,
    ...(m.startMs !== undefined ? { startMs: m.startMs } : {}),
    ...(m.endMs !== undefined ? { endMs: m.endMs } : {}),
    mode: m.mode,
  }));
  const settings = {
    ...(regions.length > 0 ? { blurRegions: regions } : {}),
    ...(r.band ? { burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: r.band.y, h: r.band.h }, subtitlesInBand: true } } : {}),
  };
  if (Object.keys(settings).length > 0) {
    lines.push(
      `To apply: update_settings with settings=${JSON.stringify(settings)} (applyToParts=true on a series), then start_dubbing fromStep="render" ` +
        '(a part already rendered needs only that). Modes: blur (soft), pixelate (blocks), delogo (filled in from around it, for small marks); ' +
        'strength 1-10 (default 5). subtitlesInBand puts the dub\'s burned-in subtitles where the source\'s were; leave it out to keep them where they are.',
    );
  }
  return { text: lines.join('\n'), isError: false };
}

export function registerPictureTools(server: McpServer, deps: PictureToolDeps): void {
  const { api, guarded } = deps;

  server.registerTool(
    'detect_watermark',
    {
      title: "Find the watermark and the source's subtitles",
      description:
        "Find, without AI, a still watermark in the corners of a project's video (e.g. \"玄荒漫剧 bilibili\") and the band where the source's own subtitles are burned in, from ~100 frames (once the project has a transcript, frames during speech are compared with frames in silence; a video joined from several files is looked at file by file). Returns the boxes as settings.blurRegions proposals and the band as burnSubtitleStyle.coverBand, each with a confidence, and the path of a preview frame with the boxes (red) and the band (yellow) drawn on it: look at it before applying. Changes nothing: apply with update_settings (applyToParts=true on a series), then redo from \"render\". Takes 10-60 s; while it runs, call again: it continues the same detection. fresh=true looks again even when a recent result exists.",
      inputSchema: z.object({
        projectId: z.string(),
        fresh: z.boolean().default(false).describe('Look again even when a result from the last 10 minutes exists.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, fresh }, ctx) => {
      const waitMs = Math.max(0, Math.min(45_000, deps.workBudgetMs));
      const job = await api.post<PictureDetectionJob>(
        `/projects/${encodeURIComponent(projectId)}/picture/detect`,
        { fresh, waitMs },
        { signal: ctx.mcpReq.signal, timeoutMs: waitMs + 30_000 },
      );
      const out = formatPictureJob(job);
      return out.isError ? { content: [{ type: 'text', text: out.text }], isError: true } : deps.text(out.text);
    }),
  );
}

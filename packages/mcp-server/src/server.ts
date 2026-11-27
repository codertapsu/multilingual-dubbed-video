/**
 * The VideoDubber MCP server: the whole dubbing workflow as tools, so Claude
 * (Claude Desktop, Claude Code) can take a video from a file or a link to a
 * rendered dub — and, above all, do the part no local model does as well:
 * read the WHOLE transcript and write the translation with full context.
 *
 * Every tool is a thin wrapper over the app's own HTTP API, so the pipeline's
 * guarantees hold for Claude exactly as for a click: the readiness gate,
 * atomic artifacts, the run queue, the editor's lock/stale rules.
 *
 * Long operations (a download, a dub, re-voicing many lines) never hold a tool
 * call open for minutes — MCP clients time those out. They work for at most
 * ~50 s, report where they got to, and can simply be called again.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT_INFO_META_KEY, McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { continuedSeriesSettings, projectOutputFiles, projectOutputVideoPath } from '@videodubber/shared';
import type {
  DubPreset,
  PipelineState,
  PipelineStepId,
  Project,
  ProjectLineIssues,
  ProjectListItem,
  ProjectSettings,
  TimelineDocument,
  TranslationDocContext,
} from '@videodubber/shared';
import { AppNotRunningError, VideoDubberApiError, requestContext, type VideoDubberApi } from './api.js';
import { cookiesOfSite, takeCookieExport } from './cookies.js';
import { ensureAppRunning, type LaunchTarget } from './launcher.js';
import { registerJoinTools } from './joinTools.js';
import { SERIES_ARG_DEFAULTS, describeBuiltinPreset, describePresetSeries, findPreset, missingLanguage, seriesRequest } from './presetJobs.js';
import { registerPictureTools } from './pictureTools.js';
import {
  renderProjectJobs,
  renderRetranscribeJob,
  renderRetranscribed,
  speakerJobSentence,
  type ProjectJobLite,
  type RetranscribeAnswer,
  type RetranscribeJobLite,
  type SpeakerJobLite,
} from './lineJobs.js';
import {
  audioDriftLines,
  clock,
  lineFlags,
  lineIssuesBrief,
  renderLine,
  renderLineIssues,
  renderPipeline,
  renderTranslationReport,
  type TranslationReportDoc,
} from './format.js';

export interface VideoDubberServerOptions {
  api: VideoDubberApi;
  /** The desktop app to start when it is not running (packaged builds only). */
  launch?: LaunchTarget;
  /** Server version reported to the client. */
  version: string;
  /** Poll interval for waits; tests shorten it. */
  pollMs?: number;
  /** How long one call may keep working before it reports and returns. */
  workBudgetMs?: number;
  /** How long create_project waits for the app to make the project (30 min; tests shorten it). */
  createProjectTimeoutMs?: number;
}

const STEP_IDS = [
  'probe-video',
  'extract-audio',
  'stt',
  'translation',
  'refine',
  'tts',
  'alignment',
  'audio-mix',
  'render',
] as const satisfies readonly PipelineStepId[];

/**
 * A series part paused or stopped on its own (Project.pausedByUser). Its
 * pause used to leave nothing behind, so the next start of the series queued
 * it again an hour later (claude-dubber, 2026-11-27).
 */
const HELD_PART = 'paused on its own, so starting the series leaves it; start_dubbing on this part continues it';

/** Which step to re-run from after a settings change, earliest wins. */
const SETTING_STEP: Partial<Record<keyof ProjectSettings, PipelineStepId>> = {
  sourceLanguage: 'stt',
  sttProviderId: 'stt',
  sttModel: 'stt',
  forcedAlignment: 'stt',
  diarize: 'stt',
  diarizeSpeakers: 'stt',
  transcriptSpotCheck: 'stt',
  subtitleCoverageCheck: 'stt',
  useBurnedInSubtitles: 'stt',
  stopAtAdTail: 'stt',
  targetLanguage: 'translation',
  translationProviderId: 'translation',
  refineProviderId: 'refine',
  holdFlaggedLines: 'refine',
  ttsProviderId: 'tts',
  ttsVoiceId: 'tts',
  synthesisGrouping: 'tts',
  speakerVoices: 'tts',
  maxSpeedRatio: 'alignment',
  allowedOverflowMs: 'alignment',
  autoFitOverflow: 'alignment',
  timeStretchEngine: 'alignment',
  includeOriginalBackgroundAudio: 'audio-mix',
  duckOriginalAudio: 'audio-mix',
  duckingLevelDb: 'audio-mix',
  originalAudioMode: 'audio-mix',
  ttsGainDb: 'audio-mix',
  roomTone: 'audio-mix',
  branding: 'audio-mix',
  useSourceSubtitles: 'stt',
  syncSubtitlesToVoice: 'render',
  songSubtitles: 'render',
  subtitleExportMode: 'render',
  renderQuality: 'render',
  burnSubtitleStyle: 'render',
  blurRegions: 'render',
  watermarkAuto: 'render',
};

const subtitleMode = z
  .enum(['burned-in', 'embedded-soft', 'srt-file', 'vtt-file', 'none'])
  .describe('burned-in = drawn onto the video; embedded-soft = a selectable track; srt-file / vtt-file = a separate file.');

/** The settings a project may change after creation (orchestrator EDITABLE_SETTING_KEYS). */
const editableSettings = z
  .object({
    sourceLanguage: z.string().describe('Spoken language of the video, e.g. "zh", "en", "ja" (the app does not detect it).'),
    targetLanguage: z.string().describe('Dub language, e.g. "vi-VN", "en-US".'),
    sttProviderId: z.string().describe('Speech-to-text engine id (list_providers).'),
    sttModel: z.string().describe('Whisper model: tiny, base, small, medium, large-v3, large-v3-turbo, phowhisper-medium, …'),
    translationProviderId: z.string().describe('Translation engine id (list_providers).'),
    refineProviderId: z.string().describe('Optional AI review pass after translation; "none" to skip.'),
    ttsProviderId: z.string().describe('Text-to-speech engine id (list_providers).'),
    ttsVoiceId: z.string().describe('Voice id (list_voices).'),
    subtitleExportMode: subtitleMode,
    reviewBeforeSynthesis: z
      .boolean()
      .describe('Pause after translation, before any voice is made, so the translation can be reviewed (recommended when you will rewrite it).'),
    subtitleCoverageCheck: z
      .boolean()
      .describe(
        "Check speech-to-text against the video's own burned-in subtitles (the band picture detection found, or burnSubtitleStyle.coverBand): lines under a subtitle are never removed as silence, and get_project names subtitles with no line (speech lost) and lines with no subtitle (maybe hallucinated). Default: on for Chinese, Japanese and Korean video. Costs a read of the picture, a few minutes per hour of video.",
      ),
    useBurnedInSubtitles: z
      .boolean()
      .describe(
        "Take the transcript from the subtitles burned into the picture, read as text on this computer, instead of speech-to-text: each subtitle becomes a line, timed by when it shows (names and wording as the video writes them). Needs the subtitle reader engine (install_engine ocr-rapid, ~250 MB); Chinese and English subtitles. When the engine is missing or the subtitles cannot be read, the speech is transcribed and get_project says why.",
      ),
    holdFlaggedLines: z
      .boolean()
      .describe(
        'Stop before any voice is made when lines still fail the translation checks after the two automatic repairs (Chinese letters or a pinyin name in a Vietnamese line, no diacritics, "/" alternatives, untranslated). get_project then names them; fix them with set_translations and start_dubbing. Off by default: they are voiced, and named in a lines-flagged warning.',
      ),
    originalAudioMode: z.enum(['keep', 'remove', 'replace-vocals']).describe('What happens to the original soundtrack.'),
    duckingLevelDb: z.number().describe('How much the original audio is lowered under the dub, in dB (e.g. -12).'),
    ttsGainDb: z.number().describe('Dub voice gain in dB.'),
    maxSpeedRatio: z.number().min(1).max(2).describe('Fastest the dub may be sped up to fit its slot (e.g. 1.6).'),
    allowedOverflowMs: z.number().min(0).describe('How far a line may run past its slot, in ms.'),
    autoFitOverflow: z.boolean().describe('Automatically shorten lines that still do not fit (LLM translators only).'),
    syncSubtitlesToVoice: z.boolean().describe('Time subtitles to when the dub voice speaks.'),
    songSubtitles: z
      .boolean()
      .describe('Show subtitles for the lines kept as the original song (mark_song). Off by default: the original song plays untouched. The subtitle files follow at once; render_video shows it.'),
    renderQuality: z
      .enum(['auto', 'quality', 'fast'])
      .describe('auto (default) = the hardware encoder when it works here, else x264; quality = always x264 on the CPU (smallest files, slower); fast = same as auto.'),
    burnSubtitleStyle: z
      .object({
        position: z
          .enum(['auto', 'bottom', 'raised', 'top'])
          .describe(
            "Where burned-in subtitles sit: auto (default) = just above the source's own hardsubs when the app found them (detect_watermark, or the band set to cover) and they are not covered, else at the bottom; bottom = always the standard strip; raised = above that strip and above the source's hardsubs; top.",
          ),
        coverOriginal: z
          .union([z.boolean(), z.enum(['solid', 'blur'])])
          .describe(
            "Hide the source's own burned-in subtitles: 'blur' blurs a band over them (the picture shows through; works in every subtitle mode), 'solid' or true covers them with an opaque band (with burned-in subtitles only), false shows them.",
          ),
        coverBand: z
          .object({ y: z.number().min(0).max(1), h: z.number().gt(0).max(1) })
          .nullable()
          .describe("Where that band is: its top y and height h, 0-1 of the frame height (detect_watermark finds it); null = the bottom strip."),
        coverStrength: z.number().int().min(1).max(10).nullable().describe('How strongly a blurred band blurs, 1-10 (default 5).'),
        subtitlesInBand: z
          .boolean()
          .nullable()
          .describe("Put the dub's burned-in subtitles inside that band, where the source's own were (instead of position)."),
      })
      .partial()
      .describe(
        "Where burned-in subtitles sit, and hiding the source's own (many Chinese videos burn theirs in). position is for subtitleExportMode burned-in; a blurred band works in every mode.",
      ),
    blurRegions: z
      .array(
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          w: z.number().gt(0).max(1),
          h: z.number().gt(0).max(1),
          startMs: z.number().int().min(0).optional(),
          endMs: z.number().int().min(1).optional(),
          mode: z.enum(['blur', 'pixelate', 'delogo']),
          strength: z.number().int().min(1).max(10).optional(),
        }),
      )
      .max(20)
      .describe(
        "Parts of the picture hidden in the render (a watermark), boxes in 0-1 of the frame: blur (soft), pixelate (blocks) or delogo (filled in from around it, for small marks); strength 1-10 (default 5). startMs/endMs (the whole video's time, also on a series part) limit a box to a while. Replaces the list; [] removes them (and turns watermarkAuto off). detect_watermark proposes them; redo from \"render\".",
      ),
    watermarkAuto: z
      .object({
        mode: z.enum(['blur', 'pixelate', 'delogo']).default('blur'),
        strength: z.number().int().min(1).max(10).optional(),
      })
      .nullable()
      .describe(
        'Find the watermark and hide it without drawing boxes: a series looks once in the whole video during its analysis and makes every part with the boxes (its plan notes say what was found, shown at review); a single video, or a part whose series found none, looks when it renders. Only clear marks (confidence 0.5 and up) are hidden; what is found is saved as blurRegions. null turns it off. While a series is still being analysed it can be set (with blurRegions) and is used for the parts.',
      ),
    diarize: z.boolean().describe('Detect who says each line (needs the "Speaker detection" engine, list_engines).'),
    diarizeSpeakers: z
      .number()
      .int()
      .min(0)
      .max(20)
      .describe('How many people speak, when known (2-20; 0 = let speaker detection decide). Far more reliable than detecting the count.'),
    transcriptSpotCheck: z
      .boolean()
      .describe(
        'Spot-check the transcript at the end of speech-to-text: one minute of every half hour is decoded again without context and compared with the lines, and stretches that do not match (a bad join or download) become warnings with their time range. Chinese/Japanese/Korean only; about 3-5 % of the speech-to-text time. Unset = on for videos over 2 hours; false = off; true = also on shorter videos.',
      ),
    stopAtAdTail: z
      .boolean()
      .describe(
        'Stop where an advert tail begins (default on): on "全集免费" uploads whose drama is only their start, the same banner for the full version stays on the picture to the end, for hours, over a still image or moving footage. The app looks for it at the start of speech-to-text (videos of 20 minutes or more): speech-to-text and its checks stop there, a series ends there, and an ad-tail warning says where (detect_watermark shows it too). false = dub the whole video (redo from "stt").',
      ),
    minorVoices: z
      .number()
      .int()
      .min(0)
      .max(12)
      .describe('How many voices the minor speakers of each gender share when voices are cast (cast_voices): 1-12, 0 = automatic (3-6 by how many there are). Takes effect at the next cast_voices.'),
    branding: z
      .object({
        logo: z
          .object({
            assetId: z.string().describe('A logo id from list_brand_kit (logo_…).'),
            corner: z.enum(['top-right', 'top-left', 'bottom-right', 'bottom-left']).optional(),
            widthPct: z.number().min(2).max(50).optional().describe('Width as % of the video width (default 10).'),
            opacity: z.number().min(0.05).max(1).optional(),
            show: z.enum(['always', 'periods', 'interval']).optional(),
            periods: z.array(z.object({ startMs: z.number(), endMs: z.number() })).optional(),
            showSec: z.number().optional(),
            everyMin: z.number().optional(),
          })
          .optional(),
        greeting: z
          .object({
            assetId: z.string().describe('A greeting id from list_brand_kit (greeting_…).'),
            atStart: z.boolean().optional().describe('In the first quiet moment of the opening (never before the video).'),
            startWindowSec: z.number().optional(),
            repeat: z.union([z.enum(['off', 'auto']), z.number().int().min(0).max(20)]).optional(),
            gainDb: z.number().optional(),
          })
          .optional(),
      })
      .describe('Logo drawn over the video and a spoken greeting played in quiet moments; {} turns both off.'),
    useSourceSubtitles: z
      .boolean()
      .describe("Use the subtitles the site published (Bilibili CC/AI) as the transcript when the download has them in the spoken language: much faster than speech-to-text."),
    speakerVoices: z
      .array(z.object({ speakerId: z.string().regex(/^SPEAKER_\d{2,3}$/), voiceId: z.string() }))
      .max(100)
      .describe(
        'The voice of each speaker ("SPEAKER_00"…, as get_transcript shows them), replacing the whole table; [] clears it. A line\'s own voice still wins. Lines whose voice this changes need regenerate_voices.',
      ),
  })
  .partial();

type EditableSettings = z.infer<typeof editableSettings>;

export function createVideoDubberServer(opts: VideoDubberServerOptions): McpServer {
  const { api } = opts;
  const pollMs = opts.pollMs ?? 2000;
  const workBudgetMs = opts.workBudgetMs ?? 45_000;

  const server = new McpServer(
    { name: 'videodubber', title: 'VideoDubber', version: opts.version },
    {
      instructions: [
        'VideoDubber dubs videos into another language on this computer: speech-to-text, translation, a synthetic voice, timing, mixing and rendering, with burned-in or separate subtitles.',
        'Typical flow: get_status -> (download_video) -> create_project -> start_dubbing -> get_project(waitSeconds) until done -> review with get_transcript (and get_translation_report for what the app itself flagged) -> fix with set_translations / adjust_lines -> regenerate_voices -> render_video.',
        'For the best translation, create the project with reviewBeforeSynthesis=true: the run pauses after a quick draft translation, you read the whole transcript, record names/terms/forms of address with set_translation_context, rewrite the lines with set_translations, then start_dubbing continues with your text.',
        'Every line must be speakable in its own time slot: get_transcript shows each line\'s budget at the voice\'s pace (e.g. "≤13 syllables (aim 11)") and the current length in [brackets]. Aim for the target and never exceed the ceiling, but keep the full meaning: an over-short line is a worse dub than a slightly fast one. Never merge or split lines while translating (replace_lines restructures a range before translation). Fix every line marked NEEDS FIX; lines marked LOOP? may be a transcription loop the app could not repair: check them with retranscribe_range.',
        'Speakers: the speaker ids on the lines (SPEAKER_00...) decide the forms of address in the translation (Vietnamese xưng hô), so speakers must be detected before translating (settings.diarize). Map each speaker id to its character in the character sheet (set_translation_context cast[].speakerId) and fix what speech-to-text mishears with its corrections. get_project lists the warnings of a run (speaker detection failed, loops repaired or left, GPU busy so a step ran on the CPU): act on them.',
        'Series (a long video in parts): even with autoStart the parts start by themselves only when the analysis is clean; otherwise the series stops at review and get_series says why. After fixing the series transcript, rebuild_parts (some parts or all; queued ones are rebuilt where they wait); update_settings / set_translation_context take applyToParts; pause_dubbing / start_dubbing on the series act on all its parts in order. edit_part renames or retitles a made part; replan_series plans again before the parts exist; create_project series.continues starts a later season of a series.',
        'When something fails: get_diagnostics (the app\'s health, GPU, queue, engine output, recent errors; bundle=true writes a support bundle) and get_queue (what waits and why, who holds the GPU lane). Every tool error ends with a log reference.',
        'Changing settings, engines or downloads is the user\'s machine: say what you are about to install (sizes are in list_engines) before doing it.',
        'Batches (Bilibili, Douyin): set_download_login with the path of a browser cookie export (never cookie values; optional, logged out gets up to 720p) -> download_videos -> follow_jobs_command (long batches) or wait_jobs -> dub_downloads (a preset from list_presets, or targetLanguage + settings) -> follow the projects -> get_outputs -> post -> mark_published.',
        'A long dub can be paused (pause_dubbing) and continued later with start_dubbing, also after the app was closed: nothing done is lost. get_project says when a dub is paused.',
        'Voices: list_voices searches every engine\'s voices (and the user\'s cloned voices) with licences; install_voice downloads one. A cloned voice is made only by the user in the app (Voices screen), which records their consent: ask them to do it, never try to.',
        'Several files of one story (P1, P2…): join_videos makes ONE project from them in order (each file\'s sound re-timed to its own picture; never join them yourself with ffmpeg), so speakers, cast and part numbers run across all of them; get_join follows the join. A large single file: create_project links it instead of copying; if it ever times out, the project may still appear: check list_projects before creating it again.',
        'Picture: detect_watermark finds a static watermark and the source\'s own burned-in subtitle band without AI and proposes boxes; set them with update_settings (blurRegions; burnSubtitleStyle.coverOriginal "blur" with coverBand) and applyToParts for a series; finished parts need only render_video again.',
        'Songs: lines sung in the video can keep the original song instead of a dub voice (mark_song, per line; subtitles for them only with settings.songSubtitles). get_transcript marks suggestions SONG?: confirm them with the user\'s intent, never mark silently. cast_voices gives minor speakers a rotating pool of built-in voices, never the user\'s clone unless chosen.',
        'Everything you start shows in the app\'s activity list with your name, and every change to lines is in the project\'s history (get_history, undo_edit). Work you do outside the app for a project (a long script, an upload): report_activity so the user sees it; get_activity lists what the app is doing.',
      ].join('\n'),
    },
  );

  // Who is calling, sent with every request to the app (api.ts
  // initiatorHeaders): the tool's name (registerTool is wrapped once, so no
  // tool changes for it), the client's name from its handshake, the session.
  const toolName = new AsyncLocalStorage<string>();
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, (...a: unknown[]) => toolName.run(name, () => cb(...a)));
  const ownSession = `mcp-${randomBytes(6).toString('hex')}`;
  const caller = (ctx: ServerContext): { client?: string; session: string; tool?: string } => {
    const fromEnvelope = (ctx.mcpReq.envelope as Record<string, { name?: string } | undefined> | undefined)?.[CLIENT_INFO_META_KEY]?.name;
    const client = fromEnvelope ?? server.server.getClientVersion()?.name;
    const tool = toolName.getStore();
    return { ...(client ? { client } : {}), session: ctx.sessionId ?? ownSession, ...(tool ? { tool } : {}) };
  };

  // ------------------------------------------------------------------ helpers

  const text = (body: string): CallToolResult => ({ content: [{ type: 'text', text: body }] });

  const failure = (err: unknown, requestId?: string): CallToolResult => {
    let message: string;
    if (err instanceof AppNotRunningError) {
      message = opts.launch
        ? 'VideoDubber did not answer, even after starting it. Open the VideoDubber app, wait for it to finish starting, and try again.'
        : `VideoDubber is not running (nothing answers at ${api.baseUrl}). Open the VideoDubber app and try again. In a source checkout, start it with \`pnpm dev\` or \`pnpm app\`.`;
    } else if (err instanceof VideoDubberApiError) {
      message = `${err.message}${err.remediation ? `\nHow to fix: ${err.remediation}` : ''}\n(code ${err.code})`;
    } else {
      message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Where to look: the app's log lines for this call carry the same id.
    if (requestId && !(err instanceof AppNotRunningError)) {
      message += `\nLog reference: ${requestId} (get_diagnostics shows recent errors and engine output).`;
    }
    return { content: [{ type: 'text', text: message }], isError: true };
  };

  /** Start the app if needed, run the tool, turn any failure into a readable error. */
  const guarded =
    <A>(fn: (args: A, ctx: ServerContext) => Promise<CallToolResult>) =>
    async (args: A, ctx: ServerContext): Promise<CallToolResult> => {
      const requestId = `mcp-${Math.random().toString(36).slice(2, 10)}`;
      return requestContext.run({ requestId, ...caller(ctx) }, async () => {
        try {
          const state = await ensureAppRunning(api, {
            ...(opts.launch ? { target: opts.launch } : {}),
            signal: ctx.mcpReq.signal,
          });
          const result = await fn(args, ctx);
          if (state === 'started' && result.content[0]?.type === 'text') {
            result.content[0] = {
              type: 'text',
              text: `(VideoDubber was not running, so I started it.)\n${result.content[0].text}`,
            };
          }
          return result;
        } catch (err) {
          return failure(err, requestId);
        }
      });
    };

  /** Report progress when the client asked for it (a progressToken in _meta). */
  const progress = async (ctx: ServerContext, done: number, total: number | undefined, message: string): Promise<void> => {
    const token = ctx.mcpReq._meta?.progressToken;
    if (token === undefined) return;
    await ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress: done, ...(total !== undefined ? { total } : {}), message },
      })
      .catch(() => undefined);
  };

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

  /** `etaSec`: the time left while it dubs, from the run's own pace (absent too early to tell). */
  const getProject = (id: string, signal?: AbortSignal) =>
    api.get<{ project: Project; pipeline: PipelineState; etaSec?: number }>(`/projects/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });

  const getTimeline = (id: string, signal?: AbortSignal) =>
    api.get<TimelineDocument>(`/projects/${encodeURIComponent(id)}/timeline`, { ...(signal ? { signal } : {}) });

  /** The last lines of the project's pipeline log (the app writes it under its workspace). */
  const logTail = async (project: Project, lines: number): Promise<string[]> => {
    try {
      const body = await readFile(path.join(project.workspaceDir, 'logs', 'pipeline.log'), 'utf8');
      return body.trimEnd().split(/\r?\n/).slice(-lines);
    } catch {
      return [];
    }
  };

  const settingsSummary = (s: ProjectSettings): string =>
    [
      `${s.sourceLanguage || 'auto'} -> ${s.targetLanguage}`,
      `speech-to-text ${s.sttProviderId}${s.sttModel ? ` (${s.sttModel})` : ''}`,
      `translation ${s.translationProviderId}${s.refineProviderId && s.refineProviderId !== 'none' ? ` + review by ${s.refineProviderId}` : ''}`,
      `voice ${s.ttsProviderId}${s.ttsVoiceId ? ` (${s.ttsVoiceId})` : ''}`,
      `subtitles ${s.subtitleExportMode}`,
      ...(s.reviewBeforeSynthesis ? ['pauses for review before voicing'] : []),
      ...(s.holdFlaggedLines ? ['stops before voicing while lines fail the translation checks'] : []),
      ...(s.blurRegions?.length ? [`hides ${s.blurRegions.length} part(s) of the picture`] : []),
      ...(s.watermarkAuto ? [`finds the watermark and ${s.watermarkAuto.mode === 'pixelate' ? 'pixelates' : s.watermarkAuto.mode === 'delogo' ? 'removes' : 'blurs'} it`] : []),
      ...(s.burnSubtitleStyle?.coverOriginal
        ? [`source subtitles ${s.burnSubtitleStyle.coverOriginal === 'blur' ? 'blurred' : 'covered'}${s.burnSubtitleStyle.coverBand ? ` at ${Math.round(s.burnSubtitleStyle.coverBand.y * 100)} % of the height` : ''}`]
        : []),
    ].join('; ');

  // ------------------------------------------------------------ status & setup

  server.registerTool(
    'get_status',
    {
      title: 'VideoDubber status',
      description:
        'What this computer can do: app version, CPU/RAM/GPU, which local services are up, installed engines, engines recommended for this hardware but not installed, and the dubbing queue. Call this first.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [health, system, workers, queue, engines, recs, motherClaude] = await Promise.all([
        api.get<{ version?: string; commit?: string; platform?: string }>('/health', { signal }),
        api.get<{ profile: SystemProfileLite }>('/system', { signal }).catch(() => undefined),
        api.get<unknown>('/workers/health', { signal }).catch(() => undefined),
        api.get<unknown>('/queue', { signal }).catch(() => undefined),
        api.get<{ installed: { id: string }[] }>('/engines', { signal }).catch(() => undefined),
        api
          .get<{ recommendations: { packId: string; reason: string }[] }>('/engines/recommended', { signal })
          .catch(() => undefined),
        api.get<{ url?: string; reachable?: boolean; keyRejected?: boolean }>('/credentials/mother-claude', { signal }).catch(() => undefined),
      ]);
      const p = system?.profile;
      const installed = new Set((engines?.installed ?? []).map((e) => e.id));
      const missing = (recs?.recommendations ?? []).filter((r) => !installed.has(r.packId));
      const lines = [
        `VideoDubber ${health.version ?? '?'}${health.commit ? ` (${health.commit})` : ''} on ${health.platform ?? '?'}`,
        p
          ? `Hardware: ${p.cpuModel} (${p.cpuCores} cores), ${(p.totalRamMb / 1024).toFixed(0)} GB RAM, ` +
            (p.appleSilicon
              ? 'Apple Silicon GPU'
              : p.gpus.length > 0
                ? p.gpus.map((g) => `${g.name}${g.vramMb ? ` ${(g.vramMb / 1024).toFixed(0)} GB` : ''}${g.driverVersion ? ` (driver ${g.driverVersion})` : ''}`).join(', ')
                : 'no NVIDIA GPU detected')
          : 'Hardware: unknown',
        `Local services: ${JSON.stringify(workers ?? 'unknown')}`,
        `Engines installed: ${[...installed].join(', ') || 'none'}`,
        missing.length > 0
          ? `Recommended for this computer, not installed:\n${missing.map((r) => `  - ${r.packId}: ${r.reason}`).join('\n')}`
          : 'Every engine recommended for this computer is installed.',
        `Dubbing queue: ${JSON.stringify(queue ?? 'unknown')}`,
        motherClaude?.reachable
          ? `Claude through Mother Claude: reachable at ${motherClaude.url}${motherClaude.keyRejected ? ' (but its HTTP API refused the key)' : ''}.`
          : `Claude through Mother Claude: not reachable${motherClaude?.url ? ` at ${motherClaude.url}` : ''} (start Mother Claude's HTTP API to use it).`,
      ];
      return text(lines.join('\n'));
    }),
  );

  /** Seconds as "1 h 05 min" / "12 min" / "40 s". */
  const duration = (sec: number): string =>
    sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')} min` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`;

  server.registerTool(
    'get_queue',
    {
      title: 'The dubbing queue',
      description:
        'What is dubbing now (step, progress, estimated time left), what waits and why (no free slot, the GPU is busy, another app such as Voice Mask holds the graphics card, the queue is paused), who holds the GPU lane (a dub, an editor action or a voice preview), other apps\' holds on the graphics card, and the points budget.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      type Q = {
        maxProjects: number;
        budgetPoints: number;
        usedPoints: number;
        paused: boolean;
        laneOwner?: string;
        holds?: { holdId: string; holder: string; name?: string; reason: string; expiresAt: string }[];
        running: {
          projectId: string;
          name: string;
          heavy: boolean;
          step?: string;
          progressPercent?: number;
          stepPercent?: number;
          stepDetail?: string;
          etaSec?: number;
        }[];
        entries: { projectId: string; name: string; position: number; reason: string; message: string }[];
      };
      const q = await api.get<Q>('/queue', { signal: ctx.mcpReq.signal });
      // The step's own progress and what it does ("stt (15%: Detecting speakers 3/20)").
      const stepNow = (r: Q['running'][number]): string => {
        const said = [r.stepPercent !== undefined ? `${r.stepPercent}%` : '', r.stepDetail ?? ''].filter(Boolean).join(': ');
        return said ? ` (${said})` : '';
      };
      const lines = [
        `Dubs at once: ${q.maxProjects} (points ${q.usedPoints}/${q.budgetPoints})${q.paused ? '; the queue is PAUSED (Settings)' : ''}.`,
        `GPU lane: ${q.laneOwner ? `held by ${q.laneOwner}` : 'free'}.`,
        // Another app's hold (Voice Mask's live session): new dubs needing the card wait; nothing running is touched.
        ...(q.holds ?? []).map(
          (h) => `${h.name ?? h.holder} is using the graphics card (hold ${h.holdId}, until ${h.expiresAt}, renewed by its app)${h.reason ? `: ${h.reason}` : ''}. New dubs that need it wait.`,
        ),
        q.running.length > 0 ? 'Dubbing now:' : 'Nothing is dubbing.',
        ...q.running.map(
          (r) =>
            `- ${r.projectId} "${r.name}"${r.step ? `, ${r.step}${stepNow(r)}` : ''}${r.progressPercent !== undefined ? `, ${r.progressPercent}%` : ''}${r.etaSec !== undefined ? `, about ${duration(r.etaSec)} left` : ''}${r.heavy ? ' (uses the GPU lane)' : ''}`,
        ),
        ...(q.entries.length > 0 ? ['Waiting:'] : []),
        ...q.entries.map((e) => `- ${e.position}. ${e.projectId} "${e.name}": ${e.reason} (${e.message})`),
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'get_diagnostics',
    {
      title: 'What went wrong, and where',
      description:
        'The app\'s own health and evidence: uptime, memory and event-loop delay; GPU memory and who holds the GPU lane; the queue; engines running or failed, with their last output; disk used per project and free disk; recent warnings and errors (with the log references tool errors give); crash reports; each project\'s measured audio drift against its picture. bundle=true also writes a support bundle (a zip of logs and reports, no keys or logins) and returns its path.',
      inputSchema: z.object({ bundle: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ bundle }, ctx) => {
      type R = { t?: string; level: string; msg: string; projectId?: string; mcpRequestId?: string };
      type D = {
        health: { version: string; commit?: string; uptimeSec: number; heapLimitMb: number; latest?: { rssMb: number; heapUsedMb: number; lagP99Ms: number; lagMaxMs: number; freeRamShare: number }; peak: { rssMb: number; lagMaxMs: number }; recoveredFrom?: { at: string; codeHex?: string; meaning?: string } };
        gpu: { name: string; memoryUsedMb: number; memoryTotalMb: number; utilizationPct: number }[] | null;
        laneOwner?: string;
        queue: { running: { projectId: string }[]; entries: { projectId: string; reason: string }[] } | null;
        engines: { running: string[]; unusable: string[]; lastOutput: Record<string, string> };
        disk: { freeBytes?: number; projectsDir: string; projects: { id: string; name: string; bytes: number }[] };
        recent: { warnings: R[]; errors: R[] };
        crashes: { file: string; at: string; kind: string }[];
        /** Absent from apps before 0.18.1. */
        audioDrift?: { id: string; name: string; driftMs: number }[];
      };
      const d = await api.get<D>('/diagnostics/summary', { signal: ctx.mcpReq.signal, timeoutMs: 120_000 });
      const gb = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`;
      const h = d.health;
      const lines = [
        `VideoDubber ${h.version}${h.commit ? ` (${h.commit})` : ''}, up ${duration(h.uptimeSec)}.`,
        ...(h.recoveredFrom ? [`Restarted after a crash at ${h.recoveredFrom.at}${h.recoveredFrom.codeHex ? ` (${h.recoveredFrom.codeHex}: ${h.recoveredFrom.meaning ?? ''})` : ''}.`] : []),
        h.latest
          ? `Memory ${Math.round(h.latest.rssMb)} MB (peak ${Math.round(h.peak.rssMb)}, heap limit ${h.heapLimitMb} MB); event-loop delay p99 ${h.latest.lagP99Ms} ms (worst ${h.peak.lagMaxMs} ms); free RAM ${Math.round(h.latest.freeRamShare * 100)}%.`
          : 'No health sample yet (one is taken every minute).',
        d.gpu
          ? `GPU: ${d.gpu.map((g) => `${g.name} ${g.memoryUsedMb}/${g.memoryTotalMb} MB, ${g.utilizationPct}% busy`).join('; ')}.`
          : 'GPU: no NVIDIA card answered.',
        `GPU lane: ${d.laneOwner ? `held by ${d.laneOwner}` : 'free'}.`,
        d.queue ? `Queue: ${d.queue.running.length} dubbing, ${d.queue.entries.length} waiting${d.queue.entries.length ? ` (${[...new Set(d.queue.entries.map((e) => e.reason))].join(', ')})` : ''}.` : 'Queue: unavailable.',
        `Engines running: ${d.engines.running.join(', ') || 'none'}${d.engines.unusable.length ? `; failed to start this session: ${d.engines.unusable.join(', ')}` : ''}.`,
        ...Object.entries(d.engines.lastOutput)
          .filter(([, t]) => t.trim())
          .map(([id, t]) => `Last output of ${id}:\n${t.trim().split('\n').slice(-12).join('\n')}`),
        `Disk: ${d.disk.freeBytes !== undefined ? `${gb(d.disk.freeBytes)} free` : 'free space unknown'} where the projects are (${d.disk.projectsDir}).`,
        ...d.disk.projects.slice(0, 10).map((p) => `- ${p.id} "${p.name}": ${gb(p.bytes)}`),
        ...(d.recent.errors.length ? ['Recent errors:', ...d.recent.errors.slice(-10).map((r) => `- ${r.t ?? ''} ${r.msg}${r.projectId ? ` [${r.projectId}]` : ''}${r.mcpRequestId ? ` (ref ${r.mcpRequestId})` : ''}`)] : ['No recent errors.']),
        ...(d.recent.warnings.length ? ['Recent warnings:', ...d.recent.warnings.slice(-10).map((r) => `- ${r.t ?? ''} ${r.msg}${r.projectId ? ` [${r.projectId}]` : ''}`)] : []),
        ...(d.crashes.length ? ['Crash reports:', ...d.crashes.slice(0, 5).map((c) => `- ${c.at} ${c.kind}: ${c.file}`)] : ['No crash reports.']),
        ...(d.audioDrift?.length
          ? [
              'Audio against the picture, as measured at each project\'s extract-audio step (re-timed to the picture whatever it was; a warning from +0.5 s):',
              ...d.audioDrift
                .slice(0, 10)
                .map((a) => `- ${a.id} "${a.name}": ${a.driftMs >= 0 ? '+' : '-'}${(Math.abs(a.driftMs) / 1000).toFixed(2)} s`),
            ]
          : []),
      ];
      if (bundle) {
        const b = await api.post<{ path: string; sizeBytes: number }>('/diagnostics/bundle', {}, { signal: ctx.mcpReq.signal, timeoutMs: 300_000 });
        lines.push(`Support bundle: ${b.path} (${(b.sizeBytes / 1024 ** 2).toFixed(1)} MB). It has logs and reports, no keys or logins.`);
      }
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_languages',
    {
      title: 'Languages',
      description: 'Languages the app offers for source and target, and which offline translation language packs are installed.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => text(JSON.stringify(await api.get('/languages', { signal: ctx.mcpReq.signal }), null, 1))),
  );

  server.registerTool(
    'list_providers',
    {
      title: 'Engines per pipeline step',
      description:
        'The speech-to-text, translation and voice engines this machine offers, whether each is ready, and what to do when one is not (install a pack, add a key, ...).',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      type P = { id: string; displayName?: string; available?: boolean; isLocal?: boolean; remediation?: string };
      const all = await api.get<Record<'stt' | 'translation' | 'tts', P[]>>('/providers', { signal: ctx.mcpReq.signal });
      const block = (title: string, list: P[] = []) =>
        `${title}:\n${list
          .map(
            (p) =>
              `  - ${p.id}: ${p.displayName ?? p.id} — ${p.available ? 'ready' : `not ready${p.remediation ? ` (${p.remediation})` : ''}`}${p.isLocal === false ? ' [cloud]' : ''}`,
          )
          .join('\n')}`;
      return text([block('Speech-to-text', all.stt), block('Translation', all.translation), block('Voice', all.tts)].join('\n'));
    }),
  );

  server.registerTool(
    'list_voices',
    {
      title: 'Voices for a language',
      description:
        'The voice library: every voice for a dub language across engines (VieNeu 3.8 and the ten older VieNeu voices, ZeroTTS, Piper, Kokoro, Supertonic, OpenAI) plus the user\'s own cloned voices, best first, each with its licence and whether it is installed. A voice id goes into ttsVoiceId, and its engine\'s provider into ttsProviderId (shown per voice). Piper speakers of a multi-speaker model are "<id>#<speaker index>".',
      inputSchema: z.object({
        language: z.string().optional().describe('Dub language, e.g. "vi-VN" (all languages when omitted).'),
        engine: z
          .enum(['vieneu', 'vieneu-classic', 'zerotts', 'piper', 'kokoro', 'supertonic', 'openai', 'neural', 'omnivoice'])
          .optional()
          .describe('Only this engine ("neural" = the older VieNeu voices).'),
        gender: z.enum(['female', 'male']).optional(),
        license: z
          .enum(['permissive', 'attribution', 'use-restricted', 'non-commercial', 'service-terms', 'unknown'])
          .optional()
          .describe('Only this licence category.'),
        installed: z.boolean().optional().describe('true = only voices usable right now.'),
        kind: z.enum(['preset', 'profile']).optional().describe('"profile" = only the voices the user cloned.'),
        projectId: z.string().optional().describe("Also list this project's own cloned voices."),
        query: z.string().optional().describe('Free text: a name ("Hải Đăng"), a style ("tin tức"), a speaker.'),
        limit: z.number().int().min(1).max(200).default(40),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ language, engine, gender, license, installed, kind, projectId, query, limit }, ctx) => {
      if (engine === 'omnivoice') {
        const q = new URLSearchParams({ language: language ?? 'vi-VN', engine });
        return text(JSON.stringify(await api.get(`/setup/voices?${q}`, { signal: ctx.mcpReq.signal }), null, 1));
      }
      const q = new URLSearchParams({
        limit: String(limit),
        ...(language ? { language } : {}),
        ...(engine ? { engine: engine === 'neural' ? 'vieneu-classic' : engine } : {}),
        ...(gender ? { gender } : {}),
        ...(license ? { license } : {}),
        ...(installed !== undefined ? { installed: String(installed) } : {}),
        ...(kind ? { kind } : {}),
        ...(projectId ? { projectId } : {}),
        ...(query ? { q: query } : {}),
      });
      type Item = {
        id: string;
        kind: string;
        engine: string;
        name: string;
        languages: string[];
        gender?: string;
        accent?: string;
        tags?: string[];
        speakers?: { index: number; name: string }[];
        license: { category: string; label: string };
        sizeMb: number;
        installed: boolean;
        engineInstalled: boolean;
        engineAvailable: boolean;
        recommended?: boolean;
        mainOnly?: boolean;
      };
      const res = await api.get<{ voices: Item[]; total: number; engines: { id: string; providerId: string }[] }>(
        `/voices?${q}`,
        { signal: ctx.mcpReq.signal },
      );
      const provider = new Map(res.engines.map((e) => [e.id, e.providerId]));
      const rows = res.voices.map((v) => {
        const state = v.installed
          ? 'INSTALLED'
          : !v.engineAvailable
            ? 'not available on this computer'
            : v.engine === 'openai'
              ? 'needs an OpenAI API key'
              : v.engineInstalled || v.engine === 'piper'
                ? `install_voice downloads ~${Math.max(1, Math.round(v.sizeMb))} MB`
                : 'install_voice also installs its engine (see list_engines for the size)';
        const who = [v.gender, v.accent, ...(v.tags ?? [])].filter(Boolean).join(', ');
        const speakers = v.speakers?.length ? ` ${v.speakers.length} speakers (append #index)` : '';
        return `- ${v.id}: ${v.name}${v.kind === 'profile' ? ' (cloned voice)' : ''}${v.mainOnly ? ' [one main character only: never shared, never a default]' : ''}${v.recommended ? ' [recommended]' : ''} — ${provider.get(v.engine as never) ?? v.engine}; ${v.languages.slice(0, 4).join(', ')}${v.languages.length > 4 ? ` +${v.languages.length - 4}` : ''}${who ? `; ${who}` : ''}${speakers}; licence ${v.license.label} (${v.license.category}); ${state}`;
      });
      return text(`${res.total} voice(s)${res.total > res.voices.length ? `, first ${res.voices.length}` : ''}:\n${rows.join('\n')}`);
    }),
  );

  server.registerTool(
    'install_voice',
    {
      title: 'Install a voice',
      description:
        'Download one voice from list_voices, and the engine that speaks it when that is not installed yet (an engine is 0.3-5 GB: tell the user what will download first). Works for up to ~45 s, then returns while the download continues in the app; call list_voices with installed=true to see when it is ready. Cloned voices cannot be made here: the user records or imports them in the app (Voices screen), which asks for their consent.',
      inputSchema: z.object({ voiceId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ voiceId }, ctx) => {
      type Started = { started: boolean; enginePacks: string[]; downloadMb: number };
      type Ev = { type: string; packId?: string; item?: string; percent?: number | null; message?: string; error?: { message?: string; remediation?: string } };
      const signal = ctx.mcpReq.signal;
      const modelId = voiceId.split('#')[0]!;
      let last = '';
      // Set once the reply names the engine pack; the stream callbacks read it.
      const watch: { pack?: string } = {};
      let opened = 0;
      let bothOpen!: () => void;
      const ready = new Promise<void>((r) => (bothOpen = r));
      const onOpen = () => {
        opened += 1;
        if (opened >= 2) bothOpen();
      };
      const report = (e: Ev) => {
        last = `${e.percent != null ? `${Math.round(e.percent)}% ` : ''}${e.message ?? ''}`.trim();
        void progress(ctx, e.percent ?? 0, 100, last);
      };
      // Subscribe BEFORE starting, or a fast download's events are gone. Both
      // streams open (which one matters is known only from the reply); the
      // unneeded one is closed at once.
      const stopEngine = new AbortController();
      const stopPiper = new AbortController();
      const engineDone = api.followEvents<Ev>('/engines/events', {
        timeoutMs: workBudgetMs,
        signal: AbortSignal.any([signal, stopEngine.signal]),
        onOpen,
        until: (e) => e.packId !== undefined && e.packId === watch.pack && (e.type === 'done' || e.type === 'error'),
        onEvent: (e) => {
          if (e.packId === watch.pack && e.type === 'progress') report(e);
        },
      });
      const piperDone = api.followEvents<Ev>('/setup/events', {
        timeoutMs: workBudgetMs,
        signal: AbortSignal.any([signal, stopPiper.signal]),
        onOpen,
        until: (e) => (e.type === 'item-done' && e.item === `piper:${modelId}`) || e.type === 'error',
        onEvent: (e) => {
          if (e.item === `piper:${modelId}` && e.type === 'progress') report(e);
        },
      });
      await Promise.race([ready, sleep(3000)]);
      let started: Started;
      try {
        started = await api.post<Started>(`/voices/${encodeURIComponent(voiceId)}/install`, {}, { signal });
      } catch (err) {
        stopEngine.abort();
        stopPiper.abort();
        throw err;
      }
      if (!started.started) {
        stopEngine.abort();
        stopPiper.abort();
        return text(`${voiceId} is already installed.`);
      }
      watch.pack = started.enginePacks[0];
      (watch.pack ? stopPiper : stopEngine).abort();
      const end = await (watch.pack ? engineDone : piperDone);
      stopEngine.abort();
      stopPiper.abort();
      if (end?.type === 'done' || end?.type === 'item-done') {
        return text(`Installed ${voiceId}${watch.pack ? ` (with the ${watch.pack} engine)` : ''}.`);
      }
      if (end?.type === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Installing ${voiceId} failed: ${end.error?.message ?? 'unknown error'}${end.error?.remediation ? `\nHow to fix: ${end.error.remediation}` : ''}` }],
        };
      }
      return text(`${voiceId} is still downloading in the app${last ? ` (${last})` : ''}. Call list_voices with installed=true later to see when it is ready.`);
    }),
  );

  server.registerTool(
    'list_engines',
    {
      title: 'Engine packs',
      description:
        'Downloadable engines (faster speech-to-text on the GPU, local AI translation models, natural voices): which are installed, which this hardware runs well, sizes, and what is recommended.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      type Pack = { id: string; displayName: string; kind: string; approxSizeMb: number; description?: string };
      const signal = ctx.mcpReq.signal;
      const [engines, recs] = await Promise.all([
        api.get<{ available: Pack[]; installed: { id: string; version?: string }[]; updatable?: { id: string }[] }>('/engines', { signal }),
        api.get<{ recommendations: { packId: string; reason: string }[]; fits: string[] }>('/engines/recommended', { signal }),
      ]);
      const installed = new Set(engines.installed.map((i) => i.id));
      const updatable = new Set((engines.updatable ?? []).map((u) => u.id));
      const fits = new Set(recs.fits);
      const recommended = new Map(recs.recommendations.map((r) => [r.packId, r.reason]));
      const rows = engines.available.map((p) => {
        const tags = [
          installed.has(p.id) ? 'INSTALLED' : '',
          updatable.has(p.id) ? 'update available' : '',
          recommended.has(p.id) ? 'RECOMMENDED' : '',
          fits.has(p.id) ? 'runs well here' : 'may be slow here',
        ].filter(Boolean);
        return `- ${p.id} (${p.kind}, ~${(p.approxSizeMb / 1024).toFixed(1)} GB) ${p.displayName} [${tags.join(', ')}]${recommended.has(p.id) ? `\n    why: ${recommended.get(p.id)}` : ''}`;
      });
      return text(rows.join('\n'));
    }),
  );

  server.registerTool(
    'install_engine',
    {
      title: 'Install an engine pack',
      description:
        'Download and install one engine pack (ids from list_engines). Packs are large (0.1-5 GB): tell the user what you are installing and why first. Works for up to ~45 s, then returns while the install continues in the app; call list_engines to see when it is installed.',
      inputSchema: z.object({ packId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ packId }, ctx) => {
      type Ev = { type: string; packId?: string; percent?: number | null; message?: string; error?: { message?: string; remediation?: string } };
      let last = '';
      let opened!: () => void;
      const ready = new Promise<void>((r) => (opened = r));
      const finished = api.followEvents<Ev>('/engines/events', {
        timeoutMs: workBudgetMs,
        signal: ctx.mcpReq.signal,
        onOpen: () => opened(),
        until: (e) => e.packId === packId && (e.type === 'done' || e.type === 'error'),
        onEvent: (e) => {
          if (e.packId !== packId || e.type !== 'progress') return;
          last = `${e.percent != null ? `${Math.round(e.percent)}% ` : ''}${e.message ?? ''}`.trim();
          void progress(ctx, e.percent ?? 0, 100, last);
        },
      });
      // Subscribe BEFORE starting, or a fast install's events are gone.
      await Promise.race([ready, sleep(3000)]);
      await api.post('/engines/install', { packId }, { signal: ctx.mcpReq.signal });
      const end = await finished;
      if (end?.type === 'done') return text(`Installed ${packId}.`);
      if (end?.type === 'error') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Installing ${packId} failed: ${end.error?.message ?? 'unknown error'}${end.error?.remediation ? `\nHow to fix: ${end.error.remediation}` : ''}` }],
        };
      }
      return text(`${packId} is still installing in the app${last ? ` (${last})` : ''}. Call list_engines later to see when it is installed.`);
    }),
  );

  // ---------------------------------------------------------- video & project

  // ------------------------------------------------------------- downloads

  type DlItem = {
    id: string;
    state: string;
    percent: number | null;
    page: number;
    input: string;
    sourceKey?: string;
    source?: { title: string; partTitle?: string; partCount: number; ownerName?: string; url: string; durationSec?: number };
    filePath?: string;
    heightPx?: number;
    error?: { code?: string; message?: string; remediation?: string };
    retryAt?: string;
    projectIds?: string[];
  };
  const FINAL_DL = new Set(['done', 'failed', 'cancelled']);

  /** One line about a download (no paths but the finished file). */
  const describeDownload = (d: DlItem): string => {
    const title = d.source ? `"${d.source.title}"${d.source.partCount > 1 ? ` P${d.page}${d.source.partTitle ? ` ${d.source.partTitle}` : ''}` : ''}` : d.input;
    const where =
      d.state === 'done'
        ? `done${d.heightPx ? ` (${d.heightPx}p)` : ''}: ${d.filePath}`
        : d.state === 'failed'
          ? `FAILED: ${d.error?.message ?? 'unknown error'}${d.error?.code ? ` (${d.error.code})` : ''}${d.error?.remediation ? `\n    How to fix: ${d.error.remediation}` : ''}`
          : d.state === 'queued' && d.retryAt
            ? `waiting until ${d.retryAt} (the site is limiting requests)`
            : `${d.state}${d.percent !== null && d.percent !== undefined ? ` ${Math.round(d.percent)}%` : ''}`;
    return `- ${d.id} ${title}${d.sourceKey ? ` [${d.sourceKey}]` : ''}: ${where}${d.projectIds?.length ? ` (projects: ${d.projectIds.join(', ')})` : ''}`;
  };

  /** Follow one download until it ends or the time is up; the last state either way. */
  async function followDownload(id: string, ctx: ServerContext, budgetMs: number): Promise<CallToolResult> {
    const signal = ctx.mcpReq.signal;
    let item = await api.get<DlItem>(`/downloads/${encodeURIComponent(id)}`, { signal });
    if (!FINAL_DL.has(item.state)) {
      type Ev = { type: string; item?: DlItem };
      const end = await api.followEvents<Ev>('/download/events', {
        timeoutMs: budgetMs,
        signal,
        until: (e) => e.type === 'item' && e.item?.id === id && FINAL_DL.has(e.item.state),
        onEvent: (e) => {
          if (e.type !== 'item' || e.item?.id !== id) return;
          item = e.item;
          void progress(ctx, e.item.percent ?? 0, 100, `${e.item.state} ${Math.round(e.item.percent ?? 0)}%`);
        },
      });
      if (end?.item) item = end.item;
    }
    if (item.state === 'done') return text(`Downloaded ${describeDownload(item).slice(2)}\nUse ${item.filePath} as create_project's video, or dub_downloads with downloadIds ["${item.id}"].`);
    if (item.state === 'failed' || item.state === 'cancelled') return { isError: true, content: [{ type: 'text', text: describeDownload(item) }] };
    return text(`Still going: ${describeDownload(item).slice(2)}\nCall get_download with "${item.id}" to keep waiting (or follow it with follow_jobs_command).`);
  }

  server.registerTool(
    'download_video',
    {
      title: 'Download a video from a link',
      description:
        'Download one video to dub from a Bilibili or Douyin link (or a bare BV id). Waits up to ~45 s; if it is still downloading, returns its download id for get_download. For several videos use download_videos.',
      inputSchema: z.object({
        url: z.string().min(1),
        part: z.number().int().min(1).optional().describe('Part/page number for multi-part videos (Bilibili "P2" = 2).'),
        maxHeight: z.number().int().optional().describe('Highest video height to fetch, e.g. 720 or 1080.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ url, part, maxHeight }, ctx) => {
      const { jobId } = await api.post<{ jobId: string }>(
        '/download/start',
        { input: url, ...(part ? { page: part } : {}), ...(maxHeight ? { targetHeightPx: maxHeight } : {}) },
        { signal: ctx.mcpReq.signal },
      );
      return followDownload(jobId, ctx, workBudgetMs);
    }),
  );

  server.registerTool(
    'download_videos',
    {
      title: 'Download many videos',
      description:
        'Queue many Bilibili/Douyin links (or BV ids) at once; two download at a time, the rest wait, and a rate-limited site is waited out. Returns at once with a download id per video. Asking for a video already in the list returns that download (each has a sourceKey like bilibili:BV…:p2), retrying it when it failed. parts="all" adds every part of a multi-part video; pages=[3,4,5] only those parts of each link (a part a video does not have fails that download, naming how many it has). Follow them with follow_jobs_command (best for long batches) or wait_jobs, then dub_downloads.',
      inputSchema: z.object({
        urls: z.array(z.string().min(1)).min(1).max(200),
        parts: z.enum(['link', 'all']).default('link').describe('link = the part each link points at; all = every part of multi-part videos. Ignored with pages.'),
        pages: z
          .array(z.number().int().min(1))
          .min(1)
          .max(200)
          .optional()
          .describe('Only these parts (P numbers, Bilibili "P3" = 3) of each link, one download each: some parts of a multi-part video without all of them. At most 200 downloads per call in all.'),
        maxHeight: z.number().int().optional().describe('Highest video height to fetch, e.g. 720 or 1080; the best the video has when omitted.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ urls, parts, pages, maxHeight }, ctx) => {
      const quality = maxHeight ? { targetHeightPx: maxHeight } : {};
      const wanted = pages?.length ? [...new Set(pages)].sort((a, b) => a - b) : undefined;
      const items = wanted ? urls.flatMap((input) => wanted.map((page) => ({ input, page, ...quality }))) : urls.map((input) => ({ input, ...quality }));
      if (items.length > 200) {
        return failure(new Error(`That is ${items.length} downloads (${urls.length} link(s) × ${wanted!.length} part(s)): at most 200 per call. Split the links over several calls.`));
      }
      const res = await api.post<{ added: DlItem[]; existing: DlItem[]; rejected: { input: string; error: { message?: string } }[] }>(
        '/downloads',
        { items, allParts: !wanted && parts === 'all' },
        { signal: ctx.mcpReq.signal },
      );
      const lines = [
        `Queued ${res.added.length}, already in the list ${res.existing.length}, refused ${res.rejected.length}.`,
        ...res.added.map(describeDownload),
        ...res.existing.map(describeDownload),
        ...res.rejected.map((r) => `- refused ${r.input}: ${r.error.message ?? 'not a supported link'}`),
      ];
      const ids = [...res.added, ...res.existing].map((d) => d.id);
      if (ids.length > 0) lines.push(`Download ids: ${JSON.stringify(ids)}`);
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'get_download',
    {
      title: 'Download status',
      description: 'Status of one download (download_video / download_videos). Waits up to waitSeconds for it to finish.',
      inputSchema: z.object({ jobId: z.string().describe('The download id.'), waitSeconds: z.number().min(0).max(50).default(30) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ jobId, waitSeconds }, ctx) => followDownload(jobId, ctx, Math.max(1000, waitSeconds * 1000))),
  );

  server.registerTool(
    'list_downloads',
    {
      title: 'Downloads',
      description: 'Every download the app knows, newest first, with its state, source key, file and the projects made from it.',
      inputSchema: z.object({ state: z.enum(['queued', 'resolving', 'downloading', 'merging', 'done', 'failed', 'cancelled']).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ state }, ctx) => {
      const all = await api.get<DlItem[]>('/downloads', { signal: ctx.mcpReq.signal });
      const shown = state ? all.filter((d) => d.state === state) : all;
      return text(shown.length === 0 ? 'No downloads.' : shown.map(describeDownload).join('\n'));
    }),
  );

  for (const [name, title, verb, description] of [
    ['cancel_download', 'Cancel a download', 'cancel', 'Stop a download (or take it out of the line); its partial files are removed. retry_download starts it again.'],
    ['retry_download', 'Retry a download', 'retry', 'Try a failed or cancelled download again (it continues from what it already has when it can).'],
  ] as const) {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ downloadId: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: verb === 'retry' } },
      guarded(async ({ downloadId }, ctx) =>
        text(describeDownload(await api.post<DlItem>(`/downloads/${encodeURIComponent(downloadId)}/${verb}`, {}, { signal: ctx.mcpReq.signal }))),
      ),
    );
  }

  server.registerTool(
    'delete_download',
    {
      title: 'Remove a download',
      description:
        'Take a download off the list. deleteFile=true also deletes the downloaded video (projects made from it keep their own copy of it).',
      inputSchema: z.object({ downloadId: z.string(), deleteFile: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ downloadId, deleteFile }, ctx) => {
      await api.delete(`/downloads/${encodeURIComponent(downloadId)}?deleteFile=${deleteFile ? 'true' : 'false'}`, { signal: ctx.mcpReq.signal });
      return text(`Removed ${downloadId}${deleteFile ? ' and its file' : ''}.`);
    }),
  );

  server.registerTool(
    'set_download_login',
    {
      title: 'Give the app the browser\'s site cookies',
      description:
        'Sign VideoDubber in to Bilibili with the user\'s browser cookies: pass the path of the file Mother Claude\'s browser_cookies export wrote (never the cookie values). The file is read and deleted here; only SESSDATA and buvid3 of bilibili.com are kept. Logged out in the browser works too (up to 720p). Answers logged in or not, the account, and the best quality available.',
      inputSchema: z.object({
        provider: z.enum(['bilibili']).default('bilibili'),
        cookiesFile: z.string().describe('Absolute path of the cookie export (Netscape cookies.txt or JSON).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ provider, cookiesFile }, ctx) => {
      if (!path.isAbsolute(cookiesFile)) return failure(new Error('cookiesFile must be an absolute path.'));
      const cookies = cookiesOfSite(await takeCookieExport(cookiesFile), 'bilibili.com');
      const res = await api.post<{ configured: boolean; check?: { valid: boolean; uname?: string; premium?: boolean } }>(
        `/download/providers/${provider}/session/import`,
        { cookies },
        { signal: ctx.mcpReq.signal },
      );
      return text(describeLogin(res));
    }),
  );

  server.registerTool(
    'get_download_login',
    {
      title: 'Is the app signed in to the site?',
      description: 'Whether VideoDubber holds a Bilibili login, the account, and the best quality it can download. Changes nothing.',
      inputSchema: z.object({ provider: z.enum(['bilibili']).default('bilibili') }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ provider }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const described = await api.get<{ configured: boolean }>(`/download/providers/${provider}/session`, { signal });
      const check = described.configured
        ? await api.post<{ valid: boolean; uname?: string; premium?: boolean }>(`/download/providers/${provider}/session/test`, {}, { signal }).catch(() => undefined)
        : undefined;
      return text(describeLogin({ ...described, ...(check ? { check } : {}) }));
    }),
  );

  function describeLogin(s: { configured: boolean; check?: { valid: boolean; uname?: string; premium?: boolean } }): string {
    if (!s.configured || !s.check?.valid) {
      return `Not logged in to Bilibili${s.configured ? ' (the saved login no longer works)' : ''}: downloads get up to 720p.`;
    }
    return `Logged in to Bilibili${s.check.uname ? ` as ${s.check.uname}` : ''}${s.check.premium ? ' (premium)' : ''}: downloads get up to ${s.check.premium ? '1080p60 / 4K where the video has them' : '1080p'}.`;
  }

  // ------------------------------------------------------------ batches

  server.registerTool(
    'list_brand_kit',
    {
      title: 'Logos and greetings',
      description:
        "The user's brand kit (Settings → Logo & greeting): logos and spoken greetings, by id, for a project's settings.branding. The user adds them in the app.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      type A = { id: string; kind: string; name: string; durationMs?: number; text?: string; width?: number; height?: number };
      const list = await api.get<A[]>('/branding', { signal: ctx.mcpReq.signal });
      if (list.length === 0) return text('The brand kit is empty: the user can add a logo or a greeting in Settings → Logo & greeting.');
      return text(
        list
          .map((a) =>
            a.kind === 'logo'
              ? `- ${a.id} logo "${a.name}" (${a.width}x${a.height})`
              : `- ${a.id} greeting "${a.name}" (${((a.durationMs ?? 0) / 1000).toFixed(1)} s${a.text ? `, says "${a.text}"` : ''})`,
          )
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'dismiss_warnings',
    {
      title: 'Dismiss project warnings',
      description:
        "Set a project's warnings aside once you have checked them (get_project lists them): those with the codes given, or all. They are kept as dismissed; a step that runs again and finds the same raises them again. Warnings about a stretch of the transcript (lines over silence, a failed spot check) also clear by themselves when that stretch is re-transcribed or its lines replaced.",
      inputSchema: z.object({
        projectId: z.string(),
        codes: z.array(z.string()).optional().describe('e.g. ["stt-no-speech", "transcript-mismatch"]; omit for every warning.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, codes }, ctx) => {
      const res = await api.post<{ dismissed: number; codes: string[]; warnings: { code: string }[] }>(
        `/projects/${encodeURIComponent(projectId)}/warnings/dismiss`,
        codes ? { codes } : {},
        { signal: ctx.mcpReq.signal },
      );
      return text(
        res.dismissed === 0
          ? 'No warning to dismiss.'
          : `Dismissed ${res.dismissed} warning(s) (${res.codes.join(', ')}).${res.warnings.length > 0 ? ` ${res.warnings.length} remain.` : ''}`,
      );
    }),
  );

  server.registerTool(
    'list_presets',
    {
      title: 'Dub presets',
      description:
        'The user\'s saved dub presets (languages, engines, voice, subtitles, save folder, series of parts for long videos), and the built-in ones every computer has (builtin:quality, builtin:balanced, builtin:economy: engines on this computer only, never a cloud AI; they need targetLanguage and sourceLanguage), for create_project, join_videos and dub_downloads (presetId). The user makes their own in New project.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      const [list, builtins] = await Promise.all([
        api.get<DubPreset[]>('/presets', { signal: ctx.mcpReq.signal }),
        api.get<DubPreset[]>('/presets/builtin', { signal: ctx.mcpReq.signal }).catch(() => [] as DubPreset[]),
      ]);
      const builtIn =
        builtins.length > 0
          ? [
              '',
              'Built in, worked out for this computer (its own engines only, never a cloud AI; give targetLanguage and sourceLanguage with them):',
              ...builtins.map(describeBuiltinPreset),
            ]
          : [];
      if (list.length === 0) {
        return text(['No presets of the user\'s yet. create_project, join_videos and dub_downloads also take targetLanguage and settings directly.', ...builtIn].join('\n'));
      }
      return text(
        [...list
          .map((p) => `- ${p.id} "${p.name}": ${p.sourceLanguage || 'auto'} -> ${p.targetLanguage}${p.settings.ttsVoiceId ? `, voice ${p.settings.ttsVoiceId}` : ''}${p.settings.subtitleExportMode ? `, subtitles ${p.settings.subtitleExportMode}` : ''}${p.outputDir ? `, saves to ${p.outputDir}` : ''}${p.series ? `, ${describePresetSeries(p.series)}` : ''}${p.start ? ', starts at once' : ''}`), ...builtIn]
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'dub_downloads',
    {
      title: 'Dub finished downloads',
      description:
        'Make a project per finished download (the video is linked, not copied), from a preset and/or settings, and start them when start=true: they dub one after another in the queue, and one whose models are still downloading starts when they arrive. Returns the project ids; follow them with follow_jobs_command or wait_jobs.',
      inputSchema: z.object({
        downloadIds: z.array(z.string()).min(1).max(200),
        presetId: z.string().optional().describe('A preset from list_presets (a built-in one needs targetLanguage and sourceLanguage).'),
        targetLanguage: z.string().optional().describe('Dub language, e.g. "vi-VN" (required without a preset).'),
        sourceLanguage: z.string().optional().describe('Spoken language, e.g. "zh" (required without a preset that has one).'),
        saveTo: z.string().optional().describe('Absolute folder for the finished videos and subtitles.'),
        settings: editableSettings.optional(),
        start: z.boolean().optional().describe('Start dubbing right away (default: the preset\'s choice, else no).'),
        series: z
          .object({
            minMinutes: z.number().min(5).max(120).optional(),
            maxMinutes: z.number().min(5).max(180).optional(),
            ai: z.string().optional().describe("anthropic | openai | gemini | llama-cpp-chat; default the preset's, else the built-in Gemma chat model on this computer. A cloud AI is used only when named."),
            recapSec: z.number().min(0).max(8).optional(),
            autoStart: z.boolean().optional(),
            longerThanMinutes: z.number().min(5).optional().describe('Only videos longer than this are split (default 1.5 x maxMinutes).'),
            nameTemplate: z
              .string()
              .max(200)
              .optional()
              .describe('How the parts are named: {series}, {n}, {nn} (two digits), {total}, {title}; default "<video> - Phần 01".'),
          })
          .optional()
          .describe('Dub the long downloads as series of parts (15-20 min by default); follow each with get_series.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ downloadIds, presetId, targetLanguage, sourceLanguage, saveTo, settings, start, series }, ctx) => {
      type R = {
        downloadId: string;
        projectId?: string;
        name?: string;
        started?: boolean;
        queued?: boolean;
        waiting?: boolean;
        series?: boolean;
        error?: { message?: string; code?: string };
      };
      const res = await api.post<{ results: R[] }>(
        '/downloads/dub',
        {
          downloadIds,
          ...(presetId ? { presetId } : {}),
          ...(targetLanguage ? { targetLanguage } : {}),
          ...(sourceLanguage !== undefined ? { sourceLanguage } : {}),
          ...(saveTo?.trim() ? { outputDir: saveTo.trim() } : {}),
          ...(settings ? { settings } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(series
            ? {
                series: {
                  ...(series.minMinutes ? { minMinutes: series.minMinutes } : {}),
                  ...(series.maxMinutes ? { maxMinutes: series.maxMinutes } : {}),
                  ...(series.ai ? { aiProviderId: series.ai } : {}),
                  ...(series.recapSec !== undefined ? { recapSec: series.recapSec } : {}),
                  ...(series.autoStart !== undefined ? { autoStart: series.autoStart } : {}),
                  ...(series.longerThanMinutes ? { longerThanMinutes: series.longerThanMinutes } : {}),
                  ...(series.nameTemplate?.trim() ? { nameTemplate: series.nameTemplate.trim() } : {}),
                },
              }
            : {}),
        },
        { signal: ctx.mcpReq.signal, timeoutMs: 300_000 },
      );
      const lines = res.results.map((r) =>
        r.projectId
          ? `- ${r.downloadId} -> ${r.projectId} "${r.name ?? ''}"${r.series ? ' (long: split into parts, get_series for them)' : ''}${r.waiting ? ': starts when its models have downloaded' : r.queued ? ': queued' : r.started ? ': dubbing' : ': created (start_dubbing to begin)'}`
          : `- ${r.downloadId}: not made: ${r.error?.message ?? 'unknown error'}`,
      );
      const ids = res.results.flatMap((r) => (r.projectId ? [r.projectId] : []));
      // How the series start, as the app made them: the preset's own choice
      // when the call names no series block. This said "autoStart=true" for a
      // preset with false, while the projects were made right (2026-11-27).
      const madeSeries = res.results.find((r) => r.series && r.projectId);
      if (madeSeries?.projectId) {
        const made = await getProject(madeSeries.projectId, ctx.mcpReq.signal).catch(() => undefined);
        const settings = made?.project.series?.role === 'parent' ? made.project.series.settings : undefined;
        lines.push(seriesGateNote(settings?.autoStart ?? series?.autoStart ?? true));
      }
      if (ids.length > 0) lines.push(`Project ids: ${JSON.stringify(ids)}`);
      return text(lines.join('\n'));
    }),
  );

  /** One line about where a job is (wait_jobs). */
  async function jobLine(kind: 'download' | 'project', id: string, signal: AbortSignal): Promise<{ key: string; line: string; stopped: boolean }> {
    try {
      if (kind === 'download') {
        const d = await api.get<DlItem>(`/downloads/${encodeURIComponent(id)}`, { signal });
        return { key: `${d.state}|${Math.floor((d.percent ?? 0) / 10)}`, line: describeDownload(d), stopped: FINAL_DL.has(d.state) };
      }
      const { project, pipeline } = await getProject(id, signal);
      const state = pipeline.awaitingReview ? 'awaiting review' : project.status;
      return {
        key: `${state}|${pipeline.currentStep}|${Math.floor(pipeline.progressPercent / 10)}`,
        line: `- ${id} "${project.name}": ${state}${project.status === 'running' ? ` (${pipeline.currentStep ?? ''} ${Math.round(pipeline.progressPercent)}%)` : ''}`,
        stopped: project.status !== 'running' && project.status !== 'queued',
      };
    } catch {
      return { key: 'unknown', line: `- ${id}: unknown (no such ${kind})`, stopped: true };
    }
  }

  server.registerTool(
    'wait_jobs',
    {
      title: 'Wait for downloads and dubs',
      description:
        'Wait (up to waitSeconds, at most 50) until any of the named downloads or dubs moves on or stops, then say where each one is. For batches that take hours, follow_jobs_command is cheaper.',
      inputSchema: z.object({
        downloadIds: z.array(z.string()).max(200).default([]),
        projectIds: z.array(z.string()).max(200).default([]),
        waitSeconds: z.number().min(0).max(50).default(45),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ downloadIds, projectIds, waitSeconds }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const jobs = [...downloadIds.map((id) => ['download', id] as const), ...projectIds.map((id) => ['project', id] as const)];
      if (jobs.length === 0) return failure(new Error('Name at least one download or project id.'));
      const read = () => Promise.all(jobs.map(([kind, id]) => jobLine(kind, id, signal)));
      let now = await read();
      const start = now.map((j) => j.key).join(',');
      const deadline = Date.now() + waitSeconds * 1000;
      while (!now.every((j) => j.stopped) && Date.now() < deadline && !signal.aborted) {
        await sleep(pollMs, signal);
        now = await read();
        if (now.map((j) => j.key).join(',') !== start) break;
      }
      const stopped = now.filter((j) => j.stopped).length;
      return text([`${stopped} of ${now.length} stopped (finished, failed, paused or waiting for a review).`, ...now.map((j) => j.line)].join('\n'));
    }),
  );

  server.registerTool(
    'follow_jobs_command',
    {
      title: 'A command that follows jobs',
      description:
        'The shell command that streams one JSON line per change of the named downloads and dubs ({seq, at, kind, id, state, title?, progress?, step?, error?}), and exits once all of them have stopped: run it in the background or under a monitor and act on its lines. Progress is written every 25% or 5 minutes. Pass since=<seq> to get only what was missed after a reconnect.',
      inputSchema: z.object({
        downloadIds: z.array(z.string()).max(500).default([]),
        projectIds: z.array(z.string()).max(500).default([]),
        since: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ downloadIds, projectIds, since }) => {
      if (downloadIds.length + projectIds.length === 0) return failure(new Error('Name at least one download or project id.'));
      const q = new URLSearchParams({
        ...(downloadIds.length ? { downloads: downloadIds.join(',') } : {}),
        ...(projectIds.length ? { projects: projectIds.join(',') } : {}),
        ...(since !== undefined ? { since: String(since) } : {}),
        untilDone: '1',
      });
      const url = `${api.baseUrl}/jobs/events?${q.toString()}`;
      return text(
        [
          `PowerShell: curl.exe -sN "${url}"`,
          `bash: curl -sN '${url}'`,
          'It exits (code 0) once every job has stopped. When the app is not running, curl exits 7 ("Failed to connect"). In Windows PowerShell 5.1 write curl.exe: plain curl is Invoke-WebRequest there.',
        ].join('\n'),
      );
    }),
  );

  type SeriesViewLite = {
    parentId: string;
    name: string;
    state: string;
    settings: {
      minMinutes: number;
      maxMinutes: number;
      aiProviderId: string;
      recapSec: number;
      nameTemplate?: string;
      seriesName?: string;
      partNumberOffset?: number;
      totalParts?: number;
    };
    plan?: {
      parts: { index: number; startMs: number; endMs: number; title: string; summary: string; cutBy: string }[];
      notes: string[];
      createdAt?: string;
    };
    reviewReasons?: { code: string; message: string }[];
    parts: {
      index: number;
      projectId?: string;
      title: string;
      summary?: string;
      name?: string;
      startMs: number;
      endMs: number;
      status?: string;
      progressPercent?: number;
      /** Paused or stopped on its own: starting the series leaves it. */
      pausedByUser?: boolean;
      /** Its lines to look at (H7), when it has any. */
      issues?: ProjectLineIssues;
    }[];
    continues?: { parentId: string; name: string };
    error?: { message?: string };
  };

  const describeSeries = (v: SeriesViewLite): string => {
    const lines = [
      `Series "${v.name}" (${v.parentId}): ${v.state}${v.error?.message ? ` — ${v.error.message}` : ''}`,
      `Parts of ${v.settings.minMinutes}-${v.settings.maxMinutes} min, cuts by ${v.settings.aiProviderId}, ${v.settings.recapSec} s recap.`,
      // A later season: its name and numbers carry on from the series it continues.
      ...(v.continues ? [`Continues "${v.continues.name}" (${v.continues.parentId}): parts numbered from ${(v.settings.partNumberOffset ?? 0) + 1}.`] : []),
      ...(v.settings.nameTemplate ? [`Parts named "${v.settings.nameTemplate}".`] : []),
      // Asked to start by itself, it stopped at review: the analysis was not clean.
      ...(v.reviewReasons ?? []).map((r) => `STOPPED AT REVIEW: ${r.message}`),
      ...(v.plan?.notes ?? []).map((n) => `Note: ${n}`),
      ...v.parts.map((p) => {
        const summary = p.summary ?? v.plan?.parts.find((x) => x.index === p.index)?.summary;
        return `- part ${p.index}: ${clock(p.startMs)}-${clock(p.endMs)} "${p.title}"${summary ? ` (${summary})` : ''}${p.projectId ? ` project ${p.projectId}${p.name ? ` "${p.name}"` : ''}` : ''}${p.status ? `, ${p.status}${p.status === 'running' ? ` ${p.progressPercent ?? 0}%` : ''}` : ''}${p.pausedByUser ? `, ${HELD_PART}` : ''}${lineIssuesBrief(p.issues)}`;
      }),
    ];
    if (v.state === 'review') {
      lines.push('Next: set_split_plan to change cuts or titles (replan_series to plan again), or start_series to make and dub the parts.');
    }
    if (v.state === 'parts') {
      lines.push(
        'The series acts as a whole: pause_dubbing / start_dubbing on its id pause or continue every part in order; rebuild_parts remakes the parts\' transcripts after the series transcript was fixed (some or all, queued ones where they wait); edit_part renames or retitles a part.',
      );
    }
    return lines.join('\n');
  };

  server.registerTool(
    'rebuild_parts',
    {
      title: 'Remake the parts from the fixed series transcript',
      description:
        'After the series transcript was fixed (speakers re-detected, loops repaired, lines replaced on the parent): make each part\'s transcript again from it, copy the series\' character sheet to every part again, and move stale translation checkpoints aside. parts=[23, 24] rebuilds only those (their numbers as get_series shows them); all parts otherwise. A part waiting in the queue is rebuilt where it waits and keeps its place (no need to pause anything); a part being dubbed is never touched, and the answer says why. Parts already translated are left alone unless force=true (their translation is then discarded, kept beside as a file, and the part continues at the translation on its next run). Reports old and new line counts and speakers per part; each rebuild is in the part\'s edit history.',
      inputSchema: z.object({
        projectId: z.string().describe('The series (parent) or any part.'),
        parts: z.array(z.number().int().min(1)).max(500).optional().describe('Only these part numbers, e.g. [23, 24].'),
        force: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, parts, force }, ctx) => {
      type P = {
        projectId: string;
        index: number;
        rebuilt: boolean;
        skipped?: string;
        reason?: string;
        queued?: boolean;
        translationDiscarded?: boolean;
        oldLines?: number;
        newLines?: number;
        speakers?: number;
      };
      const res = await api.post<{ parts: P[] }>(
        `/projects/${encodeURIComponent(projectId)}/series/rebuild-parts`,
        { force, ...(parts?.length ? { parts } : {}) },
        { signal: ctx.mcpReq.signal, timeoutMs: 300_000 },
      );
      // The app's reason ("is being dubbed now"), with what to do unless it says so itself.
      const why = (p: P): string =>
        p.skipped === 'translated'
          ? 'already translated (force=true discards it)'
          : p.skipped === 'running'
            ? `it ${p.reason ?? 'is being dubbed'}${p.reason?.includes(':') ? '' : '; rebuild it once that is done, or pause it first'}`
            : 'not found';
      return text(
        [
          ...res.parts.map((p) =>
            p.rebuilt
              ? `- part ${p.index} (${p.projectId}): ${p.oldLines ?? '?'} -> ${p.newLines ?? '?'} lines, ${p.speakers ?? 0} speaker(s)` +
                `${p.queued ? ', still waiting in the queue at the same place' : ''}${p.translationDiscarded ? ', translation set aside: it continues at the translation' : ''}`
              : `- part ${p.index} (${p.projectId}): left as it was: ${why(p)}`,
          ),
          'Rebuilt parts translate from their new transcript on their next run (start_dubbing on the series continues them in order).',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'get_series',
    {
      title: 'A long video dubbed in parts',
      description:
        'Where a series stands (analysing, planning, review, parts, failed), its planned cuts with titles and summaries, and each part\'s project and progress, with the ids of its lines to look at (still failing the translation checks, or voiced running into the next line by more than 0.3 s). Works with the parent or any part\'s project id.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) =>
      text(describeSeries(await api.get<SeriesViewLite>(`/projects/${encodeURIComponent(projectId)}/series`, { signal: ctx.mcpReq.signal }))),
    ),
  );

  server.registerTool(
    'set_split_plan',
    {
      title: 'Change where a series is cut',
      description:
        'Before the parts are made (state review): set the cut times (each part at least a minute; the parts follow them) and/or the parts\' titles and one-sentence summaries. Use your own reading of get_transcript to cut between topics. Times as "m:ss", "h:mm:ss" or ms.',
      inputSchema: z.object({
        projectId: z.string(),
        cuts: z.array(z.union([z.string(), z.number()])).optional().describe('Where each part after the first starts.'),
        titles: z.array(z.object({ title: z.string(), summary: z.string().optional() })).optional().describe('One per part, in order.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, cuts, titles }, ctx) => {
      const toMs = (t: string | number): number => {
        if (typeof t === 'number') return t;
        const parts = t.trim().split(':').map(Number);
        return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
      };
      await api.put(
        `/projects/${encodeURIComponent(projectId)}/series/plan`,
        { ...(cuts ? { cuts: cuts.map(toMs) } : {}), ...(titles ? { titles } : {}) },
        { signal: ctx.mcpReq.signal },
      );
      return text(describeSeries(await api.get<SeriesViewLite>(`/projects/${encodeURIComponent(projectId)}/series`, { signal: ctx.mcpReq.signal })));
    }),
  );

  server.registerTool(
    'start_series',
    {
      title: 'Make and dub the parts',
      description: 'Make the parts of a planned series (once) and queue them in order. Follow them with get_series or follow_jobs_command (their project ids).',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const res = await api.post<{ parts: { projectId: string; index?: number; error?: string; queued?: boolean; waiting?: boolean; done?: boolean; held?: boolean }[] }>(
        `/projects/${encodeURIComponent(projectId)}/series/start`,
        {},
        { signal: ctx.mcpReq.signal, timeoutMs: 300_000 },
      );
      return text(
        [
          ...res.parts.map(
            (p, i) =>
              `- part ${p.index ?? i + 1}: ${p.projectId}${p.error ? ` not started: ${p.error}` : p.held ? ` left as it is: ${HELD_PART}` : p.done ? ' finished' : p.waiting ? ' (starts when its models arrive)' : p.queued ? ' queued' : ' dubbing'}`,
          ),
          `Project ids: ${JSON.stringify(res.parts.map((p) => p.projectId))}`,
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'get_outputs',
    {
      title: 'A finished dub, for posting it',
      description:
        'A project\'s finished files (video with size and sha256, subtitles, a thumbnail JPG for the post: a frame with no subtitle on it), its length, the source it was downloaded from (title, uploader, link: for the caption and its credit line) and where it has been posted (mark_published).',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      type O = {
        name: string;
        status: string;
        finished: boolean;
        durationMs?: number;
        targetLanguage: string;
        files: { kind: string; path: string; sizeBytes: number; sha256?: string }[];
        source?: { title: string; partTitle?: string; page: number; partCount: number; ownerName?: string; url: string };
        part?: { index: number; count: number; seriesName: string; title?: string; summary?: string };
        published: { url: string; at: string; part?: number }[];
      };
      const o = await api.get<O>(`/projects/${encodeURIComponent(projectId)}/outputs`, { signal: ctx.mcpReq.signal, timeoutMs: 120_000 });
      const lines = [
        `"${o.name}" (${projectId}): ${o.finished ? 'finished' : `not finished (${o.status})`}${o.durationMs ? `, ${clock(o.durationMs)}` : ''}, dubbed into ${o.targetLanguage}`,
        ...(o.files.length > 0
          ? o.files.map((f) => `- ${f.kind}: ${f.path} (${(f.sizeBytes / 1024 ** 2).toFixed(1)} MB${f.sha256 ? `, sha256 ${f.sha256}` : ''})`)
          : ['- no files yet']),
        o.source
          ? `Source: "${o.source.title}"${o.source.partCount > 1 ? ` part ${o.source.page}/${o.source.partCount}${o.source.partTitle ? ` "${o.source.partTitle}"` : ''}` : ''}${o.source.ownerName ? ` by ${o.source.ownerName}` : ''}, ${o.source.url}`
          : 'Source: a local file (no download).',
        ...(o.part ? [`Part ${o.part.index} of ${o.part.count} of "${o.part.seriesName}"${o.part.title ? `: ${o.part.title}` : ''}${o.part.summary ? ` — ${o.part.summary}` : ''}`] : []),
        o.published.length > 0 ? `Posted: ${o.published.map((p) => `${p.url} (${p.at}${p.part ? `, part ${p.part}` : ''})`).join('; ')}` : 'Not posted yet.',
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'mark_published',
    {
      title: 'Record where a dub was posted',
      description: 'After posting a finished dub, record the post\'s address: get_outputs and the app then show it, so a rerun never posts it twice.',
      inputSchema: z.object({ projectId: z.string(), url: z.url(), part: z.number().int().min(1).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, url, part }, ctx) => {
      const res = await api.post<{ published: { url: string }[] }>(
        `/projects/${encodeURIComponent(projectId)}/published`,
        { url, ...(part ? { part } : {}) },
        { signal: ctx.mcpReq.signal },
      );
      return text(`Recorded. ${projectId} has been posted ${res.published.length} time(s).`);
    }),
  );

  server.registerTool(
    'delete_project',
    {
      title: 'Delete a project',
      description:
        'Delete a project and its working files (and its finished video when it is saved in the project\'s own folder; files saved to a chosen folder stay). Refused while it dubs or waits in the queue. Ask the user first.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      await api.delete(`/projects/${encodeURIComponent(projectId)}`, { signal: ctx.mcpReq.signal });
      return text(`Deleted ${projectId}.`);
    }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'Projects',
      description: 'Every dubbing project, most recently changed first.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      const projects = await api.get<ProjectListItem[]>('/projects', { signal: ctx.mcpReq.signal });
      if (projects.length === 0) return text('No projects yet.');
      return text(
        projects
          .map((p) => {
            const dur = p.mediaInfo?.durationMs ? clock(p.mediaInfo.durationMs) : '?';
            // Its lines to look at (H7): get_project names them.
            const issues =
              `${p.issues?.flagged ? `, ${p.issues.flagged} line(s) flagged` : ''}` +
              `${p.issues?.overruns ? `, ${p.issues.overruns} voice(s) running over` : ''}`;
            return `- ${p.id} "${p.name}" ${p.status}, ${dur}, ${p.settings.sourceLanguage || 'auto'} -> ${p.settings.targetLanguage}, updated ${p.updatedAt}${issues}`;
          })
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Project and dubbing progress',
      description:
        'A project\'s settings, each pipeline step\'s status, errors with how to fix them, recent log lines and output files, the jobs working on it outside the dub (speaker detection, re-transcription of a long range, and the like) with their progress, and its lines to look at: every line still failing the translation checks (with the checks) and every voice running into the next line by more than 0.3 s. With waitSeconds > 0 it waits (up to 50 s) for the dub to move on before answering — call it repeatedly to follow a dub.',
      inputSchema: z.object({
        projectId: z.string(),
        waitSeconds: z.number().min(0).max(50).default(0),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, waitSeconds }, ctx) => {
      const signal = ctx.mcpReq.signal;
      let { project, pipeline, etaSec } = await getProject(projectId, signal);
      const signature = (p: PipelineState) =>
        `${p.status}|${p.currentStep}|${p.awaitingReview}|${p.steps.map((s) => `${s.status}${Math.floor(s.progressPercent / 10)}`).join(',')}`;
      const startSig = signature(pipeline);
      const deadline = Date.now() + waitSeconds * 1000;
      while (pipeline.status === 'running' && Date.now() < deadline && !signal.aborted) {
        await sleep(pollMs, signal);
        ({ project, pipeline, etaSec } = await getProject(projectId, signal));
        void progress(ctx, pipeline.progressPercent, 100, `${pipeline.currentStep ?? ''} ${Math.round(pipeline.progressPercent)}%`);
        if (signature(pipeline) !== startSig) break;
      }
      const lines = [
        `"${project.name}" (${project.id}) — ${project.status}`,
        `Video: ${project.inputVideoPath}${project.mediaInfo?.durationMs ? ` (${clock(project.mediaInfo.durationMs)})` : ''}`,
        ...audioDriftLines(project.mediaInfo),
        `Saves to: ${projectOutputVideoPath(project)} (and subtitle files beside it)`,
        `Settings: ${settingsSummary(project.settings)}`,
        renderPipeline(pipeline, etaSec),
      ];
      // Work on the project outside its dub (an app of before 0.18 has no such route: nothing to list).
      const jobs = await api.get<{ jobs: ProjectJobLite[] }>(`/projects/${encodeURIComponent(projectId)}/jobs`, { signal }).catch(() => undefined);
      if (jobs?.jobs.length) lines.push('Jobs outside the dub:', ...renderProjectJobs(jobs.jobs));
      // Its lines to look at after the dub, all of them (H7; an app of before 0.20 has no such route).
      const issues = await api.get<ProjectLineIssues>(`/projects/${encodeURIComponent(projectId)}/issues`, { signal }).catch(() => undefined);
      if (issues) lines.push(...renderLineIssues(issues));
      if (pipeline.status === 'running' || pipeline.status === 'failed') {
        const tail = await logTail(project, 8);
        if (tail.length > 0) lines.push('Recent log:', ...tail.map((l) => `  ${l}`));
      }
      const outputs = await listOutputs(project);
      if (outputs.length > 0) lines.push('Output files:', ...outputs.map((o) => `  ${o}`));
      return text(lines.join('\n'));
    }),
  );

  /**
   * This project's finished files. Only its own: a folder the user chose may be
   * shared with other projects (and their videos are none of this one's).
   */
  async function listOutputs(project: Project): Promise<string[]> {
    const present = await Promise.all(
      projectOutputFiles(project).map((f) => stat(f).then((s) => (s.size > 0 ? f : undefined), () => undefined)),
    );
    return present.filter((f): f is string => f !== undefined);
  }

  server.registerTool(
    'create_project',
    {
      title: 'Create a dubbing project',
      description:
        'Create a project from a local video file (use download_video first for a link). Engines default to the best ones installed for this hardware and the user\'s saved preferences; override any of them in settings. With presetId the user\'s preset is the starting point instead (its languages, engines, voices, subtitles, save folder, and for a long enough video its series of parts); anything given here is laid over it. Also starts downloading any language model the project needs. Set start=true to begin dubbing right away. For the best translation set settings.reviewBeforeSynthesis=true and rewrite the draft translation before voicing.',
      inputSchema: z.object({
        videoPath: z.string().describe('Absolute path of the video file on this computer.'),
        presetId: z
          .string()
          .optional()
          .describe(
            'A preset from list_presets: one of the user\'s, or a built-in one (builtin:quality, builtin:balanced, builtin:economy; engines on this computer only, and they need targetLanguage and sourceLanguage). A video longer than a preset\'s series block allows becomes a series of parts with the preset\'s choices, unless series is given (then series is laid over them).',
          ),
        targetLanguage: z.string().optional().describe('Dub language, e.g. "vi-VN" (required without a preset).'),
        sourceLanguage: z
          .string()
          .optional()
          .describe('Spoken language, e.g. "zh" (Bilibili and Douyin videos are usually "zh"). Needed: the app does not detect it, and refuses a project without one.'),
        name: z.string().optional(),
        saveTo: z
          .string()
          .optional()
          .describe(
            'Absolute folder for the finished video and subtitles, e.g. "D:\\Dubs", or "D:\\Dubs\\{series}" for a folder named after the project. They are named after the project ("<name>.<lang>.mp4"), so projects can share a folder. Omit to keep them in the project\'s own folder in the app\'s data (or the preset\'s folder).',
          ),
        settings: editableSettings.optional(),
        series: z
          .object({
            minMinutes: z.number().min(5).max(120).optional().describe('Default 15 (or the preset\'s).'),
            maxMinutes: z.number().min(5).max(180).optional().describe('Default 20 (or the preset\'s).'),
            ai: z
              .string()
              .optional()
              .describe('anthropic | openai | gemini | llama-cpp-chat (or the full ids anthropic-translate, openai-translate, gemini-translate); default the preset\'s, else the built-in Gemma chat model on this computer. A cloud AI is used only when named here (or in the preset).'),
            recapSec: z.number().min(0).max(8).optional().describe('Default 4 (or the preset\'s).'),
            autoStart: z.boolean().optional().describe('Make and dub the parts without stopping for a review of the cuts. Default true (or the preset\'s).'),
            nameTemplate: z
              .string()
              .max(200)
              .optional()
              .describe(
                'How the parts (and their files in saveTo) are named: {series}, {n}, {nn} (two digits), {total}, {title}, e.g. "{series} - Tập {nn}: {title}". Needs {n} or {nn}. Default "<name> - Phần 01".',
              ),
            continues: z
              .string()
              .optional()
              .describe(
                'A later season: the id of the series this one continues (its parent project, or any of its parts). Its name, numbering (part 49 after 48 parts) and name template carry on, its settings are the starting point, and its voices go to the speakers here whose voice matches one of its speakers (once speakers are detected); the others get the voices for minor speakers.',
              ),
            partNumberOffset: z.number().int().min(1).optional().describe('Number the parts after this one (with continues: after its last part).'),
            totalParts: z.number().int().min(1).optional().describe('The total the title cards say ("Phần 49/60"); default: as many as there are.'),
          })
          .optional()
          .describe('Dub a long video as a series of parts (15-20 min by default). Needs an AI set up in Settings. start=true then transcribes the whole video once, plans the cuts and dubs the parts in order; follow with get_series.'),
        start: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ videoPath, presetId, targetLanguage, sourceLanguage, name, saveTo, settings, series, start }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const noLanguage = missingLanguage(targetLanguage ?? settings?.targetLanguage, presetId);
      if (noLanguage) return { content: [{ type: 'text', text: noLanguage }], isError: true };
      // A wrong preset id fails here, before anything is made.
      const preset = presetId
        ? await findPreset(api, presetId, signal, {
            sourceLanguage: settings?.sourceLanguage ?? sourceLanguage ?? '',
            targetLanguage: settings?.targetLanguage ?? targetLanguage ?? '',
          })
        : undefined;
      // A later season starts from the series it continues: its engines, voices, subtitles and look.
      const continued = series?.continues ? (await getProject(series.continues, signal)).project : undefined;
      const fromContinued = continued ? continuedSeriesSettings(continued.settings) : {};
      const spoken = settings?.sourceLanguage ?? sourceLanguage ?? fromContinued.sourceLanguage ?? '';
      const dubInto = settings?.targetLanguage ?? targetLanguage;
      // From a preset, the app lays these over it (POST /projects); else they go over its defaults here.
      const own: Partial<ProjectSettings> = {
        ...fromContinued,
        // The app fills what a partial logo or greeting leaves out (branding/sanitize.ts).
        ...((settings ?? {}) as Partial<ProjectSettings>),
        ...(spoken ? { sourceLanguage: spoken } : {}),
        ...(dubInto ? { targetLanguage: dubInto } : {}),
      };
      const defaults = preset
        ? undefined
        : await api.get<{ settings: ProjectSettings; notes?: string[] }>(
            `/project-defaults?${new URLSearchParams({ targetLanguage: dubInto ?? '', sourceLanguage: spoken })}`,
            { signal },
          );
      const merged = defaults ? ({ ...defaults.settings, ...own, sourceLanguage: spoken } as ProjectSettings) : undefined;
      // A series: the AI named here or in the preset, else the built-in Gemma chat model (the app decides).
      let seriesBody: Record<string, unknown> | undefined;
      if (series) {
        // No AI named: the app plans with the built-in Gemma chat model, or
        // says to choose one (a cloud AI only when named).
        seriesBody = {
          ...seriesRequest(series, { preset: Boolean(preset) }),
          ...(continued ? { continues: continued.id } : {}),
          ...(series.partNumberOffset ? { partNumberOffset: series.partNumberOffset } : {}),
          ...(series.totalParts ? { totalParts: series.totalParts } : {}),
        };
      }
      // The video is linked into the project, not copied, when it is on the
      // projects' drive (a hard link; copied across drives), and the app gets
      // up to 30 minutes when it must copy. The 60 s default failed an 18 GB
      // file while the app went on and made the project 6.5 minutes later
      // (claude-dubber report, 2026-11-23).
      const projectName = name ?? path.parse(videoPath).name;
      let project: Project;
      try {
        project = await whileCreating(ctx, `Creating "${projectName}" (copying the video when it cannot be linked)`, () =>
          api.post<Project>(
            '/projects',
            {
              name: projectName,
              inputVideoPath: videoPath,
              ...(preset ? { presetId: preset.id, settings: own } : { settings: merged }),
              ...(saveTo?.trim() ? { outputDir: saveTo.trim() } : {}),
              linkInputVideo: true,
              ...(seriesBody ? { series: seriesBody } : {}),
            },
            { signal, timeoutMs: CREATE_PROJECT_TIMEOUT_MS },
          ),
        );
      } catch (err) {
        if (!createRequestTimedOut(err) || signal.aborted) throw err;
        return createTimedOut(projectName, videoPath);
      }
      const id = encodeURIComponent(project.id);
      await api.post(`/projects/${id}/probe`, {}, { signal, timeoutMs: 120_000 });
      const ensured = await api.post<{ installing: boolean; enginePacks?: string[] }>(`/projects/${id}/ensure-resources`, {}, { signal });
      const lines = [
        `Created "${project.name}" (${project.id})${preset ? ` from the preset "${preset.name}"` : ''}.`,
        `Saves to: ${projectOutputVideoPath(project)}`,
        `Settings: ${settingsSummary(project.settings)}`,
        ...(defaults?.notes ?? []).map((n) => `Note: ${n}`),
      ];
      const downloading = [...(ensured.installing ? ['language models'] : []), ...(ensured.enginePacks ?? [])];
      if (downloading.length > 0) lines.push(`Downloading in the background: ${downloading.join(', ')}. start_dubbing waits for them.`);
      if (continued) lines.push(continuationNote(project, continued));
      lines.push(...seriesMadeNotes(project, series, preset));
      if (start) lines.push(await startRun(project.id, undefined, signal));
      else lines.push('Next: start_dubbing.');
      return text(lines.join('\n'));
    }),
  );

  /**
   * The series a create_project or join_videos made, if any: the one it asked
   * for, or the preset's for a long video (said, so the agent knows a preset
   * turned its single video into parts), or why a preset's series was not used.
   */
  function seriesMadeNotes(project: Project, asked: { autoStart?: boolean } | undefined, preset: DubPreset | undefined): string[] {
    if (project.series?.role === 'parent') {
      const s = project.series.settings;
      return [
        ...(asked ? [] : [`Made as a series of ${s.minMinutes}-${s.maxMinutes} min parts, as the preset asks for a video this long.`]),
        seriesGateNote(s.autoStart),
      ];
    }
    // Asked for, though the answer does not say how it starts: as asked, else the preset's, else the default.
    if (asked) return [seriesGateNote(asked.autoStart ?? preset?.series?.autoStart ?? SERIES_ARG_DEFAULTS.autoStart)];
    return preset?.series ? ["Dubbed whole: the video is not long enough for the preset's series of parts."] : [];
  }

  /**
   * What a series will do after its analysis (the review gate, Phase 4.1):
   * said where it is made, so an agent never assumes parts that never started.
   */
  function seriesGateNote(autoStart: boolean): string {
    return autoStart
      ? 'Series: autoStart=true. Its parts are made and dubbed by themselves only if the analysis is clean (speakers detected when asked for, no transcription loops left); otherwise it stops at review and get_series says why.'
      : 'Series: autoStart=false. It stops at review after its analysis: check the cuts with get_series, then start_series.';
  }

  async function startRun(projectId: string, fromStep: PipelineStepId | undefined, signal: AbortSignal): Promise<string> {
    const id = encodeURIComponent(projectId);
    const res = fromStep
      ? await api.post<{ started?: boolean; queued?: boolean; position?: number }>(`/projects/${id}/retry`, { stepId: fromStep }, { signal })
      : await api.post<{ started?: boolean; queued?: boolean; position?: number }>(`/projects/${id}/run`, {}, { signal });
    const parts = (
      res as {
        parts?: { projectId: string; index?: number; started?: boolean; queued?: boolean; done?: boolean; waiting?: boolean; held?: boolean; left?: string; error?: string }[];
      }
    ).parts;
    if (parts) {
      // A series parent continues as a whole: its parts, in order; a redo of
      // the mix or render runs in every part that made it.
      return [
        fromStep ? `Redoing "${fromStep}" in the parts that made it, in order:` : 'The series continues: its parts, in order.',
        ...parts.map(
          (p, i) =>
            `- part ${p.index ?? i + 1} (${p.projectId}): ${p.error ? `not started: ${p.error}` : p.left ? `left as it is: ${p.left}` : p.held ? `left as it is: ${HELD_PART}` : p.done ? 'finished' : p.waiting ? 'starts when its models arrive' : p.queued ? 'queued' : 'dubbing'}`,
        ),
        'Follow them with get_series or get_queue.',
      ].join('\n');
    }
    if (res.queued) return `Queued behind other dubs (position ${res.position ?? '?'}). Follow it with get_project(waitSeconds=50).`;
    return `Dubbing${fromStep ? ` from "${fromStep}"` : ''} started. Follow it with get_project(waitSeconds=50).`;
  }

  // ------------------------------------------------------------------ the run

  server.registerTool(
    'start_dubbing',
    {
      title: 'Start, continue or redo a dub',
      description:
        'Start the dub, continue it after a pause (pause_dubbing, a review pause, or the app having been closed), or redo it from a step (fromStep) after changing settings or the translation. Finished steps are reused. On a series, start_dubbing without fromStep continues its parts in order; with fromStep "alignment", "audio-mix" or "render" it redoes that step in every part that made it (after update_settings with applyToParts); an earlier step is redone part by part (refused on the series). If an engine or model is missing the app says what to install; whisper.cpp speech models start downloading by themselves.',
      inputSchema: z.object({
        projectId: z.string(),
        fromStep: z.enum(STEP_IDS).optional().describe('Redo from this step on; omit to start or continue.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, fromStep }, ctx) => text(await startRun(projectId, fromStep, ctx.mcpReq.signal))),
  );

  server.registerTool(
    'run_next',
    {
      title: 'Dub a waiting project next',
      description:
        'Move a project (or one part of a series) that waits in the queue to the front, so it starts as soon as a slot frees. It must be waiting: start_dubbing queues it. A part retried after a failure already takes its place in its series\' order.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const r = await api.post<{ position?: number }>(`/projects/${encodeURIComponent(projectId)}/run-next`, {}, { signal: ctx.mcpReq.signal });
      return text(`First in the queue now${r.position ? ` (position ${r.position})` : ''}: it starts as soon as a slot frees. get_queue says what it waits for.`);
    }),
  );

  server.registerTool(
    'pause_dubbing',
    {
      title: 'Pause a dub',
      description:
        'Pause a running dub. It stops at once and keeps everything done so far, including the part of the current step it saved (translated batches, speech-to-text chunks, voice clips); the user can then close the app or turn off the computer. start_dubbing continues it from there. A queued dub leaves the queue before it starts. A part of a series paused here stays paused when the series is started again (start_series, start_dubbing on the series), until start_dubbing on that part; pausing the series itself pauses every part, and they continue as a whole.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const res = await api.post<{ pausedParts?: string[]; was?: string }>(`/projects/${encodeURIComponent(projectId)}/pause`, {}, { signal });
      if (res?.pausedParts) {
        return text(
          res.pausedParts.length > 0
            ? `Paused the series: ${res.pausedParts.length} part(s) (${res.pausedParts.join(', ')}). Everything done is kept; start_dubbing on the series continues them in order.`
            : 'No part of this series was dubbing or waiting.',
        );
      }
      return text(await pausedReply(projectId, res?.was, 'Paused', signal));
    }),
  );

  server.registerTool(
    'cancel_dubbing',
    {
      title: 'Stop a dub',
      description:
        'Stop a running dub (the same as pause_dubbing: nothing done is thrown away) or take a queued one out of the queue. start_dubbing continues it. A part of a series stopped here stays stopped when the series is started again, until start_dubbing on that part.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const res = await api.post<{ was?: string }>(`/projects/${encodeURIComponent(projectId)}/cancel`, {}, { signal });
      return text(await pausedReply(projectId, res?.was, 'Stopped', signal));
    }),
  );

  /**
   * What a pause or stop of one project did, from the app's answer (`was`):
   * a queued dub used to read "Paused. Everything done so far is kept" when
   * it had only left the queue, and nothing said whether it would stay out.
   */
  async function pausedReply(projectId: string, was: string | undefined, verb: 'Paused' | 'Stopped', signal: AbortSignal): Promise<string> {
    const { project, pipeline } = await getProject(projectId, signal);
    const part = project.series?.role === 'part' ? ` As a part of a series it is ${HELD_PART}.` : '';
    if (was === 'queued') return `Taken out of the queue before it started.${part || ' start_dubbing queues it again.'}`;
    if (was === 'waiting') return `It was waiting for its models to download: it no longer starts by itself.${part || ' start_dubbing starts it.'}`;
    if (was === 'idle') return `It was not dubbing or waiting${pipeline.status === 'paused' ? ' (it is paused)' : ''}.${part}`;
    const where = pipeline.status === 'paused' && pipeline.pausedStep ? ` at "${pipeline.pausedStep}"` : '';
    return `${verb}${where}. Everything done so far is kept; start_dubbing continues from there.${part}`;
  }

  server.registerTool(
    'update_settings',
    {
      title: 'Change project settings',
      description:
        'Change engines, voice, language, subtitles or mix settings of a project that is not running. While a dub runs, only what changes its mix and render (blurRegions, watermarkAuto, burnSubtitleStyle, branding, subtitles, levels, render quality) can change, and only until it starts mixing (songSubtitles and syncSubtitlesToVoice only until it times the dub, when the subtitle files are written; a series still being analysed always takes them, for its parts). Returns the step to redo from so the change takes effect (pass it to start_dubbing as fromStep). On a series, applyToParts=true makes the same change on every part (speaker voices included) and reports each part: a part waiting in the queue takes a change to its mix or render (blurRegions, burnSubtitleStyle, branding, songSubtitles, subtitles, render quality, levels) where it waits; any other change skips it, and a part being dubbed is skipped, with the reason. Finished parts then need a redo: start_dubbing on the series with fromStep "audio-mix" or "render" redoes it in every part that made it.',
      inputSchema: z.object({ projectId: z.string(), settings: editableSettings, applyToParts: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, settings, applyToParts }, ctx) => {
      const changed = Object.keys(settings) as (keyof EditableSettings)[];
      if (changed.length === 0) return text('Nothing to change.');
      const res = await api.put<{ project: Project; parts?: { projectId: string; index: number; ok: boolean; queued?: boolean; unchanged?: boolean; skipped?: string; error?: string }[] }>(
        `/projects/${encodeURIComponent(projectId)}/settings${applyToParts ? '?applyToParts=true' : ''}`,
        settings,
        { signal: ctx.mcpReq.signal },
      );
      const steps = changed.map((k) => SETTING_STEP[k]).filter((s): s is PipelineStepId => s !== undefined);
      const earliest = STEP_IDS.find((s) => steps.includes(s));
      const partLines = (res.parts ?? []).map(
        (p) =>
          `- part ${p.index} (${p.projectId}): ${p.ok ? (p.unchanged ? 'already so, nothing changed' : p.queued ? 'changed where it waits in the queue' : 'changed') : p.skipped ? `skipped, ${p.skipped}` : `failed: ${p.error ?? '?'}`}`,
      );
      return text(
        `Saved. Now: ${settingsSummary(res.project.settings)}\n` +
          (partLines.length > 0 ? `${partLines.join('\n')}\n` : applyToParts ? 'No parts to change (not a series, or its parts are not made yet).\n' : '') +
          (earliest
            ? partLines.length > 0
              ? `To apply, redo each changed part from "${earliest}" (start_dubbing projectId=<part> fromStep="${earliest}").`
              : `To apply, call start_dubbing with fromStep="${earliest}".`
            : 'This takes effect on the next run.'),
      );
    }),
  );

  server.registerTool(
    'set_save_folder',
    {
      title: 'Choose where a project is saved',
      description:
        "Choose the folder a project saves its finished video and subtitle files in (a full path), or leave folder out to go back to the project's own folder in the app's data. Files already rendered move along. In a chosen folder the files are named after the project (\"<name>.<lang>.mp4\"), so projects can share a folder. Not while the project is running.",
      inputSchema: z.object({
        projectId: z.string(),
        folder: z
          .string()
          .optional()
          .describe('Full folder path, e.g. "D:\\Dubs" or "/Users/me/Movies/Dubs". Leave out for the default folder.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, folder }, ctx) => {
      const project = await api.put<Project>(
        `/projects/${encodeURIComponent(projectId)}/output-dir`,
        { outputDir: folder?.trim() || null },
        { signal: ctx.mcpReq.signal },
      );
      return text(`Saves to: ${projectOutputVideoPath(project)} (and subtitle files beside it).`);
    }),
  );

  // ------------------------------------------------------ transcript & review

  server.registerTool(
    'get_transcript',
    {
      title: 'Transcript and translation',
      description:
        'The lines of a project: id, time slot, spoken-length budget for the dub language ("≤13 syllables (aim 11)", at the voice\'s measured pace, counting up to a second of the pause after the line), the original text and (=>) the translation with its length in [brackets], and how the dub fits ("fit 1.20x ok", "timing-conflict"). "NEEDS FIX" marks lines the app\'s checks rejected (foreign script, pinyin, "a/b" alternatives, no diacritics). filter="attention" lists only lines that need work: untranslated, flagged, over budget, out of time, or with out-of-date voices. "SONG" marks a line kept as the original song (no voice; mark_song), "SONG?" one the app suggests is sung (never applied by itself); filter="songs" lists both. Pages through long videos with offset/limit.',
      inputSchema: z.object({
        projectId: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(400).default(150),
        filter: z.enum(['all', 'attention', 'songs']).default('all'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, offset, limit, filter }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [{ project }, doc, songsDoc] = await Promise.all([
        getProject(projectId, signal),
        getTimeline(projectId, signal),
        // The app's song suggestions (an older app has none to give).
        api
          .get<{ suggestions?: { lineId: string; reasons: string[] }[] }>(`/projects/${encodeURIComponent(projectId)}/songs`, { signal })
          .catch(() => undefined),
      ]);
      const target = project.settings.targetLanguage;
      const all = doc.segments;
      if (all.length === 0) return text('No transcript yet: the speech-to-text step has not run. start_dubbing first.');
      const suggested = new Map((songsDoc?.suggestions ?? []).map((s) => [s.lineId, s.reasons]));
      // Budget each line like the pipeline does: the voice's pace, plus up to a
      // second of the pause before the next line.
      const ctxOf = (i: number) => ({
        ...(doc.speechRate ? { perSecond: doc.speechRate.perSecond } : {}),
        ...(all[i + 1] ? { nextStartMs: all[i + 1]!.startMs } : {}),
      });
      const flagsOf = new Map(all.map((s, i) => [s.id, lineFlags(s, target, ctxOf(i))]));
      const indexOf = new Map(all.map((s, i) => [s.id, i]));
      const needsWork = (s: (typeof all)[number]): boolean => {
        // A song line has no voice: only its subtitle can need a translation.
        if (s.song) return project.settings.songSubtitles === true && !s.translatedText?.trim();
        const f = flagsOf.get(s.id)!;
        return !s.translatedText?.trim() || f.quality.length > 0 || f.overBudget || f.conflict || f.review || f.stale || s.loopSuspect === true;
      };
      const pool =
        filter === 'attention' ? all.filter(needsWork) : filter === 'songs' ? all.filter((s) => s.song === true || suggested.has(s.id)) : all;
      const page = pool.slice(offset, offset + limit);
      const counts = {
        lines: all.length,
        translated: all.filter((s) => s.translatedText?.trim()).length,
        flagged: all.filter((s) => flagsOf.get(s.id)!.quality.length > 0).length,
        overBudget: all.filter((s) => flagsOf.get(s.id)!.overBudget).length,
        conflicts: all.filter((s) => s.alignment?.status === 'timing-conflict').length,
        stale: all.filter((s) => s.ttsStale).length,
      };
      const pace = doc.speechRate
        ? ` Budgets use the voice's ${doc.speechRate.source === 'measured' ? 'measured' : 'typical'} pace of ${doc.speechRate.perSecond.toFixed(1)}/s.`
        : '';
      const songs = all.filter((s) => s.song === true).length;
      const songNote =
        songs || suggested.size
          ? ` ${songs} kept as the original song (no voice; subtitles ${project.settings.songSubtitles ? 'on' : 'off'}), ${suggested.size} suggested as sung (SONG?: listen, then mark_song).`
          : '';
      const header = [
        `"${project.name}": ${project.settings.sourceLanguage || 'auto'} -> ${target}. ${counts.lines} lines, ${counts.translated} translated, ${counts.flagged} flagged by the checks, ${counts.overBudget} over budget, ${counts.conflicts} timing conflicts, ${counts.stale} with out-of-date voices.${songNote}${pace}`,
        `Showing ${filter === 'attention' ? 'lines needing attention ' : filter === 'songs' ? 'song lines and suggested songs ' : ''}${offset + 1}-${offset + page.length} of ${pool.length}.`,
      ];
      const next = offset + page.length < pool.length ? `More: call again with offset=${offset + page.length}.` : '';
      return text(
        [...header, ...page.map((s) => renderLine(s, target, ctxOf(indexOf.get(s.id)!), suggested.get(s.id))), next].filter(Boolean).join('\n'),
      );
    }),
  );

  // ------------------------------------------------------------------ speakers

  type SpeakerRow = {
    speakerId: string;
    minutes: number;
    lines: number;
    f0Hz?: number;
    gender?: 'male' | 'female' | 'unknown';
    genderConfidence?: number;
    samples: { id: string; text: string }[];
    voiceId?: string;
  };
  type SpeakersDoc = {
    speakers: SpeakerRow[];
    detected?: { at?: string; model?: string };
    job?: SpeakerJobLite;
    defaults?: { male?: string; female?: string };
  };

  server.registerTool(
    'get_speakers',
    {
      title: 'Who speaks in a project',
      description:
        'The detected speakers of a project, most-heard first: minutes and lines, median pitch, gender (male/female/unknown) with how sure it is, a few sample lines, and the voice each one has. Also whether a detect_speakers job is running. Use it to cast voices (cast_voices) and to map speaker ids to characters in the character sheet.',
      inputSchema: z.object({ projectId: z.string(), limit: z.number().int().min(1).max(200).default(40) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, limit }, ctx) => {
      const doc = await api.get<SpeakersDoc>(`/projects/${encodeURIComponent(projectId)}/speakers`, { signal: ctx.mcpReq.signal });
      const said = doc.job ? speakerJobSentence(doc.job) : undefined;
      const lines = [
        ...(said ? [said] : []),
        doc.speakers.length === 0
          ? 'No speakers detected: the lines have no speaker ids. detect_speakers finds them (settings.diarize does it during speech-to-text).'
          : `${doc.speakers.length} speaker(s)${doc.detected?.at ? `, detected ${doc.detected.at}` : ''}:`,
        ...doc.speakers.slice(0, limit).map(
          (s) =>
            `- ${s.speakerId}: ${s.minutes.toFixed(1)} min, ${s.lines} line(s)` +
            `${s.f0Hz ? `, ${Math.round(s.f0Hz)} Hz` : ''}${s.gender ? `, ${s.gender}${s.genderConfidence !== undefined ? ` (${Math.round(s.genderConfidence * 100)}%)` : ''}` : ''}` +
            `, voice ${s.voiceId ?? '(project voice)'}` +
            `${s.samples.length ? ` | e.g. ${s.samples.map((x) => `${x.id} "${x.text}"`).join('; ')}` : ''}`,
        ),
        ...(doc.speakers.length > limit ? [`(${doc.speakers.length - limit} more: raise limit)`] : []),
        ...(doc.defaults?.male || doc.defaults?.female
          ? [`Default voices for speakers without one: male ${doc.defaults.male ?? '-'}, female ${doc.defaults.female ?? '-'}.`]
          : []),
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'detect_speakers',
    {
      title: 'Detect who speaks again',
      description:
        'Run speaker detection again over the project\'s existing transcript and give every line its speaker: never speech-to-text again, never re-timing. Starts a job and returns at once (it can take long on hours of audio): follow it with get_project (its jobs) or get_speakers; a job the app was closed during is shown as interrupted, and calling this again continues from the parts already done. Voices chosen per line are kept; voices chosen per speaker follow their speakers to the new ids (matched by voice print). With fromMs and toMs, only the lines in that range are labelled again (after retranscribe_range left lines without a speaker): linked to the speakers the project already has, by voice print, so their ids and voices stay; a voice never heard before gets a new id. It reuses the saved detection when the audio has not changed (a moment), else detects only the 10-minute parts over the range. Not while the project is being dubbed.',
      inputSchema: z.object({
        projectId: z.string(),
        numSpeakers: z.number().int().min(2).max(50).optional().describe('When you know exactly how many people speak.'),
        fromMs: z.number().min(0).optional().describe('With toMs: detect only this range (ms of the video), linked to the existing speakers.'),
        toMs: z.number().min(1).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, numSpeakers, fromMs, toMs }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const id = encodeURIComponent(projectId);
      const ranged = fromMs !== undefined || toMs !== undefined;
      await api.post(`/projects/${id}/speakers/detect`, { ...(numSpeakers ? { numSpeakers } : {}), ...(ranged ? { fromMs, toMs } : {}) }, { signal });
      if (ranged) {
        // From the saved detection a range takes a moment: answer with its result when it is that quick.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !signal.aborted) {
          await sleep(pollMs, signal);
          const job = (await api.get<{ job?: SpeakerJobLite }>(`/projects/${id}/speakers`, { signal })).job;
          if (job && job.state !== 'running') {
            const said = speakerJobSentence(job);
            return job.state === 'done'
              ? text(`${said ?? 'Speakers detected.'} Check the lines with get_transcript; cast_voices gives a new speaker a voice.`)
              : failure(new Error(said ?? 'Speaker detection did not finish.'));
          }
        }
      }
      return text('Speaker detection started. Follow it with get_speakers or get_project; when it is done, cast_voices (and set_translation_context cast[].speakerId) use the new speakers. If the project was translated, redo it from "translation": the speakers decide the forms of address.');
    }),
  );

  server.registerTool(
    'cast_voices',
    {
      title: 'Choose a voice for each speaker',
      description:
        'Propose (and with apply=true, save) a voice for every detected speaker by gender: the user\'s own cloned voices first, then built-in ones, to the speakers heard most in the lines that will be voiced (lines kept as the original song count for nothing, and a speaker who only sings gets no voice). It casts CHARACTERS: the speaker ids the character sheet gives one name (one cast entry per id, set_translation_context) are ranked by their talk time together and get one voice. The user\'s lead voices (Voices → Lead voices, up to 3 per gender, in order) go first of all to the most-heard characters; a narrator or a system voice (its role or name in the sheet says so) takes neither a lead voice nor a clone. Within a gender the voices go by pitch rank (higher speaker, higher voice), by voice print only when that is clearly better than chance. The speakers past the distinct voices (minor speakers) share a POOL of voices per gender: 3-6 by how many there are (minorVoices sets it, saved with apply), built-in voices no main speaker has, then the voices of the least-heard cast speakers, never a clone unless the user picks one (minorPool); speakers who answer each other get different pool voices where possible. Built-in voices that sound like one of the user\'s clones are left out of shared use and named. Speakers of unknown gender are listed with their three longest lines and talk time: they keep the project voice until someone sets them (swaps). A cloned voice whose gender the user has not confirmed is left out of the proposal, which then says so first; apply=true is refused while any is left out, unless allowWithoutClones=true (the user agreed to a cast without them). Ask the user to confirm them in Voices → My voices instead when you can: their rule is their clones first. Show the user the pairing and let them swap before applying. applyToParts=true saves it on every part of a series.',
      inputSchema: z.object({
        projectId: z.string(),
        apply: z.boolean().default(false),
        applyToParts: z.boolean().default(false),
        allowWithoutClones: z
          .boolean()
          .default(false)
          .describe('Apply even though some cloned voices are left out (gender not confirmed): only when the user said so.'),
        swaps: z
          .array(z.object({ speakerId: z.string(), voiceId: z.string() }))
          .optional()
          .describe(
            'Changes to the proposal (from the user), applied before saving. A swapped voice is that speaker\'s alone: the rest of the cast is proposed without it. Any id of a character changes the whole character.',
          ),
        minorVoices: z
          .number()
          .int()
          .min(0)
          .max(12)
          .optional()
          .describe('How many voices the minor speakers of each gender share (1-12); 0 = automatic (3-6). Saved as the project\'s setting with apply.'),
        minorPool: z
          .object({ male: z.array(z.string()).optional(), female: z.array(z.string()).optional() })
          .optional()
          .describe('The exact voices (ids) the minor speakers of a gender share, when the user picked them (their clones allowed).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, apply, applyToParts, allowWithoutClones, swaps, minorVoices, minorPool }, ctx) => {
      type PoolVoice = { voiceId: string; name: string; from: 'spare' | 'reused' | 'picked'; sharedWith?: string; speakers: string[] };
      type Cast = {
        refused?: boolean;
        message?: string;
        unconfirmed: { voiceId: string; name: string }[];
        assignments: { speakerId: string; voiceId: string; voiceName: string; by: string }[];
        defaults: { male?: string; female?: string };
        unassigned: string[];
        notes: string[];
        pools?: Partial<Record<'male' | 'female', { minorSpeakers: number; size: number; voices: PoolVoice[] }>>;
        soundalikes?: { voiceId: string; name: string; cloneName: string; similarity: number }[];
        unknown?: { speakerId: string; minutes: number; lines: number; samples: { id: string; text: string; startMs?: number }[] }[];
        applied?: boolean;
        parts?: { projectId: string; index: number; ok: boolean; skipped?: string; error?: string }[];
      };
      const res = await api.post<Cast>(
        `/projects/${encodeURIComponent(projectId)}/speakers/cast`,
        {
          apply,
          applyToParts,
          allowWithoutClones,
          ...(swaps?.length ? { swaps } : {}),
          ...(minorVoices !== undefined ? { minorVoices: minorVoices === 0 ? null : minorVoices } : {}),
          ...(minorPool ? { minorPool } : {}),
        },
        { signal: ctx.mcpReq.signal },
      );
      // What was left out comes first: the user's rule is their clones first,
      // and a proposal without them must not read like the intended cast.
      const leftOut = res.unconfirmed.length
        ? [
            `${res.unconfirmed.length} of the user's cloned voices were left out because their gender isn't confirmed: ${res.unconfirmed.map((v) => `"${v.name}" (${v.voiceId})`).join(', ')}. ` +
              'Ask the user to confirm them in Voices → My voices and propose again, or apply without them only if the user agrees (allowWithoutClones=true).',
          ]
        : [];
      if (res.refused) {
        return text([...leftOut, `Not saved: ${res.message ?? 'cloned voices would be left out.'}`].join('\n'));
      }
      // The minor speakers by pool voice (one line per voice, not per speaker:
      // the series had 59 of them), then who is left to the project voice.
      const pooled = new Set((['male', 'female'] as const).flatMap((g) => res.pools?.[g]?.voices.flatMap((v) => v.speakers) ?? []));
      const pools = (['male', 'female'] as const).flatMap((g) => {
        const pool = res.pools?.[g];
        if (!pool) return [];
        return [
          `Minor ${g} speakers: ${pool.minorSpeakers} share ${pool.voices.length} voice(s) (speakers who answer each other get different ones):`,
          ...pool.voices.map(
            (v) =>
              `  - ${v.name} (${v.voiceId}, ${v.from === 'spare' ? 'a built-in no main speaker has' : v.from === 'picked' ? 'picked' : `also ${v.sharedWith}'s voice`}): ${v.speakers.length} speaker(s): ${v.speakers.join(', ')}`,
          ),
        ];
      });
      const unknownRows = res.unknown?.length
        ? [
            `Gender unknown (they keep the project voice: set them with swaps, or in the editor):`,
            ...res.unknown.map(
              (u) =>
                `- ${u.speakerId}: ${u.minutes.toFixed(1)} min, ${u.lines} line(s); longest: ${u.samples
                  .map((s) => `${s.id}${s.startMs !== undefined ? ` ${clock(s.startMs)}` : ''} "${s.text}"`)
                  .join('; ')}`,
            ),
          ]
        : res.unassigned.length
          ? [`Project voice (gender unknown): ${res.unassigned.join(', ')}`]
          : [];
      // Notes the lines above already say are not repeated.
      const said = /minor speaker\(s\) share|^Built-in voice "|of unknown gender keep the project voice/;
      return text(
        [
          ...leftOut,
          `${res.applied ? 'Saved' : 'Proposed'} cast (${res.assignments.length} speaker(s)):`,
          ...res.assignments.filter((a) => !pooled.has(a.speakerId)).map((a) => `- ${a.speakerId} -> ${a.voiceName} (${a.voiceId}, ${a.by})`),
          ...pools,
          ...(res.defaults.male || res.defaults.female
            ? [`A speaker detected later: male -> ${res.defaults.male ?? '(project voice)'}, female -> ${res.defaults.female ?? '(project voice)'}.`]
            : []),
          ...(res.soundalikes ?? []).map(
            (s) => `Left out of shared use: built-in "${s.name}" (${s.voiceId}) sounds like the user's clone "${s.cloneName}" (${s.similarity.toFixed(2)}).`,
          ),
          ...unknownRows,
          ...res.notes.filter((n) => !said.test(n)).map((n) => `Note: ${n}`),
          ...(res.parts ?? []).map((p) => `- part ${p.index} (${p.projectId}): ${p.ok ? 'saved' : p.skipped ? `skipped, ${p.skipped}` : `failed: ${p.error ?? '?'}`}`),
          res.applied
            ? 'To hear it, redo from "tts" (start_dubbing fromStep="tts"), or regenerate_voices for an edited project.'
            : 'Show this to the user; apply with apply=true (swaps for any change they want).',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'export_transcript',
    {
      title: 'The whole transcript as a file',
      description:
        'Write every line (id, times, speaker, original, translation, flags) to a JSON or tab-separated file in the project\'s folder and return its path: for long videos, where get_transcript would take dozens of pages. Read the file with your own tools.',
      inputSchema: z.object({ projectId: z.string(), format: z.enum(['json', 'tsv']).default('json') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, format }, ctx) => {
      const res = await api.post<{ path: string; lines: number; format: string }>(
        `/projects/${encodeURIComponent(projectId)}/transcript/export`,
        { format },
        { signal: ctx.mcpReq.signal, timeoutMs: 120_000 },
      );
      return text(`Wrote ${res.lines} line(s) as ${res.format.toUpperCase()}: ${res.path}`);
    }),
  );

  server.registerTool(
    'replace_lines',
    {
      title: 'Replace the lines of a time range',
      description:
        'Change the line structure of a range before translation: remove a transcription loop, split or merge lines, add lines speech-to-text missed. Every line of the project inside [fromMs, toMs) is replaced by `lines` (times in ms of the video, each inside the range, no overlaps; speakerId like "SPEAKER_03" optional). Many ranges at once: `ranges` ([{fromMs, toMs, lines}]), or `file`, the absolute path of a JSON file holding them ({"ranges": [...]} or the list itself): one write and ONE history entry, undone as one. Lines are renumbered: the new ids are returned. Refused once the project is translated; in a series, fix the series (parent) and then rebuild_parts. Get the audio\'s own words for a range with retranscribe_range.',
      inputSchema: z.object({
        projectId: z.string(),
        fromMs: z.number().min(0).optional(),
        toMs: z.number().min(1).optional(),
        lines: z.array(z.object({ startMs: z.number().min(0), endMs: z.number().min(1), text: z.string(), speakerId: z.string().optional() })).max(500).optional(),
        ranges: z
          .array(
            z.object({
              fromMs: z.number().min(0),
              toMs: z.number().min(1),
              lines: z.array(z.object({ startMs: z.number().min(0), endMs: z.number().min(1), text: z.string(), speakerId: z.string().optional() })),
            }),
          )
          .max(2000)
          .optional()
          .describe('Many ranges in one call (instead of fromMs, toMs and lines).'),
        file: z.string().optional().describe('Absolute path of a JSON file with the ranges, for a large repair (instead of ranges).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, fromMs, toMs, lines, ranges, file }, ctx) => {
      if (ranges || file) {
        let list = ranges;
        if (file) {
          const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
          list = (Array.isArray(parsed) ? parsed : (parsed as { ranges?: unknown }).ranges) as typeof ranges;
          if (!Array.isArray(list)) return { content: [{ type: 'text', text: `${file} holds no ranges: write {"ranges": [{"fromMs", "toMs", "lines"}]} or the list itself.` }], isError: true };
        }
        const many = await api.post<{ replaced: number; made: number; ranges: { fromMs: number; toMs: number; replaced: number; lines: unknown[] }[] }>(
          `/projects/${encodeURIComponent(projectId)}/lines/replace-many`,
          { ranges: list },
          { signal: ctx.mcpReq.signal, timeoutMs: 120_000 },
        );
        return text(
          [
            `Replaced ${many.replaced} line(s) with ${many.made} in ${many.ranges.length} range(s), as one history entry (undo_edit undoes them together).`,
            ...many.ranges.slice(0, 20).map((r) => `- ${clock(r.fromMs)}-${clock(r.toMs)}: ${r.replaced} -> ${r.lines.length}`),
            ...(many.ranges.length > 20 ? [`…and ${many.ranges.length - 20} more.`] : []),
            'Line ids moved: read them again with get_transcript before using them.',
          ].join('\n'),
        );
      }
      if (fromMs === undefined || toMs === undefined || !lines) {
        return { content: [{ type: 'text', text: 'Give fromMs, toMs and lines (one range), or ranges / file (many).' }], isError: true };
      }
      const res = await api.post<{ replaced: number; lines: { id: string; startMs: number; endMs: number; text: string; speakerId?: string }[] }>(
        `/projects/${encodeURIComponent(projectId)}/lines/replace`,
        { fromMs, toMs, lines },
        { signal: ctx.mcpReq.signal },
      );
      return text(
        [
          `Replaced ${res.replaced} line(s) in ${clock(fromMs)}-${clock(toMs)} with ${res.lines.length}:`,
          ...res.lines.map((l) => `- ${l.id} ${clock(l.startMs)}-${clock(l.endMs)}${l.speakerId ? ` [${l.speakerId}]` : ''} ${l.text}`),
          'Ids after this range moved too: read them again with get_transcript before using them.',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'retranscribe_range',
    {
      title: 'Transcribe a time range again',
      description:
        'Run the project\'s own speech-to-text again on [fromMs, toMs), by default without the previous text as a prompt (noContext), which is what breaks a transcription loop, then the checks speech-to-text itself runs: credit lines removed, each loop decoded again without context to confirm it (a repeat heard again is kept as really said; one that could not be checked is marked LOOP?). The range grows to the whole lines across its edges. Returns the lines it heard, in video time; apply=true also replaces the range with them (as replace_lines; refused on a translated project, before anything is decoded): a new line keeps its speaker only where its words still match the old line under it, the others are left without one and counted (detect_speakers with fromMs/toMs gives them speakers). Up to 15 minutes it answers with the lines. A longer range is one job in 15-minute windows, each applied as soon as it is heard: this tool follows it for waitSeconds, then retranscribe_range with jobId (or get_project) follows it further. The app already does this by itself for the loops it finds; use it for ranges it marked LOOP? or that sound wrong.',
      inputSchema: z.object({
        projectId: z.string(),
        fromMs: z.number().min(0).optional().describe('Start of the range, ms of the video (needed unless jobId is given).'),
        toMs: z.number().min(1).optional().describe('End of the range, ms of the video (needed unless jobId is given).'),
        noContext: z.boolean().default(true),
        model: z.string().optional().describe('Another speech model of the same engine, e.g. "large-v3-turbo".'),
        apply: z.boolean().default(false),
        jobId: z.string().optional().describe('Follow a re-transcription job started earlier (the id from its first answer) instead of starting one.'),
        waitSeconds: z
          .number()
          .min(0)
          .max(600)
          .default(50)
          .describe('A range over 15 minutes is a job: how long to follow it before answering.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, fromMs, toMs, noContext, model, apply, jobId, waitSeconds }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const id = encodeURIComponent(projectId);
      const readJob = (jid: string) => api.get<RetranscribeJobLite>(`/projects/${id}/lines/retranscribe/${encodeURIComponent(jid)}`, { signal });
      let job: RetranscribeJobLite;
      if (jobId) {
        job = await readJob(jobId);
      } else {
        if (fromMs === undefined || toMs === undefined) return failure(new Error('Give fromMs and toMs (or the jobId of a re-transcription to follow).'));
        // Up to 15 minutes: one request with every check, as long as the decodes take.
        const res = await api.post<RetranscribeAnswer>(
          `/projects/${id}/lines/retranscribe`,
          { fromMs, toMs, noContext, ...(model ? { model } : {}), apply },
          { signal, timeoutMs: 900_000 },
        );
        if (!res.job) return text(renderRetranscribed(res, { fromMs, toMs, noContext }));
        job = res.job;
      }
      const deadline = Date.now() + waitSeconds * 1000;
      while (job.state === 'running' && Date.now() < deadline && !signal.aborted) {
        await sleep(pollMs, signal);
        job = await readJob(job.id);
        void progress(ctx, job.done, job.windows, `Re-transcribing: ${job.done}/${job.windows} windows`);
      }
      return text(renderRetranscribeJob(job));
    }),
  );

  server.registerTool(
    'set_translations',
    {
      title: 'Write translations',
      description:
        'Save translated text for lines (ids from get_transcript). Keep each line within its budget and its meaning; never merge or split lines. A line you change is locked, so automatic shortening never overwrites it, and its voice is marked out of date (regenerate_voices, or start_dubbing when paused for review). Before any translation exists, every line must be included in one call.',
      inputSchema: z.object({
        projectId: z.string(),
        lines: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, lines }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const doc = await getTimeline(projectId, signal);
      const known = new Map(doc.segments.map((s) => [s.id, s]));
      const unknown = lines.filter((l) => !known.has(l.id)).map((l) => l.id);
      const empty = lines.filter((l) => !l.text.trim()).map((l) => l.id);
      if (unknown.length > 0 || empty.length > 0) {
        return failure(
          new VideoDubberApiError(400, 'INVALID_EDIT', [
            unknown.length > 0 ? `Unknown line ids: ${unknown.slice(0, 20).join(', ')}.` : '',
            empty.length > 0 ? `Empty text for: ${empty.slice(0, 20).join(', ')}.` : '',
          ].filter(Boolean).join(' '), 'Use the ids from get_transcript, and give every line some text.'),
        );
      }
      if (!doc.translated) {
        const given = new Set(lines.map((l) => l.id));
        const missing = doc.segments.filter((s) => !given.has(s.id)).map((s) => s.id);
        if (missing.length > 0) {
          return failure(
            new VideoDubberApiError(
              400,
              'INVALID_EDIT',
              `This project has no translation yet, so all ${doc.segments.length} lines must be saved together (${missing.length} missing, e.g. ${missing.slice(0, 5).join(', ')}).`,
              'Send every line in one set_translations call, or let the app translate first (start_dubbing with reviewBeforeSynthesis=true), then rewrite lines.',
            ),
          );
        }
      }
      const changed = lines.filter((l) => (known.get(l.id)?.translatedText ?? '').trim() !== l.text.trim());
      await api.put(
        `/projects/${encodeURIComponent(projectId)}/segments`,
        { segments: lines.map((l) => ({ id: l.id, translatedText: l.text.trim() })) },
        { signal },
      );
      const { pipeline } = await getProject(projectId, signal);
      const after = pipeline.awaitingReview
        ? 'The dub is paused for review: start_dubbing continues and voices your text.'
        : doc.aligned
          ? 'Their voices are now out of date: regenerate_voices, then render_video.'
          : 'They will be voiced when the dub reaches the voice step.';
      return text(`Saved ${lines.length} lines (${changed.length} changed). ${after}`);
    }),
  );

  server.registerTool(
    'adjust_lines',
    {
      title: 'Adjust timing, voice or rate of lines',
      description:
        'Move or trim lines (startMs/endMs on the original timeline; lines never overlap or pass a neighbour), pick a voice (voiceId; null = the speaker/project voice), set who says it (speakerId "SPEAKER_00"…; null = nobody), set a speaking rate (0.5-2; null = natural), or lock/unlock a line against automatic rewriting. Voice/rate/timing changes, and a speaker change that changes the voice, need regenerate_voices.',
      inputSchema: z.object({
        projectId: z.string(),
        changes: z
          .array(
            z.object({
              id: z.string(),
              startMs: z.number().int().min(0).optional(),
              endMs: z.number().int().min(0).optional(),
              voiceId: z.string().nullable().optional(),
              speakerId: z
                .string()
                .regex(/^SPEAKER_\d{2,3}$/)
                .nullable()
                .optional(),
              speakingRate: z.number().min(0.5).max(2).nullable().optional(),
              locked: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, changes }, ctx) => {
      const doc = await api.patch<TimelineDocument>(
        `/projects/${encodeURIComponent(projectId)}/timeline`,
        { segments: changes },
        { signal: ctx.mcpReq.signal },
      );
      const stale = doc.segments.filter((s) => s.ttsStale).length;
      return text(`Updated ${changes.length} line(s).${stale > 0 ? ` ${stale} line(s) need regenerate_voices.` : ''}`);
    }),
  );

  server.registerTool(
    'regenerate_voices',
    {
      title: 'Re-voice lines',
      description:
        'Make new voice clips for lines whose text, voice, rate or timing changed (all out-of-date lines, or the given ids). Works ~45 s per call and reports how many remain; call again until none remain, then render_video.',
      inputSchema: z.object({ projectId: z.string(), ids: z.array(z.string()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, ids }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const deadline = Date.now() + workBudgetMs;
      const wanted = ids ? new Set(ids) : undefined;
      let done = 0;
      // Lines voiced on the slower CPU build because the GPU was busy or its
      // engine would not start: said in the result, never only in a log (B5).
      let onCpu = 0;
      let cpuWhy = '';
      const cpuNote = (): string =>
        onCpu > 0 ? `\n${onCpu} line(s) were voiced on the CPU build (slower; ${cpuWhy}). They sound the same; nothing needs reinstalling unless it says the engine could not start.` : '';
      for (;;) {
        const doc = await getTimeline(projectId, signal);
        if (!doc.aligned) {
          return text('This project has no voices yet: start_dubbing makes them for every line.');
        }
        // Re-read after every line: re-voicing one member of a merged clip
        // re-voices (and un-stales) all of its members, as the editor does.
        // Explicit ids are each done once, stale or not (the user asked).
        const pending = doc.segments.filter((s) => (wanted ? wanted.has(s.id) : s.ttsStale));
        const next = pending[0];
        if (!next) return text(`Re-voiced ${done} line(s). Nothing left out of date: render_video next.${cpuNote()}`);
        // Every call voices one line at least: a slow read of the timeline
        // must not use up the budget of a call that has done nothing yet.
        if ((done > 0 && Date.now() > deadline) || signal.aborted) {
          return text(`Re-voiced ${done} line(s); ${pending.length} still to do. Call regenerate_voices again to continue.${cpuNote()}`);
        }
        const res = await api.post<{ engineFallback?: { packId: string; reason: 'busy' | 'memory' | 'failed'; busyWith?: string } }>(
          `/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(next.id)}/tts`,
          {},
          // How many are left, this one included: the app's activity list shows the batch's progress.
          { signal, timeoutMs: 300_000, headers: { 'x-vd-batch-left': String(pending.length) } },
        );
        if (res?.engineFallback) {
          onCpu++;
          const f = res.engineFallback;
          cpuWhy =
            f.reason === 'busy'
              ? `the GPU was busy with ${f.busyWith ?? 'another job'}`
              : f.reason === 'memory'
                ? `${f.packId} did not have enough free graphics memory to start (nothing to reinstall: another program on the graphics card took the room)`
                : `${f.packId} could not start; reinstall it in Settings > Engines if this keeps happening`;
        }
        wanted?.delete(next.id);
        done++;
        void progress(ctx, done, done + pending.length - 1, `re-voiced ${next.id}`);
      }
    }),
  );

  server.registerTool(
    'get_translation_context',
    {
      title: 'Character sheet',
      description:
        'The project\'s translation context: synopsis, cast, glossary (names/terms that must stay the same everywhere) and the forms-of-address plan (Vietnamese xưng hô). The context-aware translators follow it.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const { context } = await api.get<{ context: TranslationDocContext | null }>(
        `/projects/${encodeURIComponent(projectId)}/translation-context`,
        { signal: ctx.mcpReq.signal },
      );
      return text(context ? JSON.stringify(context, null, 1) : 'No character sheet yet.');
    }),
  );

  server.registerTool(
    'get_translation_report',
    {
      title: 'What the translation passes did',
      description:
        "How the app's own passes treated the translation: whether the character sheet was built (and why not), " +
        'which lines failed the checks (repaired, or still flagged), what the review model changed or was refused, ' +
        'and which lines auto-fit shortened. Read it to find the lines worth your attention before set_translations.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const report = await api.get<TranslationReportDoc>(
        `/projects/${encodeURIComponent(projectId)}/translation-report`,
        { signal: ctx.mcpReq.signal },
      );
      return text(renderTranslationReport(report));
    }),
  );

  server.registerTool(
    'set_translation_context',
    {
      title: 'Write the character sheet',
      description:
        'Set the synopsis, cast, glossary, forms-of-address plan and/or source corrections. Given fields replace the old ones; omitted fields are kept. Map each detected speaker to its character with cast[].speakerId ("SPEAKER_03"): the speaker ids decide the forms of address in the translation. corrections fix what speech-to-text mishears before translating ({heard:"枪人", is:"羌人"}). Does not re-translate by itself: redo from the translation step (start_dubbing fromStep="translation"). On a series, applyToParts=true saves it on every part too.',
      inputSchema: z.object({
        projectId: z.string(),
        synopsis: z.string().optional(),
        cast: z
          .array(
            z.object({
              name: z.string(),
              role: z
                .string()
                .optional()
                .describe('Who they are. A narrator or a system voice says so ("narrator", "người dẫn truyện", "giọng hệ thống"): cast_voices gives it a built-in voice, never a lead voice or a clone.'),
              speakerId: z
                .string()
                .optional()
                .describe('The detected speaker this character is, e.g. "SPEAKER_03". A character speaker detection split into several ids takes one entry per id, with the same name: cast_voices gives it one voice.'),
            }),
          )
          .optional(),
        glossary: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
        pronounGuide: z.string().optional().describe('Who calls whom what, e.g. "Ngộ Không xưng ta, gọi Bát Giới là ngươi".'),
        corrections: z.array(z.object({ heard: z.string(), is: z.string() })).optional().describe('Source text fixes applied before translating: what was heard -> what is said.'),
        applyToParts: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, applyToParts, ...fields }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const url = `/projects/${encodeURIComponent(projectId)}/translation-context`;
      const { context } = await api.get<{ context: TranslationDocContext | null }>(url, { signal });
      const next: TranslationDocContext = { ...(context ?? {}) };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
      const res = await api.put<{ parts?: { projectId: string; index: number; ok: boolean; skipped?: string; error?: string }[] }>(
        `${url}${applyToParts ? '?applyToParts=true' : ''}`,
        { context: next },
        { signal },
      );
      if (res?.parts) {
        const changed = res.parts.filter((p) => p.ok);
        return text(
          [
            `Saved the character sheet on the series and ${changed.length} of ${res.parts.length} part(s).`,
            ...res.parts.filter((p) => !p.ok).map((p) => `- part ${p.index} (${p.projectId}): ${p.skipped ? `skipped, ${p.skipped}` : `failed: ${p.error ?? '?'}`}`),
            'Parts not translated yet use it when they translate. To apply it to a translated part, redo that part from "translation" (start_dubbing projectId=<part> fromStep="translation").',
          ].join('\n'),
        );
      }
      return text('Saved the character sheet.');
    }),
  );

  // ------------------------------------------------------------------- output

  server.registerTool(
    'render_video',
    {
      title: 'Mix and render the final video',
      description:
        'Re-mix the dub and render the final video (after edits). Lines with out-of-date voices must be re-voiced first (regenerate_voices). Optionally switch the subtitle mode. Rendering runs in the app; follow it with get_project(waitSeconds=50).',
      inputSchema: z.object({ projectId: z.string(), subtitleExportMode: subtitleMode.optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, subtitleExportMode }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const doc = await getTimeline(projectId, signal);
      if (!doc.aligned) return text('Nothing to render yet: start_dubbing makes the dub first.');
      const stale = doc.segments.filter((s) => s.ttsStale).length;
      if (stale > 0) {
        return failure(new VideoDubberApiError(409, 'INVALID_EDIT', `${stale} line(s) have out-of-date voices.`, 'Call regenerate_voices until none remain, then render_video.'));
      }
      if (subtitleExportMode) {
        await api.put(`/projects/${encodeURIComponent(projectId)}/settings`, { subtitleExportMode }, { signal });
      }
      return text(await startRun(projectId, 'audio-mix', signal));
    }),
  );

  server.registerTool(
    'open_output_folder',
    {
      title: 'Show the output folder',
      description: 'Open the folder with the project\'s rendered video and subtitles in the file manager, for the user.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const { project } = await getProject(projectId, ctx.mcpReq.signal);
      await api.post('/open', { path: project.outputDir }, { signal: ctx.mcpReq.signal });
      return text(`Opened ${project.outputDir}.`);
    }),
  );

  // ------------------------------------------------------------------ prompts

  server.registerPrompt(
    'dub_video',
    {
      title: 'Dub a video with the best quality',
      description: 'Take a video file or link to a finished dub, with Claude writing the translation.',
      argsSchema: z.object({
        video: z.string().describe('Path of a video on this computer, or a link to one.'),
        target_language: z.string().describe('Dub language, e.g. vi-VN.'),
        source_language: z.string().optional().describe('Spoken language, e.g. zh. Leave empty to auto-detect.'),
      }),
    },
    ({ video, target_language, source_language }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Dub this video into ${target_language} with VideoDubber, aiming for the best possible translation and subtitles: ${video}${source_language ? ` (spoken language: ${source_language})` : ''}.`,
              '',
              '1. get_status. If engines recommended for this hardware are missing (e.g. GPU speech-to-text or a natural voice), tell me what they are and their size, and ask before installing.',
              '2. If the video is a link, download_video it.',
              '3. create_project with settings.reviewBeforeSynthesis=true and start=true.',
              '4. Follow with get_project(waitSeconds=50) until it is PAUSED FOR REVIEW. If a step fails, explain the error and fix it.',
              '5. Read the WHOLE transcript with get_transcript (all pages) before translating anything. Fix obvious speech-recognition mistakes in your understanding of the source.',
              '6. set_translation_context: a synopsis, the cast, a glossary of names and recurring terms, and the forms of address between characters (for Vietnamese: xưng hô per speaker pair).',
              '7. Rewrite every line with set_translations (batches of ~100): faithful, natural and idiomatic as a professional dubbing script; names and pronouns consistent with the character sheet; each line at or under its budget; never merge or split lines.',
              '8. start_dubbing to continue, then follow with get_project(waitSeconds=50) until completed.',
              '9. get_transcript filter="attention": fix lines that are over budget or out of time (shorter wording first; timing via adjust_lines only if needed), then regenerate_voices and render_video.',
              '10. Tell me where the final video is and offer open_output_folder.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'improve_translation',
    {
      title: 'Review and improve a dub\'s translation',
      description: 'Have Claude read a finished or paused dub, fix the translation and re-render.',
      argsSchema: z.object({ project_id: z.string() }),
    },
    ({ project_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Review and improve the translation of VideoDubber project ${project_id}.`,
              '1. get_project, then read every page of get_transcript before changing anything.',
              "2. get_translation_report: what the app's own passes flagged, repaired, or were refused — start with those lines.",
              '3. Check get_translation_context; correct or complete it (names, terms, forms of address) with set_translation_context.',
              '4. Rewrite only the lines that are wrong, unnatural, inconsistent with the character sheet, or over budget, with set_translations. Keep good lines as they are.',
              '5. Re-voice the changed lines with regenerate_voices (call until none remain), then render_video, and follow with get_project(waitSeconds=50).',
              '6. Summarize what you changed and why.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  // ---- 0.18.0 tools (docs/plans/production-requests-2026-11-23.md). Each
  // area adds its tools at its own anchor below, so parallel work never edits
  // the same lines.

  // [tools: re-transcription and speaker detection]


  // [tools: casting and songs]
  // (cast_voices is with the speaker tools above.)
  server.registerTool(
    'mark_song',
    {
      title: 'Keep lines as the original song',
      description:
        'Keep sung lines as the original song (song=true, the default) or dub them again (song=false). A song line gets no voice; the original audio plays in its window (not lowered; with replace-vocals its singer comes back; with the original removed it plays there anyway); its subtitle shows only when the project\'s songSubtitles is on (update_settings, off by default). Per LINE, never a whole scene: calls and dialogue between the lyrics stay dubbed. Name the lines (lineIds from get_transcript) or a time range (fromMs/toMs: the lines at least half inside it). get_transcript filter="songs" lists the song lines and the app\'s suggestions (SONG?), which it never applies by itself: listen before keeping them. On a series (the project the parts were made from), applyToParts=true marks the same lines in every part, by time; a part being dubbed is skipped with the reason. Lines that shared a voice clip with a song line are marked out of date: regenerate_voices makes their new clips (or start_dubbing fromStep="alignment"), then render_video. Not while the project is dubbing.',
      inputSchema: z.object({
        projectId: z.string(),
        lineIds: z.array(z.string()).optional().describe('The lines, e.g. ["seg_0412", "seg_0413"].'),
        fromMs: z.number().min(0).optional().describe('Or a time range in ms of the video: from…'),
        toMs: z.number().min(1).optional().describe('…to.'),
        song: z.boolean().default(true).describe('true: keep the original song; false: dub the lines again.'),
        applyToParts: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, lineIds, fromMs, toMs, song, applyToParts }, ctx) => {
      if (!lineIds?.length && (fromMs === undefined || toMs === undefined)) {
        return { content: [{ type: 'text', text: 'Name the lines (lineIds) or a time range (fromMs and toMs).' }], isError: true };
      }
      type Span = { id: string; startMs: number; endMs: number };
      const res = await api.post<{
        song: boolean;
        targets: Span[];
        changed: Span[];
        revoice: string[];
        songs: number;
        parts?: { projectId: string; index: number; ok: boolean; skipped?: string; error?: string }[];
      }>(
        `/projects/${encodeURIComponent(projectId)}/songs`,
        { song, applyToParts, ...(lineIds?.length ? { lineIds } : { fromMs, toMs }) },
        // Every part of a long series is read and written: allow it the time.
        { signal: ctx.mcpReq.signal, ...(applyToParts ? { timeoutMs: 600_000 } : {}) },
      );
      const shown = res.changed.slice(0, 20).map((l) => `${l.id} ${clock(l.startMs)}-${clock(l.endMs)}`);
      const same = res.targets.length - res.changed.length;
      return text(
        [
          res.targets.length === 0
            ? 'No line is at least half inside that range.'
            : `${res.song ? 'Kept as the original song' : 'Dubbed again'}: ${res.changed.length} line(s)${shown.length ? ` (${shown.join(', ')}${res.changed.length > shown.length ? ', …' : ''})` : ''}${same > 0 ? `; ${same} already were` : ''}. The project has ${res.songs} song line(s) now.`,
          ...(res.revoice.length
            ? [`${res.revoice.length} line(s) need a new voice clip (they shared one with a song line, or sing no more): regenerate_voices, then render_video.`]
            : res.changed.length
              ? ['render_video makes the video with it (the mix is redone).']
              : []),
          ...(res.parts ?? []).map((p) => `- part ${p.index} (${p.projectId}): ${p.ok ? 'done' : p.skipped ? `skipped, ${p.skipped}` : `failed: ${p.error ?? '?'}`}`),
        ].join('\n'),
      );
    }),
  );


  // [tools: series, create, continue]

  /** create_project gives the app this long when it must copy the video (linking is instant). */
  const CREATE_PROJECT_TIMEOUT_MS = opts.createProjectTimeoutMs ?? 30 * 60_000;

  /** The request ran out of its time (AbortSignal.timeout), as opposed to the caller cancelling it. */
  function createRequestTimedOut(err: unknown): boolean {
    return (err as { name?: string } | undefined)?.name === 'TimeoutError';
  }

  /** An answer that refuses the call, without "Unexpected error" in front of it. */
  function seriesRefusal(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
  }

  /**
   * Keep a client that waits on a long request informed: progress every 15 s
   * (a client that resets its own timeout on progress keeps the call open).
   */
  async function whileCreating<T>(ctx: ServerContext, message: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const timer = setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      void progress(ctx, sec, undefined, `${message}: ${sec} s`);
    }, 15_000);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * create_project ran out of time: the app may still be copying the video and
   * make the project after all. Said so, with where it will appear, so the
   * agent looks for it instead of creating it again (a second 18 GB copy).
   */
  async function createTimedOut(projectName: string, videoPath: string): Promise<CallToolResult> {
    const folder = await api
      .get<{ projectsDir?: string }>('/storage/projects-folder', { timeoutMs: 10_000 })
      .then((f) => f.projectsDir, () => undefined);
    const requestId = requestContext.getStore()?.requestId;
    const waited = CREATE_PROJECT_TIMEOUT_MS >= 60_000 ? `${Math.round(CREATE_PROJECT_TIMEOUT_MS / 60_000)} minutes` : `${Math.ceil(CREATE_PROJECT_TIMEOUT_MS / 1000)} s`;
    return seriesRefusal(
      [
        `VideoDubber is still making "${projectName}" after ${waited}: it is probably still copying ${videoPath} (a video on another drive than the projects is copied, not linked).`,
        `The project may still appear. Do not create it again, which would copy the video a second time: look for it with list_projects in a few minutes${folder ? ` (its folder will be in ${folder})` : ''}.`,
        'get_diagnostics shows what the app is doing.',
        ...(requestId ? [`Log reference: ${requestId}.`] : []),
      ].join('\n'),
    );
  }

  /** What create_project says about a series that continues another. */
  function continuationNote(project: Project, continued: Project): string {
    const s = project.series?.role === 'parent' ? project.series.settings : undefined;
    return (
      `Continues "${s?.seriesName ?? continued.name}": its parts are numbered from ${(s?.partNumberOffset ?? 0) + 1}` +
      `${s?.nameTemplate ? ` and named "${s.nameTemplate}"` : ''}; its settings started from that series'. ` +
      'Its voices go to the speakers here whose voice matches one of its speakers, once speakers are detected (the get_series notes say which); the others get the voices for minor speakers (cast_voices).'
    );
  }

  server.registerTool(
    'edit_part',
    {
      title: 'Rename or retitle a part of a series',
      description:
        'After the parts are made: rename a part (its project, and its finished files when they are saved in a chosen folder), change its title (drawn on its title card) or its one-sentence summary (for the post), without redoing its dub. A part already rendered with the old title is set to render again, only the render: start_series (or start_dubbing on the part) does it. A part waiting in the queue keeps its place; a part being dubbed is refused. Before the parts are made, use set_split_plan.',
      inputSchema: z.object({
        projectId: z.string().describe("The part's project id, or the series' id together with `part`."),
        part: z.number().int().min(1).optional().describe('The part number as get_series shows it, when projectId is the series.'),
        name: z.string().max(200).optional(),
        title: z.string().max(120).optional().describe('An empty string removes the title.'),
        summary: z.string().max(600).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, part, name, title, summary }, ctx) => {
      const signal = ctx.mcpReq.signal;
      if (name === undefined && title === undefined && summary === undefined) return seriesRefusal('Give the part a new name, title or summary.');
      let id = projectId;
      if (part !== undefined) {
        const v = await api.get<SeriesViewLite>(`/projects/${encodeURIComponent(projectId)}/series`, { signal });
        const p = v.parts.find((x) => x.index === part);
        if (!p) return seriesRefusal(`"${v.name}" has no part ${part}: its parts are ${v.parts[0]?.index ?? 1}–${v.parts.at(-1)?.index ?? 0}.`);
        if (!p.projectId) return seriesRefusal(`The parts of "${v.name}" are not made yet: change their titles with set_split_plan.`);
        id = p.projectId;
      }
      const res = await api.patch<{ project: Project; renderAgain: boolean }>(
        `/projects/${encodeURIComponent(id)}/series-part`,
        { ...(name !== undefined ? { name } : {}), ...(title !== undefined ? { title } : {}), ...(summary !== undefined ? { summary } : {}) },
        { signal },
      );
      const info = res.project.series?.role === 'part' ? res.project.series : undefined;
      return text(
        [
          `Part ${info?.index ?? '?'} (${res.project.id}): "${res.project.name}"${info?.title ? `, titled "${info.title}"` : ', no title'}${info?.summary ? ` — ${info.summary}` : ''}.`,
          `Saves to: ${projectOutputVideoPath(res.project)}`,
          res.renderAgain
            ? 'Its video shows the old title, so it is set to render again (only the render): start_series, or start_dubbing on this part, does it.'
            : 'Nothing of its dub had to be redone.',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'replan_series',
    {
      title: 'Plan a series again',
      description:
        "Before the parts are made (review, or a failed plan): choose the cuts and name the parts again with the series' AI (after it failed, another AI was set up, or the transcript was fixed). keepTitles=true keeps the titles and summaries written in review (set_split_plan, the series page) on the new parts that cover the same stretch of video. It waits up to ~45 s for the new plan, then answers; follow a longer one with get_series. A series set to start by itself makes and starts its parts after the new plan when its analysis is clean.",
      inputSchema: z.object({
        projectId: z.string().describe('The series, or any of its parts.'),
        keepTitles: z.boolean().default(false),
        perFile: z
          .boolean()
          .optional()
          .describe('A series joined from several files: true plans one part per file (cut where each file begins), false plans parts by length again.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, keepTitles, perFile }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const url = `/projects/${encodeURIComponent(projectId)}/series`;
      const before = await api.get<SeriesViewLite>(url, { signal });
      await api.post(`${url}/replan`, { keepTitles, ...(perFile !== undefined ? { perFile } : {}) }, { signal });
      const started = Date.now();
      let now = before;
      let seenPlanning = false;
      // Done once a new plan is written, or this planning failed (not an older failure).
      const fresh = (): boolean => now.plan?.createdAt !== undefined && now.plan.createdAt !== before.plan?.createdAt;
      const failedNow = (): boolean =>
        now.state === 'failed' && (seenPlanning || before.state !== 'failed' || now.error?.message !== before.error?.message);
      while (Date.now() - started < workBudgetMs && !signal.aborted) {
        await sleep(pollMs, signal);
        now = await api.get<SeriesViewLite>(url, { signal });
        void progress(ctx, Math.round((Date.now() - started) / 1000), undefined, `Planning "${now.name}" (${now.state})`);
        if (now.state === 'planning') seenPlanning = true;
        else if (fresh() || failedNow()) break;
      }
      if (now.state === 'planning' || (!fresh() && !failedNow())) {
        return text(`"${now.name}" is being planned again (${now.state}). Follow it with get_series.`);
      }
      return text(describeSeries(now));
    }),
  );


  // [tools: join videos]
  // join_videos, get_join, retry_join (joinTools.ts): one project from several files.
  registerJoinTools(server, {
    api,
    guarded,
    findPreset: (id, signal, languages) => findPreset(api, id, signal, languages),
    seriesMadeNotes,
    settingsSchema: editableSettings,
    progress,
    sleep,
    settingsSummary,
    seriesGateNote,
    pollMs,
    workBudgetMs,
  });


  // [tools: picture options]
  registerPictureTools(server, { api, guarded, text, workBudgetMs });


  // [tools: activity and edit history]
  // Everything the app works on, whoever started it (GET /activity), the
  // agents' own outside work in the same list (report_activity), and each
  // project's edit history with undo (activity/ in the orchestrator).
  type Who = { kind: 'ui' | 'mcp' | 'scheduler' | 'unknown'; client?: string; session?: string };
  type Activity = {
    id: string;
    kind: string;
    title: string;
    projectId?: string;
    projectName?: string;
    initiator: Who;
    state: string;
    percent: number | null;
    message?: string;
    startedAt: string;
    updatedAt: string;
    endedAt?: string;
    etaSec?: number;
    result?: string;
    error?: { code: string; message: string };
    external?: boolean;
    logRef?: string;
  };
  type HistorySummary = {
    id: string;
    at: string;
    initiator: Who;
    summary: string;
    target: 'source' | 'translation';
    range?: { fromMs: number; toMs: number };
    beforeCount: number;
    afterCount: number;
    undoneAt?: string;
    undoOf?: string;
  };
  const whoText = (w: Who, external?: boolean): string => {
    const by = w.kind === 'ui' ? 'the user in the app' : w.kind === 'mcp' ? `${w.client ?? 'an agent'} (MCP)` : w.kind === 'scheduler' ? 'VideoDubber by itself' : 'unknown';
    return external ? `reported by ${by}` : `by ${by}`;
  };
  const ago = (iso: string): string => `${duration(Math.max(0, (Date.now() - Date.parse(iso)) / 1000))} ago`;

  server.registerTool(
    'get_activity',
    {
      title: 'What the app is working on',
      description:
        'Every long piece of work, newest first, whoever started it (the user, an agent, the app itself): dubs and renders with their step, speaker detection, re-transcription, re-voicing, downloads, installs, series planning, and work agents reported. Each with its progress, result or error and a log reference. active=true for what still runs or waits.',
      inputSchema: z.object({
        projectId: z.string().optional().describe('Only this project\'s (its older activity included).'),
        active: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, active, limit }, ctx) => {
      const q = new URLSearchParams({ limit: String(limit), ...(projectId ? { projectId } : {}), ...(active ? { active: '1' } : {}) });
      const { entries } = await api.get<{ entries: Activity[] }>(`/activity?${q}`, { signal: ctx.mcpReq.signal });
      if (entries.length === 0) return text(active ? 'Nothing is running or waiting.' : 'No activity recorded yet.');
      const lines = entries.map((e) => {
        const status =
          e.state === 'running' ? `running${e.percent !== null ? ` ${e.percent}%` : ''}${e.etaSec !== undefined ? `, about ${duration(e.etaSec)} left` : ''}` : e.state;
        const outcome = e.error ? `error: ${e.error.message}` : (e.result ?? e.message);
        return [
          `- ${e.id} [${status}] ${e.title}`,
          outcome ? ` — ${outcome}` : '',
          ` · ${whoText(e.initiator, e.external)}`,
          ` · started ${ago(e.startedAt)}${e.endedAt ? `, ended ${ago(e.endedAt)}` : ''}`,
          e.projectId ? ` · project ${e.projectId}${e.projectName ? ` "${e.projectName}"` : ''}` : '',
          e.logRef ? ` · log ${e.logRef}` : '',
        ].join('');
      });
      return text([`Activity (newest first, ${entries.length}):`, ...lines].join('\n'));
    }),
  );

  server.registerTool(
    'report_activity',
    {
      title: 'Report your own work in the app',
      description:
        'Show work you do outside the app (joining files, editing in another tool, a long analysis) in its activity list, beside its own work and marked as reported, so the user sees it. The first call (no id) creates the entry and returns its id; call again with that id to update it, and with state done/failed/cancelled when it ends.',
      inputSchema: z.object({
        id: z.string().optional().describe('The id the first report returned, to update it.'),
        projectId: z.string().optional().describe('The project it is for, if any.'),
        title: z.string().max(200).optional().describe('What the work is, in a few words (required on the first report).'),
        state: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled']),
        progress: z.number().min(0).max(100).optional().describe('Percent done, when you know it.'),
        detail: z.string().max(1000).optional().describe('The step it is on, or how it ended.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ id, projectId, title, state, progress, detail }, ctx) => {
      if (!id && !title) return { content: [{ type: 'text', text: 'Give a title on the first report (what the work is).' }], isError: true };
      const { entry } = await api.post<{ entry: Activity }>(
        '/activity/report',
        {
          ...(id ? { id } : {}),
          ...(projectId ? { projectId } : {}),
          ...(title ? { title } : {}),
          state,
          ...(progress !== undefined ? { percent: progress } : {}),
          ...(detail ? { detail } : {}),
        },
        { signal: ctx.mcpReq.signal },
      );
      return text(
        entry.endedAt
          ? `Reported "${entry.title}" as ${entry.state}. It stays in the app's activity list.`
          : `${id ? 'Updated' : 'Reported'} "${entry.title}" (${entry.state}${entry.percent !== null ? `, ${entry.percent}%` : ''}) as ${entry.id}: it shows in the app's activity list, marked as reported. Report again with id="${entry.id}" to update it, and with state "done" (or "failed") when it ends.`,
      );
    }),
  );

  server.registerTool(
    'get_history',
    {
      title: 'Edit history of a project',
      description:
        'Every change to a project\'s lines, newest first (the last 200): who made it (the user, which agent, the app), when, what (replace_lines, re-transcription, set_translations, adjust_lines, the editor), and whether it was undone. undo_edit undoes one.',
      inputSchema: z.object({ projectId: z.string(), limit: z.number().int().min(1).max(200).default(30) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, limit }, ctx) => {
      const { entries } = await api.get<{ entries: HistorySummary[] }>(
        `/projects/${encodeURIComponent(projectId)}/history?limit=${limit}`,
        { signal: ctx.mcpReq.signal },
      );
      if (entries.length === 0) return text('No change to this project\'s lines is recorded yet.');
      const lines = entries.map(
        (e) =>
          `- ${e.id} · ${e.at} (${ago(e.at)}) · ${whoText(e.initiator)} · ${e.target === 'source' ? 'transcript' : 'translation'}: ${e.summary}` +
          ` (${e.beforeCount} line(s) before, ${e.afterCount} after)` +
          (e.undoOf ? ` · undo of ${e.undoOf}` : '') +
          (e.undoneAt ? ` · UNDONE ${ago(e.undoneAt)}` : ''),
      );
      return text(
        [
          `History of ${projectId} (newest first):`,
          ...lines,
          'undo_edit undoes one when its lines have not changed since; undo the newest first.',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'undo_edit',
    {
      title: 'Undo a change to the lines',
      description:
        'Undo one entry of get_history: its lines get back their text, translation, timing, speaker, voice and pace as they were before it. Refused, with what changed, when those lines were changed again since (undo the later change first). The undo is itself an entry, so it can be undone too. Not while the project is dubbing.',
      inputSchema: z.object({ projectId: z.string(), entryId: z.string().describe('An id from get_history (edit_…).') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, entryId }, ctx) => {
      const res = await api.post<{ undone: HistorySummary; entry?: HistorySummary }>(
        `/projects/${encodeURIComponent(projectId)}/history/${encodeURIComponent(entryId)}/undo`,
        {},
        { signal: ctx.mcpReq.signal, timeoutMs: 120_000 },
      );
      return text(
        res.entry
          ? `Undone: ${res.undone.summary}. Recorded as ${res.entry.id} (undo_edit on it puts the change back). Lines whose text, voice or pace changed need regenerate_voices.`
          : `Undone: ${res.undone.summary}. The lines already read as before it, so nothing had to be written.`,
      );
    }),
  );


  return server;
}

/** The parts of the app's SystemProfile this server reads. */
interface SystemProfileLite {
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  appleSilicon: boolean;
  gpus: { name: string; vramMb?: number; driverVersion?: string }[];
}

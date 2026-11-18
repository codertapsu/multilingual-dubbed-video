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
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { projectOutputFiles, projectOutputVideoPath } from '@videodubber/shared';
import type {
  PipelineState,
  PipelineStepId,
  Project,
  ProjectSettings,
  TimelineDocument,
  TranslationDocContext,
} from '@videodubber/shared';
import { AppNotRunningError, VideoDubberApiError, type VideoDubberApi } from './api.js';
import { ensureAppRunning, type LaunchTarget } from './launcher.js';
import {
  clock,
  lineFlags,
  renderLine,
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

/** Which step to re-run from after a settings change, earliest wins. */
const SETTING_STEP: Partial<Record<keyof ProjectSettings, PipelineStepId>> = {
  sourceLanguage: 'stt',
  sttProviderId: 'stt',
  sttModel: 'stt',
  forcedAlignment: 'stt',
  diarize: 'stt',
  targetLanguage: 'translation',
  translationProviderId: 'translation',
  refineProviderId: 'refine',
  ttsProviderId: 'tts',
  ttsVoiceId: 'tts',
  synthesisGrouping: 'tts',
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
  syncSubtitlesToVoice: 'render',
  subtitleExportMode: 'render',
  renderQuality: 'render',
  burnSubtitleStyle: 'render',
};

const subtitleMode = z
  .enum(['burned-in', 'embedded-soft', 'srt-file', 'vtt-file', 'none'])
  .describe('burned-in = drawn onto the video; embedded-soft = a selectable track; srt-file / vtt-file = a separate file.');

/** The settings a project may change after creation (orchestrator EDITABLE_SETTING_KEYS). */
const editableSettings = z
  .object({
    sourceLanguage: z.string().describe('Spoken language of the video, e.g. "zh", "en", "ja". Empty string = auto-detect.'),
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
    originalAudioMode: z.enum(['keep', 'remove', 'replace-vocals']).describe('What happens to the original soundtrack.'),
    duckingLevelDb: z.number().describe('How much the original audio is lowered under the dub, in dB (e.g. -12).'),
    ttsGainDb: z.number().describe('Dub voice gain in dB.'),
    maxSpeedRatio: z.number().min(1).max(2).describe('Fastest the dub may be sped up to fit its slot (e.g. 1.6).'),
    allowedOverflowMs: z.number().min(0).describe('How far a line may run past its slot, in ms.'),
    autoFitOverflow: z.boolean().describe('Automatically shorten lines that still do not fit (LLM translators only).'),
    syncSubtitlesToVoice: z.boolean().describe('Time subtitles to when the dub voice speaks.'),
    renderQuality: z
      .enum(['auto', 'quality', 'fast'])
      .describe('auto (default) = the hardware encoder when it works here, else x264; quality = always x264 on the CPU (smallest files, slower); fast = same as auto.'),
    burnSubtitleStyle: z
      .object({
        position: z
          .enum(['bottom', 'raised', 'top'])
          .describe('Where burned-in subtitles sit: bottom (standard), raised (above a source\'s own hardsubs), top.'),
        coverOriginal: z
          .boolean()
          .describe('Hide the source\'s own burned-in subtitles under a solid band at the bottom of the picture.'),
      })
      .partial()
      .describe('Only for subtitleExportMode burned-in. Many Chinese videos have their own subtitles burned in at the bottom.'),
    diarize: z.boolean().describe('Detect speakers (needs the alignment engine).'),
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
        'Every line must be speakable in its own time slot: get_transcript shows each line\'s budget at the voice\'s pace (e.g. "≤13 syllables (aim 11)") and the current length in [brackets]. Aim for the target and never exceed the ceiling, but keep the full meaning: an over-short line is a worse dub than a slightly fast one. Never merge or split lines. Fix every line marked NEEDS FIX.',
        'Changing settings, engines or downloads is the user\'s machine: say what you are about to install (sizes are in list_engines) before doing it.',
        'A long dub can be paused (pause_dubbing) and continued later with start_dubbing, also after the app was closed: nothing done is lost. get_project says when a dub is paused.',
        'Voices: list_voices searches every engine\'s voices (and the user\'s cloned voices) with licences; install_voice downloads one. A cloned voice is made only by the user in the app (Voices screen), which records their consent: ask them to do it, never try to.',
      ].join('\n'),
    },
  );

  // ------------------------------------------------------------------ helpers

  const text = (body: string): CallToolResult => ({ content: [{ type: 'text', text: body }] });

  const failure = (err: unknown): CallToolResult => {
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
    return { content: [{ type: 'text', text: message }], isError: true };
  };

  /** Start the app if needed, run the tool, turn any failure into a readable error. */
  const guarded =
    <A>(fn: (args: A, ctx: ServerContext) => Promise<CallToolResult>) =>
    async (args: A, ctx: ServerContext): Promise<CallToolResult> => {
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
        return failure(err);
      }
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

  const getProject = (id: string, signal?: AbortSignal) =>
    api.get<{ project: Project; pipeline: PipelineState }>(`/projects/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) });

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
      const [health, system, workers, queue, engines, recs] = await Promise.all([
        api.get<{ version?: string; commit?: string; platform?: string }>('/health', { signal }),
        api.get<{ profile: SystemProfileLite }>('/system', { signal }).catch(() => undefined),
        api.get<unknown>('/workers/health', { signal }).catch(() => undefined),
        api.get<unknown>('/queue', { signal }).catch(() => undefined),
        api.get<{ installed: { id: string }[] }>('/engines', { signal }).catch(() => undefined),
        api
          .get<{ recommendations: { packId: string; reason: string }[] }>('/engines/recommended', { signal })
          .catch(() => undefined),
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
      ];
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
        return `- ${v.id}: ${v.name}${v.kind === 'profile' ? ' (cloned voice)' : ''}${v.recommended ? ' [recommended]' : ''} — ${provider.get(v.engine as never) ?? v.engine}; ${v.languages.slice(0, 4).join(', ')}${v.languages.length > 4 ? ` +${v.languages.length - 4}` : ''}${who ? `; ${who}` : ''}${speakers}; licence ${v.license.label} (${v.license.category}); ${state}`;
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

  server.registerTool(
    'download_video',
    {
      title: 'Download a video from a link',
      description:
        'Download a video to dub from a link (YouTube, Bilibili and other supported sites). Waits up to ~45 s; if it is still downloading, returns a jobId for get_download. Returns the local file path for create_project.',
      inputSchema: z.object({
        url: z.url(),
        part: z.number().int().min(1).optional().describe('Part/page number for multi-part videos (Bilibili "P2" = 2).'),
        maxHeight: z.number().int().optional().describe('Highest video height to fetch, e.g. 720 or 1080.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    'get_download',
    {
      title: 'Download status',
      description: 'Status of a download started by download_video. Waits up to waitSeconds for it to finish.',
      inputSchema: z.object({ jobId: z.string(), waitSeconds: z.number().min(0).max(50).default(30) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ jobId, waitSeconds }, ctx) => followDownload(jobId, ctx, Math.max(1000, waitSeconds * 1000))),
  );

  async function followDownload(jobId: string, ctx: ServerContext, budgetMs: number): Promise<CallToolResult> {
    type Ev = { type: string; jobId?: string; percent?: number; phase?: string; filePath?: string; title?: string; error?: { message?: string; remediation?: string } };
    let latest: Ev | undefined;
    const end = await api.followEvents<Ev>('/download/events', {
      timeoutMs: budgetMs,
      signal: ctx.mcpReq.signal,
      until: (e) => e.jobId === jobId && (e.type === 'done' || e.type === 'error'),
      onEvent: (e) => {
        if (e.jobId !== jobId) return;
        latest = e;
        if (e.type === 'progress') void progress(ctx, e.percent ?? 0, 100, `${e.phase ?? 'downloading'} ${Math.round(e.percent ?? 0)}%`);
      },
    });
    if (end?.type === 'done') return text(`Downloaded "${end.title ?? 'video'}" to:\n${end.filePath}\nUse this path as create_project's video.`);
    if (end?.type === 'error') {
      return { isError: true, content: [{ type: 'text', text: `Download failed: ${end.error?.message ?? 'unknown error'}${end.error?.remediation ? `\nHow to fix: ${end.error.remediation}` : ''}` }] };
    }
    const where = latest?.type === 'progress' ? ` (${latest.phase ?? 'downloading'} ${Math.round(latest.percent ?? 0)}%)` : '';
    return text(`Still downloading${where}. Call get_download with jobId "${jobId}" to keep waiting.`);
  }

  server.registerTool(
    'list_projects',
    {
      title: 'Projects',
      description: 'Every dubbing project, most recently changed first.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (_args, ctx) => {
      const projects = await api.get<Project[]>('/projects', { signal: ctx.mcpReq.signal });
      if (projects.length === 0) return text('No projects yet.');
      return text(
        projects
          .map((p) => {
            const dur = p.mediaInfo?.durationMs ? clock(p.mediaInfo.durationMs) : '?';
            return `- ${p.id} "${p.name}" ${p.status}, ${dur}, ${p.settings.sourceLanguage || 'auto'} -> ${p.settings.targetLanguage}, updated ${p.updatedAt}`;
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
        'A project\'s settings, each pipeline step\'s status, errors with how to fix them, recent log lines and output files. With waitSeconds > 0 it waits (up to 50 s) for the dub to move on before answering — call it repeatedly to follow a dub.',
      inputSchema: z.object({
        projectId: z.string(),
        waitSeconds: z.number().min(0).max(50).default(0),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, waitSeconds }, ctx) => {
      const signal = ctx.mcpReq.signal;
      let { project, pipeline } = await getProject(projectId, signal);
      const signature = (p: PipelineState) =>
        `${p.status}|${p.currentStep}|${p.awaitingReview}|${p.steps.map((s) => `${s.status}${Math.floor(s.progressPercent / 10)}`).join(',')}`;
      const startSig = signature(pipeline);
      const deadline = Date.now() + waitSeconds * 1000;
      while (pipeline.status === 'running' && Date.now() < deadline && !signal.aborted) {
        await sleep(pollMs, signal);
        ({ project, pipeline } = await getProject(projectId, signal));
        void progress(ctx, pipeline.progressPercent, 100, `${pipeline.currentStep ?? ''} ${Math.round(pipeline.progressPercent)}%`);
        if (signature(pipeline) !== startSig) break;
      }
      const lines = [
        `"${project.name}" (${project.id}) — ${project.status}`,
        `Video: ${project.inputVideoPath}${project.mediaInfo?.durationMs ? ` (${clock(project.mediaInfo.durationMs)})` : ''}`,
        `Saves to: ${projectOutputVideoPath(project)} (and subtitle files beside it)`,
        `Settings: ${settingsSummary(project.settings)}`,
        renderPipeline(pipeline),
      ];
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
        'Create a project from a local video file (use download_video first for a link). Engines default to the best ones installed for this hardware and the user\'s saved preferences; override any of them in settings. Also starts downloading any language model the project needs. Set start=true to begin dubbing right away. For the best translation set settings.reviewBeforeSynthesis=true and rewrite the draft translation before voicing.',
      inputSchema: z.object({
        videoPath: z.string().describe('Absolute path of the video file on this computer.'),
        targetLanguage: z.string().describe('Dub language, e.g. "vi-VN".'),
        sourceLanguage: z.string().optional().describe('Spoken language, e.g. "zh". Omit to auto-detect.'),
        name: z.string().optional(),
        saveTo: z
          .string()
          .optional()
          .describe(
            'Absolute folder for the finished video and subtitles, e.g. "D:\\Dubs". They are named after the project ("<name>.<lang>.mp4"), so projects can share a folder. Omit to keep them in the project\'s own folder in the app\'s data.',
          ),
        settings: editableSettings.optional(),
        start: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ videoPath, targetLanguage, sourceLanguage, name, saveTo, settings, start }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const q = new URLSearchParams({ targetLanguage, sourceLanguage: sourceLanguage ?? '' });
      const defaults = await api.get<{ settings: ProjectSettings; notes?: string[] }>(`/project-defaults?${q}`, { signal });
      const merged: ProjectSettings = {
        ...defaults.settings,
        ...(settings ?? {}),
        sourceLanguage: settings?.sourceLanguage ?? sourceLanguage ?? '',
        targetLanguage: settings?.targetLanguage ?? targetLanguage,
      };
      const project = await api.post<Project>(
        '/projects',
        {
          name: name ?? path.parse(videoPath).name,
          inputVideoPath: videoPath,
          settings: merged,
          ...(saveTo?.trim() ? { outputDir: saveTo.trim() } : {}),
        },
        { signal },
      );
      const id = encodeURIComponent(project.id);
      await api.post(`/projects/${id}/probe`, {}, { signal, timeoutMs: 120_000 });
      const ensured = await api.post<{ installing: boolean; enginePacks?: string[] }>(`/projects/${id}/ensure-resources`, {}, { signal });
      const lines = [
        `Created "${project.name}" (${project.id}).`,
        `Saves to: ${projectOutputVideoPath(project)}`,
        `Settings: ${settingsSummary(merged)}`,
        ...(defaults.notes ?? []).map((n) => `Note: ${n}`),
      ];
      const downloading = [...(ensured.installing ? ['language models'] : []), ...(ensured.enginePacks ?? [])];
      if (downloading.length > 0) lines.push(`Downloading in the background: ${downloading.join(', ')}. start_dubbing waits for them.`);
      if (start) lines.push(await startRun(project.id, undefined, signal));
      else lines.push('Next: start_dubbing.');
      return text(lines.join('\n'));
    }),
  );

  async function startRun(projectId: string, fromStep: PipelineStepId | undefined, signal: AbortSignal): Promise<string> {
    const id = encodeURIComponent(projectId);
    const res = fromStep
      ? await api.post<{ started?: boolean; queued?: boolean; position?: number }>(`/projects/${id}/retry`, { stepId: fromStep }, { signal })
      : await api.post<{ started?: boolean; queued?: boolean; position?: number }>(`/projects/${id}/run`, {}, { signal });
    if (res.queued) return `Queued behind other dubs (position ${res.position ?? '?'}). Follow it with get_project(waitSeconds=50).`;
    return `Dubbing${fromStep ? ` from "${fromStep}"` : ''} started. Follow it with get_project(waitSeconds=50).`;
  }

  // ------------------------------------------------------------------ the run

  server.registerTool(
    'start_dubbing',
    {
      title: 'Start, continue or redo a dub',
      description:
        'Start the dub, continue it after a pause (pause_dubbing, a review pause, or the app having been closed), or redo it from a step (fromStep) after changing settings or the translation. Finished steps are reused. If an engine or model is missing the app says what to install; whisper.cpp speech models start downloading by themselves.',
      inputSchema: z.object({
        projectId: z.string(),
        fromStep: z.enum(STEP_IDS).optional().describe('Redo from this step on; omit to start or continue.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ projectId, fromStep }, ctx) => text(await startRun(projectId, fromStep, ctx.mcpReq.signal))),
  );

  server.registerTool(
    'pause_dubbing',
    {
      title: 'Pause a dub',
      description:
        'Pause a running dub. It stops at once and keeps everything done so far, including the part of the current step it saved (translated batches, speech-to-text chunks, voice clips); the user can then close the app or turn off the computer. start_dubbing continues it from there. A queued dub just leaves the queue.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      const signal = ctx.mcpReq.signal;
      await api.post(`/projects/${encodeURIComponent(projectId)}/pause`, {}, { signal });
      const { pipeline } = await getProject(projectId, signal);
      const where = pipeline.status === 'paused' && pipeline.pausedStep ? ` at "${pipeline.pausedStep}"` : '';
      return text(`Paused${where}. Everything done so far is kept; start_dubbing continues from there.`);
    }),
  );

  server.registerTool(
    'cancel_dubbing',
    {
      title: 'Stop a dub',
      description:
        'Stop a running dub (the same as pause_dubbing: nothing done is thrown away) or take a queued one out of the queue. start_dubbing continues it.',
      inputSchema: z.object({ projectId: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId }, ctx) => {
      await api.post(`/projects/${encodeURIComponent(projectId)}/cancel`, {}, { signal: ctx.mcpReq.signal });
      return text('Stopped. start_dubbing continues from where it stopped.');
    }),
  );

  server.registerTool(
    'update_settings',
    {
      title: 'Change project settings',
      description:
        'Change engines, voice, language, subtitles or mix settings of a project that is not running. Returns the step to redo from so the change takes effect (pass it to start_dubbing as fromStep).',
      inputSchema: z.object({ projectId: z.string(), settings: editableSettings }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, settings }, ctx) => {
      const changed = Object.keys(settings) as (keyof EditableSettings)[];
      if (changed.length === 0) return text('Nothing to change.');
      const { project } = await api.put<{ project: Project }>(
        `/projects/${encodeURIComponent(projectId)}/settings`,
        settings,
        { signal: ctx.mcpReq.signal },
      );
      const steps = changed.map((k) => SETTING_STEP[k]).filter((s): s is PipelineStepId => s !== undefined);
      const earliest = STEP_IDS.find((s) => steps.includes(s));
      return text(
        `Saved. Now: ${settingsSummary(project.settings)}\n` +
          (earliest
            ? `To apply, call start_dubbing with fromStep="${earliest}".`
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
        'The lines of a project: id, time slot, spoken-length budget for the dub language ("≤13 syllables (aim 11)", at the voice\'s measured pace, counting up to a second of the pause after the line), the original text and (=>) the translation with its length in [brackets], and how the dub fits ("fit 1.20x ok", "timing-conflict"). "NEEDS FIX" marks lines the app\'s checks rejected (foreign script, pinyin, "a/b" alternatives, no diacritics). filter="attention" lists only lines that need work: untranslated, flagged, over budget, out of time, or with out-of-date voices. Pages through long videos with offset/limit.',
      inputSchema: z.object({
        projectId: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(400).default(150),
        filter: z.enum(['all', 'attention']).default('all'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, offset, limit, filter }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [{ project }, doc] = await Promise.all([getProject(projectId, signal), getTimeline(projectId, signal)]);
      const target = project.settings.targetLanguage;
      const all = doc.segments;
      if (all.length === 0) return text('No transcript yet: the speech-to-text step has not run. start_dubbing first.');
      // Budget each line like the pipeline does: the voice's pace, plus up to a
      // second of the pause before the next line.
      const ctxOf = (i: number) => ({
        ...(doc.speechRate ? { perSecond: doc.speechRate.perSecond } : {}),
        ...(all[i + 1] ? { nextStartMs: all[i + 1]!.startMs } : {}),
      });
      const flagsOf = new Map(all.map((s, i) => [s.id, lineFlags(s, target, ctxOf(i))]));
      const indexOf = new Map(all.map((s, i) => [s.id, i]));
      const needsWork = (s: (typeof all)[number]): boolean => {
        const f = flagsOf.get(s.id)!;
        return !s.translatedText?.trim() || f.quality.length > 0 || f.overBudget || f.conflict || f.review || f.stale;
      };
      const pool = filter === 'attention' ? all.filter(needsWork) : all;
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
      const header = [
        `"${project.name}": ${project.settings.sourceLanguage || 'auto'} -> ${target}. ${counts.lines} lines, ${counts.translated} translated, ${counts.flagged} flagged by the checks, ${counts.overBudget} over budget, ${counts.conflicts} timing conflicts, ${counts.stale} with out-of-date voices.${pace}`,
        `Showing ${filter === 'attention' ? 'lines needing attention ' : ''}${offset + 1}-${offset + page.length} of ${pool.length}.`,
      ];
      const next = offset + page.length < pool.length ? `More: call again with offset=${offset + page.length}.` : '';
      return text(
        [...header, ...page.map((s) => renderLine(s, target, ctxOf(indexOf.get(s.id)!))), next].filter(Boolean).join('\n'),
      );
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
        'Move or trim lines (startMs/endMs on the original timeline; lines never overlap or pass a neighbour), pick a voice (voiceId; null = project voice), set a speaking rate (0.5-2; null = natural), or lock/unlock a line against automatic rewriting. Voice/rate/timing changes need regenerate_voices.',
      inputSchema: z.object({
        projectId: z.string(),
        changes: z
          .array(
            z.object({
              id: z.string(),
              startMs: z.number().int().min(0).optional(),
              endMs: z.number().int().min(0).optional(),
              voiceId: z.string().nullable().optional(),
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
        if (!next) return text(`Re-voiced ${done} line(s). Nothing left out of date: render_video next.`);
        if (Date.now() > deadline || signal.aborted) {
          return text(`Re-voiced ${done} line(s); ${pending.length} still to do. Call regenerate_voices again to continue.`);
        }
        await api.post(`/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(next.id)}/tts`, {}, { signal, timeoutMs: 300_000 });
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
        'Set the synopsis, cast, glossary and/or forms-of-address plan. Given fields replace the old ones; omitted fields are kept. Does not re-translate by itself: redo from the translation step (start_dubbing fromStep="translation") to apply it to the app\'s own translator.',
      inputSchema: z.object({
        projectId: z.string(),
        synopsis: z.string().optional(),
        cast: z.array(z.object({ name: z.string(), role: z.string().optional() })).optional(),
        glossary: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
        pronounGuide: z.string().optional().describe('Who calls whom what, e.g. "Ngộ Không xưng ta, gọi Bát Giới là ngươi".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ projectId, ...fields }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const url = `/projects/${encodeURIComponent(projectId)}/translation-context`;
      const { context } = await api.get<{ context: TranslationDocContext | null }>(url, { signal });
      const next: TranslationDocContext = { ...(context ?? {}) };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
      await api.put(url, { context: next }, { signal });
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

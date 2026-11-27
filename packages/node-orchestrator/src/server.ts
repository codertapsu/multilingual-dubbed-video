/**
 * Fastify HTTP server exposing the full orchestrator API (port 5100).
 *
 * Every endpoint from the contract maps 1:1 to a Tauri command. SSE progress is
 * served directly at `GET /projects/:id/events` (the Tauri shell does NOT proxy
 * SSE — the webview connects here directly).
 *
 * `createServer()` is exported for tests/embedding; a main guard starts the
 * server when this file is run directly.
 */
import { initiatorFromHeaders, runAsScheduler, runWithInitiator } from './activity/context.js';
import { registerActivityRoutes } from './activity/activityRoutes.js';
import { DiagnosticsService } from './diagnostics/diagnosticsService.js';
import { StructuredLog } from './diagnostics/logFiles.js';
import { WarningInbox } from './diagnostics/warningInbox.js';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, parse as parsePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ALL_CLOUD_SERVICES,
  AppErrorException,
  COMMON_LANGUAGES,
  DEFAULT_SERIES_SETTINGS,
  defaultSeriesAiId,
  isBuiltinPresetId,
  pipelineStepIndex,
  resolveOutputDir,
  seriesAiId,
  toAppError,
  isVoiceProfileId,
  projectOutputFiles,
  VOICE_ENGINE_PROVIDER,
  voiceEngineOfId,
  type AlignedSegment,
  type TranscriptSegment,
  type VoiceEngineId,
  type VoiceLibraryItem,
  type ArgosPair,
  type CloudServiceId,
  type CreateProjectInput,
  type DownloadItem,
  type RunScheduleResult,
  type SeriesAiOption,
  type SeriesSettings,
  type DubDownloadResult,
  type DubDownloadsRequest,
  type DubPreset,
  type Project,
  type ReviseProjectInput,
  type ProjectsFolderRequest,
  type PipelineStepId,
  type ProjectSettings,
  type SaveCredentialRequest,
  type SegmentPatch,
  type SetupInstallRequest,
  type SubtitleExportMode,
  type SubtitleStyle,
  type TranslationDocContext,
  type UpdatePreferences,
  type BackendCrash,
  type BackendHealth,
  type DownloadPreferences,
} from '@videodubber/shared';
import { buildInfo } from './buildInfo.js';
import { HealthMonitor, installNativeCrashEvidence, takeRecoveredCrash } from './diagnostics/health.js';
import { RunActivity } from './diagnostics/runActivity.js';
import {
  downloadGate,
  effectiveDownloadPolicy,
  powerfulForParallel,
  type DownloadGate,
  type DownloadPolicy,
} from './providers/download/downloadGate.js';
import { recommendCapacity } from './system/capacity.js';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { CredentialsStore, normalizeMotherClaudeUrl } from './credentials/credentialsStore.js';
import { probeMotherClaude, testCloudCredential } from './credentials/testConnection.js';
import { buildSystemResponse, getSystemProfile } from './system/systemProfile.js';
import { EngineEventBus } from './engines/engineBus.js';
import { EngineInstaller } from './engines/engineInstaller.js';
import { EngineManager, isGpuPack } from './engines/engineManager.js';
import { systemVcDeps } from './engines/vcRuntime.js';
import { EnginePackStore } from './engines/enginePackStore.js';
import { availablePacks, findPack } from './engines/enginePackCatalog.js';
import {
  companionRuntimesFor,
  installedPacksForProvider,
  isPackUsable,
  pickInstalledLocalLlmChatModel,
  pickInstalledLocalLlmModel,
  resolveActivePackSelections,
} from './engines/packSelection.js';
import { packFitsMachine, packHardwareSupported, recommendEnginePacks } from './engines/engineRecommendation.js';
import { configureUvHome, resolveUvPath, uvObtainable } from './engines/uv.js';
import { AudioCppSeparationProvider, currentVocals } from './providers/separation/audioCppSeparationProvider.js';
import type { SeparationService } from './media.js';
import { WhisperxAlignmentProvider } from './providers/alignment/whisperxProvider.js';
import { SherpaDiarizationProvider } from './providers/diarization/sherpaDiarizationProvider.js';
import { RapidOcrProvider } from './providers/ocr/rapidOcrProvider.js';
import { GpuHolds, parseHoldRequest } from './scheduler/gpuHolds.js';
import { installedPackFiles } from './engines/installedFiles.js';
import { diarizationBudget, registerTranscriptJobRoutes } from './transcriptJobs.js';
import { EventBusRegistry } from './events.js';
import { checkWorkersHealth } from './health.js';
import { toHttpError } from './httpErrors.js';
import { decideRange } from './httpRange.js';
import { createFfmpegMediaService } from './mediaAdapter.js';
import { PictureDetectionService } from './picture/pictureDetection.js';
import { registerPictureRoutes } from './picture/pictureRoutes.js';
import { openPath } from './openPath.js';
import { describeStorage, clearStorage, dirSize } from './storage.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import type { ProviderRegistry } from './providers/registry.js';
import { createDefaultRegistry, OLLAMA_MODEL } from './providers/registry.js';
import {
  buildReadinessContext,
  checkProviderReadiness,
  describeProviderReadiness,
  downloadStartedReadiness,
  selfInstallingModelPack,
  type ProviderReadiness,
  type ReadinessDeps,
} from './providers/readiness.js';
import { getWorkerJson, postWorkerJson, probeWorkerHealth } from './providers/workerHttp.js';
import { OllamaPullManager, listOllamaModels } from './providers/ollamaModels.js';
import { computeRequiredResources, hasRequiredResources } from './setup/requiredResources.js';
import { recommendProjectSettings } from './projectDefaults.js';
import { sttWorkerSpeechMap } from './pipeline/speechMap.js';
import { performanceCoresFromSttWorker } from './system/performanceCores.js';
import {
  claudeIntegrationStatus,
  setClaudeCodeConnection,
  setClaudeDesktopConnection,
  type ClaudeCodeAction,
} from './integrations/claude.js';
import { samePath } from './workspace/outputFolder.js';
import { MEDIA_SERVICE_METHODS, type PipelineMediaService } from './media.js';
import { ProjectStore, writeJsonAtomic, writeTextAtomic } from './workspace/projectStore.js';
import { projectsDirOf, readProjectsRoot } from './workspace/projectsFolder.js';
import { ProjectsFolderService } from './workspace/projectsFolderService.js';
import { buildCatalog, findPiperVoice, translatableLanguages } from './setup/catalog.js';
import { listVoicesForLanguage } from './setup/voicesCatalog.js';
import { listNeuralVoicesForLanguage } from './setup/neuralVoicesCatalog.js';
import { listOmnivoiceForLanguage } from './setup/omnivoicesCatalog.js';
import { VoicePreviewCache } from './voices/previewCache.js';
import { registerProfileRoutes } from './voices/profileRoutes.js';
import { VoiceProfileService } from './voices/profileService.js';
import { PROFILE_FILES, VoiceProfileStore } from './voices/profileStore.js';
import {
  castCandidates,
  castChoices,
  castRows,
  castSettings,
  mostlySuggestedSongs,
  proposeCast,
  speakerList,
  speakerRows,
  unknownSpeakers,
  VoiceMeasureCache,
  withSwaps,
  type CastResult,
  type VoiceMeasure,
} from './voices/speakerCast.js';
import { dialogueAdjacency } from './voices/casting.js';
import { registerSongRoutes } from './songs/songRoutes.js';
import { openSuggestions, readSongSuggestions, songSuggestionsPath } from './songs/songSuggestions.js';
import { suggestGender } from './voices/casting.js';
import { libraryItems } from './voices/voiceLibrary.js';
import { readSpeakerProfiles } from './pipeline/diarization.js';
import { baseLanguage } from './providers/download/siteSubtitles.js';
import { ReferencePrep } from './voices/referencePrep.js';
import { VoiceFavorites } from './voices/voicePreferences.js';
import { allCatalogVoices, VOICE_ENGINES } from './voices/voiceCatalog.js';
import { registerVoiceRoutes, speakCacheKey } from './voices/voiceRoutes.js';
import { runPreflight } from './setup/preflight.js';
import { SetupEventBus } from './setup/setupBus.js';
import { SetupInstaller } from './setup/installer.js';
import { SetupStore } from './setup/setupStore.js';
import { detectInstalledModels } from './setup/detectInstalledModels.js';
import { downloadsDirFor, resolveVideo } from './providers/download/downloadService.js';
import { isStopped, JobFeed, type JobLine } from './jobFeed.js';
import { cleanPresetInput, PresetStore } from './workspace/presetStore.js';
import { builtinPresets, localProviderDefaults } from './workspace/builtinPresets.js';
import { BrandKit } from './branding/brandKit.js';
import { changesOnlyMixAndRender, partRedoAction, partSkipReason, seriesRedoRefusal, stableJson } from './series/partWork.js';
import { SeriesService } from './series/seriesService.js';
import { registerSeriesRoutes } from './series/seriesRoutes.js';
import type { SeriesChat } from './series/seriesAi.js';
import type { AnalysisChat } from './providers/translation/translationContext.js';
import { isTranslationRefiner } from './providers/types.js';
import { greetingSettingsKey, readGreetingPlan, dubWindows, originalSpeech } from './branding/greetingMix.js';
import { planGreetings, validatePlacements } from './branding/greetingPlanner.js';
import { createHash } from 'node:crypto';
import { createReadStream as openReadStream } from 'node:fs';
import { DownloadQueue } from './providers/download/queue.js';
import type { BrowserCookie } from './providers/download/types.js';
import {
  createProviders,
  describeProviders,
  loadProviderSessions,
  providerById,
  providerFor,
} from './providers/download/registry.js';

/** Ollama's OpenAI-compatible base URL (for the prerequisites probe). */
const OLLAMA_URL = process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434/v1';

/** Dependencies that can be overridden when embedding/testing the server. */
export interface CreateServerOptions {
  config?: OrchestratorConfig;
  /** The backend's health monitor (tests inject one; startServer makes the real one). */
  health?: HealthMonitor;
  /** The crash the shell restarted this backend after: interrupted dubs continue. */
  recoveredCrash?: BackendCrash;
  /** Injected media service (defaults to the lazily-loaded ffmpeg-backed one). */
  media?: PipelineMediaService;
  /** Injected provider registry (defaults to the local providers + cloud stubs). */
  registry?: ProviderRegistry;
  /** Injected project store (defaults to a config.projectsDir-backed store). */
  store?: ProjectStore;
  /** Injected event bus registry. */
  bus?: EventBusRegistry;
  /** Pre-built orchestrator (overrides the above for full control in tests). */
  orchestrator?: LocalJobOrchestrator;
  /** Injected first-run setup/preferences store (defaults to a configDir store). */
  setupStore?: SetupStore;
  /** Injected global setup event bus (defaults to a fresh one). */
  setupBus?: SetupEventBus;
  /** Injected first-run installer (defaults to one built from the above). */
  installer?: SetupInstaller;
  /** Injected cloud-credentials store (defaults to a configDir-backed one). */
  credentials?: CredentialsStore;
  /** Injected engine-pack install-state store. */
  enginePackStore?: EnginePackStore;
  /** Injected engine runtime lifecycle manager. */
  engineManager?: EngineManager;
  /** Injected engine-pack install event bus. */
  engineBus?: EngineEventBus;
  /** Injected engine-pack installer. */
  engineInstaller?: EngineInstaller;
  /** Injected vocal-separation service. */
  separation?: SeparationService;
}

/**
 * A media service proxy that lazily resolves the real ffmpeg-backed service on
 * first use. This lets the server boot even if the media-worker package is not
 * yet built; the failure surfaces only when a media operation is attempted.
 *
 * The forwarders are GENERATED from {@link MEDIA_SERVICE_METHODS} rather than
 * written out by hand. The hand-written version listed six methods and omitted
 * `clip16kMono`, which is exactly what the runner's chunking gate tests
 * (`typeof media.clip16kMono === 'function'`) — so chunked STT was dead in every
 * shipped build while the injected fixture media service (which does implement
 * it) kept every test green. Deriving the surface from the interface makes that
 * class of omission a type error instead of a silent capability loss.
 *
 * @param load Injectable loader for the real service (test seam).
 */
export function createLazyMediaService(
  load: () => Promise<PipelineMediaService> = createFfmpegMediaService,
): PipelineMediaService {
  let real: PipelineMediaService | undefined;
  let loading: Promise<PipelineMediaService> | undefined;

  const resolve = async (): Promise<PipelineMediaService> => {
    if (real) return real;
    loading ??= load();
    real = await loading;
    return real;
  };

  const proxy: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const name of MEDIA_SERVICE_METHODS) {
    proxy[name] = async (...args: never[]): Promise<unknown> => {
      const svc = await resolve();
      const fn = svc[name] as ((...a: never[]) => Promise<unknown>) | undefined;
      if (typeof fn !== 'function') {
        // Loud rather than silent: a media-worker that cannot do this operation
        // is a broken install, not a reason to quietly degrade the pipeline.
        throw new AppErrorException('UNKNOWN', `The media worker does not provide "${name}".`, {
          remediation: 'Rebuild the app (pnpm --filter @videodubber/media-worker build) or reinstall VideoDubber.',
          docsRef: 'docs/ARCHITECTURE.md#media-worker',
        });
      }
      return fn.apply(svc, args);
    };
  }
  return proxy as unknown as PipelineMediaService;
}

/** Send a structured error response derived from a thrown value. */
function sendError(reply: FastifyReply, err: unknown): void {
  const { status, error } = toHttpError(err);
  void reply.status(status).send({ error });
}

/** Best-effort content type for the static `/file` route, by extension. */
function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.srt':
      return 'application/x-subrip';
    case '.vtt':
      return 'text/vtt';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

/** Build (but do not start) the Fastify server with all routes wired. */
/** The "downloads while dubbing" choice as stored: one of the known values, else automatic. */
function sanitizeDownloadPrefs(raw: Partial<DownloadPreferences> | undefined): DownloadPreferences {
  const v = raw?.whileDubbing;
  return v === 'pause-heavy' || v === 'one-task' || v === 'no-limit' ? { whileDubbing: v } : { whileDubbing: 'auto' };
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  // Warnings raised outside a run (engine fallbacks), kept with the run's step.
  const warningInbox = new WarningInbox();
  /** Engine fallbacks of work outside runs (`editor:<id>`, `preview:<voice>`), newest last. */
  const laneFallbacks: { ownerId: string; at: number; packId: string; reason: 'busy' | 'failed'; busyWith?: string }[] = [];
  const fallbacksSince = (ownerId: string, since: number) => laneFallbacks.filter((f) => f.ownerId === ownerId && f.at >= since);
  const config = options.config ?? loadConfig();
  // The app's own logs (diagnostics/logFiles.ts): engines' output, and one
  // JSON record per line for what matters later (requests that failed or
  // changed something, runs, warnings, engine fallbacks).
  const logsDir = join(config.configDir, 'logs');
  const structured = new StructuredLog(logsDir);

  // The projects folder chosen in Settings wins over VIDEODUBBER_PROJECTS_DIR,
  // which the desktop shell always sets to the default (projectsFolder.ts).
  const chosenRoot = await readProjectsRoot(config.configDir);
  const store = options.store ?? new ProjectStore(chosenRoot ? projectsDirOf(chosenRoot) : config.projectsDir);
  const media = options.media ?? createLazyMediaService();
  const credentials = options.credentials ?? new CredentialsStore(config.configDir);

  // Engine-pack subsystem: install-state store, the runtime lifecycle manager,
  // the install event bus, and the installer. These power the optional
  // accelerated/heavy engines (whisper.cpp, llama.cpp, neural TTS, separation,
  // alignment) that download on demand.
  const enginePackStore = options.enginePackStore ?? new EnginePackStore(config.configDir);
  // Where a self-downloaded ("managed") uv lives when neither the bundled
  // sidecar nor a PATH uv exists — dev/source builds and corrupt installs.
  configureUvHome(config.configDir);
  // Windows only: every native engine pack needs the Microsoft Visual C++ runtime,
  // which a clean Windows does not have (vcRuntime.ts).
  const onWindows = process.platform === 'win32';
  const engineManager =
    options.engineManager ??
    new EngineManager({
      store: enginePackStore,
      logger: {
        info: (m) => console.log(`[engines] ${m}`),
        warn: (m) => console.warn(`[engines] ${m}`),
      },
      ...(onWindows ? { vcRuntimeState: () => systemVcDeps(() => undefined).detect() } : {}),
      cpuThreads: performanceCoresFromSttWorker(config.sttWorkerUrl),
      logsDir,
      // A run that fell back to the CPU build says so (a warning on its step).
      onFallback: (f) => {
        structured.write({
          level: f.reason === 'busy' ? 'info' : 'warn',
          msg: `engine fallback: ${f.packId} (${f.reason}${f.busyWith ? `, GPU held by ${f.busyWith}` : ''})`,
          ...(f.ownerId ? { projectId: f.ownerId } : {}),
          event: 'engine-fallback',
        });
        if (f.ownerId?.includes(':')) {
          // An editor action or a preview: its route reports it (a re-voice
          // over MCP once said nothing about running on the CPU, B5).
          laneFallbacks.push({ ...f, ownerId: f.ownerId, at: Date.now() });
          if (laneFallbacks.length > 50) laneFallbacks.shift();
          return;
        }
        if (!f.ownerId || f.ownerId === 'anonymous') return;
        warningInbox.push(f.ownerId, {
          code: 'gpu-fallback',
          message:
            f.reason === 'busy'
              ? `The GPU was busy (${f.busyWith ?? 'another job'}), so "${f.packId}" ran on the next installed runtime, usually the CPU build (slower).`
              : `"${f.packId}" could not start, so the next installed runtime was used (usually the CPU build). If it keeps happening, reinstall it in Settings → Engines.`,
          key: f.reason === 'busy' ? 'warning.gpu-fallback-busy' : 'warning.gpu-fallback-failed',
          params: { pack: f.packId },
        });
      },
    });
  const engineBus = options.engineBus ?? new EngineEventBus();
  const engineInstaller =
    options.engineInstaller ??
    new EngineInstaller({
      store: enginePackStore,
      bus: engineBus,
      ...(onWindows ? { vcRuntime: (progress: (message: string) => void) => systemVcDeps(progress) } : {}),
    });
  // Music & voice separation: HTDemucs through audio.cpp's command-line tool
  // (the vd_separator Python worker the old provider expected was never built).
  const separation: SeparationService =
    options.separation ??
    new AudioCppSeparationProvider({
      engines: engineManager,
      store: enginePackStore,
      media,
      threads: performanceCoresFromSttWorker(config.sttWorkerUrl),
      logger: { warn: (m) => console.warn(`[separation] ${m}`) },
    });
  const alignment = new WhisperxAlignmentProvider(engineManager, enginePackStore, config.workerRequestTimeoutMs);
  const diarization = new SherpaDiarizationProvider(engineManager, enginePackStore, config.workerRequestTimeoutMs);
  // The video's own burned-in subtitles read as text (the ocr-rapid pack).
  const ocr = new RapidOcrProvider(engineManager, enginePackStore);
  // Other apps' holds on the graphics card (Voice Mask's live sessions): in
  // memory only, each line of the log says who took or released the card.
  const holds = new GpuHolds({ log: (msg) => console.log(`[gpu-holds] ${msg}`) });

  // Hardware profile so the registry only offers providers whose packs can run
  // on this machine (e.g. whisper.cpp only where an NVIDIA/Metal pack exists).
  // Best-effort: on detection failure the registry falls back to OS/arch gating.
  const registryProfile = options.registry ? undefined : await getSystemProfile().catch(() => undefined);
  // First-run setup: config/state store (also the user's preferences, which the
  // registry reads for the chosen local models), the global setup SSE bus, and
  // the model installer that streams progress over it. Declared before the
  // readiness deps so the run gate can read the installed-model inventory.
  const setupStore = options.setupStore ?? new SetupStore(config.configDir);
  // Voice profiles (cloning). Built before the registry: the engines that can
  // clone resolve a profile id to their voice file through the service.
  const voiceProfileStore = new VoiceProfileStore(config.configDir, () => store.projectsDir);
  const referencePrep = new ReferencePrep({
    workRoot: join(config.configDir, 'voices', 'work'),
    media,
    speechMap: sttWorkerSpeechMap(config.sttWorkerUrl),
  });
  const voiceProfiles: VoiceProfileService = new VoiceProfileService({
    store: voiceProfileStore,
    prep: referencePrep,
    registry: (): ProviderRegistry => registry,
    projectExists: (id) => store.exists(id).catch(() => false),
    // Previews and enrollment hold the GPU lane only while they run.
    laneJob: (owner, fn) => orchestrator.runLaneJob(owner, fn),
  });
  const registry: ProviderRegistry =
    options.registry ??
    createDefaultRegistry(
      config,
      credentials,
      engineManager,
      enginePackStore,
      registryProfile,
      async () => (await setupStore.getPreferences()).localModels,
      voiceProfiles,
    );
  const bus = options.bus ?? new EventBusRegistry();

  const setupBus = options.setupBus ?? new SetupEventBus();
  // Source providers, plus any persisted credentials applied at boot so the
  // very first download already runs at the user's real quality ceiling.
  const downloadProviders = createProviders(config.configDir);
  void loadProviderSessions(downloadProviders);

  // The backend's own health (diagnostics/health.ts): memory and event-loop
  // delay every minute, kept for Settings → Diagnostics and get_diagnostics,
  // and the pressure the download gate reads.
  const runActivity = new RunActivity();
  const health =
    options.health ??
    new HealthMonitor({
      logger: {
        info: (m) => console.info(m),
        warn: (m) => {
          console.warn(m);
          structured.write({ level: 'warn', msg: m, event: 'health' });
        },
      },
      busy: () => runActivity.anyRunning(),
    });
  health.start();
  const lastWarningKey = new Map<string, string>();
  // Which step each dub is in (the download gate pauses downloads in heavy ones).
  bus.observe((projectId, event) => {
    runActivity.onEvent(projectId, event);
    if (event.type === 'step' && event.step.status !== 'running') {
      structured.write({
        level: event.step.status === 'failed' ? 'error' : 'info',
        msg: `step ${event.step.id} ${event.step.status}${event.step.error ? `: ${event.step.error}` : ''}`,
        projectId,
        event: 'step',
      });
    } else if (event.type === 'error') {
      structured.write({ level: 'error', msg: `run failed: ${event.error.code} ${event.error.message}`, projectId, event: 'run' });
    } else if (event.type === 'done') {
      structured.write({ level: 'info', msg: 'run completed', projectId, event: 'run' });
    } else if (event.type === 'state' && event.pipeline.warnings?.length) {
      const key = `${projectId}:${event.pipeline.warnings.map((w) => `${w.step}/${w.code}`).join(',')}`;
      if (key !== lastWarningKey.get(projectId)) {
        lastWarningKey.set(projectId, key);
        for (const w of event.pipeline.warnings) {
          structured.write({ level: 'warn', msg: w.message, projectId, step: w.step, code: w.code, event: 'warning' });
        }
      }
    }
    if (event.type === 'step' || event.type === 'done' || event.type === 'error') downloads.reconsider();
  });
  // Downloads while dubbing (providers/download/downloadGate.ts): the user's
  // choice in Settings → Downloads, or by the hardware. Re-read every few
  // seconds, with the pressure and the GPU lane.
  // Until the hardware is known, one thing at a time (the safe side).
  let downloadPolicy: DownloadPolicy = 'one-task';
  // The hardware as probed once at start (registryProfile; absent when a test
  // injects its own registry, which then counts as not powerful).
  const isPowerfulMachine = async (): Promise<boolean> =>
    registryProfile ? powerfulForParallel(registryProfile, recommendCapacity(registryProfile).maxProjects) : false;
  const refreshDownloadPolicy = async (): Promise<void> => {
    const prefs = await setupStore.getPreferences().catch(() => undefined);
    const choice = prefs?.downloads?.whileDubbing;
    // An explicit choice needs no hardware probe.
    downloadPolicy = effectiveDownloadPolicy(choice, choice && choice !== 'auto' ? false : await isPowerfulMachine());
  };
  const downloadGateNow = (): DownloadGate => {
    const steps = runActivity.steps();
    const runs = [...steps].map(([projectId, step]) => ({ projectId, step, heavy: orchestrator.heavyStepsOf(projectId).includes(step) }));
    const lane = engineManager.heavyLaneOwner();
    return downloadGate({
      policy: downloadPolicy,
      runs,
      externalHeavy: lane !== undefined && !steps.has(lane),
      pressure: health.pressure(),
      concurrency: 2,
    });
  };
  void refreshDownloadPolicy().then(() => downloads.reconsider());
  const gateTimer = setInterval(() => {
    void refreshDownloadPolicy().then(() => downloads.reconsider());
  }, 5000);
  gateTimer.unref?.();
  // Source-video downloads: a queue kept on disk (queue.ts), two at a time,
  // into `<projects root>\downloads` (it follows a moved projects folder).
  // What an app exit interrupted continues now, from its partial files.
  const downloads = new DownloadQueue({
    file: join(config.configDir, 'download-queue.json'),
    downloadsDir: () => downloadsDirFor(store.projectsDir),
    providers: downloadProviders,
    ffmpegPath: config.ffmpegPath ?? 'ffmpeg',
    ffprobePath: config.ffprobePath ?? 'ffprobe',
    logger: { info: (m) => console.info(`[downloads] ${m}`), warn: (m) => console.warn(`[downloads] ${m}`) },
    gate: () => downloadGateNow(),
  });
  // Read before serving: a request must never see an empty list that is merely not loaded yet.
  await downloads.load();
  const installer =
    options.installer ?? new SetupInstaller({ config, store: setupStore, bus: setupBus });

  // Reconcile the recorded inventory with what's actually on disk BEFORE serving:
  // the desktop shell seed-copies the bundled default models (whisper 'small' +
  // en->vi Argos + the vi Piper voice) into the model dirs on first launch, so
  // record them as installed here. Otherwise a first OFFLINE dub's required-
  // resource check would try to re-download a model that's already present.
  // Best-effort — a detection error must never block the server from starting.
  try {
    const onDisk = await detectInstalledModels({
      modelsDir: config.modelsDir,
      whisperCacheDir: config.whisperCacheDir,
    });
    await setupStore.reconcileInstalled(onDisk);
  } catch {
    /* non-fatal: fall back to the recorded inventory */
  }

  // Probe the bundled worker backing a local provider's phase. The readiness
  // contract uses this to block a run while a worker is still booting — so a run
  // can't start and then fail against a not-yet-listening faster-whisper/argos/
  // piper worker. Same source of truth feeds /providers + run-preflight + the gate.
  const probeWorker = async (phase: 'stt' | 'translation' | 'refine' | 'tts'): Promise<boolean> => {
    const url =
      phase === 'stt'
        ? config.sttWorkerUrl
        : phase === 'translation' || phase === 'refine' // refine's only bundled-worker provider is Argos
          ? config.translationWorkerUrl
          : config.ttsWorkerUrl;
    return (await probeWorkerHealth(url, `${phase} worker`)).available;
  };
  const readinessDeps = (): ReadinessDeps => ({
    registry,
    credentials,
    enginePackStore,
    probeWorker,
    packUsable: (id) => isPackUsable(enginePackStore, id),
    // Block a run whose selected default model (whisper/argos/piper) for this
    // language hasn't finished downloading, instead of failing mid-pipeline.
    installedModels: () => setupStore.getStatus().then((s) => s.installed),
    packInstalling: (id) => engineInstaller.isInstalling(id),
    voiceProfile: (id) => voiceProfileStore.get(id),
  });
  /**
   * Start downloading the whisper.cpp speech model a project is waiting for
   * (see selfInstallingModelPack) and report it as downloading, so pressing
   * Start or Retry is enough: the user does not have to find the model among
   * the packs in Settings → Engines.
   */
  const startModelDownloads = (results: ProviderReadiness[]): ProviderReadiness[] =>
    results.map((r) => {
      const packId = selfInstallingModelPack(r);
      if (!packId) return r;
      void engineInstaller.install(packId);
      return downloadStartedReadiness(r, packId);
    });

  // Watermarks and the source's own subtitle band (picture/): for the routes,
  // and for the settings that ask for the watermark to be blurred by itself.
  const pictures = new PictureDetectionService({ store });

  const orchestrator =
    options.orchestrator ??
    new LocalJobOrchestrator({
      config,
      warningInbox,
      // "Find the watermark and blur it" at render (picture/watermarkAuto.ts).
      watermark: { detect: (id: string) => pictures.detectNow(id) },
      // The user's voices kept for one main character (voices/mainOnly.ts).
      mainOnlyVoices: async (projectId: string) =>
        new Map((await voiceProfileStore.list(projectId).catch(() => [])).filter((p) => p.mainOnly).map((p) => [p.id, p.name])),
      store,
      media,
      registry,
      bus,
      // Renders wait for a full dub beside them while the computer is short of breath.
      pressure: () => health.pressure(),
      separation,
      alignment,
      diarization,
      ocr,
      holds,
      // Anchors transcript lines to when they are spoken (the STT worker's VAD).
      speechMap: sttWorkerSpeechMap(config.sttWorkerUrl),
      // Logos and greetings (Settings → Logo & greeting); used only at run time.
      brandKit: { get: (id: string) => brandKit.get(id) },
      // A series parent analysed its video: plan the parts (series/seriesService.ts).
      seriesAnalysed: (id: string): Promise<void> => series.analysed(id),
      // Engine lifecycle + preferences: the scheduler releases a finished run's
      // heavy-engine lane, and reads the user's simultaneous-dub limit.
      engines: engineManager,
      // An installed GPU pack is also the one its provider prefers (cuda ranks
      // first), so its family will run on the GPU and must be admitted as heavy.
      // Over-counting only queues a dub; under-counting fails one at step 6.
      gpuEngineFamilies: async () =>
        new Set(
          (await enginePackStore.list())
            .filter((rec) => isGpuPack(rec.id))
            .map((rec) => findPack(rec.id)?.providerId)
            .filter((family): family is string => family !== undefined),
        ),
      // The built-in Gemma chat can run: a llama.cpp runtime and a chat model.
      localChatAvailable: async () =>
        (await installedPacksForProvider(enginePackStore, 'local-llm')).length > 0 &&
        (await pickInstalledLocalLlmChatModel(enginePackStore)) !== undefined,
      setup: setupStore,
      // Gate runs on provider readiness so an unready provider (e.g. Ollama with
      // no daemon, a missing engine pack, or an unconfigured cloud key) fails
      // fast with remediation instead of dying mid-pipeline.
      checkReadiness: async (project, fromStep) =>
        startModelDownloads(await checkProviderReadiness(project, readinessDeps(), fromStep)),
    });

  // Re-establish the dubbing queue from disk: projects left `queued` re-enter in
  // their original order, and any project the app died on mid-run is demoted to
  // `paused` rather than silently resumed. Best-effort; never blocks boot.
  // After a crash the shell restarted the backend for, the dubs it interrupted
  // continue by themselves (the user's call, 2026-11-21); after a quit they wait.
  void orchestrator.reconcileQueue({ resumeInterrupted: options.recoveredCrash !== undefined });
  if (options.recoveredCrash) {
    // The crash belongs in the same timeline as the run events around it, so
    // the support bundle shows what was running when the backend died.
    const c = options.recoveredCrash;
    structured.write({
      level: 'error',
      msg: `backend restarted after it stopped at ${c.at}${c.codeHex ? ` (${c.codeHex}${c.meaning ? `: ${c.meaning}` : ''})` : ''}`,
      event: 'crash',
    });
  }

  // Settings → Projects folder (where the projects live, and moving them).
  const projectsFolder = new ProjectsFolderService({
    configDir: config.configDir,
    defaultProjectsDir: config.projectsDir,
    store,
    busyProjects: () => orchestrator.busyProjects(),
    downloads,
    logger: { warn: (m) => console.warn(`[projects-folder] ${m}`) },
  });

  // Tracks background Ollama model pulls (lazy on-demand for the large, optional
  // local-LLM translation models). The UI polls /providers/ollama/pull-status.
  const ollamaPulls = new OllamaPullManager(OLLAMA_URL);

  const app = Fastify({ logger: false });

  app.addHook('onClose', async () => {
    clearInterval(gateTimer);
    health.stop();
  });

  // What downloads do while a dub runs, here: the user's choice and what it
  // comes to on this computer (Settings → Downloads shows both).
  app.get('/downloads/policy', async () => {
    const prefs = await setupStore.getPreferences().catch(() => undefined);
    return {
      choice: prefs?.downloads?.whileDubbing ?? 'auto',
      effective: downloadPolicy,
      powerful: await isPowerfulMachine(),
      gate: downloadGateNow(),
    };
  });

  // The backend's own health: uptime, memory and event-loop delay over the last
  // hour, and the crash it was restarted after (Settings → Diagnostics).
  app.get('/diagnostics/health', async (): Promise<BackendHealth> => {
    const build = buildInfo();
    return {
      version: build.version,
      ...(build.commit ? { commit: build.commit } : {}),
      startedAt: health.startedAt.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      heapLimitMb: health.heapLimitMb,
      ...(health.latest() ? { latest: health.latest()! } : {}),
      peak: health.peak(),
      samples: health.samples(),
      ...(options.recoveredCrash ? { recoveredFrom: options.recoveredCrash } : {}),
    };
  });

  // CORS restricted to the app's own origins: localhost dev servers and the
  // Tauri webview (tauri://localhost on macOS/Linux, http://tauri.localhost on
  // Windows). A web page on the internet must NOT be able to drive this API.
  const allowedOrigin =
    /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/;
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header (curl, same-origin, sidecar-to-sidecar) is allowed.
      if (!origin || allowedOrigin.test(origin)) cb(null, true);
      else cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // The window sends `x-vd-initiator` with every request (who asked,
    // activity/context.ts), which makes even a GET ask first; the allowed
    // headers are the ones asked for (the plugin's default), and the answer
    // is kept 10 minutes instead of 5 seconds.
    maxAge: 600,
  });

  /**
   * Headers for the Server-Sent-Event streams, which hijack the reply — so the
   * cors plugin above never sees them — with the SAME origin rule. They used to
   * send `Access-Control-Allow-Origin: *`, which let any web page open in the
   * user's browser read download links, project logs and engine events off
   * 127.0.0.1.
   */
  const sseHeaders = (req: FastifyRequest): Record<string, string> => {
    const origin = req.headers.origin;
    return {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      Vary: 'Origin',
      ...(origin && allowedOrigin.test(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    };
  };

  // Who asked (activity/context.ts): every job and edit below the route records
  // it. And a change still running after 30 s is logged WHILE it runs: requests
  // were logged only when they ended, so the 18 GB copy behind a POST /projects
  // left no line for 6.5 minutes while the agent that sent it had already given
  // up (claude-dubber, 2026-11-23).
  const slowTimers = new WeakMap<FastifyRequest, NodeJS.Timeout>();
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD') {
      const started = Date.now();
      const mcpRequestId = req.headers['x-request-id'];
      let ticks = 0;
      const tick = (): void => {
        const sec = Math.round((Date.now() - started) / 1000);
        structured.write({
          level: 'info',
          msg: `still running: ${req.method} ${req.url.split('?')[0]} (${sec} s)`,
          requestId: req.id,
          ...(typeof mcpRequestId === 'string' ? { mcpRequestId } : {}),
          event: 'http-slow',
        });
        // Then every 2 minutes, for at most 2 hours (a client that went away
        // never gets its onResponse).
        if (++ticks < 60) {
          const next = setTimeout(tick, 120_000);
          next.unref();
          slowTimers.set(req, next);
        }
      };
      const first = setTimeout(tick, 30_000);
      first.unref();
      slowTimers.set(req, first);
    }
    // The agent's tool call id too: the log reference of what it starts.
    const toolCall = req.headers['x-request-id'];
    runWithInitiator(initiatorFromHeaders(req.headers), done, typeof toolCall === 'string' ? { requestId: toolCall.slice(0, 80) } : {});
  });

  // What a request did, for the structured log: failures, slow ones, and every
  // change (not the screens' polling). The plugin sends its tool call's id as
  // X-Request-Id, so its errors can point at these lines.
  app.addHook('onResponse', async (req, reply) => {
    const slow = slowTimers.get(req);
    if (slow) clearTimeout(slow);
    const ms = Math.round(reply.elapsedTime);
    const changed = req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD';
    if (!changed && reply.statusCode < 400 && ms < 5000) return;
    const mcpRequestId = req.headers['x-request-id'];
    structured.write({
      level: reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info',
      msg: `${req.method} ${req.url.split('?')[0]} ${reply.statusCode} ${ms} ms`,
      requestId: req.id,
      ...(typeof mcpRequestId === 'string' ? { mcpRequestId } : {}),
      event: 'http',
    });
  });

  // Settings → Diagnostics, Help → Export support bundle, the plugin's get_diagnostics.
  const diagnostics = new DiagnosticsService({
    logsDir,
    structured,
    health: (): BackendHealth => {
      const build = buildInfo();
      return {
        version: build.version,
        ...(build.commit ? { commit: build.commit } : {}),
        startedAt: health.startedAt.toISOString(),
        uptimeSec: Math.round(process.uptime()),
        heapLimitMb: health.heapLimitMb,
        ...(health.latest() ? { latest: health.latest()! } : {}),
        peak: health.peak(),
        samples: health.samples(),
        ...(options.recoveredCrash ? { recoveredFrom: options.recoveredCrash } : {}),
      };
    },
    queueState: () => orchestrator.queueState(),
    laneOwner: () => engineManager.heavyLaneOwner(),
    runningEngines: () => engineManager.runningPackIds(),
    unusableEngines: () => engineManager.unusablePackIds(),
    projectsDir: () => store.projectsDir,
    listProjects: () => store.listProjects(),
    extras: async () => ({
      versions: { ...buildInfo(), node: process.version, platform: `${process.platform}-${process.arch}` },
      system: (await getSystemProfile().catch(() => undefined)) ?? {},
      // Preferences hold no secrets; keys and site logins are never included.
      preferences: await setupStore.getPreferences().catch(() => ({})),
      downloads: { policy: downloadPolicy, gate: downloadGateNow() },
    }),
  });
  app.get('/diagnostics/summary', async (_req, reply) => {
    try {
      return await diagnostics.summary();
    } catch (err) {
      return sendError(reply, err);
    }
  });
  app.post('/diagnostics/bundle', async (_req, reply) => {
    try {
      return await diagnostics.bundle();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // While the projects move to another folder, nothing may change one: a write
  // would land in the folder they are leaving, or in one half-moved. Reading
  // goes on (the list shows what is where).
  app.addHook('onRequest', async (req, reply) => {
    if (!projectsFolder.moving || req.method === 'GET' || req.method === 'OPTIONS') return;
    if (!/^\/projects(\/|\?|$)/.test(req.url)) return;
    return reply.status(409).send({
      error: {
        code: 'RUN_IN_PROGRESS',
        message: 'VideoDubber is moving your projects to another folder.',
        remediation: 'Try again when Settings → Projects folder shows the move has finished.',
      },
    });
  });

  // On the way out, pause the dubs in progress first (each saves its progress
  // and continues at the next start), then stop any running engine servers
  // (whisper.cpp / llama.cpp / uv-env workers) so no child process is orphaned.
  app.addHook('onClose', async () => {
    await orchestrator.pauseAll();
    await downloads.stop();
    await engineManager.stopAll();
  });

  // ---- Health -------------------------------------------------------------

  // The version/commit stamp is what makes the "stale sidecar" release bug
  // (docs/RELEASING.md) detectable at RUNTIME: the shell, a smoke script or a
  // user's bug report can compare this to the app version instead of grepping
  // strings out of a bundled binary. `startedAt` additionally reveals a sidecar
  // that silently restarted mid-session.
  const startedAt = new Date().toISOString();
  app.get('/health', async () => ({
    status: 'ok',
    // Discovery by name (Voice Mask finds VideoDubber on its port by this).
    app: 'videodubber',
    ...buildInfo(),
    startedAt,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    pid: process.pid,
  }));

  app.get('/workers/health', async (_req, reply) => {
    try {
      const health = await checkWorkersHealth(config);
      return health;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Languages ----------------------------------------------------------

  app.get('/languages', async () => {
    const worker = await orchestrator.listTranslationLanguages();
    return {
      common: COMMON_LANGUAGES,
      // Only languages the local Argos engine can actually translate (reach
      // English in the curated pairs) — the dropdowns use this to avoid offering
      // a pair Argos can't do.
      translatable: translatableLanguages(),
      installed: worker.installed,
      available: worker.available ?? [],
    };
  });

  // ---- First-run setup ----------------------------------------------------

  app.get('/setup/status', async (_req, reply) => {
    try {
      return await setupStore.getStatus();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/setup/preflight', async (_req, reply) => {
    try {
      return await runPreflight(config);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/setup/catalog', async (_req, reply) => {
    try {
      return buildCatalog();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full per-language Piper voice list (every voice for the target language),
  // best-first. The curated default(s) for the language are flagged
  // `recommended` so the UI can show them first / pre-select. Voices not yet on
  // disk are downloaded on demand when selected (POST /setup/install-voice, or
  // automatically via /projects/:id/ensure-resources once pinned).
  app.get(
    '/setup/voices',
    async (req: FastifyRequest<{ Querystring: { language?: string; engine?: string } }>, reply) => {
      try {
        const language = (req.query.language ?? '').trim();
        if (!language) {
          return reply.status(400).send({ error: { code: 'UNKNOWN', message: 'Query parameter "language" is required.' } });
        }
        // engine=neural-v2 / neural-v3 (or legacy "neural" = v3) lists the VieNeu
        // preset voices bundled in that pack; the default (Piper) lists per-voice
        // downloadable voices.
        const engine = (req.query.engine ?? '').trim().toLowerCase();
        // Only serve voices for engines whose pack is actually offered on this
        // machine, so a disabled/unavailable engine (v2, OmniVoice) can't leak
        // voices into the UI even if a stale request asks for them.
        const packOffered = (packId: string): boolean => availablePacks().some((p) => p.id === packId);
        if (engine === 'neural-v2') {
          const voices = packOffered('tts-neural-v2') ? listNeuralVoicesForLanguage(language, 'v2') : [];
          return { language, engine: 'neural-v2', voices };
        }
        if (engine === 'neural-v3' || engine === 'neural') {
          return { language, engine: 'neural-v3', voices: listNeuralVoicesForLanguage(language, 'v3') };
        }
        // engine=omnivoice lists OmniVoice's "designed" voices (same set for every
        // language; OmniVoice is multilingual). Apple-Silicon-only pack.
        if (engine === 'omnivoice') {
          const voices = packOffered('tts-omnivoice') ? listOmnivoiceForLanguage(language) : [];
          return { language, engine: 'omnivoice', voices };
        }
        const voices = listVoicesForLanguage(language).map((v) => ({
          ...v,
          // A curated default for the language gets the `recommended` badge.
          recommended: v.recommended ?? Boolean(findPiperVoice(v.id)),
        }));
        return { language, engine: 'piper', voices };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/setup/install', async (req: FastifyRequest<{ Body: SetupInstallRequest }>, reply) => {
    try {
      const request = req.body ?? {};
      // Kick off asynchronously; progress is observed via GET /setup/events.
      void installer.run(request);
      return reply.status(202).send({ started: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // On-demand download of a single Piper voice (any id from the full catalog).
  // Used when the user selects a voice that isn't installed yet — the same
  // install pipeline + SSE progress as /setup/install, scoped to one voice.
  app.post('/setup/install-voice', async (req: FastifyRequest<{ Body: { voiceId?: string } }>, reply) => {
    try {
      const voiceId = (req.body?.voiceId ?? '').trim();
      if (!voiceId) {
        return reply.status(400).send({ error: { code: 'UNKNOWN', message: 'Body field "voiceId" is required.' } });
      }
      void installer.run({ piperVoices: [voiceId] });
      return reply.status(202).send({ started: true, voiceId });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Voice library (voices/voiceRoutes.ts, docs/VOICES.md) -----------------
  const usablePackIds = async (): Promise<Set<string>> => {
    const recorded = await enginePackStore.list();
    const usable = await Promise.all(recorded.map((r) => isPackUsable(enginePackStore, r.id)));
    return new Set(recorded.filter((_, i) => usable[i]).map((r) => r.id));
  };
  /** Start a pack and, for a model pack, the runtime it needs (as /engines/install does). */
  const startPackInstall = async (packId: string): Promise<string[]> => {
    if (!engineInstaller.isInstalling(packId)) void engineInstaller.install(packId);
    const profile = (await buildSystemResponse().catch(() => undefined))?.profile;
    const companions = profile ? await companionRuntimesFor(enginePackStore, packId, profile) : [];
    for (const c of companions) if (!engineInstaller.isInstalling(c)) void engineInstaller.install(c);
    return [packId, ...companions];
  };
  /** What decides which voices are installed and usable here (the voice library's state). */
  const voiceLibraryState = async () => {
    const [status, installedPacks, openai] = await Promise.all([
      setupStore.getStatus(),
      usablePackIds(),
      credentials.get('openai').catch(() => undefined),
    ]);
    return {
      installedPiper: new Set(status.installed.piperVoices),
      installedPacks,
      availablePacks: new Set(availablePacks().map((p) => p.id)),
      cloudServices: new Set(openai?.apiKey ? ['openai'] : []),
    };
  };
  const voiceFavorites = new VoiceFavorites(config.configDir);
  registerVoiceRoutes(app, {
    libraryState: voiceLibraryState,
    favorites: voiceFavorites,
    previews: new VoicePreviewCache(config.configDir),
    profiles: (projectId) => voiceProfileStore.list(projectId),
    packStates: async (packIds) => {
      const [installed, profile] = await Promise.all([
        usablePackIds(),
        buildSystemResponse()
          .then((r) => r.profile)
          .catch(() => undefined),
      ]);
      const offered = new Set(availablePacks().map((p) => p.id));
      return packIds.flatMap((id) => {
        const pack = findPack(id);
        if (!pack) return [];
        return [
          {
            id,
            displayName: pack.displayName,
            ...(pack.accel ? { accel: pack.accel } : {}),
            approxSizeMb: pack.approxSizeMb,
            installed: installed.has(id),
            available: offered.has(id),
            // A recommendation only: an unfit pack is still offered.
            fits: profile ? packHardwareSupported(pack, profile) && packFitsMachine(pack, profile) : offered.has(id),
            installing: engineInstaller.isInstalling(id),
          },
        ];
      });
    },
    installPiperVoice: (modelId) => void installer.run({ piperVoices: [modelId] }),
    installPack: startPackInstall,
    speak: (voiceId, text, language) => speakWith(voiceId, text, language),
    sendError,
  });

  /** An installed voice saying a sentence: the Voices screen's Listen, and spoken greetings. */
  async function speakWith(voiceId: string, text: string, language: string): Promise<string> {
      const profile = isVoiceProfileId(voiceId) ? await voiceProfileStore.require(voiceId) : undefined;
      const engine = profile ? profile.engine : voiceEngineOfId(voiceId);
      const providerId = engine ? VOICE_ENGINE_PROVIDER[engine] : undefined;
      const provider = providerId ? registry.getTts(providerId) : undefined;
      if (!provider || provider.id !== providerId) {
        throw new AppErrorException('ENGINE_UNAVAILABLE', `No engine on this computer speaks "${voiceId}".`);
      }
      // Cached by what decides the audio, the engine's installed version
      // included (temporary cache: Settings → Storage).
      const enginePacks = new Set(VOICE_ENGINES.find((e) => e.id === engine)?.packIds ?? []);
      const packs = (await enginePackStore.list()).filter((r) => enginePacks.has(r.id));
      const key = speakCacheKey({ voiceId, text, language, packs, ...(profile ? { profile } : {}) });
      const dir = join(config.configDir, 'cache', 'voice-speak', key);
      const done = join(dir, 'segment_0001.wav');
      if (await stat(done).then((s) => s.size > 44, () => false)) return done;
      // A preview holds the GPU lane only while it speaks (preview:<voice>).
      const result = await orchestrator.runLaneJob(`preview:${voiceId}`, () =>
        provider.synthesizeSegments({
          language,
          voiceId,
          segments: [{ id: 'seg_0001', text, startMs: 0, endMs: 15_000 }],
          outputDir: dir,
        }),
      );
      const clip = result.segments[0]?.audioPath;
      if (!clip || (result.fallbackSegments ?? 0) > 0 || result.engine === 'fallback') {
        throw new AppErrorException('ENGINE_UNAVAILABLE', `The voice "${voiceId}" could not speak this sentence.`);
      }
      return clip;
  }
  registerProfileRoutes(app, {
    store: voiceProfileStore,
    service: voiceProfiles,
    prep: referencePrep,
    source: {
      projectAudio: async (projectId) => {
        if (!(await store.exists(projectId).catch(() => false))) return undefined;
        const paths = store.paths(projectId);
        return { audioPath: paths.originalWav, transcriptPath: paths.sourceJson };
      },
      media,
      prep: referencePrep,
      workRoot: join(config.configDir, 'voices', 'work'),
      // Separate the voices of the joined lines when separation is installed.
      // Never a reason to fail: busy (another dub holds the GPU) or broken, the
      // lines are used as they are, unless the user cancelled.
      isolateVoices: async (projectId, wavPath, workDir, signal) => {
        if (!(await separation.available?.().catch(() => false))) return undefined;
        try {
          const out = await orchestrator.runEditorJob(projectId, () => separation.separate(wavPath, workDir, signal));
          return out?.vocalsPath;
        } catch (err) {
          if (signal?.aborted) throw err;
          console.warn(`[separation] Separating a voice reference failed (${String(err)}); using the lines as they are.`);
          return undefined;
        }
      },
      cachedVocals: async (projectId) => {
        const paths = store.paths(projectId);
        return currentVocals(paths.originalWav, paths.audioDir);
      },
    },
    // New speaker voices join the table (replacing those speakers' old ones);
    // the orchestrator marks the lines whose voice that changes.
    assignSpeakerVoices: async (projectId, assignments) => {
      const { project } = await orchestrator.getProjectWithPipeline(projectId);
      const keep = (project.settings.speakerVoices ?? []).filter((v) => !assignments.some((a) => a.speakerId === v.speakerId));
      await orchestrator.updateProjectSettings(projectId, { speakerVoices: [...keep, ...assignments] });
    },
    sendError,
  });

  app.post('/setup/complete', async (_req, reply) => {
    try {
      await setupStore.markFirstRunComplete();
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/setup/events', (req, reply) => {
    // Raw SSE headers; hijack the reply so Fastify doesn't try to serialize.
    reply.raw.writeHead(200, sseHeaders(req)).flushHeaders();
    reply.hijack();

    const write = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = setupBus.subscribe((event) => write(event));

    // Heartbeat comment keeps proxies/connections alive.
    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // --- Source-video downloader (experimental) --------------------------------
  // Fetch a video the user intends to dub. Resolve is separate from download so
  // the UI can show a preview card and a part picker before committing to
  // hundreds of megabytes.

  app.post(
    '/download/resolve',
    async (req: FastifyRequest<{ Body: { input?: string } }>, reply) => {
      try {
        return await resolveVideo(req.body?.input ?? '', { providers: downloadProviders });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A list link's videos (a collection, favourites, an uploader's page), for
  // the Download screen to pick from; `list` is null for any other link.
  app.post('/download/expand', async (req: FastifyRequest<{ Body: { input?: string } }>, reply) => {
    try {
      const input = (req.body?.input ?? '').trim();
      const provider = input ? providerFor(downloadProviders, input) : undefined;
      const list = provider?.isList?.(input) && provider.expand ? await provider.expand(input) : undefined;
      return { list: list ?? null };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The queue (queue.ts). 202s, not held-open requests: a download runs for
  // minutes, followed on GET /download/events (or GET /downloads/:id).
  app.get('/downloads', async () => downloads.list());

  app.post(
    '/downloads',
    async (
      req: FastifyRequest<{ Body: { items?: { input?: unknown; page?: unknown; targetHeightPx?: unknown }[]; allParts?: boolean } }>,
      reply,
    ) => {
      try {
        const raw = Array.isArray(req.body?.items) ? req.body.items : [];
        if (raw.length === 0 || raw.length > 200) {
          return reply
            .status(400)
            .send({ error: { code: 'INVALID_VIDEO_LINK', message: 'Send between 1 and 200 links in "items": [{ "input": "<link>" }].' } });
        }
        const items = raw.map((r) => ({
          input: typeof r?.input === 'string' ? r.input : '',
          ...(Number.isInteger(r?.page) && (r.page as number) > 0 ? { page: r.page as number } : {}),
          ...(Number.isInteger(r?.targetHeightPx) && (r.targetHeightPx as number) > 0 ? { targetHeightPx: r.targetHeightPx as number } : {}),
        }));
        return reply.status(202).send(await downloads.add(items, { allParts: req.body?.allParts === true }));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  const downloadOr404 = (id: string) => {
    const item = downloads.get(id);
    if (!item) {
      throw new AppErrorException('SOURCE_UNAVAILABLE', `There is no download "${id}" (it was removed, or the id is wrong).`, {
        remediation: 'GET /downloads lists the downloads the app knows.',
      });
    }
    return item;
  };

  app.get('/downloads/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return downloadOr404(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/downloads/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      downloadOr404(req.params.id);
      return await downloads.cancel(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/downloads/:id/retry', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      downloadOr404(req.params.id);
      return downloads.retry(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete(
    '/downloads/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { deleteFile?: string } }>, reply) => {
      try {
        downloadOr404(req.params.id);
        await downloads.remove(req.params.id, { deleteFile: req.query.deleteFile === 'true' || req.query.deleteFile === '1' });
        return { ok: true };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Settings → Storage: delete every finished, failed or cancelled download
  // and its file (a project made from one keeps its own link to the bytes).
  app.post('/downloads/clear-finished', async (_req, reply) => {
    try {
      const done = downloads.list().filter((d) => d.state === 'done' || d.state === 'failed' || d.state === 'cancelled');
      for (const d of done) await downloads.remove(d.id, { deleteFile: true });
      return { removed: done.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One link (the plugin's download_video before the queue): a queue item
  // whose id is the job id.
  app.post(
    '/download/start',
    async (
      req: FastifyRequest<{ Body: { input?: string; page?: number; targetHeightPx?: number } }>,
      reply,
    ) => {
      try {
        const res = await downloads.add([
          {
            input: req.body?.input ?? '',
            ...(req.body?.page ? { page: req.body.page } : {}),
            ...(req.body?.targetHeightPx ? { targetHeightPx: req.body.targetHeightPx } : {}),
          },
        ]);
        const item = res.added[0] ?? res.existing[0];
        if (!item) throw new AppErrorException(res.rejected[0]!.error);
        return reply.status(202).send({ jobId: item.id });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/download/providers', async (_req, reply) => {
    try {
      return await describeProviders(downloadProviders);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Resolve a provider by id, or 404 rather than silently doing nothing. */
  const requireProvider = (id: string): (typeof downloadProviders)[number] => {
    const provider = providerById(downloadProviders, id);
    if (!provider) {
      throw new AppErrorException('INVALID_VIDEO_LINK', `Unknown download provider "${id}".`, {
        remediation: 'Reload the app; the list of providers comes from GET /download/providers.',
      });
    }
    return provider;
  };

  /** Providers without a credential must reject rather than pretend to store one. */
  const requireSession = (id: string): NonNullable<(typeof downloadProviders)[number]['session']> => {
    const provider = requireProvider(id);
    if (!provider.session) {
      throw new AppErrorException('INVALID_VIDEO_LINK', `Provider "${id}" takes no credentials.`, {
        remediation: 'Nothing to configure for this source.',
      });
    }
    return provider.session;
  };

  app.get(
    '/download/providers/:id/session',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        return await requireSession(req.params.id).describe();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    '/download/providers/:id/session',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { value?: string } }>, reply) => {
      try {
        const session = requireSession(req.params.id);
        await session.set(req.body?.value ?? '');
        return await session.describe();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    '/download/providers/:id/session',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        const session = requireSession(req.params.id);
        await session.clear();
        return await session.describe();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // The user's browser cookies for the site (the plugin's set_download_login,
  // from Mother Claude's export): the provider keeps the ones it uses and
  // answers only masked status, never a value.
  app.post(
    '/download/providers/:id/session/import',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { cookies?: unknown } }>, reply) => {
      try {
        const session = requireSession(req.params.id);
        if (!session.importCookies) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: `Provider "${req.params.id}" takes no browser cookies.` } });
        }
        const cookies: BrowserCookie[] = (Array.isArray(req.body?.cookies) ? req.body.cookies : [])
          .filter((c): c is BrowserCookie =>
            typeof c === 'object' && c !== null &&
            typeof (c as BrowserCookie).name === 'string' &&
            typeof (c as BrowserCookie).value === 'string' &&
            typeof (c as BrowserCookie).domain === 'string')
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
        await session.importCookies(cookies);
        const check = await session.check().catch(() => ({ valid: false }));
        return { ...(await session.describe()), check };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/download/providers/:id/session/test',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        return await requireSession(req.params.id).check();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Following jobs (Mother Claude's Monitor) -----------------------------
  // NDJSON, one line per change of the named downloads and dubs (jobFeed.ts):
  // `curl.exe -sN "http://127.0.0.1:5100/jobs/events?downloads=a,b&projects=c&untilDone=1"`.
  const jobFeed = new JobFeed({
    downloads,
    buses: bus,
    getProject: (id) => orchestrator.getProjectWithPipeline(id).catch(() => undefined),
    waitingForModels: (id) => waitingForModels.has(id),
  });

  app.get(
    '/jobs/events',
    async (
      req: FastifyRequest<{ Querystring: { downloads?: string; projects?: string; since?: string; untilDone?: string } }>,
      reply,
    ) => {
      const ids = (s?: string): string[] =>
        [...new Set((s ?? '').split(',').map((x) => x.trim()).filter((x) => /^[\w-]{1,80}$/.test(x)))].slice(0, 500);
      const wanted = new Map<string, { kind: 'download' | 'project'; id: string }>();
      for (const id of ids(req.query.downloads)) wanted.set(`download:${id}`, { kind: 'download', id });
      for (const id of ids(req.query.projects)) wanted.set(`project:${id}`, { kind: 'project', id });
      if (wanted.size === 0) {
        return reply.status(400).send({
          error: { code: 'UNKNOWN', message: 'Name the jobs to follow: ?downloads=<ids>&projects=<ids> (comma-separated).' },
        });
      }
      const untilDone = req.query.untilDone === '1' || req.query.untilDone === 'true';
      const since = Number.parseInt(req.query.since ?? '', 10);

      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
      reply.hijack();
      const latest = new Map<string, JobLine>();
      let ended = false;
      let unsubscribe: () => void = () => undefined;
      const end = (): void => {
        if (ended) return;
        ended = true;
        unsubscribe();
        reply.raw.end();
      };
      const write = (line: JobLine): void => {
        if (ended) return;
        reply.raw.write(`${JSON.stringify(line)}\n`);
        latest.set(`${line.kind}:${line.id}`, line);
        if (untilDone && [...wanted.keys()].every((k) => latest.has(k) && isStopped(latest.get(k)!))) end();
      };
      req.raw.on('close', end);

      for (const { kind, id } of wanted.values()) if (kind === 'project') jobFeed.watchProject(id);
      unsubscribe = jobFeed.subscribe((line) => {
        if (wanted.has(`${line.kind}:${line.id}`)) write(line);
      });
      // Catch up: what was missed since `since`, then where each job is now.
      if (Number.isFinite(since)) for (const l of jobFeed.since(since)) if (wanted.has(`${l.kind}:${l.id}`)) write(l);
      for (const [key, { kind, id }] of wanted) {
        if (latest.has(key)) continue;
        const now = await jobFeed.snapshot(kind, id);
        write(now ?? { seq: 0, at: new Date().toISOString(), kind, id, state: 'unknown' });
      }
    },
  );

  app.get('/download/events', (req, reply) => {
    reply.raw.writeHead(200, sseHeaders(req)).flushHeaders();
    reply.hijack();

    const write = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = downloads.subscribe((event) => write(event));
    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ---- Update preferences -------------------------------------------------

  app.get('/preferences', async (_req, reply) => {
    try {
      return await setupStore.getPreferences();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/preferences', async (req: FastifyRequest<{ Body: Partial<UpdatePreferences> }>, reply) => {
    try {
      const body = req.body ?? {};
      // Partial update: omitted fields keep their stored value, so the
      // auto-update toggle and the provider defaults can be saved independently.
      const current = await setupStore.getPreferences();
      await setupStore.savePreferences({
        autoUpdate: body.autoUpdate === undefined ? current.autoUpdate : body.autoUpdate === true,
        ...(body.providerDefaults !== undefined
          ? { providerDefaults: body.providerDefaults }
          : current.providerDefaults !== undefined
            ? { providerDefaults: current.providerDefaults }
            : {}),
        ...(body.concurrency !== undefined
          ? { concurrency: body.concurrency }
          : current.concurrency !== undefined
            ? { concurrency: current.concurrency }
            : {}),
        // Per job: a field sent as "" or null goes back to automatic.
        ...(body.localModels !== undefined || current.localModels !== undefined
          ? { localModels: { ...current.localModels, ...(body.localModels ?? {}) } }
          : {}),
        ...(body.downloads !== undefined || current.downloads !== undefined
          ? { downloads: sanitizeDownloadPrefs({ ...current.downloads, ...(body.downloads ?? {}) }) }
          : {}),
      });
      // Downloads follow a changed "while dubbing" choice at once.
      await refreshDownloadPolicy();
      downloads.reconsider();
      // A limit change (or un-pausing) may let queued dubs start immediately.
      void orchestrator.pumpQueue();
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Run queue (simultaneous-dub capacity) -------------------------------

  app.get('/queue', async (_req, reply) => {
    try {
      return await orchestrator.queueState();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- GPU holds (scheduler/gpuHolds.ts) ------------------------------------
  // Another app on this computer (Voice Mask) holds the graphics card while a
  // live session runs: new heavy-lane work waits, nothing running is touched,
  // and a hold its app stops renewing expires by itself. Refused from any web
  // page but the app's own, as /shutdown is: CORS only hides an answer.
  const foreignOrigin = (req: FastifyRequest): boolean => {
    const origin = req.headers.origin;
    return typeof origin === 'string' && origin !== '' && !allowedOrigin.test(origin);
  };
  const refuseForeign = (reply: FastifyReply) =>
    reply.status(403).send({ error: { code: 'UNKNOWN', message: 'Not allowed from this origin.' } });

  app.post('/scheduler/holds', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    if (foreignOrigin(req)) return refuseForeign(reply);
    const parsed = parseHoldRequest(req.body);
    if (!parsed.ok) return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: parsed.error } });
    const hold = holds.create(parsed.value);
    if (hold === 'full') {
      return reply.status(429).send({
        error: { code: 'ENGINE_BUSY', message: 'Too many holds on the graphics card: release one (DELETE /scheduler/holds/:id) or let it expire.' },
      });
    }
    return reply.status(201).send({ holdId: hold.holdId, expiresAt: hold.expiresAt, ttlSec: hold.ttlSec });
  });

  app.put('/scheduler/holds/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (foreignOrigin(req)) return refuseForeign(reply);
    const hold = holds.renew(req.params.id);
    if (!hold) {
      return reply.status(404).send({ error: { code: 'INVALID_EDIT', message: 'No such hold: it expired or was released. Take a new one.' } });
    }
    return { holdId: hold.holdId, expiresAt: hold.expiresAt };
  });

  app.delete('/scheduler/holds/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (foreignOrigin(req)) return refuseForeign(reply);
    holds.release(req.params.id);
    return reply.status(204).send();
  });

  app.post(
    '/projects/:id/run-next',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        return { ok: true, ...(await orchestrator.runNext(req.params.id)) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Providers (per-phase pickers in wizard + settings) ------------------

  app.get('/providers', async (_req, reply) => {
    try {
      // Single source of truth for availability: the readiness contract. This
      // is the same check the run gate uses, so the UI can never show a provider
      // as available that a run would then reject (the Ollama "always available"
      // bug). Build the shared context once, then describe every provider.
      const described = registry.describe();
      const rdeps = readinessDeps();
      const ctx = await buildReadinessContext(rdeps);
      const decorate = (phase: 'stt' | 'translation' | 'tts', list: typeof described.stt) =>
        Promise.all(
          list.map(async (p) => {
            const r = await describeProviderReadiness(phase, p, rdeps, ctx);
            return {
              ...p,
              available: r.ready,
              readinessStatus: r.status,
              ...(r.remediation ? { remediation: r.remediation } : {}),
              ...(r.action ? { action: r.action } : {}),
            };
          }),
        );
      const [stt, translation, tts] = await Promise.all([
        decorate('stt', described.stt),
        decorate('translation', described.translation),
        decorate('tts', described.tts),
      ]);
      return { stt, translation, tts };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Settings for a new project: the user's saved choices where usable, else the
  // best INSTALLED engines for this machine (projectDefaults.ts). The wizard,
  // Settings → "Apply recommended" and the MCP server all start here, so a
  // GPU engine the user installed is actually used by the next project.
  /**
   * The settings the app recommends for a new project on this machine (also
   * the base of a preset). `localOnly`: with the user's saved cloud choices
   * left out (the built-in presets: a cloud AI only where the user chooses it).
   */
  const projectDefaultsFor = async (sourceLanguage: string, targetLanguage: string, opts: { localOnly?: boolean } = {}) => {
    const described = registry.describe();
    const rdeps = readinessDeps();
    const ctx = await buildReadinessContext(rdeps);
    const usable = async (phase: 'stt' | 'translation' | 'refine' | 'tts', id: string): Promise<boolean> => {
      const list = phase === 'stt' ? described.stt : phase === 'tts' ? described.tts : described.translation;
      const traits = list.find((p) => p.id === id);
      if (!traits) return false; // not offered on this machine at all
      const r = await describeProviderReadiness(phase, traits, rdeps, ctx);
      // A bundled worker that is still booting is usable by the time a run starts.
      return r.ready || r.status === 'worker-loading';
    };
    const isLocal = (phase: 'stt' | 'translation' | 'tts', id: string): boolean =>
      (phase === 'stt' ? described.stt : phase === 'tts' ? described.tts : described.translation).find((p) => p.id === id)?.isLocal === true;
    return recommendProjectSettings(
      {
        providerDefaults: async () => {
          const saved = (await setupStore.getPreferences()).providerDefaults;
          return opts.localOnly ? localProviderDefaults(saved, isLocal) : saved;
        },
        usable,
        recommendedSttModel: async () => (await buildSystemResponse().catch(() => undefined))?.recommendation.whisperModel,
        translationModelNote: async () => {
          const preferred = (await setupStore.getPreferences().catch(() => undefined))?.localModels?.translation;
          const picked = await pickInstalledLocalLlmModel(enginePackStore, undefined, preferred || undefined);
          if (!picked) return undefined;
          const name = findPack(picked.packId)?.displayName ?? picked.packId;
          if (picked.slowerThan) return `Translation model: ${name}, chosen in Settings. ${picked.slowerThan.reason}`;
          return `Translation model: ${name}${picked.chosenByUser ? ', chosen in Settings' : ', the largest that runs well on this computer'}.`;
        },
      },
      { sourceLanguage: sourceLanguage.trim(), targetLanguage: targetLanguage.trim() || 'vi-VN' },
    );
  };

  app.get(
    '/project-defaults',
    async (req: FastifyRequest<{ Querystring: { sourceLanguage?: string; targetLanguage?: string } }>, reply) => {
      try {
        return await projectDefaultsFor(req.query.sourceLanguage ?? '', req.query.targetLanguage ?? '');
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Pre-run readiness for a specific project's SELECTED providers, so the UI can
  // disable "Run" + show remediation before the click. The run gate
  // (orchestrator) is the real guarantee; this is the friendly pre-empt.
  app.get('/projects/:id/run-preflight', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const project = await store.getProject(req.params.id);
      const providers = await checkProviderReadiness(project, readinessDeps());
      return { ok: providers.every((p) => p.ready), providers };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Background pre-fetch: as soon as a project's languages/providers are known,
  // download the REQUIRED local default models (whisper / Argos pair / Piper
  // voice) that aren't installed yet — so a run doesn't stall on a missing model
  // later. Idempotent; progress streams over GET /setup/events. The wizard calls
  // this right after creating a project.
  /** Start downloading what a project needs (models, a whisper.cpp model pack); returns what started. */
  const ensureResourcesFor = async (project: Project) => {
      const status = await setupStore.getStatus();
      const request = computeRequiredResources(project.settings, status.installed);
      const installing = hasRequiredResources(request);
      if (installing) void installer.run(request);
      // A whisper.cpp project's speech model is an engine pack, not a setup
      // resource, so it starts here by the same rule as at Start. Reported
      // separately: `installing` tells the wizard to wait for the SETUP run,
      // whose events never mention engine packs, so folding this in would
      // leave Start disabled forever. The run gate reports it as downloading.
      const enginePacks: string[] = [];
      try {
        for (const r of await checkProviderReadiness(project, readinessDeps())) {
          const packId = selfInstallingModelPack(r);
          if (!packId) continue;
          void engineInstaller.install(packId);
          enginePacks.push(packId);
        }
      } catch {
        // Only a head start: the run gate checks again (and starts the
        // download) at Start. A readiness error here must not cost the wizard
        // the `installing` answer for the setup run it already started.
      }
      return { installing, request, ...(enginePacks.length > 0 ? { enginePacks } : {}) };
  };

  app.post('/projects/:id/ensure-resources', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await ensureResourcesFor(await store.getProject(req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Series: a long video dubbed in parts -----------------------------------

  /**
   * The AIs that can choose cuts and name parts: the translation providers
   * that can chat, by their registry ids (the first draft listed "anthropic",
   * "openai", "gemini", which no provider is called, so no cloud AI could ever
   * be chosen; seen live, 2026-11-19). Claude first.
   */
  const SERIES_AI_IDS = ['anthropic-translate', 'openai-translate', 'gemini-translate', 'llama-cpp-chat'] as const;
  /**
   * What the choice is called: the AI, not the translation engine built on it
   * ("Anthropic (Claude) translation (cloud)" under "AI that chooses the
   * cuts"), and a name reads the same in every language of the UI.
   */
  const SERIES_AI_LABELS: Readonly<Record<string, string>> = {
    'anthropic-translate': 'Claude',
    'openai-translate': 'OpenAI',
    'gemini-translate': 'Gemini',
    'llama-cpp-chat': 'Gemma',
  };
  /**
   * The AI a request asked for (either spelling), else the default: Claude
   * through Mother Claude when it is set up (the user's call for runs Mother
   * Claude drives), else the first one set up. Undefined: none is.
   */
  /**
   * The AI that plans a series' cuts: the one asked for (when it is set up),
   * else the built-in Gemma chat model; a cloud AI only when asked for by
   * name (the user's rule, 2026-11-25). Undefined: none to use.
   */
  const pickSeriesAi = (options: readonly SeriesAiOption[], wanted: string | undefined): SeriesAiOption | undefined => {
    const ready = options.filter((o) => o.ready);
    if (wanted?.trim()) return ready.find((o) => o.id === seriesAiId(wanted));
    const local = defaultSeriesAiId(ready);
    return local ? ready.find((o) => o.id === local) : undefined;
  };
  /** Why a series cannot be planned: the AI asked for is not set up, or none was asked for and the built-in one is missing. */
  const seriesAiRefusal = (wanted: string | undefined): AppErrorException =>
    new AppErrorException(
      'CLOUD_CREDENTIALS_MISSING',
      wanted?.trim()
        ? `The AI "${wanted}" is not set up here, so the video cannot be split into parts with it.`
        : 'Splitting a video into parts plans the cuts with an AI: the built-in Gemma chat model is not installed, and no other AI was chosen.',
      {
        remediation:
          'Install the built-in Gemma chat model (Settings → Engines: everything stays on this computer), or choose an AI you have set up: Claude (an API key, or your Claude plan through Mother Claude), OpenAI or Gemini (series.ai in the plugin, the AI field in New project).',
      },
    );
  const seriesAiOptions = async (): Promise<SeriesAiOption[]> => {
    const described = registry.describe().translation;
    const rdeps = readinessDeps();
    const ctx = await buildReadinessContext(rdeps);
    const viaMotherClaude = (await credentials.describe().catch(() => [])).some(
      (c) => c.service === 'anthropic' && c.via === 'mother-claude',
    );
    const out: SeriesAiOption[] = [];
    for (const id of SERIES_AI_IDS) {
      const traits = described.find((p) => p.id === id);
      if (!traits) continue;
      const r = await describeProviderReadiness('translation', traits, rdeps, ctx).catch(() => undefined);
      out.push({
        id,
        label: SERIES_AI_LABELS[id] ?? traits.displayName,
        ready: Boolean(r && (r.ready || r.status === 'worker-loading')),
        ...(id === 'anthropic-translate' && viaMotherClaude ? { viaMotherClaude: true } : {}),
      });
    }
    return out;
  };

  const series: SeriesService = new SeriesService({
    // A series asked to blur its watermark looks once, in the whole video, during its analysis.
    detectWatermark: (id: string) => pictures.detectNow(id),
    store,
    projects: orchestrator,
    start: (id) => startWhenReady(id) as Promise<RunScheduleResult | { waiting: true }>,
    chatFor: (providerId) => {
      try {
        const id = seriesAiId(providerId);
        const provider = registry.getTranslation(id);
        return provider.id === id && isTranslationRefiner(provider) ? (provider as unknown as SeriesChat & AnalysisChat) : undefined;
      } catch {
        return undefined;
      }
    },
    // Changes of shot near the candidate cuts (the media worker's scene score).
    sceneChanges: (video, spans) => (media.detectSceneChanges ? media.detectSceneChanges(video, spans) : Promise.resolve([])),
    pause: (id) => orchestrator.pauseJob(id),
    isBusy: (id) => orchestrator.busyProjects().includes(id),
    // A queued part is rebuilt or renamed where it waits (0.18.0).
    workOn: (id) => orchestrator.workOn(id),
    holdQueue: (fn) => orchestrator.whileQueueHeld(fn),
    renameProject: (id, name) => orchestrator.renameProject(id, name),
    logger: { info: (m) => console.info(`[series] ${m}`), warn: (m) => console.warn(`[series] ${m}`) },
  });

  /** What an apply of {@link forEachPart} answers when the part already had the change. */
  const UNCHANGED = Symbol('unchanged');

  /**
   * Apply one change to every part of a series (`applyToParts`): each part
   * reports what happened; a part being dubbed or waiting in the queue is
   * skipped with the reason and what to do (series/partWork.ts), never changed
   * under the run (Phase 4.4).
   */
  async function forEachPart(
    projectId: string,
    apply: (partId: string) => Promise<unknown>,
    /** `whileQueued`: a part waiting in the queue takes the change where it waits (the queue held meanwhile). */
    opts: { whileQueued?: boolean } = {},
  ): Promise<{ projectId: string; index: number; ok: boolean; queued?: boolean; unchanged?: boolean; skipped?: string; error?: string }[]> {
    const ids = await series.partIdsOf(projectId);
    // Parts by the numbers they are shown with (a continued series starts at its offset + 1).
    const offset = ids.length > 0 ? await series.numberOffsetOf(projectId) : 0;
    const out: { projectId: string; index: number; ok: boolean; queued?: boolean; unchanged?: boolean; skipped?: string; error?: string }[] = [];
    for (const [i, id] of ids.entries()) {
      if (orchestrator.busyProjects().includes(id)) {
        const work = orchestrator.workOn(id);
        if (opts.whileQueued === true && work === 'queued') {
          try {
            const result = await orchestrator.whileQueueHeld(() => apply(id));
            out.push({ projectId: id, index: offset + i + 1, ok: true, queued: true, ...(result === UNCHANGED ? { unchanged: true } : {}) });
          } catch (err) {
            out.push({ projectId: id, index: offset + i + 1, ok: false, error: toAppError(err).message });
          }
          continue;
        }
        out.push({ projectId: id, index: offset + i + 1, ok: false, skipped: partSkipReason(work) });
        continue;
      }
      try {
        const result = await apply(id);
        out.push({ projectId: id, index: offset + i + 1, ok: true, ...(result === UNCHANGED ? { unchanged: true } : {}) });
      } catch (err) {
        out.push({ projectId: id, index: offset + i + 1, ok: false, error: toAppError(err).message });
      }
    }
    return out;
  }

  /**
   * A series redoes a late step (series/partWork.ts SERIES_REDO_STEPS) in
   * every part that made it, in order; the others are left as they are and
   * say why (they use the change when they get there).
   */
  async function redoParts(
    parentId: string,
    partIds: readonly string[],
    stepId: PipelineStepId,
  ): Promise<{ projectId: string; index: number; started?: boolean; queued?: boolean; left?: string; error?: string }[]> {
    const offset = await series.numberOffsetOf(parentId);
    const out: { projectId: string; index: number; started?: boolean; queued?: boolean; left?: string; error?: string }[] = [];
    for (const [i, id] of partIds.entries()) {
      const index = offset + i + 1;
      const busy = orchestrator.busyProjects().includes(id) ? { work: orchestrator.workOn(id) } : undefined;
      const pipeline = busy ? undefined : await store.getPipeline(id).catch(() => undefined);
      const held = busy ? false : Boolean((await store.getProject(id).catch(() => undefined))?.pausedByUser);
      const action = partRedoAction(stepId, pipeline?.steps.find((s) => s.id === stepId)?.status, busy, held);
      if (!action.redo) {
        out.push({ projectId: id, index, left: action.reason });
        continue;
      }
      try {
        const r = await orchestrator.retryStep(id, stepId);
        out.push({ projectId: id, index, ...(r.queued ? { queued: true } : { started: true }) });
      } catch (err) {
        out.push({ projectId: id, index, error: toAppError(err).message });
      }
    }
    return out;
  }

  // Set a project's warnings aside (all, or those with these codes): the
  // user or an agent checked them. A step that runs again raises them again.
  app.post('/projects/:id/warnings/dismiss', async (req: FastifyRequest<{ Params: { id: string }; Body: { codes?: unknown } }>, reply) => {
    try {
      const codes = Array.isArray(req.body?.codes) ? req.body.codes.filter((c): c is string => typeof c === 'string') : undefined;
      const { dismissed, pipeline } = await orchestrator.dismissWarnings(req.params.id, codes);
      return { dismissed: dismissed.length, codes: [...new Set(dismissed.map((w) => w.code))], warnings: pipeline.warnings ?? [] };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The whole transcript as a file (a 10-hour series has ~19,000 lines: 48
  // pages of get_transcript), JSON or tab-separated, in the project's folder.
  app.post(
    '/projects/:id/transcript/export',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { format?: 'json' | 'tsv' } }>, reply) => {
      try {
        const segments = await orchestrator.getSegments(req.params.id);
        const format = req.body?.format === 'tsv' ? 'tsv' : 'json';
        const project = await store.getProject(req.params.id);
        const dir = join(project.workspaceDir, 'exports');
        await mkdir(dir, { recursive: true });
        const file = join(dir, `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`);
        const rows = segments.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          ...(s.speakerId ? { speakerId: s.speakerId } : {}),
          source: s.sourceText,
          ...(s.translatedText !== undefined ? { translation: s.translatedText } : {}),
          ...(s.loopSuspect ? { loopSuspect: true } : {}),
          // Every flag source.json carries (claude-dubber, 2026-11-25: the
          // export lacked the speaker and song marks a review works from).
          ...(s.speakerLowConfidence ? { speakerLowConfidence: true } : {}),
          ...(s.song ? { song: true } : {}),
          ...(s.locked ? { locked: true } : {}),
          ...(s.qualityFlags?.length ? { flags: s.qualityFlags } : {}),
        }));
        const clean = (t: string | undefined): string => (t ?? '').replace(/[\t\r\n]+/g, ' ');
        const body =
          format === 'json'
            ? JSON.stringify({ projectId: project.id, name: project.name, lines: rows }, null, 1)
            : [
                'id\tstartMs\tendMs\tspeaker\tsource\ttranslation\tflags',
                ...rows.map((r) =>
                  [r.id, r.startMs, r.endMs, r.speakerId ?? '', clean(r.source), clean(r.translation), [
                    ...(r.flags ?? []),
                    ...(r.loopSuspect ? ['loop?'] : []),
                    ...(r.speakerLowConfidence ? ['speaker?'] : []),
                    ...(r.song ? ['song'] : []),
                    ...(r.locked ? ['locked'] : []),
                  ].join(',')].join('\t'),
                ),
              ].join('\n');
        await writeTextAtomic(file, body);
        return { path: file, lines: rows.length, format };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // The line structure of a range (before translation): replace it, or hear it again.
  app.post(
    '/projects/:id/lines/replace',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { fromMs?: number; toMs?: number; lines?: { startMs: number; endMs: number; text: string; speakerId?: string }[] };
      }>,
      reply,
    ) => {
      try {
        const b = req.body ?? {};
        if (typeof b.fromMs !== 'number' || typeof b.toMs !== 'number' || !Array.isArray(b.lines)) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send fromMs, toMs and lines.' } });
        }
        return await orchestrator.replaceSourceLines(req.params.id, b.fromMs, b.toMs, b.lines);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Many ranges at once, one history entry (replace_lines with ranges or a file).
  app.post(
    '/projects/:id/lines/replace-many',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { ranges?: unknown } }>, reply) => {
      try {
        const ranges = req.body?.ranges;
        if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 2000) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send ranges: [{ fromMs, toMs, lines }] (1 to 2000 of them).' } });
        }
        const valid = ranges.every(
          (r: unknown) =>
            r && typeof r === 'object' && typeof (r as { fromMs?: unknown }).fromMs === 'number' && typeof (r as { toMs?: unknown }).toMs === 'number' && Array.isArray((r as { lines?: unknown }).lines),
        );
        if (!valid) return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Each range needs fromMs, toMs and lines.' } });
        return await orchestrator.replaceSourceRanges(
          req.params.id,
          ranges as { fromMs: number; toMs: number; lines: { startMs: number; endMs: number; text: string; speakerId?: string }[] }[],
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/projects/:id/lines/retranscribe',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { fromMs?: number; toMs?: number; noContext?: boolean; model?: string; apply?: boolean } }>,
      reply,
    ) => {
      try {
        const b = req.body ?? {};
        if (typeof b.fromMs !== 'number' || typeof b.toMs !== 'number') {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send fromMs and toMs.' } });
        }
        const res = await orchestrator.retranscribeRange(req.params.id, b.fromMs, b.toMs, {
          ...(b.noContext === false ? { noContext: false } : {}),
          ...(typeof b.model === 'string' && b.model.trim() ? { model: b.model.trim() } : {}),
          ...(b.apply === true ? { apply: true } : {}),
        });
        // Over 15 minutes it is a job: follow it on GET .../lines/retranscribe/:jobId.
        return res.job ? reply.status(202).send(res) : res;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Make the parts' transcripts again from the series transcript (series/seriesService.ts rebuildParts):
  // `parts` = only these part numbers; a queued part is rebuilt where it waits.
  app.post(
    '/projects/:id/series/rebuild-parts',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { force?: boolean; parts?: unknown } }>, reply) => {
      try {
        const parts = Array.isArray(req.body?.parts) ? req.body.parts.map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
        return { parts: await series.rebuildParts(req.params.id, { force: req.body?.force === true, ...(parts?.length ? { parts } : {}) }) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/series/ai-options', async (_req, reply) => {
    try {
      return await seriesAiOptions();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects/:id/series', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await series.view(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Review: move cuts, rename parts (or an agent's own cuts) before the parts are made.
  app.put(
    '/projects/:id/series/plan',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { cuts?: unknown; titles?: unknown } }>, reply) => {
      try {
        const cuts = Array.isArray(req.body?.cuts) ? req.body!.cuts.map(Number) : undefined;
        const titles = Array.isArray(req.body?.titles)
          ? (req.body!.titles as { title?: unknown; summary?: unknown }[]).map((t) => ({
              ...(typeof t?.title === 'string' ? { title: t.title } : {}),
              ...(typeof t?.summary === 'string' ? { summary: t.summary } : {}),
            }))
          : undefined;
        return await series.revisePlan(req.params.id, { ...(cuts ? { cuts } : {}), ...(titles ? { titles } : {}) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/projects/:id/series/parts', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return { partIds: await series.createParts(req.params.id) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Plan the cuts again (the AI failed, or another AI was set up since);
  // `keepTitles` keeps the titles and summaries written in review.
  app.post(
    '/projects/:id/series/replan',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { keepTitles?: boolean; perFile?: boolean } }>, reply) => {
    try {
      const view = await series.view(req.params.id);
      if (view.parts.some((p) => p.projectId)) {
        return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'The parts are already made.' } });
      }
      // One part per joined file, or back to parts by length.
      if (typeof req.body?.perFile === 'boolean') await series.setPerFile(view.parentId, req.body.perFile);
      void series.analysed(view.parentId, { again: true, keepTitles: req.body?.keepTitles === true });
      return reply.status(202).send({ planning: true });
    } catch (err) {
      return sendError(reply, err);
    }
    },
  );

  app.post('/projects/:id/series/start', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return { parts: await series.startParts(req.params.id) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Logo & greeting (the brand kit) -----------------------------------------

  const brandKit = new BrandKit({ dir: join(config.configDir, 'branding'), media, speak: speakWith });

  app.get('/branding', async () => brandKit.list());

  app.post(
    '/branding/logos',
    async (req: FastifyRequest<{ Body: { name?: string; path?: string } }>, reply) => {
      try {
        return reply.status(201).send(await brandKit.addLogo(req.body?.name ?? '', req.body?.path ?? ''));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A greeting from a file (`path`), or said by an installed voice (`text` + `voiceId`).
  app.post(
    '/branding/greetings',
    async (
      req: FastifyRequest<{ Body: { name?: string; path?: string; text?: string; voiceId?: string; language?: string } }>,
      reply,
    ) => {
      try {
        const b = req.body ?? {};
        const asset =
          b.text && b.voiceId
            ? await brandKit.addSpokenGreeting(b.name ?? '', b.text, b.voiceId, b.language?.trim() || 'vi-VN')
            : await brandKit.addGreeting(b.name ?? '', b.path ?? '');
        return reply.status(201).send(asset);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete('/branding/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await brandKit.delete(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The file itself, for the previews (an <img>, an <audio>).
  app.get('/branding/:id/file', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const asset = await brandKit.get(req.params.id);
      reply.header('Content-Type', asset.kind === 'logo' ? 'image/png' : 'audio/wav');
      reply.header('Cache-Control', 'no-cache');
      return reply.send(createReadStream(asset.path));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Where the greeting plays: the last mix's plan, or (before any mix) what the
  // planner would choose now, marked `preview`.
  app.get('/projects/:id/greeting-plan', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const project = await store.getProject(req.params.id);
      const paths = store.paths(req.params.id);
      const settings = project.settings.branding?.greeting;
      if (!settings) return { plan: null };
      const saved = await readGreetingPlan(paths.greetingPlanJson);
      if (saved && saved.settingsKey === greetingSettingsKey(settings)) return { plan: saved };
      const asset = await brandKit.get(settings.assetId).catch(() => undefined);
      const aligned = JSON.parse(await readFile(paths.translatedAlignedJson, 'utf8').catch(() => '[]')) as AlignedSegment[];
      const durationMs = project.mediaInfo?.durationMs ?? 0;
      if (!asset?.durationMs || durationMs <= 0) return { plan: null };
      const busy = [...dubWindows(aligned), ...(await originalSpeech(paths.speechRegionsJson, paths.sourceJson))];
      return {
        plan: { ...planGreetings({ assetId: settings.assetId, durationMs, greetingMs: asset.durationMs, busy, settings }), preview: true },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The editor moved, added or removed greetings: kept as they are (until the
  // greeting settings change), and the mix is out of date (Render remixes).
  app.put(
    '/projects/:id/greeting-plan',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { placements?: unknown } }>, reply) => {
      try {
        const project = await store.getProject(req.params.id);
        const settings = project.settings.branding?.greeting;
        if (!settings) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'This project plays no greeting: choose one first.' } });
        }
        const asset = await brandKit.get(settings.assetId);
        const raw = Array.isArray(req.body?.placements) ? (req.body!.placements as { atMs: number; kind: 'opening' | 'repeat' }[]) : [];
        const checked = validatePlacements(raw.slice(0, 50), project.mediaInfo?.durationMs ?? 0, asset.durationMs ?? 0);
        if (!checked.ok) return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: checked.reason } });
        const plan = {
          assetId: settings.assetId,
          durationMs: asset.durationMs ?? 0,
          placements: checked.placements,
          requested: checked.placements.filter((p) => p.kind === 'repeat').length,
          found: checked.placements.filter((p) => p.kind === 'repeat').length,
          settingsKey: greetingSettingsKey(settings),
          edited: true,
        };
        await writeJsonAtomic(store.paths(req.params.id).greetingPlanJson, plan);
        return { plan };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Batches: presets, a dub per finished download, outputs ----------------

  const presets = new PresetStore(config.configDir);

  app.get('/presets', async () => presets.list());

  app.post('/presets', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    try {
      return reply.status(201).send(await presets.save(cleanPresetInput(req.body)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/presets/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply) => {
    try {
      return await presets.save(cleanPresetInput(req.body), req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/presets/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await presets.delete(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Batch dubs waiting for the models they need (a new language's pack,
   * whisper.cpp's model): started as soon as the downloads end, instead of
   * failing the batch at Start with "still downloading".
   */
  const waitingForModels = new Set<string>();
  const downloadingModels = (): boolean => installer.isRunning() || engineInstaller.installingAny();
  const startWhenReady = async (projectId: string): Promise<{ started?: boolean; queued?: boolean; waiting?: boolean }> => {
    try {
      return await orchestrator.runPipeline(projectId);
    } catch (err) {
      if (!downloadingModels()) throw err;
      if (!waitingForModels.has(projectId)) {
        waitingForModels.add(projectId);
        const retry = (): void => {
          // Paused or stopped meanwhile (POST /pause or /cancel took it off
          // the list): it starts only when asked again.
          if (!waitingForModels.has(projectId)) return;
          if (downloadingModels()) {
            setTimeout(retry, 15_000).unref();
            return;
          }
          waitingForModels.delete(projectId);
          void runAsScheduler(() => orchestrator.runPipeline(projectId)).catch((e: unknown) => {
            bus.get(projectId).emit({ type: 'error', error: toAppError(e) });
          });
        };
        setTimeout(retry, 15_000).unref();
      }
      return { waiting: true };
    }
  };

  /**
   * The built-in presets for these languages (workspace/builtinPresets.ts):
   * Highest quality, Balanced, Lowest cost, on this computer's engines only.
   */
  async function builtinPresetsFor(sourceLanguage: string, targetLanguage: string): Promise<DubPreset[]> {
    const described = registry.describe();
    const saved = (await setupStore.getPreferences().catch(() => undefined))?.providerDefaults ?? {};
    const replacedCloud = (['stt', 'translation', 'tts'] as const).flatMap((phase) => {
      const id = saved[`${phase}ProviderId`];
      const provider = id ? described[phase].find((p) => p.id === id) : undefined;
      return provider && !provider.isLocal ? [{ phase, name: provider.displayName }] : [];
    });
    const [local, speakerDetection] = await Promise.all([
      projectDefaultsFor(sourceLanguage, targetLanguage, { localOnly: true }),
      diarization.available().catch(() => false),
    ]);
    return builtinPresets({ local: local.settings, replacedCloud, speakerDetection }, new Date().toISOString());
  }

  /** A preset by id: the user's, or a built-in one worked out for the job's languages (which it then needs). */
  async function presetById(presetId: string, languages: { sourceLanguage?: string; targetLanguage?: string }): Promise<DubPreset> {
    if (!isBuiltinPresetId(presetId)) return presets.get(presetId);
    const target = languages.targetLanguage?.trim();
    if (!target) {
      throw new AppErrorException('INVALID_LANGUAGE', `Say which language to dub into: the built-in preset "${presetId}" works for any language.`, {
        remediation: 'Give targetLanguage (e.g. "vi-VN") and sourceLanguage (e.g. "zh") with it.',
      });
    }
    const found = (await builtinPresetsFor(languages.sourceLanguage?.trim() ?? '', target)).find((p) => p.id === presetId.trim());
    if (!found) {
      throw new AppErrorException('INVALID_EDIT', `There is no built-in preset "${presetId}".`, {
        remediation: 'The built-in presets are builtin:quality, builtin:balanced and builtin:economy (GET /presets/builtin).',
      });
    }
    return found;
  }

  app.get(
    '/presets/builtin',
    async (req: FastifyRequest<{ Querystring: { sourceLanguage?: string; targetLanguage?: string } }>, reply) => {
      try {
        return await builtinPresetsFor(req.query.sourceLanguage ?? '', req.query.targetLanguage?.trim() || 'vi-VN');
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  /**
   * A job made from a preset (`presetId` on POST /projects and POST
   * /projects/join): the machine's recommended settings, the preset's over
   * them, the job's own over both; the preset's save folder ({series}: the
   * job's name) and, for a video longer than its series block allows
   * (`durationMs`), that block, unless the job asks for a series itself. Any
   * save folder's {series} is filled in. Every job the claude-dubber agent
   * makes is a create_project or a join_videos of one preset (2026-11-25).
   */
  async function presetJob<T extends { name: string; presetId?: string; settings?: Partial<ProjectSettings>; outputDir?: string; series?: Partial<SeriesSettings> }>(
    body: T,
    durationMs: () => Promise<number | undefined>,
    /** The name the job gets when it is given none (the file's), for {series}. */
    fallbackName?: string,
  ): Promise<T & { settings: ProjectSettings }> {
    if (!body || typeof body !== 'object') return body as T & { settings: ProjectSettings };
    const { presetId, ...rest } = body;
    const jobName = (typeof rest.name === 'string' && rest.name.trim()) || fallbackName || '';
    const named = (dir: string | undefined): { outputDir?: string } => (dir?.trim() ? { outputDir: resolveOutputDir(dir.trim(), jobName) } : {});
    if (!presetId) return { ...(rest as T & { settings: ProjectSettings }), ...named(rest.outputDir) };
    const own: Partial<ProjectSettings> = rest.settings ?? {};
    const preset = await presetById(presetId, own);
    const targetLanguage = own.targetLanguage?.trim() || preset.targetLanguage;
    const sourceLanguage = own.sourceLanguage?.trim() || preset.sourceLanguage?.trim() || '';
    if (!sourceLanguage) {
      throw new AppErrorException('INVALID_LANGUAGE', `Say which language the video speaks: the preset "${preset.name}" does not say.`, {
        remediation: 'Give sourceLanguage (e.g. "zh"), or save it in the preset.',
      });
    }
    const defaults = await projectDefaultsFor(sourceLanguage, targetLanguage);
    const settings = { ...defaults.settings, ...preset.settings, ...own, sourceLanguage, targetLanguage } as ProjectSettings;
    const seriesOf = (s: Partial<SeriesSettings>): SeriesSettings => ({ ...s, maxMinutes: Math.max(s.maxMinutes ?? 0, s.minMinutes ?? 0) }) as SeriesSettings;
    let series = rest.series as Partial<SeriesSettings> | undefined;
    if (preset.series) {
      const { longerThanMinutes, ...block } = preset.series;
      if (series) series = { ...block, ...series };
      else {
        const longer = (longerThanMinutes ?? (block.maxMinutes ?? DEFAULT_SERIES_SETTINGS.maxMinutes) * 1.5) * 60_000;
        const ms = await durationMs();
        if (ms !== undefined && ms > longer) series = block;
      }
    }
    return {
      ...(rest as T),
      settings,
      ...named(rest.outputDir || preset.outputDir),
      // Parts start by themselves unless the preset or the job says otherwise, as dub_downloads does.
      ...(series ? { series: seriesOf({ ...DEFAULT_SERIES_SETTINGS, autoStart: true, ...series }) } : {}),
    };
  }

  /** A project's name from its download: the title, and the part when the video has several. */
  const projectNameFor = (item: DownloadItem): string => {
    const s = item.source;
    if (!s) return item.filePath ? item.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : item.id;
    return s.partCount > 1 ? `${s.title} - P${s.page}${s.partTitle ? ` ${s.partTitle}` : ''}` : s.title;
  };

  app.post('/downloads/dub', async (req: FastifyRequest<{ Body: Partial<DubDownloadsRequest> }>, reply) => {
    try {
      const body = req.body ?? {};
      const ids = Array.isArray(body.downloadIds) ? body.downloadIds.filter((x): x is string => typeof x === 'string') : [];
      if (ids.length === 0 || ids.length > 200) {
        return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send between 1 and 200 download ids in "downloadIds".' } });
      }
      const preset = body.presetId
        ? await presetById(body.presetId, {
            ...(body.sourceLanguage ? { sourceLanguage: body.sourceLanguage } : {}),
            ...(body.targetLanguage ? { targetLanguage: body.targetLanguage } : {}),
          })
        : undefined;
      const targetLanguage = body.targetLanguage?.trim() || preset?.targetLanguage;
      if (!targetLanguage) {
        return reply.status(400).send({ error: { code: 'INVALID_LANGUAGE', message: 'Say which language to dub into: "targetLanguage", or a preset that has one.' } });
      }
      // The app never guesses the spoken language (a wrong one transcribes
      // fluent nonsense), and an empty one failed every video of the batch.
      const sourceLanguage = body.sourceLanguage?.trim() || preset?.sourceLanguage?.trim() || '';
      if (!sourceLanguage) {
        return reply.status(400).send({
          error: { code: 'INVALID_LANGUAGE', message: 'Say which language the videos speak: "sourceLanguage" (e.g. "zh"), or a preset that has one.' },
        });
      }
      const defaults = await projectDefaultsFor(sourceLanguage, targetLanguage);
      const settings: ProjectSettings = {
        ...defaults.settings,
        ...(preset?.settings ?? {}),
        ...(body.settings ?? {}),
        sourceLanguage,
        targetLanguage,
      };
      const outputDir = body.outputDir?.trim() || preset?.outputDir;
      const start = body.start ?? preset?.start ?? false;
      // Long ones as a series: an AI from Settings chooses the cuts. The
      // request's own series block, else the preset's.
      const seriesAsk = body.series ? { ...(preset?.series ?? {}), ...body.series } : preset?.series;
      let seriesFor: ((durationSec: number | undefined) => CreateProjectInput['series']) | undefined;
      if (seriesAsk) {
        const chosen = pickSeriesAi(await seriesAiOptions(), seriesAsk.aiProviderId);
        if (!chosen) {
          const { error } = toHttpError(seriesAiRefusal(seriesAsk.aiProviderId));
          return reply.status(400).send({ error });
        }
        const minMinutes = seriesAsk.minMinutes ?? 15;
        const maxMinutes = seriesAsk.maxMinutes ?? 20;
        const longer = (seriesAsk.longerThanMinutes ?? maxMinutes * 1.5) * 60;
        const nameTemplate = seriesAsk.nameTemplate?.trim();
        if (nameTemplate) series.checkNameTemplate(nameTemplate);
        seriesFor = (durationSec) =>
          durationSec !== undefined && durationSec > longer
            ? {
                minMinutes,
                maxMinutes,
                aiProviderId: chosen.id,
                recapSec: seriesAsk.recapSec ?? 4,
                autoStart: seriesAsk.autoStart ?? true,
                ...(nameTemplate ? { nameTemplate } : {}),
              }
            : undefined;
      }
      const results: DubDownloadResult[] = [];
      for (const downloadId of ids) {
        const item = downloads.get(downloadId);
        if (!item || item.state !== 'done' || !item.filePath) {
          results.push({
            downloadId,
            error: toAppError(
              new AppErrorException('INVALID_EDIT', item ? `"${downloadId}" has not finished downloading (${item.state}).` : `There is no download "${downloadId}".`),
            ),
          });
          continue;
        }
        try {
          // The file's own length decides, as for POST /projects: the site's
          // figure can be wrong (5:07:58 for a file of 4:06:21, BV1oSeb6cE7G,
          // 2026-11-27). The site's only when the file cannot be read.
          const fileMs = seriesFor ? (await media.probe(item.filePath).catch(() => undefined))?.durationMs : undefined;
          const series = seriesFor?.(fileMs !== undefined ? fileMs / 1000 : item.source?.durationSec);
          const project = await orchestrator.createProject({
            name: projectNameFor(item),
            inputVideoPath: item.filePath,
            settings,
            ...(outputDir ? { outputDir: resolveOutputDir(outputDir, projectNameFor(item)) } : {}),
            linkInputVideo: true,
            ...(item.source ? { source: item.source } : {}),
            ...(series ? { series } : {}),
          });
          downloads.linkProject(downloadId, project.id);
          await orchestrator.probe(project.id);
          await ensureResourcesFor(project).catch(() => undefined);
          const run = start ? await startWhenReady(project.id) : undefined;
          results.push({ downloadId, projectId: project.id, name: project.name, ...(series ? { series: true } : {}), ...(run ?? {}) });
        } catch (err) {
          results.push({ downloadId, error: toAppError(err) });
        }
      }
      return { results };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** sha256 of a finished video, kept beside the project's cache by size and time (a re-render changes both). */
  const sha256Of = async (project: Project, file: string, size: number, mtimeMs: number): Promise<string> => {
    const cacheFile = join(project.workspaceDir, 'cache', 'output-sha256.json');
    const key = `${file}|${size}|${Math.floor(mtimeMs)}`;
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { key?: string; sha256?: string };
      if (cached.key === key && cached.sha256) return cached.sha256;
    } catch {
      /* not computed yet */
    }
    const hash = createHash('sha256');
    for await (const chunk of openReadStream(file)) hash.update(chunk as Buffer);
    const sha256 = hash.digest('hex');
    await writeJsonAtomic(cacheFile, { key, sha256 }).catch(() => undefined);
    return sha256;
  };

  // What a finished dub is, for posting it: files, source, caption parts,
  // where it was posted (the plugin's get_outputs).
  app.get('/projects/:id/outputs', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const { project, pipeline } = await orchestrator.getProjectWithPipeline(req.params.id);
      const files = [];
      for (const file of projectOutputFiles(project)) {
        const s = await stat(file).catch(() => undefined);
        if (!s || s.size === 0) continue;
        const lower = file.toLowerCase();
        const kind = lower.endsWith('.mp4') ? 'video' : lower.endsWith('.vtt') ? 'vtt' : lower.endsWith('.jpg') ? 'thumbnail' : 'srt';
        files.push({
          kind,
          path: file,
          sizeBytes: s.size,
          ...(kind === 'video' ? { sha256: await sha256Of(project, file, s.size, s.mtimeMs) } : {}),
        });
      }
      return {
        projectId: project.id,
        name: project.name,
        status: project.status,
        finished: pipeline.status === 'completed',
        ...(project.mediaInfo?.durationMs ? { durationMs: project.mediaInfo.durationMs } : {}),
        targetLanguage: project.settings.targetLanguage,
        files,
        ...(project.source ? { source: project.source } : {}),
        // A series part: which one, and its title and summary for the caption.
        ...(project.series?.role === 'part'
          ? {
              part: {
                index: project.series.index,
                count: project.series.count,
                seriesName: project.series.seriesName,
                ...(project.series.title ? { title: project.series.title } : {}),
                ...(project.series.summary ? { summary: project.series.summary } : {}),
              },
            }
          : {}),
        published: project.published ?? [],
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Where the dub was posted (Mother Claude after each post): a rerun never
  // posts twice even when its own notes are lost, and the app shows it.
  app.post(
    '/projects/:id/published',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { url?: unknown; part?: unknown } }>, reply) => {
      try {
        const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        if (!/^https?:\/\/\S+$/i.test(url)) {
          return reply.status(400).send({ error: { code: 'INVALID_EDIT', message: 'Send the post\'s address in "url" (https://…).' } });
        }
        const part = Number.isInteger(req.body?.part) && (req.body!.part as number) > 0 ? (req.body!.part as number) : undefined;
        const project = await store.getProject(req.params.id);
        const record = { url, at: new Date().toISOString(), ...(part ? { part } : {}) };
        const saved = await store.saveProject({ ...project, published: [...(project.published ?? []), record] });
        return { published: saved.published ?? [] };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Ollama models (lazy, on-demand: large optional translation models) ----

  app.get('/providers/ollama/models', async (_req, reply) => {
    try {
      const models = await listOllamaModels(OLLAMA_URL);
      return { models, configured: OLLAMA_MODEL, present: models.includes(OLLAMA_MODEL) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/providers/ollama/pull', async (req: FastifyRequest<{ Body: { model?: string } }>, reply) => {
    try {
      const model = req.body?.model?.trim() || OLLAMA_MODEL;
      const state = ollamaPulls.start(model);
      return reply.status(202).send({ model, ...state });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/providers/ollama/pull-status', async (req: FastifyRequest<{ Querystring: { model?: string } }>, reply) => {
    try {
      const model = req.query?.model?.trim() || OLLAMA_MODEL;
      return { model, ...ollamaPulls.status(model) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Argos translation packs (browse the full index + remove) ------------
  // Listing/removal proxy the Translation worker (the source of truth for what's
  // installed). Installation reuses POST /setup/install with `argosPairs` (SSE
  // progress via /setup/events), so there is no separate install route here.
  const trWorker = (): string => config.translationWorkerUrl.replace(/\/$/, '');

  app.get(
    '/providers/argos/packages',
    async (req: FastifyRequest<{ Querystring: { refresh?: string } }>, reply) => {
      try {
        const refresh = req.query?.refresh === 'true' || req.query?.refresh === '1';
        const data = await getWorkerJson<{ installed?: ArgosPair[]; available?: ArgosPair[] }>(
          `${trWorker()}/packages${refresh ? '?refresh=true' : ''}`,
          { timeoutMs: config.workerRequestTimeoutMs, workerName: 'Translation worker' },
        );
        return { installed: data.installed ?? [], available: data.available ?? [] };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/providers/argos/packages/ensure',
    async (req: FastifyRequest<{ Body: { from?: string; to?: string } }>, reply) => {
      try {
        const from = req.body?.from?.trim();
        const to = req.body?.to?.trim();
        if (!from || !to) {
          throw new AppErrorException('INVALID_LANGUAGE', 'Both "from" and "to" are required.');
        }
        // Synchronous (the download held open). The app no longer calls it:
        // Settings installs a pack through /setup/install like onboarding, so
        // its progress survives leaving the page (a request held open here
        // died with the page, 0.17.0). Kept for scripts and older clients.
        const data = await postWorkerJson<{ ok?: boolean; installed?: boolean }>(
          `${trWorker()}/packages/ensure`,
          { from, to },
          { timeoutMs: config.workerRequestTimeoutMs, workerName: 'Translation worker' },
        );
        if (data?.ok) await setupStore.addArgosPair({ from, to });
        return { ok: data?.ok ?? false, installed: data?.installed ?? false };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/providers/argos/packages/remove',
    async (req: FastifyRequest<{ Body: { from?: string; to?: string } }>, reply) => {
      try {
        const from = req.body?.from?.trim();
        const to = req.body?.to?.trim();
        if (!from || !to) {
          throw new AppErrorException('INVALID_LANGUAGE', 'Both "from" and "to" are required.');
        }
        const data = await postWorkerJson<{ ok?: boolean; removed?: boolean }>(
          `${trWorker()}/packages/remove`,
          { from, to },
          { timeoutMs: config.workerRequestTimeoutMs, workerName: 'Translation worker' },
        );
        // Keep the setup inventory in sync so required-resource checks re-request
        // the pair for a future run instead of assuming it's still installed.
        if (data?.removed) await setupStore.removeArgosPair({ from, to });
        return { ok: data?.ok ?? false, removed: data?.removed ?? false };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Engine packs (download/manage optional accelerated engines) ---------

  // The installed packs' pinned files, read-only (engines/installedFiles.ts):
  // where each model is, its size and the sha256 it was verified against.
  app.get('/engines/installed', async (_req, reply) => {
    try {
      return await installedPackFiles(enginePackStore);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/engines', async (_req, reply) => {
    try {
      // Report only USABLE packs as installed: one whose venv/binary is broken
      // (e.g. a venv whose bundled-Python target moved on reinstall) drops out of
      // "installed" so it reappears as installable — a re-install repairs it —
      // instead of looking installed but failing at run with "venv missing".
      const recorded = await enginePackStore.list();
      const usable = await Promise.all(recorded.map((r) => isPackUsable(enginePackStore, r.id)));
      const installed = recorded.filter((_, i) => usable[i]);
      // Show ONLY packs that can actually RUN on this machine: platform/arch (via
      // availablePacks) + the accelerator the build needs (CUDA→NVIDIA, Metal→
      // Apple Silicon) + RAM/VRAM. This hides, e.g., a CUDA pack on a GPU-less
      // Windows laptop instead of offering a dead "Install". An already-installed
      // pack is always kept so its Remove button never vanishes. If hardware
      // detection fails, fall back to the platform-compatible list (never 500).
      let available = availablePacks();
      try {
        const { profile } = await buildSystemResponse();
        const installedIds = new Set(installed.map((i) => i.id));
        available = available.filter((p) => installedIds.has(p.id) || packHardwareSupported(p, profile));
      } catch {
        /* detection failed — show the platform-compatible list unfiltered */
      }
      // An installed pack is "updatable" when the catalog now declares a different
      // artifact version than the one recorded at install time (reinstall to get it).
      const updatable = installed
        .filter((i) => {
          const cat = findPack(i.id);
          return cat?.version != null && i.version !== cat.version;
        })
        .map((i) => i.id);
      // When several installed packs serve the SAME function (four Gemma chat
      // models, say), tell the UI which one actually runs — otherwise every row
      // reads "Installed" and the user can't tell what they're getting.
      const chosen = (await setupStore.getPreferences().catch(() => undefined))?.localModels;
      const activeSelections = await resolveActivePackSelections(enginePackStore, undefined, chosen ?? {}).catch(() => []);
      return { available, installed, updatable, activeSelections };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/engines/recommended', async (_req, reply) => {
    try {
      const { profile, recommendation } = await buildSystemResponse();
      // `fits` = packs that run WELL here (accelerator present AND enough RAM/VRAM),
      // driving the "✓ can run" vs "⚠ may be slow" badge. The shown list (/engines)
      // is broader — accelerator-only — so a memory-heavy pack (e.g. the 27B model)
      // still appears, just badged ⚠, and the user can choose to install it.
      const fits = availablePacks()
        .filter((p) => packHardwareSupported(p, profile) && packFitsMachine(p, profile))
        .map((p) => p.id);
      return { recommendations: recommendEnginePacks(profile, recommendation), fits };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // System tools some engines rely on, so the UI can guide the user. uv is
  // bundled with the packaged app (zero prerequisites); Ollama is an optional
  // user-run daemon (the llama.cpp engine pack is the no-daemon alternative).
  app.get('/engines/prerequisites', async (_req, reply) => {
    try {
      const [uvPath, obtainable, ollamaOk] = await Promise.all([
        resolveUvPath(),
        uvObtainable(),
        fetch(`${OLLAMA_URL}/models`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false),
      ]);
      // Compare against the TRIMMED env var (resolveUvPath returns the trimmed
      // path), so surrounding whitespace doesn't yield a false "not bundled".
      const bundledUv = process.env.VIDEODUBBER_UV_PATH?.trim();
      return {
        // `obtainable` is what the UI should gate Install on: when uv is absent
        // but downloadable, the install flow fetches it (pinned + checksummed)
        // as its first step, so there is nothing for the user to do.
        uv: { available: uvPath !== null, bundled: Boolean(bundledUv && uvPath === bundledUv), obtainable },
        ollama: { available: ollamaOk },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Claude (MCP) ---------------------------------------------------------
  // Settings → Claude: how Claude Desktop / Claude Code start VideoDubber's MCP
  // server, and a one-click connect for Claude Desktop (integrations/claude.ts).
  // The command written is always this app's own binary — never from the request.
  app.get('/integrations/claude', async (_req, reply) => {
    try {
      return await claudeIntegrationStatus();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/integrations/claude/desktop',
    async (req: FastifyRequest<{ Body: { connect?: boolean } }>, reply) => {
      try {
        return await setClaudeDesktopConnection(req.body?.connect !== false);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Claude Code: connect / reconnect / disconnect through its own CLI (its
  // .claude.json is only ever read here). Answers with the whole status.
  app.post(
    '/integrations/claude/code',
    async (req: FastifyRequest<{ Body: { action?: ClaudeCodeAction } }>, reply) => {
      try {
        await setClaudeCodeConnection(req.body?.action ?? 'connect');
        return await claudeIntegrationStatus();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/engines/install', async (req: FastifyRequest<{ Body: { packId?: string } }>, reply) => {
    try {
      const packId = req.body?.packId;
      if (!packId || !findPack(packId)) {
        return reply.status(400).send({ error: { code: 'ENGINE_PACK_MISSING', message: `Unknown engine pack "${packId}".` } });
      }
      // Kick off asynchronously; progress observed via GET /engines/events.
      void engineInstaller.install(packId);
      // A model pack cannot run without its runtime: install the best one for
      // this machine alongside it when none is installed, and the processor
      // build too where a graphics build cannot fall back (companionRuntimesFor).
      const profile = (await buildSystemResponse().catch(() => undefined))?.profile;
      const companions = profile ? await companionRuntimesFor(enginePackStore, packId, profile) : [];
      for (const c of companions) if (!engineInstaller.isInstalling(c)) void engineInstaller.install(c);
      return reply.status(202).send({ started: true, ...(companions.length ? { alsoInstalling: companions } : {}) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/engines/uninstall', async (req: FastifyRequest<{ Body: { packId?: string } }>, reply) => {
    try {
      const packId = req.body?.packId;
      if (!packId) {
        return reply.status(400).send({ error: { code: 'UNKNOWN', message: 'Missing "packId".' } });
      }
      await engineManager.stop(packId).catch(() => undefined);
      await enginePackStore.remove(packId);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/engines/events', (req, reply) => {
    reply.raw.writeHead(200, sseHeaders(req)).flushHeaders();
    reply.hijack();
    const write = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = engineBus.subscribe((event) => write(event));
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ---- Storage management (free up disk space) -----------------------------

  // The app's deletable, re-downloadable on-disk footprint (engine packs +
  // downloaded models + caches under the config dir). Projects are NOT included.
  app.get('/storage', async (_req, reply) => {
    try {
      const downloadsPath = downloadsDirFor(store.projectsDir);
      return {
        ...(await describeStorage(config, enginePackStore)),
        downloads: { path: downloadsPath, bytes: await dirSize(downloadsPath) },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Delete the requested categories (default: all) and reconcile the stores, so
  // the next run re-downloads what it needs. Running engines are stopped first.
  app.post(
    '/storage/clear',
    async (req: FastifyRequest<{ Body: { engines?: boolean; models?: boolean; cache?: boolean } }>, reply) => {
      try {
        return await clearStorage(req.body ?? {}, { config, enginePackStore, setupStore, engineManager });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- System profile + hardware-aware recommendation ----------------------

  app.get('/system', async (_req, reply) => {
    try {
      return await buildSystemResponse();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Cloud credentials (masked; full keys never leave the orchestrator) --

  app.get('/credentials', async (_req, reply) => {
    try {
      return { services: await credentials.describe() };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/credentials', async (req: FastifyRequest<{ Body: SaveCredentialRequest }>, reply) => {
    try {
      const body = req.body;
      if (!body || !ALL_CLOUD_SERVICES.includes(body.service as CloudServiceId)) {
        return reply
          .status(400)
          .send({ error: { code: 'UNKNOWN', message: `Unknown cloud service "${body?.service}".` } });
      }
      // A mistyped Mother Claude address is the user's input, not a server fault.
      if (typeof body.motherClaudeUrl === 'string' && body.motherClaudeUrl.trim()) {
        try {
          normalizeMotherClaudeUrl(body.motherClaudeUrl);
        } catch (err) {
          return reply.status(400).send({ error: toHttpError(err).error });
        }
      }
      await credentials.save(body);
      return { ok: true, services: await credentials.describe() };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/credentials/test',
    async (req: FastifyRequest<{ Body: { service?: CloudServiceId } }>, reply) => {
      try {
        const service = req.body?.service;
        if (!service || !ALL_CLOUD_SERVICES.includes(service)) {
          return reply
            .status(400)
            .send({ error: { code: 'UNKNOWN', message: `Unknown cloud service "${service}".` } });
        }
        return await testCloudCredential(credentials, service);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Is Mother Claude's HTTP API running at the saved address? A GET of its
  // model list (no tokens), for the status Settings shows beside the steps.
  app.get('/credentials/mother-claude', async (_req, reply) => {
    try {
      const target = await credentials.motherClaude();
      return await probeMotherClaude(target.url, target.apiKey);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Projects -----------------------------------------------------------

  app.post('/projects', async (req: FastifyRequest<{ Body: CreateProjectInput }>, reply) => {
    try {
      // A video VideoDubber downloaded is linked into the project (no second
      // copy on the drive) and keeps its source (site, link, uploader), however
      // the project is made: New project, the plugin, a batch.
      // From a preset: the job's own choices over it (presetJob).
      const input = typeof req.body?.inputVideoPath === 'string' ? req.body.inputVideoPath : undefined;
      const body: CreateProjectInput = await presetJob(
        req.body,
        async () => (input ? (await media.probe(input).catch(() => undefined))?.durationMs : undefined),
        input ? parsePath(input).name : undefined,
      );
      // A series needs an AI from Settings to choose the cuts (the user's call, 2026-11-19).
      if (body?.series) {
        const wanted = body.series.aiProviderId;
        const chosen = pickSeriesAi(await seriesAiOptions(), wanted);
        if (!chosen) {
          const { error } = toHttpError(seriesAiRefusal(wanted));
          return reply.status(400).send({ error });
        }
        body.series = { ...body.series, aiProviderId: chosen.id };
        // Its part name template checked; continuing another series: that one's name and numbers.
        body.series = await series.prepareSeries(body.series);
      }
      const fromDownload =
        typeof body?.inputVideoPath === 'string'
          ? downloads.list().find((d) => d.state === 'done' && d.filePath && samePath(d.filePath, body.inputVideoPath))
          : undefined;
      const project = await orchestrator.createProject(
        fromDownload ? { ...body, linkInputVideo: true, ...(fromDownload.source ? { source: fromDownload.source } : {}) } : body,
      );
      if (fromDownload) downloads.linkProject(fromDownload.id, project.id);
      return reply.status(201).send(project);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Delete a project from the list: its folder, and its finished files only
  // when they are in it (ProjectStore.deleteProject). Refused while it is busy.
  app.delete('/projects/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await orchestrator.deleteProject(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Settings → Projects folder: where the projects live, and moving them all
  // to another folder (in the background: GET reports how far it is).
  app.get('/storage/projects-folder', async (_req, reply) => {
    try {
      return await projectsFolder.info();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put('/storage/projects-folder', async (req: FastifyRequest<{ Body: ProjectsFolderRequest }>, reply) => {
    try {
      const root = req.body?.root;
      if (root !== null && typeof root !== 'string') {
        return reply.status(400).send({ error: { code: 'UNKNOWN', message: 'Expected { root: string | null }.' } });
      }
      const info = await projectsFolder.move(root);
      return reply.status(info.moving ? 202 : 200).send(info);
    } catch (err) {
      const { status, error } = toHttpError(err);
      // A folder the user chose that does not work is their input, not a server fault.
      return reply.status(error.code === 'UNKNOWN' ? 400 : status).send({ error });
    }
  });

  // New project after Back: the same project, as the form now is (only a
  // project that has never run). Continue used to create another one each time.
  app.put(
    '/projects/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: ReviseProjectInput }>, reply) => {
      try {
        const body = req.body;
        if (
          !body ||
          typeof body.name !== 'string' ||
          !body.settings ||
          typeof body.settings !== 'object' ||
          (body.inputVideoPath !== undefined && typeof body.inputVideoPath !== 'string')
        ) {
          return reply
            .status(400)
            .send({ error: { code: 'UNKNOWN', message: 'Expected { name, settings, inputVideoPath? }.' } });
        }
        // "Split into parts" as the form now holds it: checked as at creation.
        if (body.series) {
          const chosen = pickSeriesAi(await seriesAiOptions(), body.series.aiProviderId);
          if (!chosen) {
            return reply.status(400).send({
              error: { code: 'CLOUD_CREDENTIALS_MISSING', message: 'Splitting a video into parts needs an AI set up in Settings.' },
            });
          }
          body.series = await series.prepareSeries({ ...body.series, aiProviderId: chosen.id });
        }
        return await orchestrator.reviseProject(req.params.id, body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Where a project saves its finished video and subtitles: a folder, or null
  // for its own folder in the app's data. Moves already-rendered files along.
  app.put(
    '/projects/:id/output-dir',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { outputDir?: string | null } }>, reply) => {
      try {
        return await orchestrator.setProjectOutputDir(req.params.id, req.body?.outputDir ?? null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Each project with the count of its lines to look at, when it has any (H7).
  app.get('/projects', async (_req, reply) => {
    try {
      return await orchestrator.listProjectsWithIssues();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The project's lines to look at: still flagged by the checks, voices running over.
  app.get('/projects/:id/issues', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.lineIssues(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.getProjectWithPipeline(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/probe', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.probe(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/run', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      // A series whose parts are made continues as a whole: its parts, in order.
      if ((await series.partIdsOf(req.params.id).catch(() => [])).length > 0) {
        return reply.status(202).send({ started: true, queued: false, parts: await series.startParts(req.params.id) });
      }
      const result = await orchestrator.runPipeline(req.params.id);
      return reply.status(202).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const waiting = waitingForModels.delete(req.params.id);
      const was = await orchestrator.cancelJob(req.params.id, { byUser: true });
      return { ok: true, was: waiting && was === 'idle' ? 'waiting' : was };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Pause a dub: it stops at once, keeps everything done so far, and POST
  // /projects/:id/run continues it later, after a restart too. Answers once
  // the paused state is saved, with what it found (`was`): running, queued
  // (taken out before it started), waiting for its models, or idle. A part
  // paused here stays paused when its series is started (Project.pausedByUser).
  app.post('/projects/:id/pause', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      // A series parent pauses all its parts too (in order, so they resume in order).
      const parts = await series.partIdsOf(req.params.id).catch(() => [] as string[]);
      if (parts.length > 0) {
        if (orchestrator.busyProjects().includes(req.params.id)) await orchestrator.pauseJob(req.params.id);
        return { ok: true, pausedParts: await series.pauseParts(req.params.id) };
      }
      const waiting = waitingForModels.delete(req.params.id);
      const was = await orchestrator.pauseJob(req.params.id, { byUser: true });
      return { ok: true, was: waiting && was === 'idle' ? 'waiting' : was };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The shell's graceful stop when the app quits (sidecar.rs,
  // request_graceful_stop). It has posted here for a long time, but the route
  // did not exist: on Windows, where there is no SIGTERM to catch, every quit
  // ended in a kill after an 8-second wait, and a dub in progress was cut off
  // mid-step. Now the dubs in progress are paused (their progress saved) and
  // the process leaves through the same close as on SIGTERM. Refused from any
  // web page but the app's own: CORS only hides the answer, it does not stop a
  // simple POST from another site from arriving.
  app.post('/shutdown', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigin.test(origin)) {
      return reply.status(403).send({ error: { code: 'UNKNOWN', message: 'Not allowed from this origin.' } });
    }
    await orchestrator.pauseAll();
    await downloads.stop();
    setImmediate(() => requestShutdown());
    return { ok: true };
  });

  app.post(
    '/projects/:id/retry',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { stepId: PipelineStepId } }>, reply) => {
      try {
        // A series' parent runs nothing after speech-to-text: a redo of a later
        // step there "finished" at once and redid no part. The timing, the mix
        // and the render are redone in every part that made them; any other
        // step is refused, with how to do it part by part.
        const partIds = await series.partIdsOf(req.params.id).catch(() => []);
        if (partIds.length > 0 && pipelineStepIndex(req.body.stepId) > pipelineStepIndex('stt')) {
          const refused = seriesRedoRefusal(req.body.stepId, partIds.length);
          if (refused) throw refused;
          return reply.status(202).send({ started: true, parts: await redoParts(req.params.id, partIds, req.body.stepId) });
        }
        await orchestrator.retryStep(req.params.id, req.body.stepId);
        return reply.status(202).send({ started: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Update a whitelisted subset of project settings (the editor's "change an
  // engine / model / voice, then re-dub from that stage" flow). Returns the
  // updated { project, pipeline } envelope. Re-running is a separate /retry call.
  app.put(
    '/projects/:id/settings',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: Partial<ProjectSettings>; Querystring: { applyToParts?: string } } >,
      reply,
    ) => {
      try {
        const updated = await orchestrator.updateProjectSettings(req.params.id, req.body ?? {});
        // `?applyToParts=true` on a series: the same change on every part (speaker voices included).
        // A part waiting in the queue takes a change to its mix or render where it waits.
        if (req.query?.applyToParts === 'true' || req.query?.applyToParts === '1') {
          const body = req.body ?? {};
          const whileQueued = changesOnlyMixAndRender(body);
          return {
            ...updated,
            // A part that already had these values says so: "changed" for every
            // part, identical ones included, hid which parts really moved
            // (claude-dubber, 2026-11-24).
            parts: await forEachPart(
              req.params.id,
              async (id) => {
                const before = stableJson((await store.getProject(id)).settings);
                const after = await orchestrator.updateProjectSettings(id, body, { whileQueued });
                return stableJson(after.project.settings) === before ? UNCHANGED : undefined;
              },
              { whileQueued },
            ),
          };
        }
        return updated;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Segments -----------------------------------------------------------

  app.get('/projects/:id/segments', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.getSegments(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put(
    '/projects/:id/segments',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { segments: { id: string; translatedText: string }[] } }>,
      reply,
    ) => {
      try {
        await orchestrator.saveTranslatedSegments(req.params.id, req.body.segments ?? []);
        return { ok: true };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/projects/:id/segments/:segId/tts',
    async (
      req: FastifyRequest<{
        Params: { id: string; segId: string };
        Body: { text?: string; voiceId?: string; speed?: number };
      }>,
      reply,
    ) => {
      try {
        const since = Date.now();
        const result = await orchestrator.synthesizeSingleSegment(req.params.id, req.params.segId, req.body ?? {});
        const fell = fallbacksSince(`editor:${req.params.id}`, since)[0];
        return fell
          ? { ...result, engineFallback: { packId: fell.packId, reason: fell.reason, ...(fell.busyWith ? { busyWith: fell.busyWith } : {}) } }
          : result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // The editor's timeline document (cues + synthesis units + fit + media), and
  // the batch patch that moves/trims/re-voices lines. PATCH returns the updated
  // document so the editor never has to stitch two reads together.
  app.get('/projects/:id/timeline', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.getTimeline(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch(
    '/projects/:id/timeline',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { segments?: SegmentPatch[] } }>, reply) => {
      try {
        return await orchestrator.patchSegments(req.params.id, req.body?.segments ?? []);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Speakers and their voices (voices/speakerCast.ts) -----------------------

  /** The lines speakers are counted on: the translation when there is one, else the transcript. */
  async function readSpeakerLines(paths: { translatedJson: string; sourceJson: string }): Promise<TranscriptSegment[]> {
    for (const file of [paths.translatedJson, paths.sourceJson]) {
      const raw = await readFile(file, 'utf8').catch(() => undefined);
      if (!raw) continue;
      const doc = JSON.parse(raw) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
      return Array.isArray(doc) ? doc : (doc.segments ?? []);
    }
    return [];
  }

  /** The voices a cast of this project can use: its engine's, installed, speaking its language (clones speak any). */
  async function castableVoices(project: Project): Promise<VoiceLibraryItem[]> {
    const engine = (Object.keys(VOICE_ENGINE_PROVIDER) as VoiceEngineId[]).find((e) => VOICE_ENGINE_PROVIDER[e] === project.settings.ttsProviderId);
    if (!engine) return [];
    const [base, favorites, profiles] = await Promise.all([voiceLibraryState(), voiceFavorites.list(), voiceProfileStore.list(project.id).catch(() => [])]);
    const lang = baseLanguage(project.settings.targetLanguage);
    return libraryItems(allCatalogVoices(), VOICE_ENGINES, { ...base, favorites, profiles }).filter(
      (v) => v.engine === engine && v.installed && (v.kind === 'profile' || v.languages.some((l) => baseLanguage(l) === lang)),
    );
  }

  /** A sentence to measure a built-in voice's pitch and print with. */
  const MEASURE_SENTENCE: Record<string, string> = {
    vi: 'Xin chào, đây là một câu đọc mẫu để đo độ cao và âm sắc của giọng nói này.',
    en: 'Hello, this is a sample sentence to measure the pitch and the colour of this voice.',
  };
  const voiceMeasures = new VoiceMeasureCache(join(config.configDir, 'voices', 'measures.json'));

  /**
   * A voice's pitch and print, measured once: a clone's from its preview
   * (kept on the profile), a built-in's from a sentence it speaks (kept in
   * voices/measures.json). Undefined without the speaker detection engine.
   */
  async function measureVoice(v: VoiceLibraryItem): Promise<VoiceMeasure | undefined> {
    if (v.kind === 'profile') {
      const p = await voiceProfileStore.require(v.id);
      if (p.voicePrint?.print?.length) return { print: p.voicePrint.print, ...(p.voicePrint.f0Hz ? { f0Hz: p.voicePrint.f0Hz } : {}) };
      const e = await diarization.embed(voiceProfileStore.fileOf(p.id, PROFILE_FILES.preview));
      if (!e || e.print.length === 0) return undefined;
      await voiceProfileStore.save({ ...p, voicePrint: { print: e.print, ...(e.f0Hz ? { f0Hz: e.f0Hz } : {}), model: diarization.modelKey } });
      return { print: e.print, ...(e.f0Hz ? { f0Hz: e.f0Hz } : {}) };
    }
    const cached = await voiceMeasures.get(v.id);
    if (cached) return cached;
    const language = v.languages[0] ?? 'vi-VN';
    const wav = await speakWith(v.id, MEASURE_SENTENCE[baseLanguage(language)] ?? MEASURE_SENTENCE['en']!, language);
    const e = await diarization.embed(wav);
    if (!e || e.print.length === 0) return undefined;
    const m: VoiceMeasure = { print: e.print, ...(e.f0Hz ? { f0Hz: e.f0Hz } : {}) };
    await voiceMeasures.set(v.id, m);
    return m;
  }

  // A cloned voice's likely gender, from its print against built-in voices of
  // its engine whose gender is known (voices/casting.ts suggestGender). Saved
  // as a suggestion, never confirmed: the user confirms it in My voices.
  app.post('/voice-profiles/:id/suggest-gender', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const profile = await voiceProfileStore.require(req.params.id);
      if (profile.gender?.confirmed) return { gender: profile.gender.value, confirmed: true };
      const items = libraryItems(allCatalogVoices(), VOICE_ENGINES, { ...(await voiceLibraryState()), favorites: new Set<string>(), profiles: [] });
      const item = { id: profile.id, kind: 'profile', engine: profile.engine, name: profile.name, languages: [] } as unknown as VoiceLibraryItem;
      const mine = await measureVoice(item);
      if (!mine?.print?.length) {
        return reply.status(409).send({
          error: { code: 'ENGINE_PACK_MISSING', message: 'A suggestion needs the speaker detection engine (Settings → Engines) to measure the voice.' },
        });
      }
      const refs: { gender: 'female' | 'male'; print: number[] }[] = [];
      for (const gender of ['male', 'female'] as const) {
        const presets = items.filter((v) => v.kind === 'preset' && v.engine === profile.engine && v.installed && v.gender === gender).slice(0, 4);
        for (const v of presets) {
          const m = await measureVoice(v).catch(() => undefined);
          if (m?.print?.length) refs.push({ gender, print: m.print });
        }
      }
      const suggestion = suggestGender(mine.print, refs);
      if (!suggestion) return { suggested: null, reason: refs.length === 0 ? 'no built-in voice of this engine to compare with' : 'too close to call' };
      await voiceProfileStore.save({
        ...profile,
        gender: { value: suggestion.gender, confirmed: false, confidence: Math.round(suggestion.confidence * 100) / 100 },
      });
      return { suggested: suggestion.gender, confidence: suggestion.confidence };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Detect who says each line again, on the lines as they are (no new
  // transcript): the editor's Speakers section. Returns the timeline.
  app.post(
    '/projects/:id/speakers/detect',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { numSpeakers?: number; wait?: boolean; fromMs?: number; toMs?: number } }>, reply) => {
      try {
        // A job by default (hours of audio take an hour or more): follow it on
        // GET /projects/:id/speakers. `wait` keeps the old answer, the timeline.
        // fromMs/toMs: only that range, linked to the known speakers.
        const opts = { numSpeakers: req.body?.numSpeakers, fromMs: req.body?.fromMs, toMs: req.body?.toMs };
        if (req.body?.wait === true) return await orchestrator.redetectSpeakers(req.params.id, opts);
        const started = await orchestrator.startSpeakerDetection(req.params.id, opts);
        return reply.status(202).send(started);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Who speaks in a project: per speaker talk time, lines, pitch, gender,
  // samples and voice; the detection job's state (get_speakers, the editor).
  app.get('/projects/:id/speakers', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const project = await store.getProject(req.params.id);
      const paths = store.paths(req.params.id);
      const lines = await readSpeakerLines(paths);
      const detected = await readSpeakerProfiles(paths.diarizationJson);
      const detectedAt = await stat(paths.diarizationJson).then((s) => s.mtime.toISOString(), () => undefined);
      // Also a job saved before a restart: `interrupted` (Retry resumes from its saved parts).
      const job = await orchestrator.speakerJobState(req.params.id);
      return {
        speakers: speakerRows(lines, detected, project.settings),
        ...(detectedAt ? { detected: { at: detectedAt } } : {}),
        ...(job ? { job } : {}),
        defaults: {
          ...(project.settings.defaultMaleVoiceId ? { male: project.settings.defaultMaleVoiceId } : {}),
          ...(project.settings.defaultFemaleVoiceId ? { female: project.settings.defaultFemaleVoiceId } : {}),
        },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Cast a voice for every speaker by gender (voices/casting.ts): a proposal,
  // or saved with `apply`. While a clone of the user's is left out for an
  // unconfirmed gender, applying needs `allowWithoutClones` (the user's rule
  // is their clones first: claude-dubber, 2026-11-21). The minor speakers
  // share a pool per gender: `minorVoices` sizes it (saved with `apply`, as
  // the project's setting), `minorPool` picks its voices (clones allowed).
  app.post(
    '/projects/:id/speakers/cast',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: {
          apply?: boolean;
          applyToParts?: boolean;
          allowWithoutClones?: boolean;
          swaps?: { speakerId: string; voiceId: string }[];
          minorVoices?: number | null;
          minorPool?: { male?: string[]; female?: string[] };
        };
      }>,
      reply,
    ) => {
      try {
        const body = req.body ?? {};
        const project = await store.getProject(req.params.id);
        const paths = store.paths(req.params.id);
        const lines = await readSpeakerLines(paths);
        const detected = await readSpeakerProfiles(paths.diarizationJson);
        // Ranked by the lines that will be voiced: songs earn no voice (castRows).
        const { rows, voiced, singersOnly } = castRows(lines, detected, project.settings);
        if (rows.length === 0) {
          return reply.status(400).send({
            error: {
              code: 'INVALID_EDIT',
              message:
                singersOnly.length > 0
                  ? 'Every line with a speaker is kept as the original song: there is no voice to cast.'
                  : 'This project has no detected speakers: detect speakers first (detect_speakers, or the editor).',
            },
          });
        }
        const prints = new Map(detected.map((d) => [d.speakerId, d.print]));
        const speakers = rows.map((r) => ({
          speakerId: r.speakerId,
          minutes: r.minutes,
          ...(r.gender ? { gender: r.gender } : {}),
          ...(r.f0Hz ? { f0Hz: r.f0Hz } : {}),
          ...(prints.get(r.speakerId)?.length ? { print: prints.get(r.speakerId)! } : {}),
        }));
        const items = await castableVoices(project);
        const voices = await castCandidates(items, speakers, { measure: measureVoice });
        // null asks for the automatic size again; absent keeps the project's setting.
        const askedSize = typeof body.minorVoices === 'number' && Number.isFinite(body.minorVoices) ? Math.round(body.minorVoices) : undefined;
        const minorVoices = body.minorVoices === null ? undefined : (askedSize ?? project.settings.minorVoices);
        const minorPool = {
          ...(Array.isArray(body.minorPool?.male) ? { male: body.minorPool.male.filter((v) => typeof v === 'string') } : {}),
          ...(Array.isArray(body.minorPool?.female) ? { female: body.minorPool.female.filter((v) => typeof v === 'string') } : {}),
        };
        const proposal = withSwaps(
          proposeCast(speakers, voices, { ...(minorVoices ? { minorVoices } : {}), adjacency: dialogueAdjacency(voiced), minorPool }),
          body.swaps,
          voices,
        );
        if (singersOnly.length > 0) {
          proposal.notes.push(`${speakerList(singersOnly)}: every line is kept as the original song, so no voice is cast for them.`);
        }
        // Lines that look sung but are not kept as songs yet still rank their
        // singers: say who, so they can be kept as songs and cast again.
        const suggested = new Set(openSuggestions(await readSongSuggestions(songSuggestionsPath(paths)), lines).map((s) => s.lineId));
        const singing = mostlySuggestedSongs(voiced, suggested);
        if (singing.length > 0) {
          proposal.notes.push(
            `${speakerList(singing)}: nearly all their lines look sung (song suggestions). Keep those lines as the original song (mark_song, or Songs in the editor) and cast again, so these speakers take no voice from the others.`,
          );
        }
        // Speakers of unknown gender keep the project voice: say so when that
        // voice is kept for one main character (they would all speak with it).
        const projectVoice = voices.find((v) => v.voiceId === project.settings.ttsVoiceId);
        if (projectVoice?.mainOnly && proposal.unassigned.length > 0) {
          proposal.notes.push(
            `${proposal.unassigned.length} speaker(s) of unknown gender would speak with the project voice "${projectVoice.name}", which is kept for one main character: set their gender (the editor, or get_speakers) so they get voices of their own.`,
          );
        }
        const result: CastResult = {
          ...proposal,
          unknown: unknownSpeakers(rows, proposal),
          candidates: castChoices(voices),
          ...(minorVoices ? { minorVoices } : {}),
        };
        if (body.apply === true) {
          if (proposal.unconfirmed.length > 0 && body.allowWithoutClones !== true) {
            return {
              ...result,
              refused: true,
              message: `${proposal.unconfirmed.length} cloned voice(s) would be left out (gender not confirmed): confirm them in Voices → My voices, or apply with allowWithoutClones.`,
            };
          }
          const patch = {
            ...castSettings(proposal, speakers, project.settings.speakerVoices),
            // The pool size asked for becomes the project's (0 = automatic again).
            ...(body.minorVoices !== undefined ? { minorVoices: askedSize ?? 0 } : {}),
          };
          await orchestrator.updateProjectSettings(req.params.id, patch);
          result.applied = true;
          if (body.applyToParts === true) {
            (result as CastResult & { parts?: unknown }).parts = await forEachPart(req.params.id, (id) => orchestrator.updateProjectSettings(id, patch));
          }
        }
        return result;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Editor media: the original audio's waveform peaks and the filmstrip sprite.
  // Both are built on first request with ffmpeg, then served from the project's
  // cache/ dir (the sprite itself is fetched through /file).
  app.get('/projects/:id/waveform', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.getWaveform(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects/:id/filmstrip', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await orchestrator.getFilmstrip(req.params.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // A dub clip trimmed and tempo-fitted like the final mix, for the editor's
  // live preview. `trimStart`/`trimEnd` are the unit's alignment trim (ms).
  app.get(
    '/projects/:id/units/:unitId/fitted',
    async (
      req: FastifyRequest<{
        Params: { id: string; unitId: string };
        Querystring: { ratio?: string; trimStart?: string; trimEnd?: string };
      }>,
      reply,
    ) => {
      try {
        const { ratio, trimStart, trimEnd } = req.query;
        const trim =
          trimStart !== undefined && trimEnd !== undefined
            ? { startMs: Number(trimStart), endMs: Number(trimEnd) }
            : undefined;
        const file = await orchestrator.getFittedClip(req.params.id, req.params.unitId, Number(ratio ?? '1'), trim);
        return await sendFileWithRanges(req, reply, file);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // "Tighten to fit": re-translate one line shorter, then re-synthesize + re-align.
  app.post(
    '/projects/:id/segments/:segId/refit',
    async (req: FastifyRequest<{ Params: { id: string; segId: string } }>, reply) => {
      try {
        return await orchestrator.refitSegment(req.params.id, req.params.segId);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // What the text passes did: character sheet, line checks, review, auto-fit.
  app.get(
    '/projects/:id/translation-report',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        return await orchestrator.getTranslationReport(req.params.id);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Translation character sheet (cast / glossary / pronoun plan) --------
  // Generated by the first context-aware translation run; user-editable here.
  // Saving does NOT re-translate — re-run from the translation step to apply.

  app.get(
    '/projects/:id/translation-context',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        return { context: await orchestrator.getTranslationContext(req.params.id) };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    '/projects/:id/translation-context',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { context?: TranslationDocContext }; Querystring: { applyToParts?: string } }>,
      reply,
    ) => {
      try {
        const saved = await orchestrator.saveTranslationContext(req.params.id, req.body?.context ?? {});
        if (req.query?.applyToParts === 'true' || req.query?.applyToParts === '1') {
          return { context: saved, parts: await forEachPart(req.params.id, (id) => orchestrator.saveTranslationContext(id, saved)) };
        }
        return { context: saved };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Render -------------------------------------------------------------

  // Export's "Render again": a run from the mix when it is out of date, else
  // from the render (orchestrator.rerender). 202 like /run: follow it on the
  // project's events; `fromStep` says which.
  app.post(
    '/projects/:id/render',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { subtitleExportMode?: SubtitleExportMode; burnSubtitleStyle?: SubtitleStyle };
      }>,
      reply,
    ) => {
      try {
        const body = req.body ?? {};
        const result = await orchestrator.rerender(req.params.id, {
          ...(body.subtitleExportMode !== undefined ? { subtitleExportMode: body.subtitleExportMode } : {}),
          ...(body.burnSubtitleStyle !== undefined ? { burnSubtitleStyle: body.burnSubtitleStyle } : {}),
        });
        return reply.status(202).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Open path ----------------------------------------------------------

  app.post('/open', async (req: FastifyRequest<{ Body: { path: string } }>, reply) => {
    try {
      const target = req.body?.path;
      if (!target || typeof target !== 'string') {
        return reply.status(400).send({ error: { code: 'UNKNOWN', message: 'Missing "path" in body.' } });
      }
      // Only open locations the app actually manages: the app data dir (its
      // engine packs / models / caches — for the Settings "open folder"), the
      // projects root, or a project's configured output directory — never an
      // arbitrary filesystem path.
      const resolved = resolvePath(target);
      const projectsRoot = resolvePath(store.projectsDir);
      const configRoot = resolvePath(config.configDir);
      // The downloads folder sits beside the projects (downloadsDirFor), which
      // is outside both once the projects folder has been moved.
      const downloadsRoot = resolvePath(downloadsDirFor(store.projectsDir));
      let permitted = [projectsRoot, configRoot, downloadsRoot].some(
        (root) => resolved === root || resolved.startsWith(root + sep),
      );
      if (!permitted) {
        const projects = await store.listProjects().catch(() => []);
        permitted = projects.some((p) => {
          const out = resolvePath(p.outputDir);
          return resolved === out || resolved.startsWith(out + sep);
        });
      }
      if (!permitted) {
        return reply
          .status(403)
          .send({ error: { code: 'UNKNOWN', message: 'Path is outside the app-managed directories.' } });
      }
      await openPath(resolved);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Static file serving (audio/video/subtitle preview) -----------------
  // Serves artifacts so the webview can preview segment WAVs, the final video,
  // and subtitle sidecars. Strictly scoped to the projects directory to prevent
  // path traversal / arbitrary file reads.

  app.get('/file', async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply) => {
    try {
      const target = req.query.path;
      if (!target || typeof target !== 'string') {
        return reply
          .status(400)
          .send({ error: { code: 'UNKNOWN', message: 'Missing "path" query parameter.' } });
      }
      // Path-traversal guard: only files inside the projects directory, and a
      // project's own finished files in the folder chosen for it — exactly
      // those files, not that whole folder (it may be D:\ or Downloads).
      const root = resolvePath(store.projectsDir);
      const resolved = resolvePath(target);
      let permitted = resolved === root || resolved.startsWith(root + sep);
      if (!permitted) {
        const projects = await store.listProjects().catch(() => []);
        permitted = projects.some((p) => projectOutputFiles(p).some((f) => samePath(f, resolved)));
      }
      if (!permitted) {
        return reply
          .status(403)
          .send({ error: { code: 'UNKNOWN', message: 'Path is outside the projects directory.' } });
      }
      return await sendFileWithRanges(req, reply, resolved);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- SSE events ---------------------------------------------------------

  app.get('/projects/:id/events', (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const projectId = req.params.id;
    const projectBus = bus.get(projectId);

    // Raw SSE headers; hijack the reply so Fastify doesn't try to serialize.
    reply.raw.writeHead(200, sseHeaders(req)).flushHeaders();
    reply.hijack();

    const write = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Send an initial state snapshot so a late subscriber syncs immediately.
    void store
      .getPipeline(projectId)
      .then((pipeline) => write({ type: 'state', pipeline }))
      .catch(() => {
        /* project may not have a pipeline yet */
      });

    const unsubscribe = projectBus.subscribe((event) => write(event));

    // Heartbeat comment keeps proxies/connections alive.
    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ---- 0.18.0 feature routes (docs/plans/production-requests-2026-11-23.md).
  // Each area adds its routes at its own anchor below, so parallel work never
  // edits the same lines. Prefer a route module of its own, registered here.

  // [routes: re-transcription and speaker detection]
  // Speaker detection's parts run side by side only while no heavy step runs
  // anywhere and memory is not short (plan 6.1); a re-transcription job's and a
  // project's jobs are followed here (transcriptJobs.ts).
  diarization.setParallelism(() =>
    diarizationBudget({
      heavyLane: engineManager.heavyLaneOwner() !== undefined,
      runs: [...runActivity.steps()].map(([projectId, step]) => ({ step, heavy: orchestrator.heavyStepsOf(projectId).includes(step) })),
      pressure: health.pressure(),
    }),
  );
  registerTranscriptJobRoutes(app, { orchestrator, store, sendError });


  // [routes: casting and songs]
  // Lines kept as the original song (songs/songRoutes.ts). The cast route is
  // above (/projects/:id/speakers/cast).
  registerSongRoutes(app, { store, orchestrator, forEachPart, sendError });


  // [routes: series, create, continue]
  // A part renamed or retitled after it was made; the series a new one can continue.
  registerSeriesRoutes(app, { series, sendError });


  // [routes: join videos]
  // One project from several videos (join/): checked, made, then joined in
  // the background as a job of the activity list. Imported here rather than
  // at the top so this area's change stays inside its anchor.
  {
    const { JoinService } = await import('./join/joinService.js');
    const { registerJoinRoutes } = await import('./join/joinRoutes.js');
    const joins = new JoinService({
      store,
      probeProject: (id) => orchestrator.probe(id),
      startRun: (id) => startWhenReady(id),
      logger: { info: (m) => console.info(`[join] ${m}`), warn: (m) => console.warn(`[join] ${m}`) },
    });
    registerJoinRoutes(app, {
      joins,
      sendError,
      presetJob,
      // As POST /projects: a series needs an AI from Settings to choose the cuts.
      resolveSeries: async (s) => {
        const chosen = pickSeriesAi(await seriesAiOptions(), s.aiProviderId);
        if (!chosen) throw seriesAiRefusal(s.aiProviderId);
        // As POST /projects: the name template checked, a continuation's
        // numbering and settings resolved (series agent's prepareSeries).
        return series.prepareSeries({ ...s, aiProviderId: chosen.id });
      },
    });
    // A join the app was closed (or died) during starts again.
    void joins.resumeInterrupted();
  }


  // [routes: picture options]
  // Watermarks and the band over the source's subtitles: found without AI
  // (a job in the activity list), saved with PUT /projects/:id/settings.
  registerPictureRoutes(app, { pictures, sendError });


  // [routes: activity and edit history]
  await registerActivityRoutes(app, {
    logsDir,
    store,
    bus,
    engineBus,
    setupBus,
    downloads,
    orchestrator,
    projectsMoving: () => projectsFolder.moving,
    structured,
    sseHeaders,
    sendError,
  });


  return app;
}

/**
 * Stream a file honouring HTTP byte ranges (see httpRange.ts — WKWebView will
 * not play or seek media from a server that ignores them). Shared by `/file`
 * and the editor's fitted-clip route so both behave identically.
 */
async function sendFileWithRanges(req: FastifyRequest, reply: FastifyReply, file: string): Promise<FastifyReply> {
  const info = await stat(file).catch(() => undefined);
  if (!info || !info.isFile()) {
    return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'File not found.' } });
  }
  void reply.header('Accept-Ranges', 'bytes');
  void reply.type(contentTypeFor(file));
  const range = decideRange(req.headers.range, info.size);
  if (range.kind === 'unsatisfiable') {
    void reply.header('Content-Range', `bytes */${info.size}`);
    return reply.status(416).send();
  }
  if (range.kind === 'partial') {
    void reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    void reply.header('Content-Length', range.end - range.start + 1);
    return reply.status(206).send(createReadStream(file, { start: range.start, end: range.end }));
  }
  void reply.header('Content-Length', info.size);
  return reply.send(createReadStream(file));
}

/**
 * Install the process-level lifecycle handlers: graceful shutdown on
 * SIGTERM/SIGINT plus a last-resort crash log.
 *
 * WHY THIS LIVES IN `startServer` AND NOT IN THE `isMain()` BLOCK BELOW: the
 * packaged orchestrator is a Node SEA whose entry (scripts/package/
 * orchestrator-entry.mjs) imports `startServer` — `import.meta.url` is `{}`
 * inside the bundle, so `isMain()` is ALWAYS false there and everything guarded
 * by it is dead code in every shipped build. That meant the released app never
 * ran `app.close()`, so the Fastify `onClose` hook (-> engineManager.stopAll())
 * never fired and every llama.cpp / whisper.cpp / uv-env engine child was
 * orphaned on quit, and an unhandled rejection killed the backend mid-dub with
 * nothing written down anywhere.
 *
 * Idempotent: repeated calls (embedders, tests) install the handlers once.
 */
let lifecycleInstalled = false;
/**
 * Leave the process the graceful way (POST /shutdown). A no-op until
 * installProcessLifecycle runs: a server embedded in a test must not exit.
 */
let requestShutdown: () => void = () => undefined;
export function installProcessLifecycle(app: FastifyInstance, config: OrchestratorConfig): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => process.exit(0));
  };
  requestShutdown = shutdown;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, shutdown);
  }

  // Node terminates the process on an unhandled rejection, so without this a
  // single stray rejection anywhere in the orchestrator killed the backend and
  // the stack went to a stdout nobody captures (the shell drops the sidecar's
  // output). Write it next to the user's other app state, then exit non-zero so
  // the shell's restart path behaves exactly as before.
  const fatal = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    const record = {
      kind,
      at: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      ...buildInfo(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    };
    try {
      const dir = join(config.configDir, 'logs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `crash-${record.at.replace(/[:.]/g, '-')}.json`);
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
       
      console.error(`[orchestrator] fatal ${kind} — crash report written to ${file}`);
    } catch {
      /* the crash report is best-effort; never mask the original failure */
    }
     
    console.error(`[orchestrator] ${kind}:`, error);
    // Nothing is transmitted anywhere: the report stays on the user's disk for
    // them to attach to an issue if they choose.
    process.exit(1);
  };
  process.on('uncaughtException', (err) => fatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
}

/**
 * Start the server using environment configuration. Returns the running
 * instance. Exported so embedders can manage the lifecycle.
 */
export async function startServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  // Engine packs run on the BUNDLED CPython, which writes bytecode caches next
  // to its sources — inside the install folder (87 __pycache__ dirs on the
  // maintainer's machine). The uninstaller removes only the files it installed,
  // so those dirs, and the install folder with them, were left behind. Every
  // Python this process starts (engines, uv, the GPU probe) inherits this.
  process.env.PYTHONPYCACHEPREFIX ??= join(config.configDir, 'cache', 'pycache');
  // Evidence for the day it dies (diagnostics/health.ts), and the crash the
  // shell restarted it after, if that is why it is starting.
  const logsDir = join(config.configDir, 'logs');
  installNativeCrashEvidence(logsDir, (m) => console.log(m));
  const recoveredCrash = options.recoveredCrash ?? takeRecoveredCrash(logsDir);
  if (recoveredCrash) {
    console.warn(
      `[orchestrator] restarted after the previous backend ended at ${recoveredCrash.at}` +
        `${recoveredCrash.codeHex ? ` (${recoveredCrash.codeHex}${recoveredCrash.meaning ? `: ${recoveredCrash.meaning}` : ''})` : ''}; interrupted dubs continue.`,
    );
  }
  const app = await createServer({ ...options, config, ...(recoveredCrash ? { recoveredCrash } : {}) });
  await app.listen({ host: config.host, port: config.port });
  installProcessLifecycle(app, config);
  const build = buildInfo();
   
  console.log(
    `[orchestrator] version ${build.version}${build.commit ? ` (${build.commit})` : ''} on node ${process.version}`,
  );
   
  console.log(`[orchestrator] listening on http://${config.host}:${config.port}`);
   
  const chosenRoot = await readProjectsRoot(config.configDir);
  console.log(`[orchestrator] projects dir: ${chosenRoot ? `${projectsDirOf(chosenRoot)} (chosen in Settings)` : config.projectsDir}`);
  return app;
}

// ---- Main guard -----------------------------------------------------------

/** True when this module is the program entry point. */
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isMain()) {
  // Shutdown/crash handling is installed by startServer() itself — see
  // installProcessLifecycle(). It used to live HERE, which meant it never ran in
  // the packaged SEA (isMain() is always false inside the bundle), so shipped
  // builds orphaned every engine child on quit.
  startServer().catch((err) => {
    console.error('[orchestrator] failed to start:', err);
    process.exitCode = 1;
  });
}

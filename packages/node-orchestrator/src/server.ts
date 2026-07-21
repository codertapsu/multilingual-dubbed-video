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
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  ALL_CLOUD_SERVICES,
  AppErrorException,
  COMMON_LANGUAGES,
  type ArgosPair,
  type CloudServiceId,
  type CreateProjectInput,
  type PipelineStepId,
  type ProjectSettings,
  type SaveCredentialRequest,
  type SetupInstallRequest,
  type SubtitleExportMode,
  type SubtitleStyle,
  type TranslationDocContext,
  type UpdatePreferences,
} from '@videodubber/shared';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { CredentialsStore } from './credentials/credentialsStore.js';
import { testCloudCredential } from './credentials/testConnection.js';
import { buildSystemResponse, getSystemProfile } from './system/systemProfile.js';
import { EngineEventBus } from './engines/engineBus.js';
import { EngineInstaller } from './engines/engineInstaller.js';
import { EngineManager } from './engines/engineManager.js';
import { EnginePackStore } from './engines/enginePackStore.js';
import { availablePacks, findPack } from './engines/enginePackCatalog.js';
import { isPackUsable } from './engines/packSelection.js';
import { packFitsMachine, packHardwareSupported, recommendEnginePacks } from './engines/engineRecommendation.js';
import { resolveUvPath } from './engines/uv.js';
import { AudioSeparatorProvider } from './providers/separation/audioSeparatorProvider.js';
import { WhisperxAlignmentProvider } from './providers/alignment/whisperxProvider.js';
import { EventBusRegistry } from './events.js';
import { checkWorkersHealth } from './health.js';
import { toHttpError } from './httpErrors.js';
import { createFfmpegMediaService } from './mediaAdapter.js';
import { openPath } from './openPath.js';
import { describeStorage, clearStorage } from './storage.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import type { ProviderRegistry } from './providers/registry.js';
import { createDefaultRegistry, OLLAMA_MODEL } from './providers/registry.js';
import { buildReadinessContext, checkProviderReadiness, describeProviderReadiness, type ReadinessDeps } from './providers/readiness.js';
import { getWorkerJson, postWorkerJson, probeWorkerHealth } from './providers/workerHttp.js';
import { OllamaPullManager, listOllamaModels } from './providers/ollamaModels.js';
import { computeRequiredResources, hasRequiredResources } from './setup/requiredResources.js';
import type { PipelineMediaService } from './media.js';
import { ProjectStore } from './workspace/projectStore.js';
import { buildCatalog, findPiperVoice, translatableLanguages } from './setup/catalog.js';
import { listVoicesForLanguage } from './setup/voicesCatalog.js';
import { listNeuralVoicesForLanguage } from './setup/neuralVoicesCatalog.js';
import { listOmnivoiceForLanguage } from './setup/omnivoicesCatalog.js';
import { runPreflight } from './setup/preflight.js';
import { SetupEventBus } from './setup/setupBus.js';
import { SetupInstaller } from './setup/installer.js';
import { SetupStore } from './setup/setupStore.js';
import { detectInstalledModels } from './setup/detectInstalledModels.js';

/** Ollama's OpenAI-compatible base URL (for the prerequisites probe). */
const OLLAMA_URL = process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434/v1';

/** Dependencies that can be overridden when embedding/testing the server. */
export interface CreateServerOptions {
  config?: OrchestratorConfig;
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
  separation?: AudioSeparatorProvider;
}

/**
 * A media service proxy that lazily resolves the real ffmpeg-backed service on
 * first use. This lets the server boot even if the media-worker package is not
 * yet built; the failure surfaces only when a media operation is attempted.
 */
function createLazyMediaService(): PipelineMediaService {
  let real: PipelineMediaService | undefined;
  let loading: Promise<PipelineMediaService> | undefined;

  const resolve = async (): Promise<PipelineMediaService> => {
    if (real) return real;
    loading ??= createFfmpegMediaService();
    real = await loading;
    return real;
  };

  return {
    probe: async (p) => (await resolve()).probe(p),
    extractAudio: async (i, o) => (await resolve()).extractAudio(i, o),
    renderFinalVideo: async (input) => (await resolve()).renderFinalVideo(input),
    extract16kMono: async (i, o) => (await resolve()).extract16kMono(i, o),
    buildTtsTimeline: async (input) => (await resolve()).buildTtsTimeline(input),
    duckAndMix: async (input) => (await resolve()).duckAndMix(input),
  };
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
export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const store = options.store ?? new ProjectStore(config.projectsDir);
  const media = options.media ?? createLazyMediaService();
  const credentials = options.credentials ?? new CredentialsStore(config.configDir);

  // Engine-pack subsystem: install-state store, the runtime lifecycle manager,
  // the install event bus, and the installer. These power the optional
  // accelerated/heavy engines (whisper.cpp, llama.cpp, neural TTS, separation,
  // alignment) that download on demand.
  const enginePackStore = options.enginePackStore ?? new EnginePackStore(config.configDir);
  const engineManager =
    options.engineManager ??
    new EngineManager({
      store: enginePackStore,
      logger: {
        info: (m) => console.log(`[engines] ${m}`),
        warn: (m) => console.warn(`[engines] ${m}`),
      },
    });
  const engineBus = options.engineBus ?? new EngineEventBus();
  const engineInstaller = options.engineInstaller ?? new EngineInstaller({ store: enginePackStore, bus: engineBus });
  const separation =
    options.separation ?? new AudioSeparatorProvider(engineManager, enginePackStore, config.workerRequestTimeoutMs);
  const alignment = new WhisperxAlignmentProvider(engineManager, enginePackStore, config.workerRequestTimeoutMs);

  // Hardware profile so the registry only offers providers whose packs can run
  // on this machine (e.g. whisper.cpp only where an NVIDIA/Metal pack exists).
  // Best-effort: on detection failure the registry falls back to OS/arch gating.
  const registryProfile = options.registry ? undefined : await getSystemProfile().catch(() => undefined);
  const registry =
    options.registry ?? createDefaultRegistry(config, credentials, engineManager, enginePackStore, registryProfile);
  const bus = options.bus ?? new EventBusRegistry();

  // First-run setup: config/state store, the global setup SSE bus, and the model
  // installer that streams progress over it. Declared here (before the readiness
  // deps) so the run gate can read the installed-model inventory from setupStore.
  const setupStore = options.setupStore ?? new SetupStore(config.configDir);
  const setupBus = options.setupBus ?? new SetupEventBus();
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
  });

  const orchestrator =
    options.orchestrator ??
    new LocalJobOrchestrator({
      config,
      store,
      media,
      registry,
      bus,
      separation,
      alignment,
      // Engine lifecycle + preferences: the scheduler releases a finished run's
      // heavy-engine lane, and reads the user's simultaneous-dub limit.
      engines: engineManager,
      setup: setupStore,
      // Gate runs on provider readiness so an unready provider (e.g. Ollama with
      // no daemon, a missing engine pack, or an unconfigured cloud key) fails
      // fast with remediation instead of dying mid-pipeline.
      checkReadiness: (project, fromStep) => checkProviderReadiness(project, readinessDeps(), fromStep),
    });

  // Re-establish the dubbing queue from disk: projects left `queued` re-enter in
  // their original order, and any project the app died on mid-run is demoted to
  // `paused` rather than silently resumed. Best-effort; never blocks boot.
  void orchestrator.reconcileQueue();

  // Tracks background Ollama model pulls (lazy on-demand for the large, optional
  // local-LLM translation models). The UI polls /providers/ollama/pull-status.
  const ollamaPulls = new OllamaPullManager(OLLAMA_URL);

  const app = Fastify({ logger: false });

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
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Stop any running engine servers (whisper.cpp / llama.cpp / uv-env workers)
  // when the orchestrator shuts down, so no child process is orphaned.
  app.addHook('onClose', async () => {
    orchestrator.stopScheduler();
    await engineManager.stopAll();
  });

  // ---- Health -------------------------------------------------------------

  app.get('/health', async () => ({ status: 'ok' }));

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
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
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
      });
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

  app.post(
    '/projects/:id/run-next',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        await orchestrator.runNext(req.params.id);
        return { ok: true };
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
  app.post('/projects/:id/ensure-resources', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const project = await store.getProject(req.params.id);
      const status = await setupStore.getStatus();
      const request = computeRequiredResources(project.settings, status.installed);
      const installing = hasRequiredResources(request);
      if (installing) void installer.run(request);
      return { installing, request };
    } catch (err) {
      return sendError(reply, err);
    }
  });

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
        // Synchronous (download held open) so the Settings UI just shows a
        // per-row spinner; onboarding's bulk install still uses /setup/install.
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
      return { available, installed, updatable };
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
      const [uvPath, ollamaOk] = await Promise.all([
        resolveUvPath(),
        fetch(`${OLLAMA_URL}/models`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false),
      ]);
      // Compare against the TRIMMED env var (resolveUvPath returns the trimmed
      // path), so surrounding whitespace doesn't yield a false "not bundled".
      const bundledUv = process.env.VIDEODUBBER_UV_PATH?.trim();
      return {
        uv: { available: uvPath !== null, bundled: Boolean(bundledUv && uvPath === bundledUv) },
        ollama: { available: ollamaOk },
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/engines/install', async (req: FastifyRequest<{ Body: { packId?: string } }>, reply) => {
    try {
      const packId = req.body?.packId;
      if (!packId || !findPack(packId)) {
        return reply.status(400).send({ error: { code: 'ENGINE_PACK_MISSING', message: `Unknown engine pack "${packId}".` } });
      }
      // Kick off asynchronously; progress observed via GET /engines/events.
      void engineInstaller.install(packId);
      return reply.status(202).send({ started: true });
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
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
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
      return await describeStorage(config, enginePackStore);
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

  // ---- Projects -----------------------------------------------------------

  app.post('/projects', async (req: FastifyRequest<{ Body: CreateProjectInput }>, reply) => {
    try {
      const project = await orchestrator.createProject(req.body);
      return reply.status(201).send(project);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/projects', async (_req, reply) => {
    try {
      return await orchestrator.listProjects();
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
      const result = await orchestrator.runPipeline(req.params.id);
      return reply.status(202).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/projects/:id/cancel', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await orchestrator.cancelJob(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post(
    '/projects/:id/retry',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { stepId: PipelineStepId } }>, reply) => {
      try {
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
      req: FastifyRequest<{ Params: { id: string }; Body: Partial<ProjectSettings> } >,
      reply,
    ) => {
      try {
        return await orchestrator.updateProjectSettings(req.params.id, req.body ?? {});
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
        const result = await orchestrator.synthesizeSingleSegment(req.params.id, req.params.segId, req.body ?? {});
        return result;
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
      req: FastifyRequest<{ Params: { id: string }; Body: { context?: TranslationDocContext } }>,
      reply,
    ) => {
      try {
        const saved = await orchestrator.saveTranslationContext(req.params.id, req.body?.context ?? {});
        return { context: saved };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- Render -------------------------------------------------------------

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
        return await orchestrator.renderFinalVideo(req.params.id, {
          ...(body.subtitleExportMode !== undefined ? { subtitleExportMode: body.subtitleExportMode } : {}),
          ...(body.burnSubtitleStyle !== undefined ? { burnSubtitleStyle: body.burnSubtitleStyle } : {}),
        });
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
      const projectsRoot = resolvePath(config.projectsDir);
      const configRoot = resolvePath(config.configDir);
      let permitted =
        resolved === projectsRoot ||
        resolved.startsWith(projectsRoot + sep) ||
        resolved === configRoot ||
        resolved.startsWith(configRoot + sep);
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
      // Path-traversal guard: only files inside the projects directory.
      const root = resolvePath(config.projectsDir);
      const resolved = resolvePath(target);
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        return reply
          .status(403)
          .send({ error: { code: 'UNKNOWN', message: 'Path is outside the projects directory.' } });
      }
      const info = await stat(resolved).catch(() => undefined);
      if (!info || !info.isFile()) {
        return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'File not found.' } });
      }
      void reply.header('Content-Length', info.size);
      void reply.type(contentTypeFor(resolved));
      return reply.send(createReadStream(resolved));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- SSE events ---------------------------------------------------------

  app.get('/projects/:id/events', (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const projectId = req.params.id;
    const projectBus = bus.get(projectId);

    // Raw SSE headers; hijack the reply so Fastify doesn't try to serialize.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Allow the webview/browser to read the stream cross-origin.
      'Access-Control-Allow-Origin': '*',
    });
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

  return app;
}

/**
 * Start the server using environment configuration. Returns the running
 * instance. Exported so embedders can manage the lifecycle.
 */
export async function startServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = await createServer({ ...options, config });
  await app.listen({ host: config.host, port: config.port });
   
  console.log(`[orchestrator] listening on http://${config.host}:${config.port}`);
   
  console.log(`[orchestrator] projects dir: ${config.projectsDir}`);
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
  startServer()
    .then((app) => {
      // Stop child engine servers cleanly on quit so heavy model processes
      // (whisper.cpp / llama.cpp / the uv-env neural-TTS workers) are NOT orphaned.
      // app.close() runs the onClose hook -> engineManager.stopAll(). A SIGKILL
      // can't be intercepted, but dev's SIGTERM/Ctrl-C and tsx-watch's restart
      // SIGTERM are handled here — exactly what was leaving orphaned multi-GB models
      // across dev restarts (which then pressured RAM and OOM-killed the workers).
      let closing = false;
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.once(sig, () => {
          if (closing) return;
          closing = true;
          void app.close().finally(() => process.exit(0));
        });
      }
    })
    .catch((err) => {
      console.error('[orchestrator] failed to start:', err);
      process.exitCode = 1;
    });
}

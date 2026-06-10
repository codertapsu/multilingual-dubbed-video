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
  COMMON_LANGUAGES,
  type CreateProjectInput,
  type PipelineStepId,
  type SetupInstallRequest,
  type SubtitleExportMode,
  type SubtitleStyle,
  type UpdatePreferences,
} from '@videodubber/shared';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { checkWorkersHealth } from './health.js';
import { toHttpError } from './httpErrors.js';
import { createFfmpegMediaService } from './mediaAdapter.js';
import { openPath } from './openPath.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import type { ProviderRegistry } from './providers/registry.js';
import { createDefaultRegistry } from './providers/registry.js';
import type { PipelineMediaService } from './media.js';
import { ProjectStore } from './workspace/projectStore.js';
import { buildCatalog } from './setup/catalog.js';
import { runPreflight } from './setup/preflight.js';
import { SetupEventBus } from './setup/setupBus.js';
import { SetupInstaller } from './setup/installer.js';
import { SetupStore } from './setup/setupStore.js';

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
  const registry = options.registry ?? createDefaultRegistry(config);
  const bus = options.bus ?? new EventBusRegistry();

  const orchestrator =
    options.orchestrator ?? new LocalJobOrchestrator({ config, store, media, registry, bus });

  // First-run setup: config/state store, the global setup SSE bus, and the
  // model installer that streams progress over that bus.
  const setupStore = options.setupStore ?? new SetupStore(config.configDir);
  const setupBus = options.setupBus ?? new SetupEventBus();
  const installer =
    options.installer ?? new SetupInstaller({ config, store: setupStore, bus: setupBus });

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

  app.put('/preferences', async (req: FastifyRequest<{ Body: UpdatePreferences }>, reply) => {
    try {
      const body = req.body ?? { autoUpdate: true };
      await setupStore.savePreferences({ autoUpdate: body.autoUpdate === true });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Providers (bonus listing; used by the UI to populate pickers) ------

  app.get('/providers', async () => registry.describe());

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
      await orchestrator.runPipeline(req.params.id);
      return reply.status(202).send({ started: true });
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
      // Only open locations the app actually manages: the projects root or a
      // project's configured output directory — not arbitrary filesystem paths.
      const resolved = resolvePath(target);
      const projectsRoot = resolvePath(config.projectsDir);
      let permitted = resolved === projectsRoot || resolved.startsWith(projectsRoot + sep);
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
  startServer().catch((err) => {
     
    console.error('[orchestrator] failed to start:', err);
    process.exitCode = 1;
  });
}

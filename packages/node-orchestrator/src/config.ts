/**
 * Typed environment configuration for the orchestrator.
 *
 * All defaults match the VideoDubber contract. Everything is read once at
 * startup but exposed via {@link loadConfig} so tests can build their own
 * config without mutating `process.env`.
 */
import os from 'node:os';
import path from 'node:path';

/** Fully-resolved, typed orchestrator configuration. */
export interface OrchestratorConfig {
  /** Port the orchestrator HTTP server listens on (default 5100). */
  readonly port: number;
  /** Host/interface to bind (default 127.0.0.1 — loopback only). */
  readonly host: string;
  /** Base URL of the orchestrator itself (used for self-reference/logging). */
  readonly orchestratorUrl: string;
  /** STT worker base URL (faster-whisper, default :5101). */
  readonly sttWorkerUrl: string;
  /** Translation worker base URL (Argos, default :5102). */
  readonly translationWorkerUrl: string;
  /** TTS worker base URL (Piper/fallback, default :5103). */
  readonly ttsWorkerUrl: string;
  /** Root directory holding all project workspaces. */
  readonly projectsDir: string;
  /** Explicit ffmpeg binary path, or undefined to use PATH lookup. */
  readonly ffmpegPath: string | undefined;
  /** Explicit ffprobe binary path, or undefined to use PATH lookup. */
  readonly ffprobePath: string | undefined;
  /** Explicit python interpreter, or undefined to use PATH lookup. */
  readonly pythonPath: string | undefined;
  /** Default faster-whisper model name when a project omits one. */
  readonly defaultWhisperModel: string;
  /** Default request timeout (ms) for worker HTTP calls. */
  readonly workerRequestTimeoutMs: number;
}

/**
 * Read an environment variable, returning `undefined` for empty/missing
 * values (so callers can fall back cleanly).
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Parse an integer env var with a default fallback. */
function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Default projects directory: ~/VideoDubber/projects. */
export function defaultProjectsDir(): string {
  return path.join(os.homedir(), 'VideoDubber', 'projects');
}

/**
 * Build the orchestrator config from the current environment (plus optional
 * overrides, handy for tests). Pure aside from reading `process.env`.
 */
export function loadConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const port = envInt('ORCHESTRATOR_PORT', 5100);
  const host = env('ORCHESTRATOR_HOST') ?? '127.0.0.1';

  const base: OrchestratorConfig = {
    port,
    host,
    orchestratorUrl: env('ORCHESTRATOR_URL') ?? `http://127.0.0.1:${port}`,
    sttWorkerUrl: env('STT_WORKER_URL') ?? 'http://127.0.0.1:5101',
    translationWorkerUrl: env('TRANSLATION_WORKER_URL') ?? 'http://127.0.0.1:5102',
    ttsWorkerUrl: env('TTS_WORKER_URL') ?? 'http://127.0.0.1:5103',
    projectsDir: env('VIDEODUBBER_PROJECTS_DIR') ?? defaultProjectsDir(),
    ffmpegPath: env('FFMPEG_PATH'),
    ffprobePath: env('FFPROBE_PATH'),
    pythonPath: env('PYTHON_PATH'),
    defaultWhisperModel: env('FASTER_WHISPER_MODEL') ?? 'small',
    workerRequestTimeoutMs: envInt('WORKER_REQUEST_TIMEOUT_MS', 1000 * 60 * 30),
  };

  return { ...base, ...overrides };
}

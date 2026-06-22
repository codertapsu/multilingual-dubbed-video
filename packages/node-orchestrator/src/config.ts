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
  /**
   * App config/state directory (owns setup.json + preferences.json).
   * Defaults to the parent of {@link projectsDir} (i.e. ~/VideoDubber).
   */
  readonly configDir: string;
  /** Root directory holding downloaded models (Piper voices under /piper). */
  readonly modelsDir: string;
  /**
   * HuggingFace hub cache dir the STT worker downloads whisper weights into
   * (the dir that holds the `models--*` snapshot folders). Mirrors the worker's
   * `STT_MODEL_CACHE_DIR` resolution so the orchestrator can watch a download in
   * flight and report a true percentage. The bundled shell sets
   * `STT_MODEL_CACHE_DIR = <modelsDir>/huggingface` for BOTH processes
   * (see src-tauri/src/sidecar.rs), and that is also the derived default here.
   */
  readonly whisperCacheDir: string;
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
 * Default app config directory: the parent of the projects directory
 * (i.e. ~/VideoDubber). Holds setup.json + preferences.json.
 */
export function defaultConfigDir(projectsDir: string): string {
  return path.dirname(projectsDir);
}

/** Default models directory: <configDir>/models (Piper voices under /piper). */
export function defaultModelsDir(configDir: string): string {
  return path.join(configDir, 'models');
}

/**
 * Build the orchestrator config from the current environment (plus optional
 * overrides, handy for tests). Pure aside from reading `process.env`.
 */
export function loadConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const port = envInt('ORCHESTRATOR_PORT', 5100);
  const host = env('ORCHESTRATOR_HOST') ?? '127.0.0.1';

  const projectsDir = env('VIDEODUBBER_PROJECTS_DIR') ?? defaultProjectsDir();
  const configDir = env('VIDEODUBBER_CONFIG_DIR') ?? defaultConfigDir(projectsDir);
  const modelsDir = env('VIDEODUBBER_MODELS_DIR') ?? defaultModelsDir(configDir);

  // Resolve the HF hub cache dir with the SAME priority the STT worker uses
  // (workers/stt-worker/app/whisper_service.py _hf_cache_dir): explicit cache
  // dir, then HF_HUB_CACHE, then HF_HOME/hub, finally <modelsDir>/huggingface
  // (what the bundled shell sets for the worker). Keep these in lockstep, or the
  // progress poller watches the wrong directory and reports 0%.
  const hfHome = env('HF_HOME');
  const whisperCacheDir =
    env('STT_MODEL_CACHE_DIR') ??
    env('HF_HUB_CACHE') ??
    (hfHome ? path.join(hfHome, 'hub') : undefined) ??
    path.join(modelsDir, 'huggingface');

  const base: OrchestratorConfig = {
    port,
    host,
    orchestratorUrl: env('ORCHESTRATOR_URL') ?? `http://127.0.0.1:${port}`,
    sttWorkerUrl: env('STT_WORKER_URL') ?? 'http://127.0.0.1:5101',
    translationWorkerUrl: env('TRANSLATION_WORKER_URL') ?? 'http://127.0.0.1:5102',
    ttsWorkerUrl: env('TTS_WORKER_URL') ?? 'http://127.0.0.1:5103',
    projectsDir,
    configDir,
    modelsDir,
    whisperCacheDir,
    ffmpegPath: env('FFMPEG_PATH'),
    ffprobePath: env('FFPROBE_PATH'),
    pythonPath: env('PYTHON_PATH'),
    defaultWhisperModel: env('FASTER_WHISPER_MODEL') ?? 'small',
    workerRequestTimeoutMs: envInt('WORKER_REQUEST_TIMEOUT_MS', 1000 * 60 * 30),
  };

  return { ...base, ...overrides };
}

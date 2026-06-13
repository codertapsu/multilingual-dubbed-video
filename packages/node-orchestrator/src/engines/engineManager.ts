/**
 * Runtime lifecycle for installed engine packs that run as local servers
 * (whisper.cpp's `whisper-server`, llama.cpp's `llama-server`, and the
 * uv-env Python workers for TTS/separation/alignment).
 *
 * Responsibilities:
 *   - Resolve an installed pack's server binary / entrypoint.
 *   - Start it on a free loopback port, wait for health, hand back a base URL.
 *   - Track running engines and stop them on demand / on shutdown.
 *   - **Sequential memory policy**: the dubbing pipeline runs one heavy phase at
 *     a time, so before starting a heavy engine the manager can unload other
 *     heavy engines (`withEngine(..., { exclusive: true })`). On big machines
 *     the caller can keep engines resident by not requesting exclusivity.
 *
 * The process launcher and the health probe are injectable so the policy +
 * lifecycle are unit-testable without real binaries.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppErrorException } from '@videodubber/shared';
import type { EnginePackStore } from './enginePackStore.js';

/**
 * Directory holding the bundled first-party engine-pack worker source (e.g. the
 * `vd_tts_engine` package). The uv venv provides the heavy third-party deps; our
 * small server module is loaded from here via PYTHONPATH so it can be updated
 * with the app without reinstalling the venv. The packaged shell sets
 * VIDEODUBBER_ENGINE_SRC_DIR to the bundled location; a source build falls back
 * to `<repo>/workers/tts-engine-neural`.
 */
function engineSrcDir(): string {
  const fromEnv = process.env.VIDEODUBBER_ENGINE_SRC_DIR;
  if (fromEnv) return fromEnv;
  // This module lives at packages/node-orchestrator/{src,dist}/engines/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../workers/tts-engine-neural');
}

/** Prepend `dir` to an existing PATH-style value (PYTHONPATH). */
function prependPath(dir: string, existing: string | undefined): string {
  return [dir, existing].filter(Boolean).join(path.delimiter);
}

/** Env for a VieNeu `vd_tts_engine` sidecar: bundled module on PYTHONPATH, the
 * model cache pinned to the pack dir, and the variant (v2/v3) selector. */
function neuralTtsEnv(packDir: string, variant: 'v2' | 'v3'): Record<string, string> {
  return {
    PYTHONPATH: prependPath(engineSrcDir(), process.env.PYTHONPATH),
    VD_PACK_DIR: packDir,
    HF_HOME: path.join(packDir, 'hf'),
    VIENEU_VARIANT: variant,
  };
}

/** A running engine instance. */
export interface RunningEngine {
  packId: string;
  baseUrl: string;
  port: number;
  /** Kill the process. */
  stop: () => Promise<void>;
}

/** How to launch one engine pack's server. */
export interface EngineLaunchSpec {
  /** Candidate binary basenames to find inside the pack dir (binary packs). */
  binaryNames?: string[];
  /** Python module to run for uv-env packs (via `<venv>/bin/python -m <module>`). */
  pythonModule?: string;
  /** Build argv given the resolved executable, port, and pack dir. */
  args: (ctx: { exe: string; port: number; packDir: string }) => string[];
  /** Extra environment for the child. */
  env?: (ctx: { port: number; packDir: string }) => Record<string, string>;
  /** Health URL builder; polled until it resolves ok. */
  healthPath?: string;
  /** Whether this engine is "heavy" (subject to the exclusive unload policy). */
  heavy?: boolean;
}

/** Built-in launch specs per provider/pack. */
export const ENGINE_LAUNCH_SPECS: Record<string, EngineLaunchSpec> = {
  'whisper-cpp': {
    binaryNames: ['whisper-server', 'whisper-server.exe'],
    args: ({ exe: _exe, port }) => ['--host', '127.0.0.1', '--port', String(port), '--inference-path', '/inference'],
    healthPath: '/',
    heavy: true,
  },
  'local-llm': {
    binaryNames: ['llama-server', 'llama-server.exe'],
    // Model path is supplied via VD_LLM_MODEL in the env builder.
    args: ({ port }) => ['--host', '127.0.0.1', '--port', String(port), '-c', '8192'],
    env: ({ packDir }) => ({ VD_PACK_DIR: packDir }),
    healthPath: '/health',
    heavy: true,
  },
  // Both VieNeu variants run the same bundled `vd_tts_engine` server; the venv
  // (per pack) supplies the deps, PYTHONPATH supplies our module, HF_HOME points
  // model downloads into the pack dir, and VIENEU_VARIANT picks v2 vs v3.
  'neural-tts': {
    pythonModule: 'vd_tts_engine',
    args: ({ port }) => ['--port', String(port)],
    env: ({ packDir }) => neuralTtsEnv(packDir, 'v3'),
    healthPath: '/health',
    heavy: false,
  },
  'neural-tts-v2': {
    pythonModule: 'vd_tts_engine',
    args: ({ port }) => ['--port', String(port)],
    env: ({ packDir }) => neuralTtsEnv(packDir, 'v2'),
    healthPath: '/health',
    heavy: false,
  },
  'audio-separator': {
    pythonModule: 'vd_separator',
    args: ({ port }) => ['--port', String(port)],
    healthPath: '/health',
    heavy: true,
  },
  whisperx: {
    pythonModule: 'vd_whisperx',
    args: ({ port }) => ['--port', String(port)],
    healthPath: '/health',
    heavy: true,
  },
};

/** Injectable seams (tests provide fakes). */
export interface EngineManagerDeps {
  store: EnginePackStore;
  /** Spawn a process; defaults to node:child_process spawn. */
  spawnImpl?: (cmd: string, args: string[], env: Record<string, string>) => ChildProcess;
  /** Probe a health URL; resolves true when ready. Default: HTTP GET 200. */
  healthProbe?: (url: string) => Promise<boolean>;
  /** Allocate a free port. Default: ephemeral via net. */
  allocatePort?: () => Promise<number>;
  /** Logger. */
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /** Health-wait timeout (ms). */
  startTimeoutMs?: number;
}

export class EngineManager {
  private readonly running = new Map<string, RunningEngine>();

  constructor(private readonly deps: EngineManagerDeps) {}

  /** Base URL of a running engine, or undefined. */
  baseUrl(packId: string): string | undefined {
    return this.running.get(packId)?.baseUrl;
  }

  /** Whether an engine is currently running. */
  isRunning(packId: string): boolean {
    return this.running.has(packId);
  }

  /**
   * Ensure a pack's server is running and return its base URL. Idempotent: a
   * second call returns the existing instance. When `exclusive` is set, other
   * *heavy* engines are stopped first to free RAM/VRAM for sequential phases.
   */
  async ensureRunning(packId: string, opts: { exclusive?: boolean } = {}): Promise<string> {
    const existing = this.running.get(packId);
    if (existing) return existing.baseUrl;

    const spec = ENGINE_LAUNCH_SPECS[this.providerOf(packId)];
    if (!spec) {
      throw new AppErrorException('ENGINE_UNAVAILABLE', `No launch spec for engine pack "${packId}".`);
    }

    if (opts.exclusive && spec.heavy) {
      await this.unloadHeavyExcept(packId);
    }

    const rec = await this.deps.store.get(packId);
    if (!rec) {
      throw new AppErrorException('ENGINE_PACK_MISSING', `Engine pack "${packId}" is not installed.`);
    }

    const exe = await this.resolveExecutable(rec.path, spec);
    const port = await (this.deps.allocatePort ?? allocateEphemeralPort)();
    // For uv-env packs the executable is the venv's `python`; it must be invoked
    // as `python -m <module> …`. The spec's `args` carry only the server flags
    // (e.g. --port), so prepend `-m <module>` here — without it the worker is
    // launched as `python --port <n>`, which Python rejects ("unknown option")
    // and exits instantly, surfacing as "engine did not become healthy in time".
    const specArgs = spec.args({ exe, port, packDir: rec.path });
    const args = spec.pythonModule ? ['-m', spec.pythonModule, ...specArgs] : specArgs;
    // Force UTF-8 stdio for the Python worker: on Windows the default console
    // encoding (cp1252) raises UnicodeEncodeError when the worker or its deps
    // print a non-Latin-1 string (e.g. a Vietnamese voice name), killing the
    // process. In the bundled app the Tauri sidecar already sets these on the
    // orchestrator (so they flow in via process.env); set them here too so
    // `npm run dev` and any host without the flag are covered. Our defaults come
    // first so an inherited value (if present) still wins.
    const env = {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...process.env,
      ...(spec.env ? spec.env({ port, packDir: rec.path }) : {}),
    } as Record<string, string>;

    this.deps.logger?.info(`Starting engine "${packId}" on port ${port}.`);
    const spawnImpl = this.deps.spawnImpl ?? defaultSpawn;
    const child = spawnImpl(exe, args, env);

    // Capture the worker's stderr + exit so a startup crash (missing dep, a native
    // lib that won't load, a bad port bind, …) is SURFACED in the timeout error
    // instead of the opaque "did not become healthy". Bounded so we never buffer
    // unboundedly. The exit handler also clears the running entry.
    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    let exitNote = '';
    child.on?.('exit', (code: number | null, signal: string | null) => {
      if (code != null && code !== 0) exitNote = ` (process exited with code ${code})`;
      else if (signal) exitNote = ` (process killed by ${signal})`;
      this.running.delete(packId);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const stop = async (): Promise<void> => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.running.delete(packId);
    };

    // Wait for health (the engine may take a moment to load its model).
    const probe = this.deps.healthProbe ?? httpHealthProbe;
    const healthUrl = `${baseUrl}${spec.healthPath ?? '/health'}`;
    const ready = await waitFor(() => probe(healthUrl), this.deps.startTimeoutMs ?? 60_000);
    if (!ready) {
      await stop();
      const tail = stderrTail.trim();
      const detail = tail ? ` Last engine output:\n${tail.slice(-1200)}` : exitNote;
      this.deps.logger?.warn(`Engine "${packId}" failed to become healthy.${detail}`);
      throw new AppErrorException(
        'ENGINE_UNAVAILABLE',
        `Engine "${packId}" did not become healthy in time.${detail}`,
        {
          remediation:
            'The local engine process failed to start or respond. Reinstall the engine pack in Settings → Engines, or switch this phase to a local CPU provider (e.g. Piper for TTS).',
        },
      );
    }

    const instance: RunningEngine = { packId, baseUrl, port, stop };
    this.running.set(packId, instance);
    return baseUrl;
  }

  /** Stop one engine. */
  async stop(packId: string): Promise<void> {
    await this.running.get(packId)?.stop();
  }

  /** Stop every running engine (call on app shutdown / project completion). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((e) => e.stop()));
  }

  /** Stop all heavy engines except the one named (the exclusive policy). */
  private async unloadHeavyExcept(keepPackId: string): Promise<void> {
    for (const [id, inst] of this.running) {
      if (id === keepPackId) continue;
      const spec = ENGINE_LAUNCH_SPECS[this.providerOf(id)];
      if (spec?.heavy) {
        this.deps.logger?.info(`Unloading heavy engine "${id}" to free memory for "${keepPackId}".`);
        await inst.stop();
      }
    }
  }

  /** Pack id == provider id by convention in the catalog; map both ways here. */
  private providerOf(packId: string): string {
    // whisper-cpp-metal/cuda/vulkan -> whisper-cpp; llama-cpp-* -> local-llm; etc.
    if (packId.startsWith('whisper-cpp')) return 'whisper-cpp';
    if (packId.startsWith('llama-cpp')) return 'local-llm';
    if (packId === 'tts-neural') return 'neural-tts';
    if (packId === 'tts-neural-v2') return 'neural-tts-v2';
    if (packId === 'separation-audio') return 'audio-separator';
    if (packId === 'alignment-whisperx') return 'whisperx';
    return packId;
  }

  /** Find the server binary (binary pack) or the venv python (uv-env pack). */
  private async resolveExecutable(packDir: string, spec: EngineLaunchSpec): Promise<string> {
    if (spec.pythonModule) {
      const py = process.platform === 'win32' ? path.join('venv', 'Scripts', 'python.exe') : path.join('venv', 'bin', 'python');
      const full = path.join(packDir, py);
      if (await exists(full)) return full;
      throw new AppErrorException('ENGINE_UNAVAILABLE', `Python venv missing in pack at ${packDir}.`);
    }
    for (const name of spec.binaryNames ?? []) {
      const found = await findFile(packDir, name);
      if (found) return found;
    }
    throw new AppErrorException('ENGINE_UNAVAILABLE', `Server binary not found in pack at ${packDir}.`);
  }
}

// --------------------------------------------------------------------------
// Helpers (exported where useful for tests)
// --------------------------------------------------------------------------

/** Recursively search a directory for a file with the given basename. */
export async function findFile(root: string, name: string, depth = 4): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFile(path.join(root, e.name), name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  return fsp
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** Poll `fn` until it returns true or the deadline passes. */
export async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // First attempt immediately.
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Allocate a free ephemeral loopback port. */
export function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

/** Default HTTP health probe: any non-5xx response counts as ready. */
async function httpHealthProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function defaultSpawn(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  // windowsHide: don't pop a console window for each spawned worker on Windows.
  return spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env, windowsHide: true });
}

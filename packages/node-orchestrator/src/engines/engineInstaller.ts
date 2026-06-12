/**
 * Engine-pack installer: download → verify → extract/materialize → record.
 *
 * Two artifact kinds:
 *   - normal URL: streamed to disk with percent progress, sha256-verified when
 *     a checksum is pinned, and extracted if it is an archive (.tar.gz/.zip).
 *   - `uv-env://<id>`: a self-contained Python environment built by uv from a
 *     locked requirements set (the ComfyUI Desktop pattern). uv + the locked
 *     env are materialized into `<packDir>/venv`. If uv is unavailable the
 *     installer reports ENGINE_PACK_FAILED with a clear remediation.
 *
 * Progress streams over an injected {@link EngineEventBus} (SSE-friendly).
 * Downloads land in a temp file and are renamed only after verification, so a
 * crash never leaves a corrupt pack recorded.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AppErrorException, type EnginePackArtifact, type EnginePackInfo, type InstalledEnginePack } from '@videodubber/shared';
import type { EngineEventBus } from './engineBus.js';
import type { EnginePackStore } from './enginePackStore.js';
import { findPack } from './enginePackCatalog.js';
import { resolveUvPath, UV_PYTHON_VERSION } from './uv.js';

/**
 * Locked Python requirement sets per uv-env pack id (the engine "manifest").
 *
 * These provide the THIRD-PARTY deps for each engine; the first-party server
 * module (e.g. `vd_tts_engine`) is loaded from bundled source via PYTHONPATH at
 * launch (see engineManager), so it is intentionally NOT listed here.
 *
 * NOTE (tts-neural / VieNeu): the GGUF CPU stack below is the documented path,
 * but `llama-cpp-python` ships platform-specific wheels and `neucodec` pulls a
 * large torch dependency — these versions should be pinned to a known-good set
 * per OS/arch after validating an install on each platform. `neuttsair` (the
 * NeuTTS Air inference code VieNeu builds on, Apache-2.0) is fetched from its
 * git repo as it is not published to PyPI.
 */
const UV_ENV_REQUIREMENTS: Record<string, string[]> = {
  'tts-neural': [
    'llama-cpp-python>=0.3',
    'neucodec>=0.0.4',
    'phonemizer>=3.2',
    'soundfile>=0.12',
    'numpy>=1.26',
    'huggingface-hub>=0.24',
    'neuttsair @ git+https://github.com/neuphonic/neutts-air.git',
    'fastapi>=0.110',
    'uvicorn>=0.29',
  ],
  'separation-audio': ['audio-separator>=0.18', 'onnxruntime>=1.20', 'fastapi>=0.110', 'uvicorn>=0.29'],
  'alignment-whisperx': ['whisperx>=3.8', 'fastapi>=0.110', 'uvicorn>=0.29'],
};

export interface EngineInstallerDeps {
  store: EnginePackStore;
  bus: EngineEventBus;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected timestamp factory (Date is unavailable in some sandboxes/tests). */
  now?: () => string;
}

export class EngineInstaller {
  private running = new Set<string>();

  constructor(private readonly deps: EngineInstallerDeps) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private nowIso(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /** Install a pack to completion; emits progress/done/error on the bus. */
  async install(packId: string): Promise<void> {
    if (this.running.has(packId)) {
      this.deps.bus.emit({ type: 'log', level: 'warn', message: `Install for "${packId}" already in progress.` });
      return;
    }
    const pack = findPack(packId);
    if (!pack) {
      this.deps.bus.emit({
        type: 'error',
        packId,
        error: { code: 'ENGINE_PACK_MISSING', message: `Unknown engine pack "${packId}".` },
      });
      return;
    }

    this.running.add(packId);
    const packDir = this.deps.store.packDir(packId);
    try {
      await fsp.rm(packDir, { recursive: true, force: true });
      await fsp.mkdir(packDir, { recursive: true });

      for (const artifact of pack.artifacts) {
        if (artifact.url.startsWith('uv-env://')) {
          await this.materializeUvEnv(pack, artifact, packDir);
        } else {
          await this.downloadArtifact(pack, artifact, packDir);
        }
      }

      const record: InstalledEnginePack = {
        id: pack.id,
        path: packDir,
        version: pack.id,
        installedAt: this.nowIso(),
      };
      await this.deps.store.add(record);
      this.deps.bus.emit({ type: 'done', packId, installed: record });
    } catch (err) {
      await fsp.rm(packDir, { recursive: true, force: true }).catch(() => undefined);
      const error =
        err instanceof AppErrorException
          ? err.appError
          : { code: 'ENGINE_PACK_FAILED' as const, message: `Failed to install "${packId}".`, cause: String(err) };
      this.deps.bus.emit({ type: 'error', packId, error });
    } finally {
      this.running.delete(packId);
    }
  }

  /** Stream a URL artifact to disk, verify, and extract if it's an archive. */
  private async downloadArtifact(pack: EnginePackInfo, artifact: EnginePackArtifact, packDir: string): Promise<void> {
    const dest = path.join(packDir, artifact.destPath === '.' ? path.basename(new URL(artifact.url).pathname) : artifact.destPath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.download`;

    this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: 0, message: `Downloading ${pack.displayName}…` });

    const res = await this.fetchImpl(artifact.url);
    if (!res.ok || !res.body) {
      throw new AppErrorException('ENGINE_PACK_FAILED', `Download failed (HTTP ${res.status}) for ${pack.displayName}.`, {
        remediation: 'Check your network connection and retry. The release URL may have changed.',
      });
    }

    const total = Number(res.headers.get('content-length') ?? 0);
    const hash = createHash('sha256');
    let received = 0;
    const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      if (total > 0) {
        const percent = Math.min(99, Math.round((received / total) * 100));
        this.deps.bus.emit({ type: 'progress', packId: pack.id, percent, message: `Downloading ${pack.displayName}… ${percent}%` });
      }
    });
    await pipeline(nodeStream, createWriteStream(tmp));

    if (artifact.sha256) {
      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw new AppErrorException('ENGINE_PACK_FAILED', `Checksum mismatch for ${pack.displayName} — download discarded.`);
      }
    } else {
      this.deps.bus.emit({ type: 'log', level: 'warn', message: `No checksum pinned for ${pack.id}; installed unverified.` });
    }

    await fsp.rename(tmp, dest);

    if (artifact.archive) {
      this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Extracting ${pack.displayName}…` });
      await this.extractArchive(dest, packDir);
      await fsp.rm(dest, { force: true }).catch(() => undefined);
    }
  }

  /** Extract a .tar.gz or .zip using the platform's system tools. */
  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.zip')) {
      // `unzip` on POSIX; PowerShell Expand-Archive on Windows.
      if (process.platform === 'win32') {
        await this.run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${destDir}"`]);
      } else {
        await this.run('unzip', ['-o', archivePath, '-d', destDir]);
      }
      return;
    }
    // tar handles .tar.gz on all three platforms (bsdtar ships on Win10+).
    await this.run('tar', ['-xzf', archivePath, '-C', destDir]);
  }

  /**
   * Materialize a uv-managed Python env from the locked requirement set.
   * Requires `uv` on PATH (we do not bundle it here; the installer reports a
   * clear remediation if it's absent so the rest of the app keeps working).
   */
  private async materializeUvEnv(pack: EnginePackInfo, artifact: EnginePackArtifact, packDir: string): Promise<void> {
    const reqs = UV_ENV_REQUIREMENTS[pack.id];
    if (!reqs) {
      throw new AppErrorException('ENGINE_PACK_FAILED', `No requirement set defined for uv pack "${pack.id}".`);
    }
    // Prefer the bundled uv (VIDEODUBBER_UV_PATH); fall back to PATH. With the
    // bundled uv, nothing needs to be preinstalled — uv downloads its own Python.
    const uv = await resolveUvPath();
    if (!uv) {
      throw new AppErrorException('ENGINE_PACK_FAILED', `'uv' is required to install ${pack.displayName} but was not found.`, {
        remediation:
          'The packaged app bundles uv automatically. In a dev/source build, install uv (https://docs.astral.sh/uv/) and retry — it manages the self-contained Python runtime for this engine.',
      });
    }
    const venvDir = path.join(packDir, artifact.destPath);
    this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Creating Python environment for ${pack.displayName}…` });
    // `--python <version>` makes uv install a managed standalone CPython when
    // the machine has none, so this works on a clean system with no Python.
    await this.run(uv, ['venv', '--python', UV_PYTHON_VERSION, venvDir]);
    const reqFile = path.join(packDir, 'requirements.txt');
    await fsp.writeFile(reqFile, `${reqs.join('\n')}\n`, 'utf8');
    this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Installing ${pack.displayName} dependencies (this can take a few minutes)…` });
    await this.run(uv, ['pip', 'install', '--python', venvDir, '-r', reqFile]);
  }

  /** Run a subprocess, rejecting on non-zero exit (stderr captured into the error). */
  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 400)}`));
      });
    });
  }
}

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
import { findPack, packRunsOn } from './enginePackCatalog.js';
import { resolveBundledPythonDir, resolveUvPath, UV_PYTHON_VERSION } from './uv.js';
import { resolveUvRequirements } from './uvRequirements.js';

/**
 * The locked, per-platform Python requirement sets live in `uvRequirements.ts`
 * (the engine "manifest"). They provide the THIRD-PARTY deps; the first-party
 * server module (e.g. `vd_tts_engine`) is loaded from bundled source via
 * PYTHONPATH at launch (see engineManager), so it is intentionally not listed.
 */

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
      if (process.platform === 'win32') {
        // Windows 10+ ships bsdtar, which extracts .zip too. Use it (paths passed
        // as argv) instead of PowerShell Expand-Archive — no shell-string to break
        // on special characters in the path, and no PowerShell process to spawn.
        await this.run('tar', ['-xf', archivePath, '-C', destDir]);
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
    // Fail fast with a clear reason on an unsupported platform/arch (e.g. the
    // VieNeu pack on Intel macOS, which has no torch wheel) instead of an opaque
    // `uv pip install` error deep in the resolve.
    if (!packRunsOn(pack, process.platform, process.arch)) {
      throw new AppErrorException(
        'ENGINE_PACK_FAILED',
        `${pack.displayName} is not supported on ${process.platform}/${process.arch}.`,
        { remediation: 'This engine has no build for your platform/architecture. Use a cloud provider for this phase instead.' },
      );
    }
    // Per-platform pinned set (e.g. tts-neural routes torch to the CPU index on
    // Linux/Windows). Resolved for the current platform/arch.
    const resolved = resolveUvRequirements(pack.id, process.platform, process.arch);
    if (!resolved) {
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

    // Use the BUNDLED standalone CPython if present so uv does NOT download an
    // interpreter from GitHub at runtime (fails on flaky links). Resolved relative
    // to the orchestrator binary, which is robust regardless of Tauri's resource
    // layout. only-managed + downloads=never => uv uses ONLY the bundled runtime.
    const uvEnv: NodeJS.ProcessEnv = { ...process.env };
    // Use the OS-native TLS stack (system trust store) instead of uv's bundled
    // rustls/webpki roots. Behind a corporate/ISP proxy or an antivirus that does
    // HTTPS/SSL inspection, the intercepting CA lives in the OS store but NOT in
    // uv's bundled roots, so downloads fail with "invalid peer certificate". The
    // native store trusts that CA, unblocking PyPI + the extra wheel indexes.
    uvEnv.UV_NATIVE_TLS = '1';
    const bundledPyDir = resolveBundledPythonDir();
    if (bundledPyDir) {
      uvEnv.UV_PYTHON_INSTALL_DIR = bundledPyDir;
      uvEnv.UV_PYTHON_DOWNLOADS = 'never';
      uvEnv.UV_PYTHON_PREFERENCE = 'only-managed';
      this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Using the bundled Python runtime (no download) for ${pack.displayName}…` });
    } else {
      this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `No bundled Python found; uv will download a runtime (needs internet) for ${pack.displayName}…` });
    }

    this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Creating Python environment for ${pack.displayName}…` });
    // `--python <version>` resolves to the bundled runtime (UV_PYTHON_INSTALL_DIR)
    // when present, else uv downloads a managed standalone CPython.
    try {
      await this.run(uv, ['venv', '--python', UV_PYTHON_VERSION, venvDir], uvEnv);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AppErrorException(
        'ENGINE_PACK_FAILED',
        `Could not create the Python environment for ${pack.displayName}: ${detail}`,
        {
          remediation: bundledPyDir
            ? `The bundled Python at "${bundledPyDir}" could not be used. Please report this with the message above.`
            : `No bundled Python runtime was found next to the app, so uv tried to download one from GitHub and the network blocked it. Reinstall the latest build (it bundles Python), or retry on a more reliable connection.`,
        },
      );
    }
    const reqFile = path.join(packDir, 'requirements.txt');
    await fsp.writeFile(reqFile, `${resolved.requirements.join('\n')}\n`, 'utf8');
    // Extra index URLs (e.g. the PyTorch CPU wheel index) precede `-r`. uv's
    // default `first-index` strategy would pin EVERY package present on an extra
    // index to that index (the PyTorch index mirrors numpy etc.), so we request
    // pip-like merge semantics (`unsafe-best-match`) when an extra index is used,
    // keeping non-torch deps resolving from PyPI at their pinned versions.
    const indexArgs = resolved.extraIndexUrls.flatMap((u) => ['--extra-index-url', u]);
    if (resolved.extraIndexUrls.length > 0) {
      indexArgs.push('--index-strategy', 'unsafe-best-match');
    }
    this.deps.bus.emit({ type: 'progress', packId: pack.id, percent: null, message: `Installing ${pack.displayName} dependencies (this can take a few minutes)…` });
    await this.run(uv, ['pip', 'install', '--python', venvDir, ...indexArgs, '-r', reqFile], uvEnv);
  }

  /** Run a subprocess, rejecting on non-zero exit (stderr captured into the error). */
  private run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: env ?? process.env });
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

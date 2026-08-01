/**
 * Self-service `uv` install — the last-resort path that makes Python engine
 * packs work with NOTHING preinstalled, even when the bundled sidecar is absent.
 *
 * WHY THIS EXISTS: the packaged app ships `uv` as a Tauri sidecar
 * (`binaries/vd-uv`, wired into `VIDEODUBBER_UV_PATH` by sidecar.rs), so end
 * users never think about it. But three real cases fall outside that:
 *   1. dev/source builds (`scripts/dev.*`, or `pnpm app` before
 *      `pnpm package:sidecars`) — the orchestrator runs from source with no
 *      sidecar and no `uv` on PATH;
 *   2. a corrupt/partial install where the declared sidecar is missing;
 *   3. a deliberately-degraded build that skipped uv bundling.
 * In all three the old behaviour was a dead end: "install uv yourself, then
 * retry". Since an engine-pack install is ALREADY downloading hundreds of MB
 * with the user's consent, fetching uv's ~20 MB release first is proportionate
 * — and it keeps the promise the UI makes ("just click Install").
 *
 * Trust model: the version is PINNED and every platform artifact carries a
 * pinned sha256 (values read from Astral's published `<asset>.sha256` files on
 * 2026-08-01) — the same tamper-evident story as the engine-pack catalog. We do
 * NOT fetch the checksum from the network alongside the artifact (that would
 * only prove the download matched itself). A mismatch discards the file.
 *
 * The result lands in `<configDir>/tools/uv/<version>/uv[.exe]`, so a version
 * bump installs cleanly beside the old one instead of overwriting a binary that
 * may be running.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppErrorException } from '@videodubber/shared';

/**
 * Pinned uv release. Keep in lockstep with the `UV_VERSION` default in
 * scripts/package/fetch-uv.sh + fetch-uv.ps1 (a unit test asserts they match),
 * so the binary a user downloads at runtime is the same one releases bundle.
 * To bump: change this, re-read the `.sha256` assets from the GitHub release,
 * update the table below, and update both scripts.
 */
export const UV_VERSION = '0.12.1';

/** Where Astral publishes the release assets. */
const UV_RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

interface UvArtifact {
  /** Release asset file name (also encodes the archive format). */
  asset: string;
  /** sha256 of the asset, from its published `.sha256` file. */
  sha256: string;
}

/**
 * Per-platform artifacts, keyed `${platform}-${arch}` in Node's own vocabulary
 * (process.platform / process.arch) so callers never hand-build a Rust triple.
 */
const UV_ARTIFACTS: Record<string, UvArtifact> = {
  'win32-x64': {
    asset: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: '8fcb0cb46e1229065e344758980924e569bef5882ef45f46fada8fb24e06b74a',
  },
  'win32-arm64': {
    asset: 'uv-aarch64-pc-windows-msvc.zip',
    sha256: '9bc7c18e616230fa2dc6fb24bc3afde18a95c2b5c9433de747e9502c66041568',
  },
  'darwin-arm64': {
    asset: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: '77d2906988e8074fd43f2f329ec452ebbf9b0c257ba1c66451c71de70a6baf42',
  },
  'darwin-x64': {
    asset: 'uv-x86_64-apple-darwin.tar.gz',
    sha256: '69d9f9a00337f25a50dcb13882052da08b8469bac11091c98c5694c3c6721467',
  },
  'linux-x64': {
    asset: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256: '90b2f223fb69d19db49e117da601f64978593417988530aa733d456141b4bcbb',
  },
  'linux-arm64': {
    asset: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    sha256: '769d373e146692c639b5fbaae33b331c297a32e03d30448772051902df52bbf4',
  },
};

/** The artifact for a platform/arch, or undefined where Astral ships no build. */
export function uvArtifactFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UvArtifact | undefined {
  return UV_ARTIFACTS[`${platform}-${arch}`];
}

/** Binary name on this platform. */
function uvBinName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/**
 * Where a self-installed uv of the PINNED version lives. Version-scoped: a
 * bump downloads beside the old copy rather than overwriting a binary that a
 * running install may still be executing.
 */
export function managedUvPath(configDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(configDir, 'tools', 'uv', UV_VERSION, uvBinName(platform));
}

/** True if a managed uv is already on disk (and executable-looking). */
export async function managedUvInstalled(configDir: string): Promise<string | null> {
  const p = managedUvPath(configDir);
  const ok = await fsp
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false);
  return ok ? p : null;
}

/** Progress sink: percent is null for indeterminate phases. */
export type UvBootstrapProgress = (percent: number | null, message: string) => void;

export interface UvBootstrapDeps {
  /** App config dir (the install lands under `<configDir>/tools/uv/...`). */
  configDir: string;
  onProgress?: UvBootstrapProgress;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * In-flight bootstrap per config dir — concurrent pack installs share ONE
 * download, but each keeps its own progress sink.
 *
 * The sink set matters: two packs installing at once each stream progress under
 * their OWN packId. If the joiner simply awaited the first caller's promise, its
 * pack would emit no events at all for the whole download — the installer's
 * first `bus.emit` happens only after uv resolves — so that row would sit frozen,
 * and a Settings revisit mid-install would replay no state for it.
 */
const inFlight = new Map<string, { promise: Promise<string>; sinks: Set<UvBootstrapProgress> }>();

/**
 * Ensure a usable uv exists, downloading the pinned release if needed.
 * Returns the binary path. Idempotent and concurrency-safe; a completed install
 * short-circuits on the next call.
 */
export function bootstrapUv(deps: UvBootstrapDeps): Promise<string> {
  const key = deps.configDir;
  const existing = inFlight.get(key);
  if (existing) {
    if (deps.onProgress) {
      const sink = deps.onProgress;
      existing.sinks.add(sink);
      // Detach on settle so a finished install can't hold the caller's closure
      // (and its bus reference) alive.
      return existing.promise.finally(() => existing.sinks.delete(sink));
    }
    return existing.promise;
  }

  const sinks = new Set<UvBootstrapProgress>();
  if (deps.onProgress) sinks.add(deps.onProgress);
  const fanOut: UvBootstrapProgress = (percent, message) => {
    for (const sink of sinks) {
      try {
        sink(percent, message);
      } catch {
        /* one bad sink must not abort the download */
      }
    }
  };
  const entry = {
    promise: doBootstrap({ ...deps, onProgress: fanOut }).finally(() => inFlight.delete(key)),
    sinks,
  };
  inFlight.set(key, entry);
  return entry.promise;
}

async function doBootstrap(deps: UvBootstrapDeps): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const already = await managedUvInstalled(deps.configDir);
  if (already) return already;

  const artifact = uvArtifactFor(platform, arch);
  if (!artifact) {
    throw new AppErrorException('ENGINE_PACK_FAILED', `No uv build is published for ${platform}/${arch}.`, {
      remediation:
        'Install uv manually (https://docs.astral.sh/uv/getting-started/installation/) so Python engine packs can be built, or use a cloud provider for this phase.',
    });
  }

  const versionDir = path.dirname(managedUvPath(deps.configDir, platform));
  // Extract into a scratch dir first: a crash mid-extract must never leave a
  // half-written tree at the path `managedUvInstalled` reports as ready.
  const workDir = `${versionDir}.tmp`;
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });

  const url = `${UV_RELEASE_BASE}/${artifact.asset}`;
  const archivePath = path.join(workDir, artifact.asset);
  try {
    deps.onProgress?.(0, `Downloading uv ${UV_VERSION} (Python environment manager)…`);
    await download(url, archivePath, artifact.sha256, deps, (pct) =>
      deps.onProgress?.(pct, `Downloading uv ${UV_VERSION}… ${pct}%`),
    );

    deps.onProgress?.(null, `Unpacking uv ${UV_VERSION}…`);
    return await installFromArchive(archivePath, workDir, deps.configDir, platform);
  } catch (err) {
    if (err instanceof AppErrorException) throw err;
    throw new AppErrorException('ENGINE_PACK_FAILED', `Could not install uv ${UV_VERSION} automatically.`, {
      cause: err instanceof Error ? err.message : String(err),
      remediation:
        'Check your network connection and retry. You can also install uv yourself (https://docs.astral.sh/uv/getting-started/installation/) and restart the app — it is picked up from PATH in dev builds.',
    });
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Unpack a VERIFIED archive and publish the binary at its managed path.
 *
 * Split out of {@link bootstrapUv} so the layout handling (Astral ships the
 * Unix binary inside `uv-<triple>/`, the Windows one at the zip root), the
 * executable bit, and the publish step are testable with a real archive —
 * without a test seam that could weaken the checksum pin.
 */
export async function installFromArchive(
  archivePath: string,
  workDir: string,
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  await extract(archivePath, workDir, platform);

  const found = await findBinary(workDir, uvBinName(platform));
  if (!found) {
    throw new AppErrorException('ENGINE_PACK_FAILED', `The uv ${UV_VERSION} archive did not contain a uv binary.`);
  }
  if (platform !== 'win32') await fsp.chmod(found, 0o755).catch(() => undefined);

  // Publish last: move the binary into place only once it is complete and
  // executable, so a concurrent `managedUvInstalled` never sees a path that
  // isn't yet runnable.
  const destBin = managedUvPath(configDir, platform);
  await fsp.mkdir(path.dirname(destBin), { recursive: true });
  await fsp.rm(destBin, { force: true }).catch(() => undefined);
  await fsp.rename(found, destBin);
  await pruneOtherVersions(configDir);
  return destBin;
}

/**
 * Delete every uv version dir except the pinned one (and any `*.tmp` scratch
 * left by an interrupted download). Version-scoped installs are what make a
 * bump safe, but without this each bump would strand another ~50 MB binary the
 * user has no way to find.
 */
async function pruneOtherVersions(configDir: string): Promise<void> {
  const root = path.join(configDir, 'tools', 'uv');
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name !== UV_VERSION)
      .map((e) => fsp.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => undefined)),
  );
}

/** Stream a URL to disk, verifying the pinned sha256 before it counts. */
async function download(
  url: string,
  dest: string,
  sha256: string,
  deps: UvBootstrapDeps,
  onPercent: (pct: number) => void,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) {
    throw new AppErrorException('ENGINE_PACK_FAILED', `Could not download uv ${UV_VERSION} (HTTP ${res.status}).`, {
      remediation:
        'Check your network connection and retry, or install uv yourself (https://docs.astral.sh/uv/getting-started/installation/).',
    });
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  let received = 0;
  let lastPct = -1;
  const stream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  stream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    hash.update(chunk);
    if (total > 0) {
      const pct = Math.min(99, Math.round((received / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        onPercent(pct);
      }
    }
  });
  await pipeline(stream, createWriteStream(dest));

  const digest = hash.digest('hex').toLowerCase();
  if (digest !== sha256.toLowerCase()) {
    await fsp.rm(dest, { force: true }).catch(() => undefined);
    throw new AppErrorException('ENGINE_PACK_FAILED', `Checksum mismatch on the uv ${UV_VERSION} download — discarded.`, {
      cause: `expected ${sha256}, got ${digest}`,
      remediation:
        'This usually means the download was corrupted or intercepted (proxy/antivirus). Retry; if it persists, install uv yourself (https://docs.astral.sh/uv/getting-started/installation/).',
    });
  }
}

/** Extract .zip/.tar.gz with the platform's system tar (bsdtar ships on Win10+). */
async function extract(archivePath: string, destDir: string, platform: NodeJS.Platform): Promise<void> {
  if (archivePath.toLowerCase().endsWith('.zip') && platform !== 'win32') {
    await run('unzip', ['-o', archivePath, '-d', destDir]);
    return;
  }
  // `tar -xf` auto-detects gzip AND zip under bsdtar, so one call covers both
  // the Windows .zip and the Unix .tar.gz.
  await run('tar', ['-xf', archivePath, '-C', destDir]);
}

/** Depth-first search for the extracted binary (layout differs per archive). */
async function findBinary(dir: string, name: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = await findBinary(path.join(dir, entry.name), name);
      if (hit) return hit;
    }
  }
  return null;
}

/** Spawn a tool and reject with its stderr tail on non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`)),
    );
  });
}

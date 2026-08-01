/**
 * Resolve the `uv` binary used to materialize Python engine packs.
 *
 * Resolution order:
 *   1. VIDEODUBBER_UV_PATH — the bundled `vd-uv` sidecar (set by the desktop
 *      shell). This is the zero-prerequisite path: a packaged app ships uv, and
 *      uv downloads its own standalone CPython, so the user installs nothing.
 *   2. A MANAGED uv previously downloaded by {@link ensureUvPath} into the app's
 *      config dir — our own pinned, checksum-verified build (see uvBootstrap.ts).
 *   3. `uv` on PATH — for dev / source checkouts.
 *
 * In a PACKAGED build (VIDEODUBBER_BUNDLED=1, set by sidecar.rs) the app owns its
 * whole toolchain, so a declared-but-broken bundled uv must NOT silently fall
 * through to a system `uv` of unknown version/Python — the PATH tier is skipped.
 * The MANAGED tier is still allowed there: it is a version-pinned binary this
 * app downloaded and hash-verified itself, not an unknown system install, and it
 * is what lets a corrupt install repair itself instead of dead-ending.
 *
 * Returns the resolved path, or null when uv is unavailable. Callers that are
 * about to NEED uv should prefer {@link ensureUvPath}, which downloads it.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException } from '@videodubber/shared';
import { bootstrapUv, managedUvInstalled, uvArtifactFor, type UvBootstrapProgress } from './uvBootstrap.js';

let cached: string | null | undefined;

/**
 * App config dir, set once at server startup — the root under which a managed
 * uv is downloaded/found. Null in unit tests that never configure it (the
 * managed tier is then simply skipped).
 */
let configDir: string | null = null;

/** Point the managed-uv tier at the app's config dir (called at startup). */
export function configureUvHome(dir: string): void {
  configDir = dir;
  cached = undefined; // a different home may hold a different (or no) managed uv
}

/** The Python version uv installs for engine-pack venvs when none is present. */
export const UV_PYTHON_VERSION = '3.12';

/** True if `dir` directly contains a `cpython-*` managed runtime (so it's usable
 * as a `UV_PYTHON_INSTALL_DIR`). */
function dirHasCpython(dir: string): boolean {
  try {
    return readdirSync(dir).some((e) => e.startsWith('cpython-'));
  } catch {
    return false;
  }
}

/**
 * Resolve the directory holding the BUNDLED standalone CPython that the packaged
 * app ships (staged into `resources/python` by scripts/package/fetch-python.*),
 * so uv can create engine-pack venvs WITHOUT downloading an interpreter from
 * GitHub at runtime (which fails on flaky international links).
 *
 * Resolution order (first hit wins), returning the dir that contains `cpython-*`:
 *   1. `UV_PYTHON_INSTALL_DIR` already set by the desktop shell (sidecar.rs).
 *   2. Relative to the orchestrator's OWN executable — the bundled SEA binary
 *      sits in the install dir next to the `resources/` tree. This is robust
 *      regardless of how Tauri lays out `resource_dir()` on a given OS/installer.
 *   3. Sibling of the bundled engine-src dir (`<resources>/engine-src` -> `<resources>/python`).
 *
 * Returns `null` in a dev/source build (no bundled runtime) — uv then downloads
 * CPython as before.
 */
export function resolveBundledPythonDir(): string | null {
  const fromEnv = process.env.UV_PYTHON_INSTALL_DIR?.trim();
  if (fromEnv && dirHasCpython(fromEnv)) return fromEnv;

  const roots: string[] = [];
  try {
    roots.push(path.dirname(process.execPath));
  } catch {
    /* execPath unavailable — skip */
  }
  const engineSrc = process.env.VIDEODUBBER_ENGINE_SRC_DIR?.trim();
  if (engineSrc) roots.push(path.dirname(engineSrc)); // <resources>/engine-src -> <resources>

  for (const root of roots) {
    for (const candidate of [path.join(root, 'resources', 'python'), path.join(root, 'python')]) {
      if (dirHasCpython(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve a usable `uv` path (cached). */
export async function resolveUvPath(): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = await resolve();
  return cached;
}

/**
 * Resolve uv, DOWNLOADING our pinned build if none is present.
 *
 * This is what callers about to run uv should use: it turns "uv is missing"
 * from a dead end (asking the user to go install a third-party tool) into a
 * ~20 MB step inside a download the user already started. Only reached in a
 * dev/source build or a broken install — the packaged app's bundled sidecar
 * short-circuits at tier 1.
 *
 * Throws (rather than returning null) when uv can neither be found nor
 * installed, so the caller can surface the actionable reason.
 */
export async function ensureUvPath(onProgress?: UvBootstrapProgress): Promise<string> {
  const found = await resolveUvPath();
  if (found) return found;
  if (!configDir) {
    throw new AppErrorException('ENGINE_PACK_FAILED', "'uv' was not found and no app config dir is available.", {
      remediation:
        'Install uv (https://docs.astral.sh/uv/getting-started/installation/) and retry — it manages the self-contained Python runtime for this engine.',
    });
  }
  const installed = await bootstrapUv({ configDir, ...(onProgress ? { onProgress } : {}) });
  cached = installed; // a later resolveUvPath() must see it without re-probing
  return installed;
}

/** Whether uv is available RIGHT NOW (bundled, managed, or on PATH). */
export async function uvAvailable(): Promise<boolean> {
  return (await resolveUvPath()) !== null;
}

/**
 * Whether uv could be made available — already present, or installable on
 * demand by {@link ensureUvPath}. The UI uses this to decide whether to offer
 * an Install button rather than a "needs uv" dead end.
 */
export async function uvObtainable(): Promise<boolean> {
  return (await uvAvailable()) || (configDir !== null && uvArtifactFor() !== undefined);
}

/** Reset the cache (tests). */
export function _resetUvCache(): void {
  cached = undefined;
  configDir = null;
}

/** True when running inside a packaged/bundled app (VIDEODUBBER_BUNDLED, set by
 * the desktop shell). Used to forbid the system-uv fallback in production. */
function isPackaged(): boolean {
  const v = process.env.VIDEODUBBER_BUNDLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function resolve(): Promise<string | null> {
  const bundled = process.env.VIDEODUBBER_UV_PATH?.trim();
  let bundledBroken = false;
  if (bundled) {
    const ok = await fsp
      .stat(bundled)
      .then((s) => s.isFile())
      .catch(() => false);
    if (ok) return bundled;
    // The bundled uv was DECLARED but is missing/unusable — a corrupt install
    // (the build-time bundle assertion should have caught a bad build). Don't
    // silently use a system uv of unknown version/Python in a packaged app;
    // our own managed copy below is fine, and repairs the install.
    bundledBroken = true;
  }
  if (configDir) {
    const managed = await managedUvInstalled(configDir);
    if (managed) return managed;
  }
  if (bundledBroken && isPackaged()) return null;
  return which('uv');
}

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [bin], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] || null : null));
  });
}

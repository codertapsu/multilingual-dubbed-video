/**
 * Resolve the `uv` binary used to materialize Python engine packs.
 *
 * Resolution order:
 *   1. VIDEODUBBER_UV_PATH — the bundled `vd-uv` sidecar (set by the desktop
 *      shell). This is the zero-prerequisite path: a packaged app ships uv, and
 *      uv downloads its own standalone CPython, so the user installs nothing.
 *   2. `uv` on PATH — for dev / source checkouts.
 *
 * Returns the resolved path, or null when uv is unavailable (the caller then
 * surfaces an actionable "install uv" remediation instead of failing opaquely).
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let cached: string | null | undefined;

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

/** Whether uv is available (bundled or on PATH). */
export async function uvAvailable(): Promise<boolean> {
  return (await resolveUvPath()) !== null;
}

/** Reset the cache (tests). */
export function _resetUvCache(): void {
  cached = undefined;
}

async function resolve(): Promise<string | null> {
  const bundled = process.env.VIDEODUBBER_UV_PATH?.trim();
  if (bundled) {
    const ok = await fsp
      .stat(bundled)
      .then((s) => s.isFile())
      .catch(() => false);
    if (ok) return bundled;
  }
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

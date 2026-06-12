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
import fsp from 'node:fs/promises';

let cached: string | null | undefined;

/** The Python version uv installs for engine-pack venvs when none is present. */
export const UV_PYTHON_VERSION = '3.12';

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
    const child = spawn(finder, [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] || null : null));
  });
}

/**
 * Resolve the first of `bins` found on PATH (for system-tool prerequisite
 * checks like espeak-ng). Returns the path, or null if none are present.
 */
export async function commandOnPath(...bins: string[]): Promise<string | null> {
  for (const bin of bins) {
    const found = await which(bin);
    if (found) return found;
  }
  return null;
}

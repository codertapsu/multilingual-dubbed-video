/**
 * Which build of the orchestrator is actually running.
 *
 * WHY: the release process has already shipped an installer carrying a STALE
 * orchestrator sidecar (docs/RELEASING.md — "skipping `-Sidecars` for a
 * non-shell change … ships an installer missing the fix entirely"). The only
 * guard was a per-change `strings`/grep of the bundled binary, which requires
 * remembering which string to look for and has already failed once. Reporting
 * the version + commit over `GET /health` turns that into something the shell,
 * a smoke script, or a user's bug report can check in one call.
 *
 * Resolution order, most-authoritative first:
 *   1. `VD_BUILD_VERSION` / `VD_BUILD_COMMIT` / `VD_BUILD_AT` env vars — what
 *      the Tauri shell (which knows its own `app.package_info().version`) or a
 *      release script sets when launching the sidecar.
 *   2. `globalThis.__VD_BUILD__` — a build-time `--define` in the SEA bundle
 *      step, for a stamp that cannot be faked by the environment.
 *   3. The nearest package.json on disk — dev/source runs only; a packaged SEA
 *      has no package.json next to it and lands on the `unknown` fallback,
 *      which is itself a useful signal (it means "not a stamped build").
 */
import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Version/commit stamp of the running orchestrator. */
export interface BuildInfo {
  /** App version (e.g. "0.9.0"), or "unknown" when the build carries no stamp. */
  version: string;
  /** Git commit the build came from, when stamped. */
  commit?: string;
  /** ISO timestamp of the build, when stamped. */
  builtAt?: string;
}

/** Shape injected by the bundler's `--define:__VD_BUILD__`. */
interface InjectedBuild {
  version?: string;
  commit?: string;
  builtAt?: string;
}

/** Trimmed env var, or undefined when unset/empty. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Walk up from this module looking for a package.json with a version. Dev-only:
 * inside the SEA bundle `import.meta.url` is undefined, `fileURLToPath` throws,
 * and we fall through to the caller's fallback.
 */
function versionFromDisk(): string | undefined {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  const { root } = parse(dir);
  for (let i = 0; i < 6 && dir !== root; i += 1) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  return undefined;
}

/** Resolve the build stamp once per process (it cannot change while running). */
function resolveBuildInfo(): BuildInfo {
  const injected = (globalThis as { __VD_BUILD__?: InjectedBuild }).__VD_BUILD__ ?? {};
  const version = env('VD_BUILD_VERSION') ?? injected.version ?? versionFromDisk() ?? 'unknown';
  const commit = env('VD_BUILD_COMMIT') ?? injected.commit;
  const builtAt = env('VD_BUILD_AT') ?? injected.builtAt;
  return {
    version,
    ...(commit ? { commit } : {}),
    ...(builtAt ? { builtAt } : {}),
  };
}

const BUILD_INFO: BuildInfo = resolveBuildInfo();

/** The running orchestrator's build stamp (resolved at import time). */
export function buildInfo(): BuildInfo {
  return BUILD_INFO;
}

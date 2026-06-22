/**
 * Disk-storage management for the Settings "free up disk space" panel.
 *
 * Everything the app downloads on demand lives under the config dir
 * (`~/VideoDubber` by default), in three deletable, re-downloadable trees:
 *   - `engines/` — engine packs (llama.cpp + GGUF models, neural-TTS/separation/
 *     alignment uv venvs, LibreTranslate) — usually the biggest consumer.
 *   - `models/`  — the Whisper HF cache (`models/huggingface`) + Piper voices
 *     (`models/piper`); pinned here by the desktop shell so nothing leaks into
 *     the user's global `~/.cache/huggingface`.
 *   - `cache/`   — transient working files (`VIDEODUBBER_CACHE_DIR`).
 *
 * The user's PROJECTS (their dubbed outputs) are deliberately NOT touched.
 * Argos packs live in argostranslate's own data dir and have their own
 * Settings manager, so they're out of scope here too.
 */
import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  StorageClearRequest,
  StorageClearResult,
  StorageCategory,
  StorageInfo,
  StorageLocation,
} from '@videodubber/shared';
import type { OrchestratorConfig } from './config.js';
import type { EnginePackStore } from './engines/enginePackStore.js';
import type { EngineManager } from './engines/engineManager.js';
import type { SetupStore } from './setup/setupStore.js';

/** The transient cache dir the desktop shell points workers at (`<config>/cache`). */
function cacheDir(config: Pick<OrchestratorConfig, 'configDir'>): string {
  return path.join(config.configDir, 'cache');
}

/**
 * Recursive byte size of a directory's contents (0 if missing). Symlinks are
 * NOT followed — `readdir` reports a symlinked dir as a non-directory, so we
 * skip it, and files are sized with `lstat` (the link's own size). This keeps
 * the walk bounded and prevents counting anything outside the tree.
 */
export async function dirSize(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing / unreadable
  }
  let total = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(full);
      else if (e.isFile()) total += (await fsp.lstat(full)).size;
    } catch {
      /* skip a file that vanished or can't be stat'd */
    }
  }
  return total;
}

/** Free disk space (bytes) at `dir`, or null if `statfs` is unavailable. */
async function freeBytes(dir: string): Promise<number | null> {
  const statfs = (fsp as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs;
  if (typeof statfs !== 'function') return null;
  // Walk up to an existing ancestor (statfs needs a real path).
  let target = path.resolve(dir);
  for (let i = 0; i < 16; i++) {
    try {
      await fsp.access(target);
      break;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
  }
  try {
    const s = await statfs(target);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** The three managed locations (paths only). */
function locationsOf(config: Pick<OrchestratorConfig, 'configDir' | 'modelsDir'>, enginesDir: string): {
  key: StorageCategory;
  label: string;
  path: string;
}[] {
  return [
    { key: 'engines', label: 'Engine packs', path: enginesDir },
    { key: 'models', label: 'Downloaded models (Whisper, Piper)', path: config.modelsDir },
    { key: 'cache', label: 'Temporary cache', path: cacheDir(config) },
  ];
}

/** Measure the app's deletable on-disk footprint (GET /storage). */
export async function describeStorage(
  config: Pick<OrchestratorConfig, 'configDir' | 'modelsDir'>,
  enginePackStore: EnginePackStore,
): Promise<StorageInfo> {
  const defs = locationsOf(config, enginePackStore.enginesDir);
  const [sizes, free, installed] = await Promise.all([
    Promise.all(defs.map((d) => dirSize(d.path))),
    freeBytes(config.configDir),
    enginePackStore.list(),
  ]);
  const locations: StorageLocation[] = defs.map((d, i) => ({ ...d, bytes: sizes[i]! }));
  return {
    root: config.configDir,
    locations,
    totalBytes: sizes.reduce((a, b) => a + b, 0),
    freeBytes: free,
    installedEnginePacks: installed.length,
  };
}

/** Wipe a directory's contents and recreate it empty; returns the pre-wipe size. */
async function wipeDir(dir: string): Promise<number> {
  const size = await dirSize(dir);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
  return size;
}

/** Dependencies for {@link clearStorage} (injectable for tests). */
export interface ClearStorageDeps {
  config: Pick<OrchestratorConfig, 'configDir' | 'modelsDir'>;
  enginePackStore: EnginePackStore;
  setupStore: SetupStore;
  /** Optional: stop running engines before deleting their files. */
  engineManager?: Pick<EngineManager, 'stopAll'>;
}

/**
 * Delete the requested storage categories (default: all) and reconcile the
 * stores so the app knows nothing is installed. Returns the bytes freed.
 */
export async function clearStorage(req: StorageClearRequest, deps: ClearStorageDeps): Promise<StorageClearResult> {
  const { config, enginePackStore, setupStore, engineManager } = deps;
  const want = {
    engines: req.engines !== false,
    models: req.models !== false,
    cache: req.cache !== false,
  };
  const cleared: StorageCategory[] = [];
  let freedBytes = 0;

  if (want.engines) {
    // Stop any running engine first so we never delete a binary/venv out from
    // under a live process (which would otherwise fail mid-pipeline).
    await engineManager?.stopAll().catch(() => undefined);
    freedBytes += await wipeDir(enginePackStore.enginesDir);
    await enginePackStore.clear();
    cleared.push('engines');
  }
  if (want.models) {
    freedBytes += await wipeDir(config.modelsDir);
    await setupStore.clearModelInventory();
    cleared.push('models');
  }
  if (want.cache) {
    freedBytes += await wipeDir(cacheDir(config));
    cleared.push('cache');
  }

  return { ok: true, freedBytes, cleared };
}

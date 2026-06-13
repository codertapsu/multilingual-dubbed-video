/**
 * Pick the right engine pack for a provider on this machine.
 *
 * A logical provider (e.g. `whisper-cpp`) has several catalog packs, one per
 * acceleration backend. We prefer the most capable backend the machine has
 * (cuda > metal > vulkan > coreml > mps > cpu) among the packs that both run on
 * this platform AND are installed.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, type EngineAccel, type EnginePackInfo } from '@videodubber/shared';
import { availablePacks, findPack } from './enginePackCatalog.js';
import type { EnginePackStore } from './enginePackStore.js';

/**
 * Is a recorded pack actually RUNNABLE — not merely present on disk?
 *
 * `EnginePackStore.isInstalled` only checks the pack DIRECTORY still exists, so a
 * pack whose venv is missing/broken (e.g. its venv `python` symlink points at a
 * bundled CPython that moved when the app was reinstalled, or a half-finished
 * install) reads as "installed", is offered as available, then fails at run with
 * "Python venv missing". This verifies the real launch artifact:
 *   - uv-env (python-uv) packs → the venv's python executable resolves (stat
 *     follows the symlink, so a dangling target correctly fails);
 *   - binary packs → the extracted directory is enough.
 */
export async function isPackUsable(store: EnginePackStore, packId: string): Promise<boolean> {
  const rec = await store.get(packId);
  if (!rec) return false;
  const dirOk = await fsp
    .stat(rec.path)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!dirOk) return false;

  const pack = findPack(packId);
  const isUvEnv = pack?.artifacts.some((a) => a.url.startsWith('uv-env://')) ?? false;
  if (!isUvEnv) return true;

  const venvPython =
    process.platform === 'win32'
      ? path.join(rec.path, 'venv', 'Scripts', 'python.exe')
      : path.join(rec.path, 'venv', 'bin', 'python');
  return fsp
    .stat(venvPython)
    .then((s) => s.isFile())
    .catch(() => false);
}

/** Higher = preferred. */
const ACCEL_RANK: Record<EngineAccel, number> = {
  cuda: 5,
  metal: 4,
  vulkan: 3,
  coreml: 2,
  mps: 2,
  cpu: 1,
};

/** Catalog packs for a provider that run on the given machine, best-accel first. */
export function packsForProvider(
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo[] {
  return availablePacks(platform, arch)
    .filter((p) => p.providerId === providerId)
    .sort((a, b) => ACCEL_RANK[b.accel] - ACCEL_RANK[a.accel]);
}

/** The best INSTALLED pack id for a provider, or undefined if none installed. */
export async function pickInstalledPack(
  store: EnginePackStore,
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string | undefined> {
  const candidates = packsForProvider(providerId, platform, arch);
  for (const pack of candidates) {
    if (await store.isInstalled(pack.id)) return pack.id;
  }
  return undefined;
}

/** Resolve an installed pack id or throw a clear ENGINE_PACK_MISSING. */
export async function requireInstalledPack(store: EnginePackStore, providerId: string): Promise<string> {
  const id = await pickInstalledPack(store, providerId);
  if (!id) {
    throw new AppErrorException('ENGINE_PACK_MISSING', `No engine pack installed for "${providerId}".`, {
      remediation: 'Install the engine pack in Settings → Engines, or pick a different provider for this phase.',
    });
  }
  return id;
}

/** The best pack to SUGGEST installing for a provider (most capable for the machine). */
export function recommendedPackFor(
  providerId: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnginePackInfo | undefined {
  return packsForProvider(providerId, platform, arch)[0];
}

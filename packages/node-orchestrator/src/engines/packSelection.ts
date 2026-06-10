/**
 * Pick the right engine pack for a provider on this machine.
 *
 * A logical provider (e.g. `whisper-cpp`) has several catalog packs, one per
 * acceleration backend. We prefer the most capable backend the machine has
 * (cuda > metal > vulkan > coreml > mps > cpu) among the packs that both run on
 * this platform AND are installed.
 */
import { AppErrorException, type EngineAccel, type EnginePackInfo } from '@videodubber/shared';
import { availablePacks } from './enginePackCatalog.js';
import type { EnginePackStore } from './enginePackStore.js';

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

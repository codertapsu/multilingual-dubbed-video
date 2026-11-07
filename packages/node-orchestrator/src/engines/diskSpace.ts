/**
 * "Is there room?" before an engine-pack download, not after.
 *
 * The GPU voice pack builds a ~4.3 GB Python environment. Without a check, a
 * small SSD fills up minutes into the install and the user gets a uv error
 * about a failed write, with no hint that disk space was the problem or how
 * much was needed. Checking first costs one statfs call.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EnginePackInfo } from '@videodubber/shared';

/** Free bytes on the volume holding `dir` (or its nearest existing parent). */
export async function freeBytes(dir: string): Promise<number | undefined> {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      const s = await fsp.statfs(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined; // statfs unsupported: don't guess
      probe = parent;
    }
  }
}

/**
 * Free space (MB) an install of `pack` needs, beyond its listed size. Pure.
 *
 * - uv environments: uv hard-links packages from its cache, so the venv is
 *   about its listed size; a quarter on top covers the resolver's temporaries.
 * - archives: the download and its extracted contents exist side by side for a
 *   moment, and extraction expands (the llama.cpp CUDA zip, 287 MB, unpacks to
 *   about 600 MB), so three times the download.
 * - plain files (model weights): written once, so a tenth on top.
 * Plus 512 MB that should stay free for everything else on the machine.
 */
export function requiredFreeMb(pack: Pick<EnginePackInfo, 'artifacts'>): number {
  const need = pack.artifacts.reduce((sum, a) => {
    if (a.url.startsWith('uv-env://')) return sum + a.approxSizeMb * 1.25;
    if (a.archive) return sum + a.approxSizeMb * 3;
    return sum + a.approxSizeMb * 1.1;
  }, 0);
  return Math.ceil(need + 512);
}

/**
 * The installed engine packs' files, as the pinned catalog names them
 * (GET /engines/installed): for another app on this computer that reuses
 * VideoDubber's downloaded models in place, read-only. Voice Mask's model
 * locator (its plan, Appendix D) assumed the layout under
 * %USERPROFILE%\VideoDubber\engines and read translategemma-4b/model.gguf
 * there; this says where each file is instead.
 *
 * A file is listed when the catalog pins it: its absolute path, its size on
 * disk, and the sha256 its download was checked against (`alsoSha256`: the
 * same content as upstream re-uploaded it, enginePackCatalog.ts). Python
 * environments (uv-env://) and the files extracted from archives carry no pin
 * of their own and are not listed. Nothing is hashed here: a reader verifies
 * a file by its own pinned catalog before it uses it.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EngineKind } from '@videodubber/shared';
import { findPack } from './enginePackCatalog.js';
import type { EnginePackStore } from './enginePackStore.js';

/** One pinned file of an installed pack. */
export interface InstalledPackFile {
  /** Absolute. */
  path: string;
  /** Bytes on disk now. */
  size: number;
  /** The checksum its download was verified against. */
  sha256: string;
  /** Other checksums of the same content (an upstream re-upload). */
  alsoSha256?: string[];
}

/** An installed pack and its pinned files. */
export interface InstalledPackFiles {
  id: string;
  /** The version recorded when it was installed. */
  version?: string;
  kind?: EngineKind;
  providerId?: string;
  files: InstalledPackFile[];
}

/** Every installed pack with the pinned files it has on disk. */
export async function installedPackFiles(store: Pick<EnginePackStore, 'list'>): Promise<InstalledPackFiles[]> {
  const out: InstalledPackFiles[] = [];
  for (const installed of await store.list()) {
    const pack = findPack(installed.id);
    const files: InstalledPackFile[] = [];
    for (const artifact of pack?.artifacts ?? []) {
      if (artifact.url.startsWith('uv-env://') || artifact.archive || !artifact.sha256) continue;
      const abs = path.resolve(installed.path, artifact.destPath);
      const st = await fsp.stat(abs).catch(() => undefined);
      if (!st?.isFile()) continue;
      files.push({
        path: abs,
        size: st.size,
        sha256: artifact.sha256.toLowerCase(),
        ...(artifact.alsoSha256?.length ? { alsoSha256: artifact.alsoSha256.map((h) => h.toLowerCase()) } : {}),
      });
    }
    out.push({
      id: installed.id,
      ...(installed.version ? { version: installed.version } : {}),
      ...(pack ? { kind: pack.kind, providerId: pack.providerId } : {}),
      files,
    });
  }
  return out;
}

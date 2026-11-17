/**
 * The folder a project saves its finished video and subtitles in (see shared
 * pipeline/output.ts for the names): checks that a folder the user chose can
 * take them, names the files so projects sharing a folder never collide, and
 * moves a project's finished files when the user picks another folder.
 */
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppErrorException, PROJECT_OUTPUT_EXTENSIONS, chosenOutputBaseName } from '@videodubber/shared';
import { renameReplacing } from '../fsRename.js';

const DOCS_REF = 'docs/TROUBLESHOOTING.md#output-not-writable';

/** Two paths name the same place (case-insensitively on Windows and macOS's default volume). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}

/**
 * Make sure `dir` exists and VideoDubber can write in it, or say why not in
 * words a user can act on. A real write, not fs.access: W_OK on a Windows
 * folder says nothing about its ACL.
 */
export async function ensureWritableDir(dir: string): Promise<void> {
  const probe = path.join(dir, `.videodubber-write-test-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, '');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw new AppErrorException('OUTPUT_NOT_WRITABLE', `VideoDubber cannot save files in ${dir}.`, {
      cause: err instanceof Error ? err.message : String(err),
      remediation: 'Choose another folder, or one you can write to (not a read-only or protected location).',
      docsRef: DOCS_REF,
    });
  }
}

/**
 * A folder the user picked or typed, as a full path VideoDubber can write
 * in. "~" means the home folder (typed in the browser UI, or by Claude). A
 * relative path is refused, not resolved: resolved against wherever the
 * orchestrator happens to run, "Dubs" would land in C:\Program Files\….
 */
export async function acceptOutputDir(dir: string): Promise<string> {
  const typed = dir.trim();
  const expanded = /^~(?=$|[\\/])/.test(typed) ? path.join(os.homedir(), typed.slice(1)) : typed;
  if (!path.isAbsolute(expanded)) {
    throw new AppErrorException('OUTPUT_NOT_WRITABLE', `"${typed}" is not a full folder path.`, {
      remediation: 'Give the whole path, starting from the drive (D:\\Dubs) or from / (/Users/you/Dubs).',
      docsRef: DOCS_REF,
    });
  }
  const resolved = path.resolve(expanded);
  await ensureWritableDir(resolved);
  return resolved;
}

/** Is `baseName` taken in `dir` (any of the files a render may write)? */
export function outputBaseNameTaken(dir: string, exists: (p: string) => boolean = existsSync) {
  return (baseName: string): boolean => PROJECT_OUTPUT_EXTENSIONS.some((ext) => exists(path.join(dir, `${baseName}${ext}`)));
}

/**
 * A free base name for a project's files in a chosen folder: not used by a
 * file there, nor `held` by another project saving to that folder that has
 * not rendered yet (lower-cased: Windows and macOS names ignore case).
 */
export function freeOutputBaseName(
  dir: string,
  projectName: string,
  targetLanguage: string,
  held: ReadonlySet<string> = new Set(),
): string {
  const onDisk = outputBaseNameTaken(dir);
  return chosenOutputBaseName(projectName, targetLanguage, (base) => held.has(base.toLowerCase()) || onDisk(base));
}

/**
 * Move one file, across drives too: rename refuses EXDEV, so copy (under a
 * .partial name, never a half-written file under the real one), then remove
 * the original. Once the copy is in place the move has happened: an original
 * still held open elsewhere stays behind rather than failing it.
 */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await renameReplacing(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const partial = `${to}.partial`;
    try {
      await fsp.copyFile(from, partial);
      await renameReplacing(partial, to);
    } catch (copyErr) {
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      throw copyErr;
    }
    await fsp.rm(from, { force: true }).catch(() => undefined);
  }
}

/**
 * Move a project's finished files to their new paths, all or none. A file
 * that will not move (on Windows: open in a video player) puts back the
 * ones already moved, so the project is never left half in each folder
 * while its record names only one of them. Missing files are skipped: a
 * project not yet rendered has nothing to move.
 */
export async function moveOutputFiles(moves: ReadonlyArray<readonly [from: string, to: string]>): Promise<void> {
  const done: Array<readonly [string, string]> = [];
  for (const [from, to] of moves) {
    const present = await fsp.stat(from).then(
      () => true,
      () => false,
    );
    if (!present) continue;
    try {
      await moveFile(from, to);
      done.push([from, to]);
    } catch (err) {
      for (const [movedFrom, movedTo] of done.reverse()) await moveFile(movedTo, movedFrom).catch(() => undefined);
      throw new AppErrorException(
        'OUTPUT_NOT_WRITABLE',
        `VideoDubber could not move ${path.basename(from)} to ${path.dirname(to)}.`,
        {
          cause: err instanceof Error ? err.message : String(err),
          remediation: 'If the video is open in another app (a video player), close it and try again.',
          docsRef: DOCS_REF,
        },
      );
    }
  }
}

/**
 * Atomic artifact writes for every ffmpeg output.
 *
 * WHY THIS EXISTS: ffmpeg used to write straight to the final path
 * (`original_16k_mono.wav`, `final_mix.wav`, `output.mp4`). If the process was
 * killed mid-write — cancel, app crash, OS restart, disk full — the final path
 * was left holding a NON-EMPTY, TRUNCATED file. The orchestrator's resume check
 * (`fileExistsNonEmpty`, runner.ts `outputsExist`) is a `size > 0` test, so the
 * next run "skipped" that step and reported SUCCESS: a dub whose audio stops
 * halfway, or an STT transcript covering only part of the video, with no error
 * anywhere. Writing to a sibling `.partial` file and renaming only after ffmpeg
 * exits 0 makes "the artifact exists" mean "the artifact is complete" again,
 * which is what the resume predicate has always assumed.
 *
 * The partial lives in the SAME directory as the destination so the rename is a
 * cheap same-filesystem operation (a temp dir could be on another volume, where
 * rename falls back to a copy — or fails outright).
 */

import { renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/**
 * The in-progress path used for `dest`: `<dir>/<base>.partial<ext>`.
 *
 * The EXTENSION IS PRESERVED because ffmpeg picks its muxer from the output
 * file's extension — a bare `output.mp4.partial` fails with "Unable to find a
 * suitable output format". Pure (unit-tested).
 */
export function partialPathFor(dest: string): string {
  const ext = extname(dest);
  const base = basename(dest, ext);
  return join(dirname(dest), `${base}.partial${ext}`);
}

/** Best-effort removal; never masks the original failure. */
function removeQuietly(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* ignore — a leftover .partial is harmless, an exception here is not */
  }
}

/**
 * Run `write(partialPath)` and publish the result to `dest` only on success.
 *
 * On ANY failure (ffmpeg non-zero exit, cancellation, timeout, ENOSPC) the
 * partial file is removed and the error is rethrown, so the destination either
 * holds a complete artifact or does not exist at all. A stale partial from a
 * previous crash is cleared before the write starts.
 */
export async function writeAtomically<T>(
  dest: string,
  write: (partialPath: string) => Promise<T>,
): Promise<T> {
  const partial = partialPathFor(dest);
  removeQuietly(partial);
  let result: T;
  try {
    result = await write(partial);
  } catch (err) {
    removeQuietly(partial);
    throw err;
  }
  // Rename is atomic within a filesystem and overwrites an existing dest, which
  // keeps the "-y overwrite" resume semantics ffmpeg had before.
  try {
    await renameReplacing(partial, dest);
  } catch (err) {
    removeQuietly(partial);
    throw err;
  }
  return result;
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** 10 ms doubling to a 250 ms cap, ~2.3 s in total. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [
  10, 20, 40, 80, 160, 250, 250, 250, 250, 250, 250, 250, 250,
];

/**
 * Replace `dest` with `from`, retrying Windows' transient "target in use" codes.
 *
 * POSIX rename replaces a file whoever has it open; Windows refuses with EPERM /
 * EACCES / EBUSY while any other handle is open on the target. Here that is not
 * hypothetical: the studio's preview streams output.mp4 and the mix from disk,
 * and Defender scans each freshly written partial. Re-rendering with the
 * preview open would fail at random on Windows only. The orchestrator carries
 * the same helper (src/fsRename.ts), which found the bug first, on
 * pipeline.json. Other platforms and other codes throw at once.
 */
export async function renameReplacing(
  from: string,
  to: string,
  deps: {
    rename?: (a: string, b: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  const rename = deps.rename ?? (async (a: string, b: string) => renameSync(a, b));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = (deps.platform ?? process.platform) === 'win32' ? RENAME_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = retries[attempt];
      if (delay === undefined || !code || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await sleep(delay);
    }
  }
}

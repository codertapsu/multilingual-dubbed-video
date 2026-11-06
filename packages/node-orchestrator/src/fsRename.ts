/**
 * `rename(tmp, dest)` that survives Windows' transient replace failures.
 *
 * Every atomic write here is "write a sibling temp file, rename it over the
 * target". POSIX rename replaces the target no matter who has it open. Windows
 * does not: MoveFileEx(REPLACE_EXISTING) fails with EPERM / EACCES / EBUSY
 * while ANY other handle is open on the target (a concurrent read of
 * pipeline.json, another write landing at the same moment, an antivirus or
 * Search indexer scan of the freshly written file). The other handle is gone
 * within milliseconds, but the rename has already thrown.
 *
 * This surfaced the first time the suite ran on Windows: the drift-grouping
 * runner test failed 4 runs in 8 with
 *   EPERM: operation not permitted, rename '.pipeline.json.<hex>.tmp' -> 'pipeline.json'
 * which in the product means a dub step failing outright, at random, on
 * Windows only. The cure is the one graceful-fs ships: retry those codes with a
 * short backoff. Other errors (ENOENT, EXDEV, ...) are real and thrown at once,
 * and other platforms never retry.
 */
import fsp from 'node:fs/promises';

/** Codes Windows returns while another handle holds the target. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface RenameRetryDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

/** Backoff schedule: 10, 20, 40 ... capped at 250 ms, ~2.3 s in total. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [
  10, 20, 40, 80, 160, 250, 250, 250, 250, 250, 250, 250, 250,
];

export async function renameReplacing(
  from: string,
  to: string,
  deps: RenameRetryDeps = {},
): Promise<void> {
  const rename = deps.rename ?? ((a: string, b: string) => fsp.rename(a, b));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = (deps.platform ?? process.platform) === 'win32' ? RENAME_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = retries[attempt];
      if (delay === undefined || !code || !TRANSIENT.has(code)) throw err;
      await sleep(delay);
    }
  }
}

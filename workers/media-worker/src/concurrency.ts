/**
 * Bounded concurrency for independent ffmpeg jobs.
 *
 * WHY: the long-video TTS timeline is mixed in chunks of 32 clips, and every
 * chunk is its own single-threaded ffmpeg (amix + adelay over the FULL
 * timeline). They ran one after another: 29-74 s per dub on a 16-thread
 * i5-13400F with 15 threads idle. The chunks share nothing until the final
 * mix, so they can run side by side; only the order of the results matters,
 * and that is fixed by index here, never by completion order, so the final mix
 * is byte-identical to the sequential one.
 */

import { availableParallelism } from 'node:os';
import { AppErrorException } from '@videodubber/shared';

/** Never run more than this many mix processes at once. */
export const MAX_MIX_CONCURRENCY = 4;

/**
 * How many chunk mixes to run at once on this machine: one per logical CPU,
 * minus one left for the orchestrator/UI, capped at {@link MAX_MIX_CONCURRENCY}.
 *
 * Logical, not physical: Node exposes no portable physical-core count, and each
 * mix is a single-threaded process, so even a hyper-threaded sibling helps. The
 * cap keeps the scratch-disk write load sane — every chunk streams a
 * full-length WAV (~360 MB for a 31-minute video). Pure given `cpuCount`.
 */
export function defaultMixConcurrency(cpuCount: number = availableParallelism()): number {
  const n = Number.isFinite(cpuCount) ? Math.floor(cpuCount) : 1;
  return Math.max(1, Math.min(MAX_MIX_CONCURRENCY, n - 1));
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight, returning the
 * results IN INPUT ORDER.
 *
 * Failure and cancellation: the first error aborts the shared signal handed to
 * every call (so sibling ffmpeg children are killed instead of grinding on), no
 * further item starts, and the function waits for every in-flight call to
 * settle before rethrowing that FIRST error — the caller's `finally` may delete
 * the scratch dir the siblings are writing into, which Windows refuses while a
 * file in it is still open. Aborting `outerSignal` behaves the same way and
 * rejects with CANCELLED if nothing else failed first.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  outerSignal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (outerSignal?.aborted) controller.abort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed && !controller.signal.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index, controller.signal);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
          controller.abort();
        }
      }
    }
  };

  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  try {
    // Workers never reject (they record the error), so this resolves only once
    // every started call has settled.
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }

  if (failed) throw firstError;
  if (outerSignal?.aborted) {
    throw new AppErrorException('CANCELLED', 'Operation was cancelled.');
  }
  return results;
}

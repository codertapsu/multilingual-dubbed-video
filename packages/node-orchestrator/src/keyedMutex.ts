/**
 * A tiny in-process mutex, keyed (here: by project id).
 *
 * WHY: the editor's project artifacts are updated read-modify-write —
 * `translated.aligned.json` is read into an array, spliced, and written back
 * whole (`patchAlignedSegment`). The editor deliberately allows concurrent
 * actions on DIFFERENT segments (see `withEditorLane`), and the UI only guards
 * per segment, so two "Regenerate" clicks interleaved their read and write and
 * one segment's alignment entry was silently lost — its clip then landed in the
 * mix with stale timing, with no error anywhere.
 *
 * Deliberately NOT reentrant: it is only ever taken around a single leaf write
 * helper, never around a region that calls another guarded helper, so a lock can
 * never be waited on from inside itself.
 */
export class KeyedMutex {
  /** Tail of the pending chain per key; absent = idle. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` with exclusive access to `key`. Rejections propagate to the caller
   * but never break the chain for whoever is waiting behind it.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Swallow the predecessor's failure: waiting on someone else's error must
    // not fail this caller, it only has to wait for their turn to end.
    const mine = previous.then(fn, fn);
    // The tail must never reject, or an unhandled rejection escapes whenever the
    // next caller does not attach an error handler.
    const tail = mine.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await mine;
    } finally {
      // Nobody queued behind us -> drop the key so the map can't grow forever.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of keys with work queued (test/diagnostic helper). */
  get size(): number {
    return this.tails.size;
  }
}

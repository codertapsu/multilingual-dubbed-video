/**
 * The queue paused for an app update (POST /queue/pause-for-update), as the
 * queue's preference says it: paused, and why, so that it goes on by itself
 * once the app is back.
 *
 * The updater refuses to install while a dub runs or waits in a queue that
 * may start it. On 2026-11-27 the way through was to pause the running dub;
 * the queue then started the next part, which had to be paused too, and so
 * on: 29 parts of a series stood "paused on their own" (each pause counted as
 * the user's), and nothing went on after the update. Now one step pauses the
 * queue and puts every running dub back at its head (Orchestrator
 * .requeueRunningForUpdate), and these two rules say what happens to the
 * pause itself.
 */
import type { ConcurrencyPreferences } from '@videodubber/shared';

/**
 * The queue's preference with the update pause on. Asked again before the app
 * is back (a second click, a retry), it keeps what the first one recorded:
 * the queue counts as paused before only if it was before the first.
 */
export function pauseQueueForUpdate(
  current: ConcurrencyPreferences | undefined,
  opts: { version?: string; now?: Date } = {},
): ConcurrencyPreferences {
  const base: ConcurrencyPreferences = { mode: 'auto', ...current };
  const marker = base.pausedForUpdate ?? {
    at: (opts.now ?? new Date()).toISOString(),
    ...(opts.version ? { version: opts.version } : {}),
    queueWasPaused: base.paused === true,
  };
  return { ...base, paused: true, pausedForUpdate: marker };
}

/**
 * The queue's preference once the app is back, or the install did not
 * happen: paused again only if it was before the update; undefined when the
 * queue was not paused for an update (nothing to do).
 */
export function queueAfterUpdate(current: ConcurrencyPreferences | undefined): ConcurrencyPreferences | undefined {
  const marker = current?.pausedForUpdate;
  if (!current || !marker) return undefined;
  const { pausedForUpdate: _done, ...rest } = current;
  return { ...rest, paused: marker.queueWasPaused };
}

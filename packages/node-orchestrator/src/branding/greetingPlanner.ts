/**
 * Where a project's spoken greeting plays (`audio/greeting_plan.json`).
 *
 * Only in quiet moments: no dub voice and no original speech there (the
 * original bed is only turned down under the dub, so a greeting over leftover
 * speech would be heard on top of it). Music is fine: the greeting rides in
 * the dub's track, so the bed is lowered under it like under a line.
 *
 *   - The opening one plays in the first quiet moment that starts within the
 *     opening window (default 60 s); none there, none at all: it never plays
 *     before the video (the user's choice, 2026-11-19).
 *   - Repeats are spread evenly rather than at random (random spots bunch up
 *     and change every render): aim at evenly spaced points and take the
 *     quiet moment nearest each, at least 3 minutes from another greeting and
 *     never in the first or last 30 s. "auto" is about one per 10 minutes, at
 *     most 6; asking for more than fit plays as many as fit, and says so.
 *   - A placement the user made or moved (`manual`) stays as it is.
 *
 * Pure: the inputs are times, the output is a plan.
 */
import type { GreetingPlacement, GreetingPlan, GreetingSettings, TimeSpan } from '@videodubber/shared';

/** Space kept clear on each side of a greeting. */
export const GREETING_PAD_MS = 400;
/** Least time between two greetings. */
export const GREETING_SPACING_MS = 180_000;
/** No repeat this close to the start or the end. */
export const GREETING_EDGE_MS = 30_000;
/** "auto": one repeat per this much video… */
export const AUTO_EVERY_MS = 600_000;
/** …and never more than this many. */
export const AUTO_MAX = 6;

export interface GreetingPlanInput {
  assetId: string;
  durationMs: number;
  greetingMs: number;
  /** When someone speaks: the dub's lines and the original's speech, in any order, overlapping. */
  busy: readonly TimeSpan[];
  settings: Pick<GreetingSettings, 'atStart' | 'startWindowSec' | 'repeat'>;
  /** Placements the user made or moved (kept). */
  manual?: readonly GreetingPlacement[];
}

/** The quiet stretches of [0, duration): the complement of `busy`. Pure. */
export function quietGaps(busy: readonly TimeSpan[], durationMs: number): TimeSpan[] {
  const spans = busy
    .map((b) => ({ startMs: Math.max(0, b.startMs), endMs: Math.min(durationMs, b.endMs) }))
    .filter((b) => b.endMs > b.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const gaps: TimeSpan[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.startMs > cursor) gaps.push({ startMs: cursor, endMs: s.startMs });
    cursor = Math.max(cursor, s.endMs);
  }
  if (cursor < durationMs) gaps.push({ startMs: cursor, endMs: durationMs });
  return gaps;
}

/** How many repeats "auto" or a count means for this video. Pure. */
export function repeatCount(repeat: GreetingSettings['repeat'], durationMs: number): number {
  if (repeat === 'off') return 0;
  if (repeat === 'auto') return Math.min(AUTO_MAX, Math.round(durationMs / AUTO_EVERY_MS));
  return Math.max(0, Math.min(20, Math.floor(repeat)));
}

export function planGreetings(input: GreetingPlanInput): GreetingPlan {
  const { durationMs, greetingMs } = input;
  const need = greetingMs + 2 * GREETING_PAD_MS;
  const gaps = quietGaps(input.busy, durationMs).filter((g) => g.endMs - g.startMs >= need);
  const manual = [...(input.manual ?? [])].filter((p) => p.manual).map((p) => ({ ...p }));
  const placed: GreetingPlacement[] = [...manual];
  const farFromOthers = (at: number): boolean => placed.every((p) => Math.abs(p.atMs - at) >= GREETING_SPACING_MS);

  let openingSkipped = false;
  if (input.settings.atStart && !manual.some((p) => p.kind === 'opening')) {
    const windowEnd = Math.max(0, input.settings.startWindowSec) * 1000;
    const first = gaps.find((g) => g.startMs + GREETING_PAD_MS <= windowEnd);
    if (first) placed.push({ atMs: Math.round(first.startMs + GREETING_PAD_MS), kind: 'opening' });
    else openingSkipped = true;
  }

  const requested = repeatCount(input.settings.repeat, durationMs);
  let found = 0;
  for (let k = 1; k <= requested; k++) {
    const target = (durationMs * k) / (requested + 1) - greetingMs / 2;
    let best: number | undefined;
    for (const g of gaps) {
      // Where in this gap the greeting may start, kept off the video's edges.
      const lo = Math.max(g.startMs + GREETING_PAD_MS, GREETING_EDGE_MS);
      const hi = Math.min(g.endMs - GREETING_PAD_MS - greetingMs, durationMs - GREETING_EDGE_MS - greetingMs);
      if (hi < lo) continue;
      const at = Math.round(Math.min(hi, Math.max(lo, target)));
      if (!farFromOthers(at)) continue;
      if (best === undefined || Math.abs(at - target) < Math.abs(best - target)) best = at;
    }
    if (best !== undefined) {
      placed.push({ atMs: best, kind: 'repeat' });
      found += 1;
    }
  }

  return {
    assetId: input.assetId,
    durationMs: greetingMs,
    placements: placed.sort((a, b) => a.atMs - b.atMs),
    requested,
    found,
    ...(openingSkipped ? { openingSkipped: true } : {}),
  };
}

/**
 * Check placements the user sent (the editor): inside the video, not over one
 * another. Returns them sorted and marked manual, or why not. Pure.
 */
export function validatePlacements(
  placements: readonly GreetingPlacement[],
  durationMs: number,
  greetingMs: number,
): { ok: true; placements: GreetingPlacement[] } | { ok: false; reason: string } {
  const sorted = [...placements]
    .map((p) => ({ atMs: Math.round(p.atMs), kind: p.kind === 'opening' ? ('opening' as const) : ('repeat' as const), manual: true }))
    .sort((a, b) => a.atMs - b.atMs);
  for (const [i, p] of sorted.entries()) {
    if (!Number.isFinite(p.atMs) || p.atMs < 0 || p.atMs + greetingMs > durationMs) {
      return { ok: false, reason: 'A greeting has to start and end inside the video.' };
    }
    const prev = sorted[i - 1];
    if (prev && p.atMs < prev.atMs + greetingMs) return { ok: false, reason: 'Two greetings would play over each other.' };
  }
  return { ok: true, placements: sorted };
}

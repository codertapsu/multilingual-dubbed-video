/**
 * When a finished video's thumbnail (the post's picture, get_outputs) is
 * taken. A frame with a subtitle across it, or the title card of a series
 * part, makes a poor picture for a post; so: the middle of the longest
 * stretch where no line is spoken, between 15 % and 60 % of the video (past
 * the opening, before the ending). A subtitle stays up a little after its
 * voice ends, hence the margins around each line. A third of the way in when
 * no stretch of at least 1.5 s is free. Pure.
 */

/** A line as it plays in the finished video (ms). */
export interface SpokenSpan {
  startMs: number;
  endMs: number;
}

/** A subtitle can come up a little before its voice and stays up after it ends. */
const LEAD_MS = 300;
const HOLD_MS = 1200;
/** The shortest quiet stretch worth aiming for. */
const MIN_FREE_MS = 1500;

export function thumbnailMomentMs(durationMs: number, spoken: readonly SpokenSpan[]): number {
  const total = Math.max(0, Math.round(durationMs));
  if (total === 0) return 0;
  const from = Math.max(Math.round(total * 0.15), Math.min(8000, Math.round(total / 2)));
  const to = Math.max(from, Math.round(total * 0.6));
  const busy = spoken
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .map((s) => ({ startMs: s.startMs - LEAD_MS, endMs: s.endMs + HOLD_MS }))
    .sort((a, b) => a.startMs - b.startMs);
  let best: SpokenSpan | undefined;
  const consider = (gapStart: number, gapEnd: number): void => {
    const s = Math.max(gapStart, from);
    const e = Math.min(gapEnd, to);
    if (e - s >= MIN_FREE_MS && (!best || e - s > best.endMs - best.startMs)) best = { startMs: s, endMs: e };
  };
  let cursor = 0;
  for (const b of busy) {
    consider(cursor, b.startMs);
    cursor = Math.max(cursor, b.endMs);
  }
  consider(cursor, total);
  const at = best ? (best.startMs + best.endMs) / 2 : total / 3;
  return Math.min(Math.max(0, total - 100), Math.round(at));
}

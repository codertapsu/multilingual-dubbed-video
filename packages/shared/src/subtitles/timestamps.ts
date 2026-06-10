/**
 * Subtitle timestamp formatting helpers.
 *
 * All timestamps are integer milliseconds internally. SRT uses a comma before
 * the millisecond field; WebVTT uses a dot.
 */

/** Clamp to a non-negative integer number of milliseconds. */
function clampMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms);
}

/** Left-pad a number with zeros to a fixed width. */
function pad(n: number, width: number): string {
  return n.toString().padStart(width, '0');
}

/**
 * Break a millisecond value into `HH`, `MM`, `SS`, `mmm` parts.
 * Hours are not capped at 24 (long media is supported).
 */
function parts(ms: number): { hh: string; mm: string; ss: string; mmm: string } {
  const total = clampMs(ms);
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return {
    hh: pad(hours, 2),
    mm: pad(minutes, 2),
    ss: pad(seconds, 2),
    mmm: pad(millis, 3),
  };
}

/**
 * Format milliseconds as an SRT timestamp: `HH:MM:SS,mmm`.
 *
 * Examples: 0 -> "00:00:00,000"; 3661001 -> "01:01:01,001".
 */
export function toSrtTimestamp(ms: number): string {
  const { hh, mm, ss, mmm } = parts(ms);
  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Format milliseconds as a WebVTT timestamp: `HH:MM:SS.mmm`.
 *
 * Examples: 0 -> "00:00:00.000"; 3661001 -> "01:01:01.001".
 */
export function toVttTimestamp(ms: number): string {
  const { hh, mm, ss, mmm } = parts(ms);
  return `${hh}:${mm}:${ss}.${mmm}`;
}

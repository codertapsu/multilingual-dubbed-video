/**
 * Source-video quality targets, shared by the orchestrator and the UI.
 *
 * The rule lives here rather than in either side because both need it and they
 * must agree: the screen promises "1080p selected → 720p will be downloaded"
 * before the download starts, and the provider then has to make exactly that
 * choice. Two copies of this rule would drift, and the symptom would be a
 * download quietly differing from what the user was shown.
 */

/** One rung of the quality ladder the user chooses from. */
export interface QualityTarget {
  /** Pixel height this rung asks for. */
  heightPx: number;
  /** i18n key suffix, so the UI names it without hardcoding a string here. */
  key: string;
}

/**
 * The ladder offered to the user, best first.
 *
 * Deliberately a fixed ladder of familiar names rather than the list of
 * qualities a particular video happens to offer. It is a standing PREFERENCE —
 * "give me 1080p when you can" — so every rung stays selectable even when this
 * video cannot serve it. That is the one place where showing an option the
 * source cannot satisfy is right rather than misleading, because the option
 * describes an intent, not a claim about this video.
 */
export const QUALITY_LADDER: readonly QualityTarget[] = [
  { heightPx: 2160, key: '4k' },
  { heightPx: 1440, key: '2k' },
  { heightPx: 1080, key: '1080p' },
  { heightPx: 720, key: '720p' },
  { heightPx: 480, key: '480p' },
  { heightPx: 360, key: '360p' },
];

/**
 * Resolve a target against what a source can actually deliver.
 *
 * Picks the highest available height that does not EXCEED the target, so
 * asking for 1080p on a video capped at 720p downloads 720p rather than
 * failing or silently jumping to something larger than requested.
 *
 * When every available height is above the target — asking for 360p from a
 * source that only serves 720p — it returns the lowest available rather than
 * nothing: the user asked for "small", and the smallest on offer is the honest
 * answer to that, where refusing to download would not be.
 *
 * No target means "the best there is".
 */
export function pickClosestHeight(
  available: readonly number[],
  targetHeightPx?: number,
): number | undefined {
  const heights = [...new Set(available.filter((h) => h > 0))].sort((a, b) => b - a);
  if (heights.length === 0) return undefined;
  if (targetHeightPx === undefined) return heights[0];

  const atOrBelow = heights.find((h) => h <= targetHeightPx);
  return atOrBelow ?? heights[heights.length - 1];
}

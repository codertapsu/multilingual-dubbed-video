/**
 * Which clip a line is voiced in, and which clips a "re-voice" asks for.
 *
 * A merged clip (one take for several lines) is ONE synthesis: its id is its
 * first line's, and re-voicing any of its lines re-voices all of them (the
 * server degroups it). The busy mark used to go on the clip while the
 * inspector's Regenerate looked for the LINE, so on any line but a clip's
 * first the button never showed it was working, and every further click
 * queued the same synthesis again.
 */

/** A unit as far as these rules care: its id and its lines. */
export interface ClipLike {
  id: string;
  segmentIds: readonly string[];
}

/** Each line's clip, from a timeline's units. */
export function unitIndex(units: readonly ClipLike[]): Map<string, ClipLike> {
  const map = new Map<string, ClipLike>();
  for (const u of units) for (const id of u.segmentIds) map.set(id, u);
  return map;
}

/** The clip a line is voiced in: its unit's id, or the line's own id before there are units. */
export function clipOf(segmentId: string, unitBySegment: ReadonlyMap<string, { id: string }>): string {
  return unitBySegment.get(segmentId)?.id ?? segmentId;
}

/**
 * The clips to re-voice for some lines: each clip once, in the order first
 * asked for, without the clips already being voiced, and at most `limit`.
 */
export function clipsToVoice(
  segmentIds: Iterable<string>,
  unitBySegment: ReadonlyMap<string, { id: string }>,
  busy: ReadonlySet<string>,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of segmentIds) {
    const clip = clipOf(id, unitBySegment);
    if (seen.has(clip)) continue;
    seen.add(clip);
    if (busy.has(clip)) continue;
    out.push(clip);
    if (out.length >= limit) break;
  }
  return out;
}

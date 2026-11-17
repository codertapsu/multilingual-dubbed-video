/**
 * Voice-synced subtitle timing overrides.
 *
 * The alignment step re-times subtitle cues inside merged synthesis groups to
 * when the dub voice actually speaks them (see {@link retimeCuesToVoice}). Those
 * overrides are PERSISTED here so EVERY place that regenerates the SRT/VTT
 * sidecars — the runner, an editor text edit, a per-segment refit — reapplies
 * them, instead of reverting the whole track to the source-speech cue times.
 *
 * The canonical `translated.json` timings are never touched; overrides live in
 * their own artifact keyed by segment id.
 */
import fsp from 'node:fs/promises';
import {
  planDisplayCues,
  transcriptSegmentsToCues,
  type DisplayCueInput,
  type IndexedCue,
  type TranscriptSegment,
} from '@videodubber/shared';
import { writeJsonAtomic } from './projectStore.js';

/** One cue's overridden start/end (ms). */
export interface CueTiming {
  startMs: number;
  endMs: number;
}

/** Persisted shape of cue_timing.json. */
interface CueTimingArtifact {
  overrides: Record<string, CueTiming>;
}

/** Read the persisted cue-timing overrides (empty map when absent/corrupt). */
export async function readCueOverrides(path: string): Promise<Map<string, CueTiming>> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as CueTimingArtifact;
    const entries = Object.entries(parsed.overrides ?? {}).filter(
      ([, v]) => typeof v?.startMs === 'number' && typeof v?.endMs === 'number',
    );
    return new Map(entries as [string, CueTiming][]);
  } catch {
    return new Map();
  }
}

/** Persist cue-timing overrides (writes an empty set rather than deleting, so a
 * later regeneration deterministically finds "no overrides" and uses canonical). */
export async function writeCueOverrides(path: string, overrides: ReadonlyMap<string, CueTiming>): Promise<void> {
  const obj: CueTimingArtifact = { overrides: Object.fromEntries(overrides) };
  // Atomic: the editor regenerates the sidecars from this file at any moment.
  await writeJsonAtomic(path, obj);
}

/**
 * Drop overrides for the given ids (e.g. a group degrouped by a single-segment
 * re-synthesis — its members now speak from their own cue, so canonical timing
 * is correct again). No-op when the file is absent or nothing matches.
 */
export async function clearCueOverridesFor(path: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const overrides = await readCueOverrides(path);
  if (overrides.size === 0) return;
  let changed = false;
  for (const id of ids) changed = overrides.delete(id) || changed;
  if (changed) await writeCueOverrides(path, overrides);
}

/**
 * Apply cue-timing overrides to a copy of `segments` (for sidecar generation
 * ONLY — never persisted back to translated.json). Segments without an override
 * keep their canonical timing. Returns the input array unchanged when there are
 * no overrides.
 */
export function applyCueOverrides(
  segments: readonly TranscriptSegment[],
  overrides: ReadonlyMap<string, CueTiming>,
): TranscriptSegment[] {
  if (overrides.size === 0) return segments as TranscriptSegment[];
  return segments.map((s) => {
    const o = overrides.get(s.id);
    return o ? { ...s, startMs: o.startMs, endMs: o.endMs } : s;
  });
}

/** What the dub did with each synthesis unit (the parts of AlignedSegment read here). */
export interface PlacedUnit {
  /** The unit's id: its first line's id. */
  segmentId: string;
  /** Where its clip starts in the mix, ms. */
  startMs: number;
  /** How long the clip plays once fitted, ms. */
  placedDurationMs: number;
}

/**
 * The cues every subtitle FILE is written from (SRT/VTT, and the burned-in
 * render, which draws the SRT): the canonical or voice-synced times, planned
 * for reading by shared `planDisplayCues` — sorted, held long enough to read,
 * never on screen for 99 s, merged within a synthesis group rather than
 * flashed. When the dub is known (`units` + `groups`), each unit's last line
 * stays up until its voice has finished: the subtitle audit found the voice
 * still talking after its subtitle had gone in 15–54 lines per video.
 */
export function displayCuesFor(
  segments: readonly TranscriptSegment[],
  dub: {
    overrides?: ReadonlyMap<string, CueTiming>;
    groups?: readonly { id: string; segmentIds: readonly string[] }[];
    units?: readonly PlacedUnit[];
  } = {},
): IndexedCue[] {
  const timed = dub.overrides ? applyCueOverrides(segments, dub.overrides) : [...segments];
  const groupOf = new Map<string, string>();
  for (const g of dub.groups ?? []) for (const id of g.segmentIds) groupOf.set(id, g.id);
  const voiceEnd = new Map<string, number>();
  for (const u of dub.units ?? []) {
    const lastLine = dub.groups?.find((g) => g.id === u.segmentId)?.segmentIds.at(-1) ?? u.segmentId;
    if (u.placedDurationMs > 0) voiceEnd.set(lastLine, u.startMs + u.placedDurationMs);
  }
  const byIndex = new Map(timed.map((s) => [s.index + 1, s.id]));
  const inputs: DisplayCueInput[] = transcriptSegmentsToCues(timed).map((cue) => {
    const id = cue.index !== undefined ? byIndex.get(cue.index) : undefined;
    const end = id ? voiceEnd.get(id) : undefined;
    const group = id ? groupOf.get(id) : undefined;
    return { ...cue, ...(end !== undefined ? { voiceEndMs: end } : {}), ...(group ? { groupId: group } : {}) };
  });
  return planDisplayCues(inputs);
}

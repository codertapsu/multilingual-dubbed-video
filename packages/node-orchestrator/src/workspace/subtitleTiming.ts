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
import type { TranscriptSegment } from '@videodubber/shared';

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
  await fsp.writeFile(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
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

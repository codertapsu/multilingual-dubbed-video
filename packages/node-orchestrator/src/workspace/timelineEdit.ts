/**
 * Editor timeline edits: validate + apply segment patches, then keep the
 * synthesis-group plan and the alignment inputs consistent with them.
 *
 * WHY THIS IS ITS OWN MODULE: a timeline edit touches four artifacts that each
 * encode the same timing — translated.json (canonical cues), source.json (so a
 * re-translate keeps the user's timing), synthesis_groups.json (a group's
 * window is derived from its members) and translated.aligned.json (placement +
 * fit status). Getting any one of them out of step produces a dub whose voice
 * plays somewhere other than where the editor shows it. Everything here is
 * PURE (no I/O) so the invariants are unit-tested; the orchestrator only reads
 * and writes.
 *
 * The invariants enforced:
 *  - a line starts before it ends, never before 0, never past the media end;
 *  - the TIMELINE ORDER never changes: dragging may move or trim a line within
 *    its neighbours, never past one (the WAV file names, every gap-aware
 *    alignment window and the synthesis groups all assume this order);
 *  - an edit may not CREATE an overlap with a neighbour (pre-existing overlaps
 *    from the recogniser are tolerated — they are the source's, not the user's);
 *  - a real text change locks the line and marks its clip stale; a voice/rate
 *    change marks the clip stale; a timing change does neither (the audio is
 *    unchanged, only where it plays).
 */
import { AppErrorException, type SegmentPatch, type TranscriptSegment } from '@videodubber/shared';
import type { AlignInputSegment } from '../alignment/align.js';
import type { SynthesisGroup } from '../pipeline/grouping.js';

/** Shortest line the editor may produce (ms). Shorter is unreadable and unspeakable. */
export const MIN_SEGMENT_MS = 80;
/** Rounding slack at the media end (container durations are ms-rounded). */
const END_TOLERANCE_MS = 50;
/** Allowed speaking-rate range — what Piper/OpenAI honour without artefacts. */
export const MIN_SPEAKING_RATE = 0.5;
export const MAX_SPEAKING_RATE = 2;
/** Sanity cap on one line's text (a subtitle, not a document). */
const MAX_TEXT_CHARS = 5000;

/** What a batch of patches changed, by kind. */
export interface PatchOutcome {
  /** The updated segments, in (unchanged) timeline order, re-indexed. */
  segments: TranscriptSegment[];
  textChanged: Set<string>;
  timingChanged: Set<string>;
  voiceChanged: Set<string>;
  rateChanged: Set<string>;
  lockChanged: Set<string>;
}

function invalid(message: string): never {
  throw new AppErrorException('INVALID_EDIT', message);
}

function finiteMs(value: unknown, field: string, id: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`Line ${id}: ${field} must be a number of milliseconds.`);
  }
  return Math.round(value);
}

/**
 * Apply editor patches to a copy of `segments`. Pure. Throws `INVALID_EDIT`
 * (HTTP 400) on the first violated invariant, leaving the input untouched.
 */
export function applySegmentPatches(
  segments: readonly TranscriptSegment[],
  patches: readonly SegmentPatch[],
  opts: { durationMs?: number } = {},
): PatchOutcome {
  const outcome: PatchOutcome = {
    segments: [],
    textChanged: new Set(),
    timingChanged: new Set(),
    voiceChanged: new Set(),
    rateChanged: new Set(),
    lockChanged: new Set(),
  };
  const indexById = new Map(segments.map((s, i) => [s.id, i]));
  const next = segments.map((s) => ({ ...s }));
  const seen = new Set<string>();

  for (const patch of patches) {
    if (!patch || typeof patch.id !== 'string') invalid('Every change must name a line id.');
    if (seen.has(patch.id)) invalid(`Line ${patch.id} appears twice in one change.`);
    seen.add(patch.id);
    const i = indexById.get(patch.id);
    if (i === undefined) invalid(`Unknown line ${patch.id}.`);
    const seg = next[i]!;
    const before = segments[i]!;

    if (patch.startMs !== undefined || patch.endMs !== undefined) {
      const startMs = patch.startMs !== undefined ? finiteMs(patch.startMs, 'startMs', patch.id) : seg.startMs;
      const endMs = patch.endMs !== undefined ? finiteMs(patch.endMs, 'endMs', patch.id) : seg.endMs;
      if (startMs < 0) invalid(`Line ${patch.id} cannot start before the video does.`);
      if (endMs - startMs < MIN_SEGMENT_MS) {
        invalid(`Line ${patch.id} must last at least ${MIN_SEGMENT_MS} ms.`);
      }
      if (opts.durationMs !== undefined && endMs > opts.durationMs + END_TOLERANCE_MS) {
        invalid(`Line ${patch.id} cannot end after the video does.`);
      }
      if (startMs !== before.startMs || endMs !== before.endMs) outcome.timingChanged.add(patch.id);
      seg.startMs = startMs;
      seg.endMs = endMs;
    }

    if (patch.translatedText !== undefined) {
      if (typeof patch.translatedText !== 'string') invalid(`Line ${patch.id}: the translation must be text.`);
      if (patch.translatedText.length > MAX_TEXT_CHARS) {
        invalid(`Line ${patch.id} is longer than ${MAX_TEXT_CHARS} characters.`);
      }
      if (patch.translatedText !== (before.translatedText ?? '')) {
        seg.translatedText = patch.translatedText;
        outcome.textChanged.add(patch.id);
      }
    }

    if (patch.voiceId !== undefined) {
      if (patch.voiceId !== null && (typeof patch.voiceId !== 'string' || patch.voiceId.trim() === '' || patch.voiceId.length > 200)) {
        invalid(`Line ${patch.id}: unknown voice.`);
      }
      const voiceId = patch.voiceId === null ? undefined : patch.voiceId.trim();
      if (voiceId !== before.voiceId) {
        if (voiceId === undefined) delete seg.voiceId;
        else seg.voiceId = voiceId;
        outcome.voiceChanged.add(patch.id);
      }
    }

    if (patch.speakingRate !== undefined) {
      let rate: number | undefined;
      if (patch.speakingRate !== null) {
        if (
          typeof patch.speakingRate !== 'number' ||
          !Number.isFinite(patch.speakingRate) ||
          patch.speakingRate < MIN_SPEAKING_RATE ||
          patch.speakingRate > MAX_SPEAKING_RATE
        ) {
          invalid(`Line ${patch.id}: speaking rate must be between ${MIN_SPEAKING_RATE}× and ${MAX_SPEAKING_RATE}×.`);
        }
        // 1× IS the default; store it as "no override" so it groups with neighbours.
        rate = Math.abs(patch.speakingRate - 1) < 1e-3 ? undefined : Math.round(patch.speakingRate * 1000) / 1000;
      }
      if (rate !== before.speakingRate) {
        if (rate === undefined) delete seg.speakingRate;
        else seg.speakingRate = rate;
        outcome.rateChanged.add(patch.id);
      }
    }

    // Lock semantics: an explicit flag wins; otherwise a real text change locks.
    const wantLocked = patch.locked ?? (outcome.textChanged.has(patch.id) ? true : before.locked === true);
    if (wantLocked !== (before.locked === true)) outcome.lockChanged.add(patch.id);
    if (wantLocked) seg.locked = true;
    else delete seg.locked;

    if (outcome.textChanged.has(patch.id) || outcome.voiceChanged.has(patch.id) || outcome.rateChanged.has(patch.id)) {
      seg.ttsStale = true;
    }
  }

  // Order + overlap: checked once over the whole result, so a batch that moves
  // two neighbours together (a multi-select drag) is judged on where they END.
  for (let i = 1; i < next.length; i++) {
    const prev = next[i - 1]!;
    const cur = next[i]!;
    const touched = outcome.timingChanged.has(prev.id) || outcome.timingChanged.has(cur.id);
    if (!touched) continue;
    if (cur.startMs < prev.startMs) {
      invalid(`Line ${cur.id} cannot move before line ${prev.id}; drag it within its neighbours.`);
    }
    const overlapNow = prev.endMs > cur.startMs;
    const overlapBefore = segments[i - 1]!.endMs > segments[i]!.startMs;
    if (overlapNow && !overlapBefore) {
      invalid(`Line ${prev.id} would overlap line ${cur.id}.`);
    }
  }

  outcome.segments = next.map((s, i) => ({ ...s, index: i }));
  return outcome;
}

/**
 * Re-derive each synthesis group's window from its members. Pure.
 *
 * A group's clip is placed at its FIRST member's start and its window runs to
 * the LAST member's end, so moving either end member moves the group; moving a
 * middle member only re-times that member's subtitle. Members that no longer
 * exist are dropped (defensive — a corrupt plan must not crash the editor).
 */
export function reconcileGroups(
  groups: readonly SynthesisGroup[],
  segments: readonly TranscriptSegment[],
): SynthesisGroup[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const out: SynthesisGroup[] = [];
  for (const g of groups) {
    const members = g.segmentIds.map((id) => byId.get(id)).filter((s): s is TranscriptSegment => s !== undefined);
    if (members.length === 0) continue;
    out.push({
      ...g,
      segmentIds: members.map((m) => m.id),
      startMs: members[0]!.startMs,
      endMs: members[members.length - 1]!.endMs,
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Alignment inputs for every synthesis unit, in timeline order. Pure.
 *
 * Durations come from the previous alignment (a timing edit does not change the
 * audio) unless `durations` overrides them (a unit just re-synthesized). A unit
 * with no known duration is aligned as empty rather than skipped, so the list
 * stays gap-aware for its neighbours.
 */
export function alignmentInputsForUnits(
  units: readonly SynthesisGroup[],
  previous: ReadonlyMap<string, { audioPath: string; generatedDurationMs: number }>,
  audioPathFor: (unitId: string) => string,
  durations: ReadonlyMap<string, number> = new Map(),
): AlignInputSegment[] {
  return units.map((u) => {
    const prior = previous.get(u.id);
    return {
      segmentId: u.id,
      startMs: u.startMs,
      endMs: u.endMs,
      audioPath: prior?.audioPath ?? audioPathFor(u.id),
      generatedDurationMs: durations.get(u.id) ?? prior?.generatedDurationMs ?? 0,
    };
  });
}

/** One group per segment, for projects synthesized before group plans existed. */
export function singletonUnits(segments: readonly TranscriptSegment[]): SynthesisGroup[] {
  return segments.map((s) => ({
    id: s.id,
    segmentIds: [s.id],
    text: (s.translatedText ?? s.sourceText ?? '').trim(),
    startMs: s.startMs,
    endMs: s.endMs,
    ...(s.speakerId ? { speakerId: s.speakerId } : {}),
  }));
}

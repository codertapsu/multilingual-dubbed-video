/**
 * Timing alignment of synthesized speech onto the original timeline.
 *
 * For each translated segment we know the window it must occupy
 * (`availableMs = endMs - startMs`) and the duration the TTS engine produced
 * (`generatedMs`). The algorithm decides how to place each segment:
 *
 *   1. If the generated audio FITS in the window -> status `ok`, speedRatio 1.
 *   2. If it is too long, try speeding it up (atempo) up to
 *      `settings.maxSpeedRatio`. The required ratio is `generatedMs/availableMs`,
 *      capped at `maxSpeedRatio`. We never compress faster than the cap.
 *   3. After speed-up, if the segment still overflows but the overflow is within
 *      `settings.allowedOverflowMs`, we accept it (status `needs-review`).
 *   4. Otherwise the segment cannot fit -> status `timing-conflict`.
 *
 * `placedDurationMs` is the duration the segment actually occupies after any
 * atempo speed-up (`generatedMs / speedRatio`). When `speedRatio > 1` the
 * media-worker must apply `atempo=speedRatio` to the segment WAV before mixing.
 *
 * This module is PURE (no I/O) so it is trivially unit-testable.
 */
import type { AlignedSegment, AlignmentStatus, ProjectSettings } from '@videodubber/shared';

/** Minimal per-segment input the aligner needs. */
export interface AlignInputSegment {
  /** Canonical segment id (e.g. `seg_0001`). */
  segmentId: string;
  /** Target window start on the original timeline (ms). */
  startMs: number;
  /** Target window end on the original timeline (ms). */
  endMs: number;
  /** Path to the synthesized WAV for this segment. */
  audioPath: string;
  /** Real measured duration of the synthesized WAV (ms). */
  generatedDurationMs: number;
}

/** Settings subset the aligner reads. */
export type AlignSettings = Pick<ProjectSettings, 'maxSpeedRatio' | 'allowedOverflowMs'>;

/** Round to the nearest integer millisecond (timings are integer ms). */
function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

/**
 * Align a single segment. Pure function — given the same inputs it always
 * yields the same {@link AlignedSegment}.
 */
export function alignSegment(
  seg: AlignInputSegment,
  settings: AlignSettings,
  availableWindowMs?: number,
): AlignedSegment {
  const startMs = roundMs(seg.startMs);
  const endMs = roundMs(seg.endMs);
  // Window the segment may occupy. Defaults to the subtitle's own duration, but
  // alignSegments passes a GAP-AWARE window (the slot until the next segment
  // starts) so a longer translation can spill into the natural pause after the
  // line instead of being flagged as a conflict.
  const availableMs = Math.max(0, availableWindowMs ?? endMs - startMs);
  const generatedMs = roundMs(seg.generatedDurationMs);

  // Guard against a degenerate / zero-length window: nothing to fit into.
  // Treat as a timing conflict but still place at startMs at natural speed.
  if (availableMs <= 0) {
    return {
      segmentId: seg.segmentId,
      startMs,
      endMs,
      audioPath: seg.audioPath,
      generatedDurationMs: generatedMs,
      placedDurationMs: generatedMs,
      speedRatio: 1,
      overflowMs: generatedMs,
      status: generatedMs > 0 ? 'timing-conflict' : 'ok',
      note: generatedMs > 0 ? 'Zero-length target window; segment cannot be placed cleanly.' : undefined,
    };
  }

  // Case 1: it already fits at natural speed.
  if (generatedMs <= availableMs) {
    return {
      segmentId: seg.segmentId,
      startMs,
      endMs,
      audioPath: seg.audioPath,
      generatedDurationMs: generatedMs,
      placedDurationMs: generatedMs,
      speedRatio: 1,
      overflowMs: 0,
      status: 'ok',
    };
  }

  // Too long: compute the ratio needed to fit, capped at the max allowed.
  const maxSpeedRatio = settings.maxSpeedRatio > 1 ? settings.maxSpeedRatio : 1;
  const requiredRatio = generatedMs / availableMs;
  const speedRatio = Math.min(requiredRatio, maxSpeedRatio);
  // Duration after applying atempo=speedRatio.
  const placedDurationMs = roundMs(generatedMs / speedRatio);
  const overflowMs = Math.max(0, placedDurationMs - availableMs);

  let status: AlignmentStatus;
  let note: string | undefined;

  if (overflowMs === 0) {
    // Speed-up alone made it fit, but we flag for review since timing changed.
    status = 'needs-review';
    note = `Sped up to ${speedRatio.toFixed(3)}x to fit the window.`;
  } else if (overflowMs <= Math.max(0, settings.allowedOverflowMs)) {
    // Still overflows but within the tolerated budget.
    status = 'needs-review';
    note =
      speedRatio > 1
        ? `Sped up to ${speedRatio.toFixed(3)}x; overflows by ${overflowMs}ms (within allowed ${settings.allowedOverflowMs}ms).`
        : `Overflows by ${overflowMs}ms (within allowed ${settings.allowedOverflowMs}ms).`;
  } else {
    // Cannot fit even at max speed within the overflow budget.
    status = 'timing-conflict';
    note = `Overflows by ${overflowMs}ms beyond allowed ${settings.allowedOverflowMs}ms even at ${speedRatio.toFixed(3)}x. Consider shortening the translation.`;
  }

  return {
    segmentId: seg.segmentId,
    startMs,
    endMs,
    audioPath: seg.audioPath,
    generatedDurationMs: generatedMs,
    placedDurationMs,
    speedRatio,
    overflowMs,
    status,
    note,
  };
}

/**
 * Align a list of segments in order. Pure.
 *
 * Each segment's available window is GAP-AWARE: the larger of (a) the subtitle's
 * own duration and (b) the time until the next segment starts (or, for the last
 * segment, until `totalDurationMs` if given). This lets a longer translation use
 * the silence between lines, which dramatically reduces timing-conflicts on real
 * content (where speech has natural pauses) without overlapping the next line.
 */
export function alignSegments(
  segments: readonly AlignInputSegment[],
  settings: AlignSettings,
  totalDurationMs?: number,
): AlignedSegment[] {
  return segments.map((s, i) => {
    const startMs = roundMs(s.startMs);
    const ownWindow = Math.max(0, roundMs(s.endMs) - startMs);
    const next = segments[i + 1];
    let slot: number;
    if (next) {
      slot = roundMs(next.startMs) - startMs;
    } else if (totalDurationMs != null) {
      slot = roundMs(totalDurationMs) - startMs;
    } else {
      slot = ownWindow;
    }
    return alignSegment(s, settings, Math.max(ownWindow, slot));
  });
}

/** Summary counts useful for logging/UI badges. */
export interface AlignmentSummary {
  total: number;
  ok: number;
  needsReview: number;
  timingConflicts: number;
  /** Segments requiring an atempo speed-up (speedRatio > 1). */
  needsAtempo: number;
}

/** Compute aggregate counts over a set of aligned segments. */
export function summarizeAlignment(aligned: readonly AlignedSegment[]): AlignmentSummary {
  const summary: AlignmentSummary = {
    total: aligned.length,
    ok: 0,
    needsReview: 0,
    timingConflicts: 0,
    needsAtempo: 0,
  };
  for (const a of aligned) {
    if (a.status === 'ok') summary.ok += 1;
    else if (a.status === 'needs-review') summary.needsReview += 1;
    else summary.timingConflicts += 1;
    if (a.speedRatio > 1.0001) summary.needsAtempo += 1;
  }
  return summary;
}

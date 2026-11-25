/**
 * What the loop pass changed, in the edit history (activity/history.ts): one
 * entry per range it replaced, removed or re-timed, undone range by range like
 * any other change of the lines (activity/undo.ts).
 *
 * WHY (claude-dubber, 2026-11-25): the analysis of 《反相之地》 removed ~780
 * real lines it took for silence, and nothing could bring them back but a
 * script reading the burned-in subtitles. Recorded once source.json is
 * written, so each entry holds the lines as they are (speakers found, timing
 * anchored) and undo finds exactly them.
 */
import type { TranscriptSegment } from '@videodubber/shared';

import { formatClock, recordEdit } from '../activity/history.js';
import type { RepairedRange } from './loopRepair.js';

/** The loop pass's result (runner.repairTranscriptLoops). */
export interface LoopOutcome {
  lines: TranscriptSegment[];
  ranges: RepairedRange[];
  /** Each range's lines as speech-to-text wrote them (parallel to `ranges`). */
  originals: TranscriptSegment[][];
}

/** The entries the pass's changes make (pure, for recordLoopEdits and the tests). */
export function loopEdits(
  outcome: Pick<LoopOutcome, 'ranges' | 'originals'>,
  final: readonly TranscriptSegment[],
): { range: RepairedRange; before: TranscriptSegment[]; after: TranscriptSegment[] }[] {
  const out: { range: RepairedRange; before: TranscriptSegment[]; after: TranscriptSegment[] }[] = [];
  for (const [i, r] of outcome.ranges.entries()) {
    const changed = r.status === 'replaced' || r.status === 'removed' || (r.counts?.retimed ?? 0) > 0;
    if (!changed) continue;
    const after = final.filter((l) => l.startMs < r.toMs && l.endMs > r.fromMs);
    // A neighbour reaching into the range is in it now: it goes back as it is.
    const neighbours = after.filter((l) => {
      const mid = (l.startMs + l.endMs) / 2;
      return mid < r.fromMs || mid > r.toMs;
    });
    out.push({ range: r, before: [...(outcome.originals[i] ?? []), ...neighbours].sort((a, b) => a.startMs - b.startMs), after });
  }
  return out;
}

/** Record the pass's changes; never throws (recordEdit does not). */
export async function recordLoopEdits(projectId: string, outcome: LoopOutcome, final: readonly TranscriptSegment[]): Promise<void> {
  for (const { range: r, before, after } of loopEdits(outcome, final)) {
    const from = formatClock(r.fromMs);
    const to = formatClock(r.toMs);
    await recordEdit({
      projectId,
      target: 'source',
      summary: `Speech-to-text checked ${from}–${to} again: ${before.length} -> ${after.length} line(s)`,
      summaryKey: 'history.summary.stt-checked',
      summaryParams: { from, to, before: before.length, after: after.length },
      before,
      after,
      range: { fromMs: r.fromMs, toMs: r.toMs },
    });
  }
}

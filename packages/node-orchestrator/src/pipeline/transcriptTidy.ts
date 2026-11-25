/**
 * The last pass over a transcript before the STT step writes it: no empty or
 * too-short fragment, no line said twice at the same moment, no two lines
 * over each other. Pure.
 *
 * WHY: 《反相之地》 (claude-dubber, 2026-11-25) reached review with
 * zero-length and duplicate fragments and 43 overlapping pairs. The editor's
 * timeline refuses an overlap the moment a line is touched
 * (workspace/timelineEdit.ts), so those lines could not even be fixed by
 * hand, and an overlap plays two voices at once in the dub. The cases it
 * listed, each handled here:
 *  - zero-length lines (seg_0985–0988 at 49:55.58, "兄弟们先别慌 / 赶紧撤退" ×2)
 *    and a 20 ms "咋了小潘伯牙": the same words once, each line then given its
 *    words' time in the gap after it;
 *  - doubled fragments ("差不多待三分钟" ×2; "里面外面的怪物听到了" with
 *    "怪物听到了" inside it): one line, the whole words kept;
 *  - two transcriptions of one sound at one instant ("盘子" and "潘子" at
 *    31:28.38): the first kept;
 *  - any other overlap: the earlier line ends where the next begins.
 *
 * It runs after the lines are anchored to the speech (segmentTiming.ts), as
 * the last thing the step does to timing, and moves a boundary only between
 * two lines that overlap.
 */
import type { TranscriptSegment } from '@videodubber/shared';

import { expectedSpeechMs } from '../alignment/clipSpeech.js';
import { padSegmentIndex } from '../workspace/paths.js';
import { normalizeLine } from './loopRepair.js';

/** A line shorter than this cannot be said or read: the least a line keeps. */
export const TIDY_MIN_MS = 200;
/** A fragment takes at least this much of the gap after it (when there is room). */
const FRAGMENT_MS = 500;
/** The same text again within this much of a line is that line once more. */
const DUPLICATE_GAP_MS = 300;
/** Lines starting this close together are at one instant. */
const SAME_INSTANT_MS = 50;
/** Two transcriptions of one sound end this close together too. */
const SAME_END_MS = 150;

export interface TidyReport {
  /** Empty lines, and fragments with no room to exist. */
  dropped: number;
  /** Duplicates, fragments of a line, and two transcriptions of one sound, made one. */
  merged: number;
  /** Overlaps resolved by moving a boundary. */
  separated: number;
}

export function tidyTranscript(lines: readonly TranscriptSegment[]): { lines: TranscriptSegment[]; report: TidyReport } {
  const report: TidyReport = { dropped: 0, merged: 0, separated: 0 };
  const sorted = lines
    // Blank only: a "♪" or "…" line has nothing to say but stays, silent in
    // the dub with its subtitle (runner: lines with nothing to say).
    .filter((l) => {
      const keep = (l.sourceText ?? '').trim() !== '';
      if (!keep) report.dropped += 1;
      return keep;
    })
    .map((l) => ({ ...l }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Fragments (no length, or too short to say anything): the same words at
  // one instant once, then each given its words' time in the gap after it,
  // one after another, before the next real line.
  const sized: TranscriptSegment[] = [];
  for (let i = 0; i < sorted.length; ) {
    const l = sorted[i]!;
    if (l.endMs - l.startMs >= TIDY_MIN_MS) {
      sized.push(l);
      i += 1;
      continue;
    }
    // The fragments at this instant, each text once.
    const cluster: TranscriptSegment[] = [];
    const seen = new Set<string>();
    let j = i;
    while (j < sorted.length && sorted[j]!.endMs - sorted[j]!.startMs < TIDY_MIN_MS && sorted[j]!.startMs - l.startMs <= SAME_INSTANT_MS) {
      const text = normalizeLine(sorted[j]!.sourceText);
      if (seen.has(text)) report.merged += 1;
      else {
        seen.add(text);
        cluster.push(sorted[j]!);
      }
      j += 1;
    }
    // Laid out one after another before the next real line.
    const next = sorted.slice(j).find((n) => n.endMs - n.startMs >= TIDY_MIN_MS);
    let at = l.startMs;
    for (const f of cluster) {
      const want = Math.max(FRAGMENT_MS, expectedSpeechMs(f.sourceText));
      const ms = Math.min(want, next ? next.startMs - at : want);
      if (ms >= TIDY_MIN_MS) {
        sized.push({ ...f, startMs: at, endMs: at + ms });
        at += ms;
      } else {
        report.dropped += 1;
      }
    }
    i = j;
  }

  const out: TranscriptSegment[] = [];
  for (const l of sized) {
    const prev = out[out.length - 1];
    if (!prev || l.startMs >= prev.endMs) {
      out.push(l);
      continue;
    }
    const a = normalizeLine(prev.sourceText);
    const b = normalizeLine(l.sourceText);
    // The same words again, at the same moment: one line.
    if (a === b && l.startMs <= prev.endMs + DUPLICATE_GAP_MS) {
      prev.endMs = Math.max(prev.endMs, l.endMs);
      report.merged += 1;
      continue;
    }
    // A fragment of the line it overlaps, or the line a fragment came from:
    // one line with the whole words, so nothing is said twice.
    if (b !== '' && a.includes(b)) {
      prev.endMs = Math.max(prev.endMs, l.endMs);
      report.merged += 1;
      continue;
    }
    if (a !== '' && b.includes(a)) {
      prev.sourceText = l.sourceText;
      prev.endMs = Math.max(prev.endMs, l.endMs);
      // Its words were the fragment's: the line's timing stands, not theirs.
      delete prev.words;
      report.merged += 1;
      continue;
    }
    // Two transcriptions of one sound ("盘子" / "潘子"): the same span and as
    // many characters. The first stays.
    if (Math.abs(l.startMs - prev.startMs) <= SAME_INSTANT_MS && Math.abs(l.endMs - prev.endMs) <= SAME_END_MS && [...a].length === [...b].length) {
      report.merged += 1;
      continue;
    }
    if (l.startMs - prev.startMs >= TIDY_MIN_MS) {
      // The earlier line ends where the next begins.
      prev.endMs = l.startMs;
      report.separated += 1;
      out.push(l);
    } else if (l.endMs - prev.endMs >= TIDY_MIN_MS) {
      // Both start together: the later one begins where the earlier ends.
      out.push({ ...l, startMs: prev.endMs });
      report.separated += 1;
    } else {
      // Inside the earlier line: words said with it.
      prev.sourceText = `${prev.sourceText.trimEnd()} ${l.sourceText.trimStart()}`;
      prev.endMs = Math.max(prev.endMs, l.endMs);
      report.merged += 1;
    }
  }
  return {
    lines: out.map((l, i) => ({ ...l, index: i, id: `seg_${padSegmentIndex(i + 1)}` })),
    report,
  };
}

/**
 * Speech-to-text checks itself (docs/plans/production-requests-2026-11-23.md
 * 1.6): lines written over silence, and minutes of digital silence. The third
 * check, a second decode compared with the lines, is spotCheck.ts.
 *
 * WHY: in the 27.8-hour series, STT chunks 141-152 "heard" 20 lines each over
 * -91 dB silence and nothing flagged them; the garbled join of P3/P4 left two
 * hours of digital silence that no transcript check can see (an empty
 * transcript and a silent re-decode agree). Both came out only by listening.
 *
 * Pure: the speech map (Silero VAD, speechMap.ts), the silences ffmpeg found
 * (media-worker silences.ts) and the lines go in; findings come out, and the
 * runner turns them into warnings and loop-pass ranges.
 */
import type { TranscriptSegment } from '@videodubber/shared';
import { normalizeLine, type LoopKind, type LoopRange } from './loopRepair.js';
import type { SpeechRegion } from './segmentTiming.js';

/** A line holding no more speech than this share of its span was written over silence... */
const SILENT_LINE_SHARE = 0.1;
/** ...or than this much (the VAD's own padding around a cough or a breath). */
const SILENT_LINE_MIN_MS = 250;
/**
 * Consecutive lines over silence that make "many": a hallucination over a
 * silent stretch writes one after another (20 per chunk in the series), while
 * a line or two the VAD missed under loud music is a single exception.
 */
export const MIN_SILENT_RUN = 5;

/** Digital silence: quieter than any room or recording (the series' was -91 dB)... */
export const DIGITAL_SILENCE_DB = -80;
/** ...for at least a minute. */
export const DIGITAL_SILENCE_MIN_MS = 60_000;
/** Talk-heavy: speech fills at least this share of the time outside the silent stretches. */
const TALK_HEAVY_SHARE = 0.25;

/**
 * The speech map sorted, overlaps merged: what the binary searches below need.
 * The worker's map is already sorted and disjoint (then it is returned as it
 * is); a cached file is not trusted to be. Pure.
 */
export function normalizeRegions(regions: readonly SpeechRegion[]): readonly SpeechRegion[] {
  let clean = true;
  for (let i = 1; i < regions.length && clean; i++) clean = regions[i]!.startMs >= regions[i - 1]!.endMs;
  if (clean) return regions;
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  const out: SpeechRegion[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ startMs: r.startMs, endMs: r.endMs });
  }
  return out;
}

/**
 * Speech (ms) the map puts inside [fromMs, toMs]. `regions` sorted and
 * disjoint ({@link normalizeRegions}); a binary search finds the first that
 * can count, so a 27.8-hour transcript checks in milliseconds. Pure.
 */
export function speechMsIn(regions: readonly SpeechRegion[], fromMs: number, toMs: number): number {
  if (!(toMs > fromMs) || regions.length === 0) return 0;
  // The first region that ends after fromMs (disjoint and sorted: ends are sorted too).
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (regions[mid]!.endMs <= fromMs) lo = mid + 1;
    else hi = mid;
  }
  let covered = 0;
  for (let i = lo; i < regions.length; i++) {
    const r = regions[i]!;
    if (r.startMs >= toMs) break;
    covered += Math.max(0, Math.min(r.endMs, toMs) - Math.max(r.startMs, fromMs));
  }
  return covered;
}

/** True when the speech map heard (nearly) nothing in [fromMs, toMs]. Pure. */
export function heardNothing(regions: readonly SpeechRegion[], fromMs: number, toMs: number): boolean {
  const span = Math.max(0, toMs - fromMs);
  return speechMsIn(regions, fromMs, toMs) <= Math.max(SILENT_LINE_MIN_MS, span * SILENT_LINE_SHARE);
}

/** loopRepair's `inSilence`: the speech map heard (nearly) nothing there. */
export function inSilenceOf(regions: readonly SpeechRegion[]): (fromMs: number, toMs: number) => boolean {
  const map = normalizeRegions(regions);
  return (fromMs, toMs) => heardNothing(map, fromMs, toMs);
}

/** A window speech-to-text transcribed on its own (runner planSttChunks). */
export interface SttChunkSpan {
  startMs: number;
  endMs: number;
}

/** Lines over silence in consecutive STT chunks: one warning. */
export interface SilentLinesFinding {
  /** 1-based, as the log counts chunks ("STT chunk 141/167"); `firstChunk === lastChunk` for one. */
  firstChunk: number;
  lastChunk: number;
  chunks: number;
  /** From the first flagged line's start to the last one's end. */
  fromMs: number;
  toMs: number;
  /** Lines written over silence there. */
  lines: number;
  /** What the speech map heard in those chunks, ms. */
  speechMs: number;
}

/**
 * Runs of at least {@link MIN_SILENT_RUN} consecutive lines the speech map
 * heard (nearly) nothing under: as loop-pass ranges (kind `silence`), and per
 * group of consecutive chunks holding them, a finding for the warning. Lines
 * with nothing to say ("…") neither count nor break a run. Pure.
 */
export function findLinesOverSilence(
  lines: readonly Pick<TranscriptSegment, 'startMs' | 'endMs' | 'sourceText'>[],
  speechMap: readonly SpeechRegion[],
  chunks: readonly SttChunkSpan[],
): { ranges: LoopRange[]; findings: SilentLinesFinding[] } {
  const regions = normalizeRegions(speechMap);
  const ranges: LoopRange[] = [];
  let runStart = -1;
  let runLines = 0;
  let lastSilent = -1;
  const close = (): void => {
    if (runStart >= 0 && runLines >= MIN_SILENT_RUN) {
      ranges.push({ start: runStart, end: lastSilent + 1, fromMs: lines[runStart]!.startMs, toMs: lines[lastSilent]!.endMs, kind: 'silence' });
    }
    runStart = -1;
    runLines = 0;
  };
  for (const [i, l] of lines.entries()) {
    if (normalizeLine(l.sourceText) === '') continue;
    if (heardNothing(regions, l.startMs, l.endMs)) {
      if (runStart < 0) runStart = i;
      runLines += 1;
      lastSilent = i;
    } else {
      close();
    }
  }
  close();

  // Per chunk: which flagged lines start in it; consecutive chunks make one finding.
  const flagged = ranges.flatMap((r) => lines.slice(r.start, r.end).filter((l) => normalizeLine(l.sourceText) !== ''));
  const perChunk = chunks.map((c, k) => {
    const mine = flagged.filter((l) => l.startMs >= c.startMs && (l.startMs < c.endMs || k === chunks.length - 1));
    return { k, mine };
  });
  const findings: SilentLinesFinding[] = [];
  let open: SilentLinesFinding | undefined;
  for (const { k, mine } of perChunk) {
    if (mine.length === 0) {
      open = undefined;
      continue;
    }
    const c = chunks[k]!;
    const speech = speechMsIn(regions, c.startMs, c.endMs);
    const fromMs = Math.min(...mine.map((l) => l.startMs));
    const toMs = Math.max(...mine.map((l) => l.endMs));
    if (open && open.lastChunk === k) {
      open.lastChunk = k + 1;
      open.toMs = Math.max(open.toMs, toMs);
      open.lines += mine.length;
      open.speechMs += speech;
    } else {
      open = { firstChunk: k + 1, lastChunk: k + 1, chunks: chunks.length, fromMs, toMs, lines: mine.length, speechMs: speech };
      findings.push(open);
    }
  }
  return { ranges, findings };
}

/** Which of two overlapping loop ranges names their merge: over silence wins (see loopRepair `silence`). */
const MERGE_RANK: Record<LoopKind, number> = { silence: 4, repeat: 3, 'low-diversity': 2, phrase: 1 };

/**
 * One sorted list of loop ranges without overlaps (repairLoops needs that),
 * from the loop finder's and the silence check's. Overlapping ranges become
 * one, named by the stronger kind. Pure.
 */
export function mergeLoopRanges(...lists: readonly (readonly LoopRange[])[]): LoopRange[] {
  const all = lists.flat().slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: LoopRange[] = [];
  for (const r of all) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      if (MERGE_RANK[r.kind] > MERGE_RANK[last.kind]) {
        last.kind = r.kind;
        if (r.phrase) last.phrase = r.phrase;
        else delete last.phrase;
      }
      if (r.end > last.end) {
        last.end = r.end;
        last.toMs = Math.max(last.toMs, r.toMs);
      }
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** A stretch of digital silence worth a warning. */
export interface DigitalSilenceFinding {
  fromMs: number;
  toMs: number;
}

/**
 * The digital silences worth a warning: each of a minute or more, in a video
 * whose other parts are talk-heavy (speech fills >= 25 % of them). A concert
 * film with silent breaks is not one; a drama with two silent hours is.
 * `speechMs`: the speech map's total, or the lines' when there is no map. Pure.
 */
export function digitalSilenceFindings(
  silences: readonly { startMs: number; endMs: number }[],
  totalMs: number,
  speechMs: number,
): DigitalSilenceFinding[] {
  const long = silences.filter((s) => s.endMs - s.startMs >= DIGITAL_SILENCE_MIN_MS);
  if (long.length === 0) return [];
  const silentMs = long.reduce((n, s) => n + (s.endMs - s.startMs), 0);
  const rest = totalMs - silentMs;
  if (!(rest > 0) || speechMs / rest < TALK_HEAVY_SHARE) return [];
  return long.map((s) => ({ fromMs: s.startMs, toMs: s.endMs }));
}

/** Time the lines cover (their union), ms: speech when there is no speech map. Pure. */
export function linesCoverMs(lines: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[]): number {
  const spans = lines.map((l) => [l.startMs, l.endMs] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [a, b] of spans) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else {
      curEnd = Math.max(curEnd, b);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

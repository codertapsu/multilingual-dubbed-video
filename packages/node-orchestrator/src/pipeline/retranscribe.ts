/**
 * A time range transcribed again, with the speech-to-text step's own checks
 * (retranscribe_range; orchestrator retranscribeRange).
 *
 * WHY: on the 27.8-hour series an agent re-transcribed 33 ranges with apply,
 * and the app wrote whisper's raw output into the transcript: credit lines,
 * loops of 11 and 31 repeats, and every line of the range without a speaker
 * (claude-dubber report, 2026-11-23, F2). Now a range is decoded without the
 * previous text, then goes through the loop pass the STT step runs
 * (pipeline/loopRepair.ts: loop and credit filter, each loop decoded again
 * without context, ±500 ms around it, to confirm it). A new line keeps a
 * speaker only where it overlaps an old line whose text is still alike
 * (character bigrams, Dice ≥ 0.5): carried blindly, a speaker would be wrong
 * exactly where a range is re-transcribed because the audio under it was
 * garbled. The rest stay unassigned and the project says so
 * (`speakers-unassigned`), pointing to a ranged speaker detection.
 *
 * A range of more than 15 minutes is one job, in windows of up to 15 minutes
 * cut in the widest gap between lines of the minute before each boundary;
 * each window is applied as soon as it is heard (one history entry each), so
 * a job stopped halfway leaves whole windows behind, never half of one.
 */
import fsp from 'node:fs/promises';
import type { ActivityPhrase, TranscriptSegment } from '@videodubber/shared';
import { formatClock } from '../activity/history.js';
import { expectedSpeechMs } from '../alignment/clipSpeech.js';
import { padSegmentIndex } from '../workspace/paths.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';
import { onDecoderWindow } from './decodeMerge.js';
import { bigramSimilarity, findLoopRanges, repairLoops, type RepairedRange } from './loopRepair.js';
import type { SpeechRegion } from './segmentTiming.js';

/** A range longer than this is a job, in windows of at most this. */
export const RETRANSCRIBE_WINDOW_MS = 15 * 60_000;
/** A window boundary moves back at most this far, into the widest gap between lines. */
const WINDOW_SNAP_MS = 60_000;
/** A boundary this far from the lines on both sides is in silence already. */
const CUT_MARGIN_MS = 1000;
/** A new line keeps an old line's speaker from this text similarity (character bigrams, Dice). */
export const SPEAKER_CARRY_MIN_SIMILARITY = 0.5;
/** A heard line shorter than this once fitted into its window is an artifact of the cut. */
const MIN_LINE_MS = 100;
/** Speech covering less than this share of a stretch: nobody speaks there (credit lines, loopRepair). */
const SILENT_SHARE = 0.1;
/** Jobs kept for their result after they end. */
export const RETRANSCRIBE_JOBS_KEPT = 20;

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** A line as heard: what retranscribe_range returns and what apply writes. */
export interface RetranscribeLine {
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  speakerLowConfidence?: true;
  /** Still inside a loop the pass could not repair (get_transcript's LOOP?). */
  loopSuspect?: true;
}

/** What the loop pass did in a window, by outcome. */
export interface LoopCounts {
  /** Loops and credit lines taken out: decoded again (varied text), or removed (nothing was said). */
  removed: number;
  /** Repeats a fresh decode heard again: really said (a chant, a song). */
  kept: number;
  /** Loops that could not be checked (the second decode failed): marked LOOP?. */
  left: number;
}

/** One window of a re-transcription, as it was heard and applied. */
export interface RetranscribeWindowResult {
  fromMs: number;
  toMs: number;
  /** Lines heard after the loop pass. */
  lines: number;
  loops: LoopCounts;
  speakers: { carried: number; unassigned: number };
  /** With apply: how many old lines the window replaced. */
  replaced?: number;
  /** The sentence the project's edit history keeps for it. */
  summary: string;
}

/** A re-transcription's answer (the request for up to 15 minutes, the job's result after). */
export interface RetranscribeResult {
  /** The range transcribed: the one asked, widened to the whole lines across its edges. */
  fromMs: number;
  toMs: number;
  /** The lines heard, after the loop pass, with the speakers carried over. */
  lines: RetranscribeLine[];
  /** What the loop pass found and did (as audio/loop_ranges.json keeps it). */
  loops: RepairedRange[];
  speakers: { carried: number; unassigned: number };
  windows: RetranscribeWindowResult[];
  applied?: { replaced: number; lines: { id: string; startMs: number; endMs: number; text: string; speakerId?: string }[] };
}

/** A re-transcription job (a range over 15 minutes), as GET .../lines/retranscribe/:jobId shows it. */
export interface RetranscribeJobView {
  /** Also its id in the activity list. */
  id: string;
  projectId: string;
  state: 'running' | 'done' | 'failed';
  fromMs: number;
  toMs: number;
  apply: boolean;
  /** Windows in all, and done so far. */
  windows: number;
  done: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Each window's outcome, as it ends. */
  results: RetranscribeWindowResult[];
  /** Totals, once it ended well. */
  result?: { lines: number; replaced: number; loops: LoopCounts; speakers: { carried: number; unassigned: number } };
  /** The lines heard, for a job that does not apply them. */
  lines?: RetranscribeLine[];
}

/** The request's answer: the result for up to 15 minutes, a job beyond. */
export type RetranscribeOutcome = (RetranscribeResult & { job?: undefined }) | { job: RetranscribeJobView };

/**
 * The range widened to the whole lines across its edges: replacing a range
 * replaces every line it touches, and a line cut at the edge lost its other
 * half's words (they were never decoded again). Pure.
 */
export function widenToLines(range: TimeRange, lines: readonly { startMs: number; endMs: number }[]): TimeRange {
  let { fromMs, toMs } = range;
  for (const l of lines) {
    if (l.startMs < range.fromMs && l.endMs > range.fromMs) fromMs = Math.min(fromMs, l.startMs);
    if (l.startMs < range.toMs && l.endMs > range.toMs) toMs = Math.max(toMs, l.endMs);
  }
  return { fromMs, toMs };
}

/**
 * Windows of at most `windowMs`, each boundary moved back (up to a minute)
 * into the middle of the widest gap between lines there, so no line is cut in
 * two decodes. Without a gap the boundary stays. Pure.
 */
export function planRetranscribeWindows(
  range: TimeRange,
  lines: readonly { startMs: number; endMs: number }[],
  windowMs = RETRANSCRIBE_WINDOW_MS,
): TimeRange[] {
  const sorted = lines
    .filter((l) => l.endMs > range.fromMs && l.startMs < range.toMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  // The gaps between lines (and before the first, after the last) in the range.
  const gaps: TimeRange[] = [];
  let reach = range.fromMs;
  for (const l of sorted) {
    if (l.startMs > reach) gaps.push({ fromMs: reach, toMs: l.startMs });
    reach = Math.max(reach, l.endMs);
  }
  if (reach < range.toMs) gaps.push({ fromMs: reach, toMs: range.toMs });

  const windows: TimeRange[] = [];
  let start = range.fromMs;
  while (range.toMs - start > windowMs) {
    const nominal = start + windowMs;
    const lo = Math.max(start + windowMs / 2, nominal - WINDOW_SNAP_MS);
    let cut = nominal;
    // Already in silence, a second from either line: the boundary stays.
    if (!gaps.some((g) => g.fromMs + CUT_MARGIN_MS <= nominal && nominal <= g.toMs - CUT_MARGIN_MS)) {
      let widest = -1;
      for (const g of gaps) {
        if (g.toMs < lo || g.fromMs > nominal) continue;
        const width = g.toMs - g.fromMs;
        if (width > widest) {
          widest = width;
          cut = Math.round(Math.min(nominal, Math.max(lo, (g.fromMs + g.toMs) / 2)));
        }
      }
    }
    windows.push({ fromMs: start, toMs: cut });
    start = cut;
  }
  windows.push({ fromMs: start, toMs: range.toMs });
  return windows;
}

/** How alike two lines' texts are (Dice of character bigrams): loopRepair.ts, re-exported for callers here. */
export { bigramSimilarity };

/**
 * Speakers for heard lines from the lines they replace: a line takes the
 * speaker of the old line it overlaps most among those whose text is alike
 * (bigramSimilarity ≥ 0.5), with its best-guess mark; otherwise none.
 * `unassigned` counts the lines left without one, in a project that has
 * speakers (a project never detected has none to lose). Pure.
 */
export function carrySpeakers<T extends { startMs: number; endMs: number; text: string; speakerId?: string; speakerLowConfidence?: true }>(
  heard: readonly T[],
  old: readonly Pick<TranscriptSegment, 'startMs' | 'endMs' | 'sourceText' | 'speakerId' | 'speakerLowConfidence'>[],
  projectHasSpeakers: boolean,
): { lines: T[]; carried: number; unassigned: number } {
  const voiced = old.filter((o) => o.speakerId);
  let carried = 0;
  let unassigned = 0;
  const lines = heard.map((line) => {
    const { speakerId: _id, speakerLowConfidence: _guess, ...rest } = line;
    let best: { speakerId: string; guess: boolean; overlap: number; sim: number } | undefined;
    for (const o of voiced) {
      const overlap = Math.min(line.endMs, o.endMs) - Math.max(line.startMs, o.startMs);
      if (overlap <= 0) continue;
      const sim = bigramSimilarity(line.text, o.sourceText);
      if (sim < SPEAKER_CARRY_MIN_SIMILARITY) continue;
      if (!best || overlap > best.overlap || (overlap === best.overlap && sim > best.sim)) {
        best = { speakerId: o.speakerId!, guess: o.speakerLowConfidence === true, overlap, sim };
      }
    }
    if (best) {
      carried++;
      return { ...rest, speakerId: best.speakerId, ...(best.guess ? { speakerLowConfidence: true as const } : {}) } as T;
    }
    if (projectHasSpeakers) unassigned++;
    return rest as T;
  });
  return { lines, carried, unassigned };
}

/**
 * Decoded lines fitted into their window: sorted, cut to the window (the
 * loop pass decodes 500 ms beyond a loop), overlaps removed (the earlier line
 * ends where the next starts; replaceSourceLines refuses overlaps), empty and
 * sliver lines dropped, word timings dropped, renumbered. Pure.
 */
export function fitToWindow(lines: readonly TranscriptSegment[], window: TimeRange): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const text = l.sourceText.trim();
    if (!text) continue;
    let startMs = Math.max(window.fromMs, Math.round(l.startMs));
    const endMs = Math.min(window.toMs, Math.round(l.endMs));
    const prev = out[out.length - 1];
    if (prev && startMs < prev.endMs) {
      if (startMs - prev.startMs >= MIN_LINE_MS) prev.endMs = startMs;
      else startMs = prev.endMs;
    }
    if (endMs - startMs < MIN_LINE_MS) continue;
    const { words: _words, ...rest } = l;
    out.push({ ...rest, sourceText: text, startMs, endMs });
  }
  return out.map((l, i) => ({ ...l, index: i, id: `seg_${padSegmentIndex(i + 1)}` }));
}

/** The loop report with a window's old ranges replaced by what its new pass found; sorted. Pure. */
export function mergeLoopReports(previous: readonly RepairedRange[], window: TimeRange, fresh: readonly RepairedRange[]): RepairedRange[] {
  return [...previous.filter((r) => r.toMs <= window.fromMs || r.fromMs >= window.toMs), ...fresh].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
}

/**
 * audio/loop_ranges.json with a re-transcribed window's old ranges replaced
 * by what its new pass found (the file the STT step writes; gone when empty,
 * as the step leaves it).
 */
export async function saveLoopReport(file: string, window: TimeRange, fresh: readonly RepairedRange[]): Promise<void> {
  let previous: RepairedRange[] = [];
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8')) as { ranges?: unknown };
    if (Array.isArray(saved.ranges)) previous = saved.ranges as RepairedRange[];
  } catch {
    /* none yet */
  }
  const ranges = mergeLoopReports(previous, window, fresh);
  if (ranges.length === 0) await fsp.rm(file, { force: true });
  else await writeJsonAtomic(file, { checkedAt: new Date().toISOString(), ranges });
}

/** What the loop pass did, by outcome. Pure. */
export function loopCounts(ranges: readonly RepairedRange[]): LoopCounts {
  const count = (s: RepairedRange['status']): number => ranges.filter((r) => r.status === s).length;
  return { removed: count('replaced') + count('removed'), kept: count('kept'), left: count('left') };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** {@link windowSummary}'s values, for its `history.summary.retranscribed` key (the UI composes the sentence). Pure. */
export function windowSummaryParams(window: TimeRange, lines: number, loops: LoopCounts, unassigned: number): Record<string, string | number> {
  return {
    from: formatClock(window.fromMs),
    to: formatClock(window.toMs),
    lines,
    removed: loops.removed,
    kept: loops.kept,
    left: loops.left,
    unassigned,
  };
}

/** {@link windowSummary} as a phrase (the edit history's keys), for the activity list. Pure. */
export function windowPhrase(window: TimeRange, lines: number, loops: LoopCounts, unassigned: number): ActivityPhrase {
  const part = (name: string, n: number): ActivityPhrase[] => (n > 0 ? [{ key: `history.summary.${name}`, params: { n } }] : []);
  return {
    key: 'history.summary.retranscribed',
    params: { from: formatClock(window.fromMs), to: formatClock(window.toMs), lines },
    parts: [
      ...part('part-loops-removed', loops.removed),
      ...part('part-loops-kept', loops.kept),
      ...part('part-loops-left', loops.left),
      ...part('part-unassigned', unassigned),
    ],
  };
}

/** "Re-transcribed 24:12:04–24:27:04: 14 lines, 2 loops removed" (the edit history's words). Pure. */
export function windowSummary(window: TimeRange, lines: number, loops: LoopCounts, unassigned: number): string {
  return (
    `Re-transcribed ${formatClock(window.fromMs)}–${formatClock(window.toMs)}: ${plural(lines, 'line', 'lines')}` +
    (loops.removed ? `, ${plural(loops.removed, 'loop', 'loops')} removed` : '') +
    (loops.kept ? `, ${loops.kept} kept as really said` : '') +
    (loops.left ? `, ${loops.left} left marked LOOP?` : '') +
    (unassigned ? `, ${unassigned} without a speaker` : '')
  );
}

/**
 * "Nobody speaks here" from the speech map: speech covers under 10 % of the
 * stretch. Credit words a drama can say (转发, 订阅) count as credits only
 * there (loopRepair creditPhrase). Pure.
 */
export function silenceTest(regions: readonly SpeechRegion[]): (fromMs: number, toMs: number) => boolean {
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  return (fromMs, toMs) => {
    const span = toMs - fromMs;
    if (!(span > 0)) return false;
    let speech = 0;
    for (const r of sorted) {
      if (r.startMs >= toMs) break;
      speech += Math.max(0, Math.min(toMs, r.endMs) - Math.max(fromMs, r.startMs));
    }
    return speech < span * SILENT_SHARE;
  };
}

/**
 * The speech map saved for this very audio (audio/speech_regions.json, see
 * pipeline/speechMap.ts), or undefined: never measured here, since measuring
 * a long video's map would hold a 15-minute request for minutes.
 */
export async function readSavedSpeechRegions(audioPath: string, cachePath: string): Promise<SpeechRegion[] | undefined> {
  try {
    const [stat, raw] = await Promise.all([fsp.stat(audioPath), fsp.readFile(cachePath, 'utf8')]);
    const saved = JSON.parse(raw) as { audio?: { sizeBytes?: number; mtimeMs?: number }; regions?: unknown };
    if (saved.audio?.sizeBytes !== stat.size || saved.audio.mtimeMs !== Math.round(stat.mtimeMs) || !Array.isArray(saved.regions)) return undefined;
    return (saved.regions as Partial<SpeechRegion>[]).filter(
      (r): r is SpeechRegion => Number.isFinite(r?.startMs) && Number.isFinite(r?.endMs) && r.endMs! > r.startMs!,
    );
  } catch {
    return undefined;
  }
}

export interface HearDeps {
  /**
   * Decode [fromMs, toMs) of the project's audio (`noContext`: without the
   * previous text; `listenToAll`: without the engine's voice filter, for the
   * loop check's second opinion); lines in video time.
   */
  decode(fromMs: number, toMs: number, noContext: boolean, signal: AbortSignal, opts?: { listenToAll?: boolean }): Promise<TranscriptSegment[]>;
  /** No speech under a stretch (the speech map), when known. */
  inSilence?: (fromMs: number, toMs: number) => boolean;
}

/**
 * One window heard: decoded, fitted into the window, then the STT step's loop
 * pass (findLoopRanges, repairLoops: credits removed, loops decoded again
 * without context to confirm them); lines still inside a loop it could not
 * check carry `loopSuspect`. A stop is the signal: whatever it throws then,
 * callers check `signal.aborted`.
 */
export async function hearWindow(
  deps: HearDeps,
  window: TimeRange,
  noContext: boolean,
  signal: AbortSignal,
): Promise<{ lines: TranscriptSegment[]; loops: RepairedRange[] }> {
  const raw = fitToWindow(await deps.decode(window.fromMs, window.toMs, noContext, signal), window);
  const ranges = findLoopRanges(raw, deps.inSilence);
  if (ranges.length === 0) return { lines: raw, loops: [] };
  const outcome = await repairLoops(
    raw,
    ranges,
    {
      redecode: (fromMs, toMs, s) => deps.decode(fromMs, toMs, true, s, { listenToAll: true }),
      expectedSpeechMs,
      // The window was decoded from its start: its 30-s decoder windows (item D).
      originalOnWindow: (ms) => onDecoderWindow(ms, window.fromMs),
      ...(deps.inSilence ? { inSilence: deps.inSilence } : {}),
    },
    signal,
  );
  const left = outcome.ranges.filter((r) => r.status === 'left');
  const lines = outcome.lines.map((l) =>
    left.some((r) => l.startMs < r.toMs && l.endMs > r.fromMs) ? { ...l, loopSuspect: true as const } : l,
  );
  return { lines: fitToWindow(lines, window), loops: outcome.ranges };
}

/** A transcript line as a heard line (what the request returns and apply writes). Pure. */
export function heardLine(s: TranscriptSegment): RetranscribeLine {
  return {
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.sourceText,
    ...(s.speakerId ? { speakerId: s.speakerId } : {}),
    ...(s.speakerId && s.speakerLowConfidence ? { speakerLowConfidence: true as const } : {}),
    ...(s.loopSuspect ? { loopSuspect: true as const } : {}),
  };
}

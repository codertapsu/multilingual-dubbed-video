/**
 * Transcription loops: found, confirmed, repaired, and what is left said.
 *
 * Whisper can lock onto one phrase and repeat it for minutes: on the 10-hour
 * field run (2026-11-21) whisper.cpp large-v3 wrote 56 ranges like "回身缠住他们"
 * every 1.00 s up to the 600 s chunk boundary (its context carries within a
 * chunk), and over music it writes credit lines that were never said ("请不吝
 * 点赞 订阅 转发 打赏", "优优独播剧场"). Each became a dubbed line.
 *
 * The rules, tuned with the production run's false positives (claude-dubber):
 *  - a repeat is the same line at least 4 times AND a run of >= 8 lines or
 *    >= 20 s (phrases of <= 2 characters need >= 12 lines or >= 30 s), so a
 *    battle's "顶住 ×3", "驾 ×2" is not one;
 *  - low diversity: unique/total < 0.3 over >= 10 lines in 60 s (a chorus);
 *  - credit phrases: the unambiguous ones always; the common words (转发, 订阅,
 *    字幕, which a modern drama may say) only twice in a line or where the
 *    speech map heard no speech.
 * A repeat is CONFIRMED by decoding its range again without the previous
 * text: repetition that comes back is real (a chant, a song) and is kept;
 * varied text replaces the loop (credit lines filtered from it too, and
 * over-long lines trimmed); nothing usable left means silence, unless the
 * original was varied. A range whose re-decode failed is left, and flagged.
 * Lines on an exact 1.00 s grid with varied text are a timing problem, not a
 * loop: the speech map re-times them at the end of the STT step.
 *
 * Where the speech map heard no speech (`silence`), and for one line that
 * lasts far longer than its words (`overlong`), the two decodes are put
 * together line by line, paired by time (decodeMerge.ts): never the speech
 * map alone, which missed ~780 lines of shouted and music-covered dialogue in
 * 《反相之地》 (claude-dubber, 2026-11-25). Seven "你还要再说一遍" of 3–20 s
 * each over ~80 real lines were no loop by the old rules (too slow for one):
 * identical lines that each last far longer than their words, and five or
 * more in a row, are loops too.
 */
import { expectedSpeechMs as defaultExpectedSpeechMs } from '../alignment/clipSpeech.js';
import { padSegmentIndex } from '../workspace/paths.js';
import type { TranscriptSegment } from '@videodubber/shared';

import { isOverlongLine, maxSpeechMs, mergeByOverlap, type HeardLine } from './decodeMerge.js';

/**
 * What kind of loop a range is. `silence`: lines the speech map heard no
 * speech under (sttChecks.ts), hallucinations over a silent stretch or speech
 * the map missed. `overlong`: one line that lasts far longer than its words
 * (it may hide the lines said under it).
 */
export type LoopKind = 'repeat' | 'low-diversity' | 'phrase' | 'silence' | 'overlong';

export interface LoopRange {
  /** Lines [start, end) of the transcript. */
  start: number;
  end: number;
  fromMs: number;
  toMs: number;
  kind: LoopKind;
  /** The repeated line, or the credit phrase. */
  phrase?: string;
  /**
   * A `phrase` range that is a credit only because the speech map heard no
   * speech under it (a weak credit word): a decode without context must
   * confirm it before it goes, as the speech map misses speech under music.
   */
  bySilence?: boolean;
}

/**
 * Credit lines Whisper writes over music, never said in a video. Whole credit
 * phrases only: "请不吝" alone is real dialogue ("请不吝赐教"), and so is "明镜"
 * ("心如明镜").
 */
const STRONG_PHRASES = ['请不吝点赞', 'amaraorg', '优优独播', '中文字幕', '字幕by', '字幕組', '字幕组', 'subtitlesby'];
/** Words a drama can say for real: they count twice in a line, or where nobody speaks. */
const WEAK_PHRASES = ['点赞', '订阅', '转发', '打赏', '字幕', '感谢观看', '谢谢观看', '明镜', 'yoyo', 'amara'];

/** A line's text for comparing: lower case, without punctuation, symbols or spaces. Pure. */
export function normalizeLine(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\s\u{200b}-\u{200f}\u{feff}]/gu, '');
}

/** The credit phrase a line is, if any (`inSilence`: no speech under it). Pure. */
export function creditPhrase(text: string, inSilence = false): string | undefined {
  const t = normalizeLine(text);
  if (!t) return undefined;
  const strong = STRONG_PHRASES.find((p) => t.includes(p));
  if (strong) return strong;
  const weak = WEAK_PHRASES.filter((p) => t.includes(p));
  if (weak.length >= 2 || (weak.length === 1 && inSilence)) return weak[0];
  return undefined;
}

const MIN_REPEATS = 4;
/** A run whose repeats are further apart than this on average is not a loop. */
const MAX_MS_PER_REPEAT = 6000;
const MIN_RUN_LINES = 8;
const MIN_RUN_MS = 20_000;
const SHORT_PHRASE_CHARS = 2;
const SHORT_RUN_LINES = 12;
const SHORT_RUN_MS = 30_000;
const DIVERSITY_WINDOW_MS = 60_000;
const DIVERSITY_MIN_LINES = 10;
const DIVERSITY_MAX_RATIO = 0.3;
/** The same line this many times in a row, each lasting far longer than its words: a loop at any pace. */
const OVERLONG_RUN_LINES = 3;
/** The same line (of 3 characters or more) this many times in a row: a loop at any pace. */
const SPACED_RUN_LINES = 5;
const SPACED_RUN_CHARS = 3;
/** Overlong single lines checked at most per transcript (the longest for their words first). */
const MAX_OVERLONG_CHECKS = 300;

interface Line {
  startMs: number;
  endMs: number;
  sourceText: string;
}

export interface FindLoopOptions {
  /** How long a line's words take to say (default alignment/clipSpeech.expectedSpeechMs). */
  expectedSpeechMs?: (text: string) => number;
}

/**
 * Ranges of a transcript that look like loops. `inSilence(fromMs, toMs)`: the
 * speech map heard nothing there (optional). Ranges are sorted, merged when
 * they overlap or touch. Pure.
 */
export function findLoopRanges(
  lines: readonly Line[],
  inSilence?: (fromMs: number, toMs: number) => boolean,
  opts: FindLoopOptions = {},
): LoopRange[] {
  const found: LoopRange[] = [];
  const norm = lines.map((l) => normalizeLine(l.sourceText));
  const expected = opts.expectedSpeechMs ?? defaultExpectedSpeechMs;

  // Runs of the same line.
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && norm[j] === norm[i] && norm[i] !== '') j++;
    const count = j - i;
    // Dense, too: a loop says its phrase about every second. The same short
    // answer four times in a minute and a half is a conversation.
    const span = j > i ? lines[j - 1]!.endMs - lines[i]!.startMs : 0;
    const chars = [...(norm[i] ?? '')].length;
    let loop = false;
    if (norm[i] && count >= MIN_REPEATS && span / count <= MAX_MS_PER_REPEAT) {
      const short = chars <= SHORT_PHRASE_CHARS;
      loop = short ? count >= SHORT_RUN_LINES || span >= SHORT_RUN_MS : count >= MIN_RUN_LINES || span >= MIN_RUN_MS;
    }
    if (norm[i] && !loop) {
      // At any pace: each one far longer than its words (the decoder holding
      // one phrase over what was really said), or five and more in a row.
      const meanMs = lines.slice(i, j).reduce((n, l) => n + (l.endMs - l.startMs), 0) / Math.max(1, count);
      const overlong = count >= OVERLONG_RUN_LINES && meanMs > 2 * maxSpeechMs(lines[i]!.sourceText, expected);
      loop = overlong || (count >= SPACED_RUN_LINES && chars >= SPACED_RUN_CHARS);
    }
    if (loop) found.push({ start: i, end: j, fromMs: lines[i]!.startMs, toMs: lines[j - 1]!.endMs, kind: 'repeat', phrase: lines[i]!.sourceText.trim() });
    i = j;
  }

  // Little variety over a minute (A B A B..., a chorus): the range is the
  // lines whose text recurs in the window, so a line said once beside a loop
  // stays out of it. Short phrases need the longer run, as for repeats.
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j < lines.length && lines[j]!.startMs - lines[i]!.startMs <= DIVERSITY_WINDOW_MS) j++;
    const window = norm.slice(i, j).filter(Boolean);
    if (window.length < DIVERSITY_MIN_LINES || new Set(window).size / window.length >= DIVERSITY_MAX_RATIO) continue;
    const counts = new Map<string, number>();
    for (const t of window) counts.set(t, (counts.get(t) ?? 0) + 1);
    const recurs = (k: number): boolean => (counts.get(norm[k]!) ?? 0) >= 2;
    let a = i;
    while (a < j && !recurs(a)) a++;
    let b = j;
    while (b > a && !recurs(b - 1)) b--;
    const kept = norm.slice(a, b).filter(Boolean);
    const allShort = kept.every((t) => [...t].length <= SHORT_PHRASE_CHARS);
    if (kept.length < (allShort ? SHORT_RUN_LINES : DIVERSITY_MIN_LINES)) continue;
    found.push({ start: a, end: b, fromMs: lines[a]!.startMs, toMs: lines[b - 1]!.endMs, kind: 'low-diversity' });
  }

  // Credit lines.
  for (const [i, l] of lines.entries()) {
    const silent = inSilence?.(l.startMs, l.endMs) === true;
    const phrase = creditPhrase(l.sourceText, silent);
    if (!phrase) continue;
    const bySilence = silent && creditPhrase(l.sourceText, false) === undefined;
    found.push({ start: i, end: i + 1, fromMs: l.startMs, toMs: l.endMs, kind: 'phrase', phrase, ...(bySilence ? { bySilence: true } : {}) });
  }

  // One line far longer than its words, alone: it may hide what was said
  // under it. Checked against a decode without context (decodeMerge.ts).
  const overlong = lines
    .map((l, i) => ({ i, ms: l.endMs - l.startMs, words: expected(l.sourceText) }))
    .filter((x) => norm[x.i] && isOverlongLine(lines[x.i]!, expected))
    .sort((a, b) => b.ms / b.words - a.ms / a.words)
    .slice(0, MAX_OVERLONG_CHECKS);
  for (const { i } of overlong) {
    found.push({ start: i, end: i + 1, fromMs: lines[i]!.startMs, toMs: lines[i]!.endMs, kind: 'overlong', phrase: lines[i]!.sourceText.trim() });
  }

  // Merge overlapping ranges; the stronger kind names the merge.
  const rank: Record<LoopKind, number> = { silence: 4, repeat: 3, 'low-diversity': 2, phrase: 1, overlong: 0 };
  const sorted = found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: LoopRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      if (rank[r.kind] > rank[last.kind]) {
        last.kind = r.kind;
        if (r.phrase) last.phrase = r.phrase;
        else delete last.phrase;
      }
      // Only a credit that is nothing but silence-dependent waits for a decode.
      if (last.kind !== 'phrase' || (r.kind === 'phrase' && !r.bySilence)) delete last.bySilence;
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

/** How a range was handled. */
export type LoopStatus = 'replaced' | 'kept' | 'removed' | 'left';

export interface RepairedRange {
  fromMs: number;
  toMs: number;
  kind: LoopKind;
  status: LoopStatus;
  phrase?: string;
  /** Lines before and after. */
  before: number;
  after: number;
  /** Why it was kept or left. */
  reason?: string;
  /**
   * What each decode heard, kept as evidence (audio/loop_ranges.json): the
   * analysis of 《反相之地》 kept only counts, so no one could tell afterwards
   * what a "removed" range had said (claude-dubber, 2026-11-25).
   */
  originalLines?: { startMs: number; endMs: number; text: string }[];
  heardLines?: { startMs: number; endMs: number; text: string }[];
  /** For a range the two decodes were paired in (decodeMerge.ts): what became of its lines. */
  counts?: { kept: number; added: number; dropped: number; retimed: number; artifacts: number };
}

/** A line as the evidence keeps it. */
const brief = (l: Pick<TranscriptSegment, 'startMs' | 'endMs' | 'sourceText'>): { startMs: number; endMs: number; text: string } => ({
  startMs: l.startMs,
  endMs: l.endMs,
  text: l.sourceText,
});

export interface LoopRepairDeps {
  /** Decode [fromMs, toMs] of the audio again without the previous text; lines in absolute ms. */
  redecode(fromMs: number, toMs: number, signal: AbortSignal): Promise<TranscriptSegment[]>;
  /** Roughly how long a line's text takes to say (alignment/clipSpeech.expectedSpeechMs). */
  expectedSpeechMs(text: string): number;
  inSilence?: (fromMs: number, toMs: number) => boolean;
  /** Where the transcript's own decode had a window start (its STT chunks' 30-s windows), when known. */
  originalOnWindow?: (startMs: number) => boolean;
}

/**
 * How alike two lines' texts are: the Dice coefficient of their character
 * bigrams (single characters for a one-character text), after
 * normalizeLine (no case, punctuation or spaces). 1 for the same text, 0 for
 * nothing shared. Pure.
 */
export function bigramSimilarity(a: string, b: string): number {
  const x = [...normalizeLine(a)];
  const y = [...normalizeLine(b)];
  if (x.length === 0 || y.length === 0) return 0;
  const n = x.length < 2 || y.length < 2 ? 1 : 2;
  const grams = (s: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n).join('');
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let shared = 0;
  for (const [g, count] of gx) shared += Math.min(count, gy.get(g) ?? 0);
  return (2 * shared) / (x.length - n + 1 + (y.length - n + 1));
}

/**
 * A decode without context "heard the same words" as the lines it checks from
 * this similarity of their texts (bigramSimilarity of the whole range).
 */
export const SAME_WORDS = 0.5;

/** A loop that repeats again in its second decode and lasts longer than this is decoded again in windows. */
const WINDOWED_MIN_MS = 45_000;
/** The windows of that third decode: short enough that one loop cannot carry over a whole range. */
const WINDOW_MS = 30_000;

/**
 * Re-decoded lines from the padded window, inside the range only: a line is
 * the range's when its middle is, and is clipped to it. The padding is there
 * for the decoder's ear; what it hears in it belongs to the lines around the
 * range, and kept, it duplicated their words and overlapped their time
 * (《反相之地》, claude-dubber 2026-11-25). Pure.
 */
export function clipToRange(fresh: readonly TranscriptSegment[], fromMs: number, toMs: number): TranscriptSegment[] {
  return fresh
    .filter((l) => {
      const mid = (l.startMs + l.endMs) / 2;
      return mid >= fromMs && mid <= toMs;
    })
    .map((l) => ({ ...l, startMs: Math.max(l.startMs, fromMs), endMs: Math.min(l.endMs, toMs) }))
    .filter((l) => l.endMs > l.startMs);
}

/** Share of distinct lines that makes a range "varied" (keep it when the re-decode has nothing). */
const VARIED_RATIO = 0.5;

/**
 * Repair the loop ranges of a transcript. The result's lines are renumbered
 * (seg_0001...) and keep every field of the lines outside the ranges; a
 * cancel (the signal) is thrown, a failed re-decode leaves its range as it
 * was and says so.
 */
export async function repairLoops(
  lines: readonly TranscriptSegment[],
  ranges: readonly LoopRange[],
  deps: LoopRepairDeps,
  signal: AbortSignal,
): Promise<{ lines: TranscriptSegment[]; ranges: RepairedRange[]; originals: TranscriptSegment[][] }> {
  const out: TranscriptSegment[] = [];
  const report: RepairedRange[] = [];
  const originals: TranscriptSegment[][] = [];
  let at = 0;
  for (const r of ranges) {
    out.push(...lines.slice(at, r.start));
    at = r.end;
    const original = lines.slice(r.start, r.end);
    originals.push(original);
    const base = {
      fromMs: r.fromMs,
      toMs: r.toMs,
      kind: r.kind,
      ...(r.phrase ? { phrase: r.phrase } : {}),
      before: original.length,
      originalLines: original.map(brief),
    };
    if (r.kind === 'phrase' && !r.bySilence) {
      // A whole credit phrase was never said in a video.
      report.push({ ...base, status: 'removed', after: 0 });
      continue;
    }
    // What a decode without context hears in the range, minus credits and the
    // neighbours' words (heard in the padding). The second decode can
    // hallucinate over music too ("优优独播剧场—YoYo…").
    const neighbours = new Set([lines[r.start - 1], lines[r.end]].filter((l): l is TranscriptSegment => l !== undefined).map((l) => normalizeLine(l.sourceText)));
    // A decode started at `clipStartMs`: its 30-s windows say which of its
    // lines start on a window (decodeMerge.ts).
    const hear = (fresh: readonly TranscriptSegment[], fromMs: number, toMs: number, clipStartMs: number): HeardLine[] =>
      clipToRange(fresh, fromMs, toMs)
        .filter((l) => {
          const text = normalizeLine(l.sourceText);
          return text !== '' && !neighbours.has(text) && !creditPhrase(l.sourceText, deps.inSilence?.(l.startMs, l.endMs) === true);
        })
        .map((line) => ({ line, clipStartMs }));
    let heard: HeardLine[];
    try {
      const clipStartMs = Math.max(0, r.fromMs - 500);
      heard = hear(await deps.redecode(clipStartMs, r.toMs + 500, signal), r.fromMs, r.toMs, clipStartMs);
    } catch (err) {
      if (signal.aborted) throw err;
      out.push(...original);
      report.push({ ...base, status: 'left', after: original.length, reason: `the second decode failed (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    const usable = heard.map((h) => h.line);
    const evidence = { heardLines: usable.map(brief) };
    const same = usable.length > 0 && bigramSimilarity(original.map((l) => l.sourceText).join(''), usable.map((l) => l.sourceText).join('')) >= SAME_WORDS;
    const loops = (lines: readonly TranscriptSegment[]): boolean => {
      const again = findLoopRanges(lines).filter((x) => x.kind !== 'phrase' && x.kind !== 'overlong');
      return again.length > 0 && again.reduce((n, x) => n + (x.end - x.start), 0) / lines.length >= 0.5;
    };
    /** The second decode's lines in place of the range's: window-start artifacts left out, over-long ones cut to their words. */
    const replacement = (from: readonly HeardLine[]): TranscriptSegment[] =>
      mergeByOverlap([], from, { expectedSpeechMs: deps.expectedSpeechMs, artifacts: 'flag' }).lines;

    // A credit word where the speech map heard nothing: gone unless a decode
    // without context heard the same words.
    if (r.kind === 'phrase') {
      if (same) {
        out.push(...original);
        report.push({ ...base, ...evidence, status: 'kept', after: original.length, reason: 'a decode without context heard the same words: really said' });
      } else {
        report.push({ ...base, ...evidence, status: 'removed', after: 0, reason: 'a credit word where the speech map heard no speech, and a decode without context did not hear it' });
      }
      continue;
    }

    // Where the speech map heard nothing, and one line far longer than its
    // words: the two decodes, paired by time (decodeMerge.ts). Never the
    // speech map alone. A LOOP heard again is no evidence, though: over true
    // silence the decoder repeats its own hallucination, word for word.
    if (r.kind === 'silence' || r.kind === 'overlong') {
      if (loops(original)) {
        const fresh = replacement(heard);
        const gone = { kept: 0, retimed: 0, artifacts: 0, dropped: original.length };
        if (fresh.length === 0 || loops(usable)) {
          report.push({ ...base, ...evidence, status: 'removed', after: 0, counts: { ...gone, added: 0 }, reason: 'a loop, and a decode without context looped again or heard nothing' });
        } else {
          out.push(...withSpeaker(fresh, original));
          report.push({
            ...base,
            ...evidence,
            status: 'replaced',
            after: fresh.length,
            counts: { ...gone, added: fresh.length },
            reason: 'a loop: replaced by what a decode without context heard',
          });
        }
        continue;
      }
      const merged = mergeByOverlap(original, heard, {
        expectedSpeechMs: deps.expectedSpeechMs,
        ...(deps.originalOnWindow ? { originalOnWindow: deps.originalOnWindow } : {}),
        isCredit: (l) => creditPhrase(l.sourceText, true) !== undefined,
        // One long line where the map heard speech (or there is no map): a
        // second decode that missed it is the only evidence against it.
        ...(r.kind === 'overlong' ? { keepUnheard: (l: TranscriptSegment) => deps.inSilence?.(l.startMs, l.endMs) !== true } : {}),
      });
      const lines = withSpeaker(merged.lines, original);
      out.push(...lines);
      const unchanged = merged.dropped === 0 && merged.added === 0;
      const parts = [
        `${merged.kept} heard by both${merged.retimed > 0 ? ` (${merged.retimed} re-timed)` : ''}`,
        ...(merged.added > 0 ? [`${merged.added} heard only without context, added`] : []),
        ...(merged.dropped > 0 ? [`${merged.dropped} not heard again, removed`] : []),
        ...(merged.artifacts > 0 ? [`${merged.artifacts} decoder window artifact(s) left out`] : []),
      ];
      report.push({
        ...base,
        ...evidence,
        status: unchanged ? 'kept' : lines.length === 0 ? 'removed' : 'replaced',
        after: lines.length,
        counts: { kept: merged.kept, added: merged.added, dropped: merged.dropped, retimed: merged.retimed, artifacts: merged.artifacts },
        reason: `${r.kind === 'silence' ? 'the speech map heard no speech here' : 'one line far longer than its words'}; paired with a decode without context by time: ${parts.join(', ')}`,
      });
      continue;
    }

    const varied = new Set(original.map((l) => normalizeLine(l.sourceText))).size / Math.max(1, original.length) >= VARIED_RATIO;
    if (usable.length === 0) {
      if (varied) {
        out.push(...original);
        report.push({ ...base, ...evidence, status: 'kept', after: original.length, reason: 'the second decode heard nothing, and the lines are varied' });
      } else {
        report.push({ ...base, ...evidence, status: 'removed', after: 0 });
      }
      continue;
    }
    let reason: string | undefined;
    if (loops(usable)) {
      // It repeats without context too. A long range may be the decoder's
      // loop all over again ("你还要再说一遍" ×7 over ~80 real lines): heard
      // in 30-second windows, a loop cannot carry over the whole range.
      let windowed: HeardLine[] | undefined;
      if (r.toMs - r.fromMs > WINDOWED_MIN_MS) {
        try {
          windowed = [];
          for (let from = r.fromMs; from < r.toMs; from += WINDOW_MS) {
            const to = Math.min(r.toMs, from + WINDOW_MS);
            const clipStartMs = Math.max(0, from - 500);
            windowed.push(...hear(await deps.redecode(clipStartMs, to + 500, signal), from, to, clipStartMs));
          }
        } catch (err) {
          if (signal.aborted) throw err;
          windowed = undefined;
        }
      }
      if (!windowed || windowed.length === 0 || loops(windowed.map((h) => h.line))) {
        // Really said (a chant, a song).
        out.push(...original);
        report.push({ ...base, ...evidence, status: 'kept', after: original.length, reason: 'it repeats in a fresh decode too: really said (a chant or a song)' });
        continue;
      }
      heard = windowed;
      reason = 'decoded again in 30-second windows: the repetition was the decoder\'s loop';
    }
    // A line starting on a decoder window and far longer than its words is
    // cut to its first seconds and marked for review (item C: such lines
    // started 1–4 s before their words and ran on 20–30 s; decodeMerge.ts).
    const replaced = withSpeaker(replacement(heard), original);
    out.push(...replaced);
    report.push({ ...base, ...evidence, status: 'replaced', after: replaced.length, ...(reason ? { reason } : {}) });
  }
  out.push(...lines.slice(at));
  return {
    lines: out.map((l, i) => ({ ...l, index: i, id: `seg_${padSegmentIndex(i + 1)}` })),
    ranges: report,
    originals,
  };
}

/** New lines of a range take its speaker when they have none (speaker detection runs after the loop check, but a re-transcription keeps speakers). */
function withSpeaker(lines: readonly TranscriptSegment[], original: readonly TranscriptSegment[]): TranscriptSegment[] {
  const speaker = original.find((l) => l.speakerId)?.speakerId;
  return lines.map((l) => (speaker && !l.speakerId ? { ...l, speakerId: speaker } : l));
}

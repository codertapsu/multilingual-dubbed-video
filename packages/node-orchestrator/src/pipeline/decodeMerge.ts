/**
 * Two decodes of one stretch, put together line by line: the transcript's
 * own (with the previous text as context) and a second one without context
 * (the loop check's second opinion, loopRepair.ts). Pure.
 *
 * WHY (《反相之地》, claude-dubber 2026-11-25): where the speech map heard no
 * speech, 0.18.0 dropped every line of the second decode that fell in that
 * "silence", so 76 ranges could only lose lines: 3:46–4:20 went 20 -> 0
 * while the second decode had heard the 15 real lines of a chase scene, and
 * ~780 lines of dialogue were gone. The two decodes are now paired by TIME,
 * never by text: the decode without context words the same utterance
 * differently (别喊 / 别看, 打不开 / 挡开, 回606 / 回六六六 走), so a text match
 * would drop the first decode's line and add the variant.
 *
 *  - A line both decodes heard keeps the first decode's text (it had the
 *    context), and the second decode's timing when the first one's start is
 *    a decoder artifact (on a 30-s window, or far longer than its words).
 *  - A line only the first decode heard goes: the speech map and a second
 *    decode both heard nothing there. (A long line the speech map heard
 *    speech under stays: a missed second decode alone is no evidence.)
 *  - A line only the second decode heard is added, unless it is the
 *    decoder's window-start artifact over music (it starts on a 30-s window
 *    and lasts far longer than its words: "盼子" for 20 s, item D).
 *  - When the first decode's lines say far less than the second's heard in
 *    the same time, they hid real lines (one "你还要再说一遍" for 20 s over a
 *    dozen lines, item B): the second decode's lines replace them.
 */
import type { TranscriptSegment } from '@videodubber/shared';

/** Whisper decodes in windows of 30 s; a window's first line may start at the window start. */
export const DECODER_WINDOW_MS = 30_000;
/** How close to a window start a line's start must be to sit on it. */
const ON_WINDOW_MS = 60;
/** A line longer than this many times its words' time (plus slack) does not say only what it says. */
export const OVERLONG_FACTOR = 1.6;
export const OVERLONG_SLACK_MS = 600;
/** Second-decode lines saying this many times more than the first decode's lines in the same time replace them. */
const HIDDEN_SPEECH_FACTOR = 2.5;
/** Two lines heard at the same time: they overlap by this much, or by this share of the shorter one. */
const MIN_OVERLAP_MS = 200;
const MIN_OVERLAP_SHARE = 0.3;

/** Whether `startMs` sits on one of the 30-s decoder windows of a decode that started at `clipStartMs`. Pure. */
export function onDecoderWindow(startMs: number, clipStartMs: number): boolean {
  const off = startMs - clipStartMs;
  if (off < -ON_WINDOW_MS) return false;
  const k = Math.round(off / DECODER_WINDOW_MS);
  return Math.abs(off - k * DECODER_WINDOW_MS) <= ON_WINDOW_MS;
}

/** One line at least this long, lasting this many times its words' time, says less than was said in it. */
export const OVERLONG_LINE_MIN_MS = 6000;
export const OVERLONG_LINE_FACTOR = 4;

/** A line far longer than its words (see {@link OVERLONG_LINE_FACTOR}). Pure. */
export function isOverlongLine(line: { startMs: number; endMs: number; sourceText: string }, expectedSpeechMs: (text: string) => number): boolean {
  const ms = line.endMs - line.startMs;
  return ms >= OVERLONG_LINE_MIN_MS && ms > OVERLONG_LINE_FACTOR * expectedSpeechMs(line.sourceText);
}

/** The longest a line saying `text` plausibly lasts. */
export function maxSpeechMs(text: string, expectedSpeechMs: (text: string) => number): number {
  return expectedSpeechMs(text) * OVERLONG_FACTOR + OVERLONG_SLACK_MS;
}

/** A line of the second decode, with where that decode started (its windows). */
export interface HeardLine {
  line: TranscriptSegment;
  clipStartMs: number;
}

export interface MergeOptions {
  expectedSpeechMs(text: string): number;
  /** The first decode's windows: whether a line of it starts on one (unknown: never). */
  originalOnWindow?(startMs: number): boolean;
  /** A line that never stays (a credit line the decoder writes over music). */
  isCredit?(line: TranscriptSegment): boolean;
  /**
   * A first-decode line the second decode did not hear that stays anyway:
   * the only evidence against it is that miss (a long line where the speech
   * map heard speech, say). Default: it goes.
   */
  keepUnheard?(line: TranscriptSegment): boolean;
  /**
   * A window-start artifact only the second decode heard: left out (`drop`,
   * the default: the first decode is a second opinion against it), or kept
   * at its end and marked for review (`flag`: nothing else heard that
   * stretch, a loop's replacement).
   */
  artifacts?: 'drop' | 'flag';
}

export interface MergeOutcome {
  lines: TranscriptSegment[];
  /** First-decode lines kept (text kept; maybe re-timed). */
  kept: number;
  /** First-decode lines re-timed to the second decode. */
  retimed: number;
  /** First-decode lines gone: not heard again, credits, or hiding the second decode's lines. */
  dropped: number;
  /** Second-decode lines added. */
  added: number;
  /** Second-decode lines left out: window-start artifacts nobody else heard. */
  artifacts: number;
}

interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Where a window's first line really starts, at most: the decoder writes it
 * from the window start, and its words came 1–4 s later (item C: "楼下也说不准"
 * at 27:41.1, really at 27:44.2; the line ran on 20–30 s past them).
 */
const ARTIFACT_LEAD_MS = 4000;

/**
 * The part of a line its words can fill: the line itself, or, for a line
 * whose start is a window artifact and that lasts far longer than its words,
 * its first seconds: the words come soon after the window start, and the
 * line's end is the window's, not theirs.
 */
function speechSpan(line: TranscriptSegment, onWindow: boolean, expectedSpeechMs: (text: string) => number): { span: Span; artifact: boolean } {
  const max = maxSpeechMs(line.sourceText, expectedSpeechMs);
  if (onWindow && line.endMs - line.startMs > max) {
    return { span: { startMs: line.startMs, endMs: Math.min(line.endMs, Math.round(line.startMs + max + ARTIFACT_LEAD_MS)) }, artifact: true };
  }
  return { span: { startMs: line.startMs, endMs: line.endMs }, artifact: false };
}

function overlaps(a: Span, b: Span): boolean {
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (shared <= 0) return false;
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shared >= MIN_OVERLAP_MS || shared >= shorter * MIN_OVERLAP_SHARE;
}

/** The two decodes of one stretch as one list of lines (see the module comment). Sorted by start. */
export function mergeByOverlap(original: readonly TranscriptSegment[], heard: readonly HeardLine[], opts: MergeOptions): MergeOutcome {
  const credits = original.filter((l) => opts.isCredit?.(l) === true).length;
  const first = original
    .filter((l) => opts.isCredit?.(l) !== true)
    .map((line) => ({ line, ...speechSpan(line, opts.originalOnWindow?.(line.startMs) === true, opts.expectedSpeechMs) }));
  const second = heard.map((h) => ({ line: h.line, ...speechSpan(h.line, onDecoderWindow(h.line.startMs, h.clipStartMs), opts.expectedSpeechMs) }));

  // Lines heard at the same time, as groups (union-find over the pairs).
  const parent = Array.from({ length: first.length + second.length }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const [i, o] of first.entries()) {
    for (const [j, h] of second.entries()) {
      if (overlaps(o.span, h.span)) parent[find(i)] = find(first.length + j);
    }
  }
  const groups = new Map<number, { o: number[]; h: number[] }>();
  for (let i = 0; i < parent.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? { o: [], h: [] };
    if (i < first.length) g.o.push(i);
    else g.h.push(i - first.length);
    groups.set(root, g);
  }

  const out: TranscriptSegment[] = [];
  const result: MergeOutcome = { lines: out, kept: 0, retimed: 0, dropped: credits, added: 0, artifacts: 0 };
  const addHeard = (j: number, alone: boolean): void => {
    const h = second[j]!;
    if (alone && h.artifact && opts.artifacts !== 'flag') {
      result.artifacts += 1;
      return;
    }
    // Heard over a stretch longer than its words: cut to them (an artifact
    // to its first seconds, speechSpan).
    const max = maxSpeechMs(h.line.sourceText, opts.expectedSpeechMs);
    const span = h.artifact || h.span.endMs - h.span.startMs <= max ? h.span : { startMs: h.span.startMs, endMs: Math.round(h.span.startMs + max) };
    const { words: _words, ...rest } = h.line;
    out.push({ ...rest, startMs: span.startMs, endMs: span.endMs, ...(alone && h.artifact ? { loopSuspect: true as const } : {}) });
    result.added += 1;
  };
  for (const g of groups.values()) {
    if (g.o.length === 0) {
      for (const j of g.h) addHeard(j, true);
      continue;
    }
    if (g.h.length === 0) {
      for (const i of g.o) {
        const o = first[i]!.line;
        if (opts.keepUnheard?.(o) === true) {
          out.push(o);
          result.kept += 1;
        } else {
          result.dropped += 1;
        }
      }
      continue;
    }
    const say = (lines: readonly TranscriptSegment[]): number => lines.reduce((n, l) => n + opts.expectedSpeechMs(l.sourceText), 0);
    const firstSays = say(g.o.map((i) => first[i]!.line));
    const secondSays = say(g.h.map((j) => second[j]!.line));
    if (g.h.length >= 2 && secondSays > firstSays * HIDDEN_SPEECH_FACTOR) {
      result.dropped += g.o.length;
      for (const j of g.h) addHeard(j, false);
      continue;
    }
    for (const i of g.o) {
      const o = first[i]!;
      result.kept += 1;
      // Its own timing stands unless it is a decoder artifact: on a window
      // and longer than its words, or far longer than its words anywhere.
      const unreliable = o.artifact || isOverlongLine(o.line, opts.expectedSpeechMs);
      const mates = g.h.map((j) => second[j]!).filter((h) => overlaps(o.span, h.span));
      if (unreliable && mates.length > 0) {
        const startMs = Math.min(...mates.map((h) => h.span.startMs));
        const endMs = Math.max(...mates.map((h) => h.span.endMs));
        if (endMs > startMs && (startMs !== o.line.startMs || endMs !== o.line.endMs)) {
          const { words: _words, ...rest } = o.line;
          out.push({ ...rest, startMs, endMs });
          result.retimed += 1;
          continue;
        }
      }
      out.push(o.line);
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return result;
}

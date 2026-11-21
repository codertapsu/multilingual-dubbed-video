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
 */
import { padSegmentIndex } from '../workspace/paths.js';
import type { TranscriptSegment } from '@videodubber/shared';

/** What kind of loop a range is. */
export type LoopKind = 'repeat' | 'low-diversity' | 'phrase';

export interface LoopRange {
  /** Lines [start, end) of the transcript. */
  start: number;
  end: number;
  fromMs: number;
  toMs: number;
  kind: LoopKind;
  /** The repeated line, or the credit phrase. */
  phrase?: string;
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

interface Line {
  startMs: number;
  endMs: number;
  sourceText: string;
}

/**
 * Ranges of a transcript that look like loops. `inSilence(fromMs, toMs)`: the
 * speech map heard nothing there (optional). Ranges are sorted, merged when
 * they overlap or touch. Pure.
 */
export function findLoopRanges(lines: readonly Line[], inSilence?: (fromMs: number, toMs: number) => boolean): LoopRange[] {
  const found: LoopRange[] = [];
  const norm = lines.map((l) => normalizeLine(l.sourceText));

  // Runs of the same line.
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && norm[j] === norm[i] && norm[i] !== '') j++;
    const count = j - i;
    // Dense, too: a loop says its phrase about every second. The same short
    // answer four times in a minute and a half is a conversation.
    const span = j > i ? lines[j - 1]!.endMs - lines[i]!.startMs : 0;
    if (norm[i] && count >= MIN_REPEATS && span / count <= MAX_MS_PER_REPEAT) {
      const short = [...norm[i]!].length <= SHORT_PHRASE_CHARS;
      const long = short ? count >= SHORT_RUN_LINES || span >= SHORT_RUN_MS : count >= MIN_RUN_LINES || span >= MIN_RUN_MS;
      if (long) found.push({ start: i, end: j, fromMs: lines[i]!.startMs, toMs: lines[j - 1]!.endMs, kind: 'repeat', phrase: lines[i]!.sourceText.trim() });
    }
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
    const phrase = creditPhrase(l.sourceText, inSilence?.(l.startMs, l.endMs) === true);
    if (phrase) found.push({ start: i, end: i + 1, fromMs: l.startMs, toMs: l.endMs, kind: 'phrase', phrase });
  }

  // Merge overlapping ranges; the stronger kind names the merge.
  const rank: Record<LoopKind, number> = { repeat: 3, 'low-diversity': 2, phrase: 1 };
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
}

export interface LoopRepairDeps {
  /** Decode [fromMs, toMs] of the audio again without the previous text; lines in absolute ms. */
  redecode(fromMs: number, toMs: number, signal: AbortSignal): Promise<TranscriptSegment[]>;
  /** Roughly how long a line's text takes to say (alignment/clipSpeech.expectedSpeechMs). */
  expectedSpeechMs(text: string): number;
  inSilence?: (fromMs: number, toMs: number) => boolean;
}

/** A re-decoded line longer than this many times its text's time (plus slack) is cut short. */
const OVERLONG_FACTOR = 1.6;
const OVERLONG_SLACK_MS = 600;

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
): Promise<{ lines: TranscriptSegment[]; ranges: RepairedRange[] }> {
  const out: TranscriptSegment[] = [];
  const report: RepairedRange[] = [];
  let at = 0;
  for (const r of ranges) {
    out.push(...lines.slice(at, r.start));
    at = r.end;
    const original = lines.slice(r.start, r.end);
    const base = { fromMs: r.fromMs, toMs: r.toMs, kind: r.kind, ...(r.phrase ? { phrase: r.phrase } : {}), before: original.length };
    if (r.kind === 'phrase') {
      // A credit line was never said: silence there.
      report.push({ ...base, status: 'removed', after: 0 });
      continue;
    }
    let fresh: TranscriptSegment[];
    try {
      fresh = await deps.redecode(Math.max(0, r.fromMs - 500), r.toMs + 500, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      out.push(...original);
      report.push({ ...base, status: 'left', after: original.length, reason: `the second decode failed (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    // The re-decode can hallucinate over music too ("优优独播剧场—YoYo…").
    const usable = fresh
      .filter((l) => l.endMs > r.fromMs - 500 && l.startMs < r.toMs + 500)
      .filter((l) => normalizeLine(l.sourceText) !== '' && !creditPhrase(l.sourceText, deps.inSilence?.(l.startMs, l.endMs) === true));
    const varied = new Set(original.map((l) => normalizeLine(l.sourceText))).size / Math.max(1, original.length) >= VARIED_RATIO;
    if (usable.length === 0) {
      if (varied) {
        out.push(...original);
        report.push({ ...base, status: 'kept', after: original.length, reason: 'the second decode heard nothing, and the lines are varied' });
      } else {
        report.push({ ...base, status: 'removed', after: 0 });
      }
      continue;
    }
    const again = findLoopRanges(usable).filter((x) => x.kind !== 'phrase');
    const repeatedShare = again.reduce((n, x) => n + (x.end - x.start), 0) / usable.length;
    if (again.length > 0 && repeatedShare >= 0.5) {
      // It repeats without context too: really said (a chant, a song).
      out.push(...original);
      report.push({ ...base, status: 'kept', after: original.length, reason: 'it repeats in a fresh decode too: really said (a chant or a song)' });
      continue;
    }
    const speaker = original.find((l) => l.speakerId)?.speakerId;
    const replaced = usable.map((l) => {
      const maxMs = deps.expectedSpeechMs(l.sourceText) * OVERLONG_FACTOR + OVERLONG_SLACK_MS;
      const endMs = l.endMs - l.startMs > maxMs ? Math.round(l.startMs + maxMs) : l.endMs;
      const { words: _words, ...rest } = l;
      return { ...rest, endMs, ...(speaker && !l.speakerId ? { speakerId: speaker } : {}) };
    });
    out.push(...replaced);
    report.push({ ...base, status: 'replaced', after: replaced.length });
  }
  out.push(...lines.slice(at));
  return {
    lines: out.map((l, i) => ({ ...l, index: i, id: `seg_${padSegmentIndex(i + 1)}` })),
    ranges: report,
  };
}

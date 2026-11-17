/**
 * Anchor each transcript line to when it is actually spoken.
 *
 * Both speech-to-text engines can stretch a short line across seconds of music
 * or fighting, and everything downstream places the dub at the line's START and
 * shows its subtitle for the whole span. Measured on real Chinese videos
 * (2026-11-17): 6.4% of lines in a 21-minute video and 15.5% in a 31-minute one
 * started too early — median 7 s, worst 46 s — so the dub spoke before the
 * speaker did, and 41% of the 31-minute video showed text for speech that had
 * not happened yet ("张三世" sat on screen for 99 s).
 *
 * The causes differ, the evidence does not:
 *  - faster-whisper's own VAD (on by default) cuts the gaps out, transcribes,
 *    then maps words back; the first word after a cut is mapped into the
 *    previous chunk's 400 ms padding. In every affected line the big gap comes
 *    right after word #0, often splitting one word (狐|狸 12 s apart). The words
 *    are right; the line's start is wrong.
 *  - whisper.cpp has no VAD and no usable word timings: a 30 s window that
 *    opens on music starts its first line at the window start
 *    ([30.00-46.96] "虎哥 这啥地方啊", spoken near the end). Its END is right.
 * So: word timings first; the speech map (Silero VAD, stt-worker
 * /speech-regions) where a line has no words or a word's place is in doubt;
 * and when in doubt, trust the end.
 *
 * Rules: a line only ever SHRINKS or SPLITS inside its own bounds — never
 * extended, never reordered, never overlapping a neighbour, never shorter than
 * MIN_MS. It runs once, at the end of the speech-to-text step, so it can never
 * touch timing the user edited by hand.
 */
import type { TranscriptSegment, TranscriptWord } from '@videodubber/shared';

export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

export interface AnchorOptions {
  /** Spoken language of the source, to estimate how long a line's text takes to say. */
  sourceLanguage?: string;
  /** The speech map: anchors lines without words and settles doubtful words. */
  regions?: readonly SpeechRegion[];
}

export interface AnchorReport {
  /** Lines whose timing changed (split lines count once). */
  moved: number;
  /** Lines split in two or more at a long pause. */
  split: number;
  /** How far the most-moved line start moved, ms. */
  maxShiftMs: number;
  /** Lines anchored by their word timings / by the speech map. */
  byWords: number;
  bySpeechMap: number;
}

/**
 * The smallest gap this failure creates: faster-whisper cuts silences of
 * >= 2000 ms and pads each side by 400 ms. A real pause this long between two
 * phrases also deserves its own dub line and its own subtitle.
 */
const GAP_MS = 1200;
/** A word moved next to its phrase keeps at most this much of its old span. */
const STRAY_MAX_MS = 400;
/** Never leave a line shorter than this. */
const MIN_MS = 300;
/** Breathing room around the first/last speech. */
const PAD_MS = 100;
/** Changes smaller than this are noise, not a fix. */
const MIN_CHANGE_MS = 300;
/** Under this share of speech (speech map), a word was not spoken where it sits. */
const SPOKEN_SHARE = 0.5;
/** A line with no speech in it is implausible when it outlasts its text by this much (and 3x). */
const IMPLAUSIBLE_EXTRA_MS = 4000;

/** Seconds per unit of text (Chinese/Japanese characters, else words) when spoken. */
const SECONDS_PER_UNIT: Record<string, number> = { zh: 0.25, ja: 0.2 };
const SECONDS_PER_WORD = 0.36;
/** Languages written without spaces between words. */
const UNSPACED = new Set(['zh', 'ja', 'th', 'lo', 'km', 'my', 'yue']);

function baseOf(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}

function textUnits(text: string, language: string): number {
  const t = text.trim();
  if (!t) return 0;
  const base = baseOf(language);
  if (base === 'zh' || base === 'ja') return [...t.replace(/[\s\p{P}]/gu, '')].length;
  return t.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function needMs(text: string, language: string): number {
  return textUnits(text, language) * (SECONDS_PER_UNIT[baseOf(language)] ?? SECONDS_PER_WORD) * 1000;
}

/** Characters a word cluster carries, punctuation and spaces aside. */
function clusterChars(words: readonly TranscriptWord[]): number {
  return [...words.map((w) => w.word).join('').replace(/[\s\p{P}]/gu, '')].length;
}

/** The text of a run of words, spaced the way the engine spaced them. */
function joinWords(words: readonly TranscriptWord[], language: string): string {
  // faster-whisper words carry their own leading space ("Hello", " world").
  if (words.slice(1).some((w) => /^\s/u.test(w.word))) return words.map((w) => w.word).join('').trim();
  return words
    .map((w) => w.word.trim())
    .join(UNSPACED.has(baseOf(language)) ? '' : ' ')
    .trim();
}

/** Does this run of words end a sentence ("Wait.", "走吧！", closing quotes allowed)? */
function endsSentence(words: readonly TranscriptWord[]): boolean {
  return /[.!?。！？…]["'”’」』)）]*$/u.test(words.at(-1)!.word.trim());
}

/** Share of [startMs, endMs] the speech map marks as speech (0..1). */
function speechShare(startMs: number, endMs: number, regions: readonly SpeechRegion[]): number {
  const span = endMs - startMs;
  if (span <= 0) return 0;
  let covered = 0;
  for (const r of regions) {
    if (r.startMs >= endMs) break; // sorted by start
    if (r.endMs <= startMs) continue;
    covered += Math.min(r.endMs, endMs) - Math.max(r.startMs, startMs);
  }
  return covered / span;
}

/** Grow [start,end] to MIN_MS around its middle, never outside [lo, hi]. */
function atLeastMin(start: number, end: number, lo: number, hi: number): [number, number] {
  if (end - start >= MIN_MS) return [start, end];
  if (hi - lo <= MIN_MS) return [lo, hi]; // the original line was this short already
  let s = Math.max(lo, Math.round((start + end) / 2 - MIN_MS / 2));
  let e = s + MIN_MS;
  if (e > hi) {
    e = hi;
    s = hi - MIN_MS;
  }
  return [s, e];
}

/** Re-time words to sit just before `endMs` (or just after `startMs`), keeping them short. */
function placeBefore(words: readonly TranscriptWord[], endMs: number): TranscriptWord[] {
  const span = Math.min(STRAY_MAX_MS, Math.max(1, words.at(-1)!.endMs - words[0]!.startMs));
  return words.map((w, k) => ({
    ...w,
    startMs: Math.round(endMs - span + (k * span) / words.length),
    endMs: Math.round(endMs - span + ((k + 1) * span) / words.length),
  }));
}
function placeAfter(words: readonly TranscriptWord[], startMs: number): TranscriptWord[] {
  const span = Math.min(STRAY_MAX_MS, Math.max(1, words.at(-1)!.endMs - words[0]!.startMs));
  return words.map((w, k) => ({
    ...w,
    startMs: Math.round(startMs + (k * span) / words.length),
    endMs: Math.round(startMs + ((k + 1) * span) / words.length),
  }));
}

/**
 * Split a line's words at long pauses, putting misplaced words back.
 *
 * A misplaced word is the first word after one of faster-whisper's cuts,
 * mapped into the padding before it. Where the speech map is available it
 * decides: no speech under a word means it was not spoken there. Without it,
 * a cluster of one word (or of one or two characters: 狐 of 狐狸) cut off by a
 * long pause is taken as misplaced — the audit found no real exception, while
 * leaving it costs a line voiced up to 46 s early.
 */
function wordClusters(words: TranscriptWord[], regions: readonly SpeechRegion[] | undefined): TranscriptWord[][] {
  const clusters: TranscriptWord[][] = [];
  for (const w of words) {
    const last = clusters.at(-1);
    if (last && w.startMs - last.at(-1)!.endMs < GAP_MS) last.push(w);
    else clusters.push([w]);
  }
  if (clusters.length < 2) return clusters;

  const unspoken = (ws: readonly TranscriptWord[]) =>
    regions !== undefined && speechShare(ws[0]!.startMs, ws.at(-1)!.endMs, regions) < SPOKEN_SHARE;

  // A line that runs across a cut ends its first part with the next part's
  // first word: only the speech map can tell, so only it moves that word.
  if (regions) {
    for (let i = 0; i < clusters.length - 1; i++) {
      const c = clusters[i]!;
      if (c.length > 1 && unspoken([c.at(-1)!])) {
        const next = clusters[i + 1]!;
        clusters[i + 1] = [...placeBefore([c.pop()!], next[0]!.startMs), ...next];
      }
    }
  }

  // One word (or one or two characters) on its own across a long pause:
  //  - not spoken there (or no map to ask): misplaced, so it moves next to its
  //    phrase (the next one when it leads, the previous one when it trails);
  //  - spoken there: real, but a fragment. It gets its own line only where a
  //    sentence ends ("Wait." … "I know you."); a lone 看 cut from 俺怎么看 would
  //    be translated and voiced out of context, so it stays in its line.
  const tiny = (c: readonly TranscriptWord[]) => c.length === 1 || clusterChars(c) <= 2;
  for (let i = 0; i < clusters.length && clusters.length > 1; ) {
    const c = clusters[i]!;
    if (!tiny(c)) {
      i++;
      continue;
    }
    const leads = i < clusters.length - 1;
    const misplaced = regions === undefined || unspoken(c);
    if (!misplaced && endsSentence(leads ? c : clusters[i - 1]!)) {
      i++;
      continue;
    }
    if (leads) {
      const next = clusters[i + 1]!;
      clusters.splice(i, 2, [...(misplaced ? placeBefore(c, next[0]!.startMs) : c), ...next]);
    } else {
      const prev = clusters[i - 1]!;
      clusters.splice(i - 1, 2, [...prev, ...(misplaced ? placeAfter(c, prev.at(-1)!.endMs) : c)]);
      i = Math.max(0, i - 1);
    }
  }
  return clusters;
}

/** For a line without words: the span the speech map says it is spoken in. */
function spanFromRegions(seg: TranscriptSegment, regions: readonly SpeechRegion[], language: string): [number, number] | undefined {
  const inside = regions
    .filter((r) => r.endMs > seg.startMs && r.startMs < seg.endMs)
    .map((r) => ({ startMs: Math.max(r.startMs, seg.startMs), endMs: Math.min(r.endMs, seg.endMs) }));
  if (inside.length === 0) return undefined; // the map heard no speech in this line
  // Runs of speech separated by a long pause; the line's END is trustworthy in
  // both engines' failure mode, so start from the last run and walk back only
  // as far as the text needs.
  const runs: SpeechRegion[][] = [];
  for (const r of inside) {
    const last = runs.at(-1);
    if (last && r.startMs - last.at(-1)!.endMs < GAP_MS) last.push(r);
    else runs.push([r]);
  }
  const need = 0.8 * needMs(seg.sourceText, language);
  let first = runs.length - 1;
  let speech = runs[first]!.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  while (speech < need && first > 0) {
    first--;
    speech += runs[first]!.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  }
  return [runs[first]![0]!.startMs - PAD_MS, runs.at(-1)!.at(-1)!.endMs + PAD_MS];
}

/**
 * Where a line without words is spoken, or undefined to leave it alone.
 *
 * The VAD hears only fragments of speech under loud music: on the two test
 * videos it shrank 25 lines below half a second ("你们真是不懂礼貌" to 0.44 s), too
 * short to read or to voice. So a line never gets shorter than its text takes
 * to say. And a line far longer than its text with no speech found in it at
 * all is a window that opened on music: its end is the evidence left.
 */
function spanWithoutWords(
  seg: TranscriptSegment,
  regions: readonly SpeechRegion[],
  language: string,
): [number, number] | undefined {
  const need = needMs(seg.sourceText, language);
  if (need <= 0) return undefined;
  const span = spanFromRegions(seg, regions, language);
  if (span) return [Math.min(span[0], span[1] - need), span[1]];
  const length = seg.endMs - seg.startMs;
  if (length > Math.max(3 * need, need + IMPLAUSIBLE_EXTRA_MS)) return [seg.endMs - 1.5 * need, seg.endMs];
  return undefined;
}

/** A line's words that lie inside it (an editor timing edit can leave stale ones). */
function wordsInside(seg: TranscriptSegment): TranscriptWord[] {
  return (seg.words ?? []).filter((w) => w.word.trim() && w.endMs > seg.startMs && w.startMs < seg.endMs);
}

/**
 * Would the speech map help? Yes when a line has no word timings, or a long
 * pause inside it (a word next to the pause may be misplaced).
 */
export function needsSpeechMap(segments: readonly TranscriptSegment[]): boolean {
  return segments.some((s) => {
    if (!s.sourceText.trim()) return false;
    const words = wordsInside(s);
    if (words.length === 0) return true;
    return words.some((w, i) => i > 0 && w.startMs - words[i - 1]!.endMs >= GAP_MS);
  });
}

/**
 * Anchor every line to its speech. Returns the new lines (re-numbered, since a
 * split adds lines; nothing downstream of speech-to-text exists yet) and what
 * changed.
 */
export function anchorSegmentsToSpeech(
  segments: readonly TranscriptSegment[],
  opts: AnchorOptions = {},
): { segments: TranscriptSegment[]; report: AnchorReport } {
  const language = opts.sourceLanguage ?? '';
  const regions =
    opts.regions && opts.regions.length > 0 ? [...opts.regions].sort((a, b) => a.startMs - b.startMs) : undefined;
  const report: AnchorReport = { moved: 0, split: 0, maxShiftMs: 0, byWords: 0, bySpeechMap: 0 };
  const out: TranscriptSegment[] = [];

  for (const seg of segments) {
    const lo = seg.startMs;
    const hi = seg.endMs;
    const words = wordsInside(seg);

    let pieces: { startMs: number; endMs: number; words?: TranscriptWord[]; text: string }[] | undefined;
    if (words.length > 0) {
      const clusters = wordClusters(words, regions);
      const lead = clusters[0]![0]!.startMs - lo;
      const trail = hi - clusters.at(-1)!.at(-1)!.endMs;
      const regrouped = clusters.length > 1 || clusters[0]!.some((w, k) => w !== words[k]);
      if (regrouped || lead >= GAP_MS || trail >= GAP_MS) {
        pieces = clusters.map((c) => ({
          startMs: Math.max(lo, c[0]!.startMs - PAD_MS),
          endMs: Math.min(hi, c.at(-1)!.endMs + PAD_MS),
          words: c,
          text: clusters.length > 1 ? joinWords(c, language) : seg.sourceText,
        }));
        report.byWords++;
      }
    } else if (regions) {
      const span = spanWithoutWords(seg, regions, language);
      if (span) {
        const start = Math.max(lo, span[0]);
        const end = Math.min(hi, span[1]);
        if (start - lo >= MIN_CHANGE_MS || hi - end >= MIN_CHANGE_MS) {
          pieces = [{ startMs: start, endMs: end, text: seg.sourceText }];
          report.bySpeechMap++;
        }
      }
    }

    if (!pieces) {
      out.push(seg);
      continue;
    }
    report.moved++;
    if (pieces.length > 1) report.split++;
    report.maxShiftMs = Math.max(report.maxShiftMs, pieces[0]!.startMs - lo);
    let floor = lo;
    for (const p of pieces) {
      const [s, e] = atLeastMin(Math.max(floor, p.startMs), p.endMs, floor, hi);
      floor = e;
      out.push({
        ...seg,
        startMs: s,
        endMs: e,
        sourceText: p.text,
        ...(p.words ? { words: p.words } : {}),
      });
    }
  }

  // Ids are ordinal; a split adds lines, so number them again.
  const renumbered = out.map((s, i) => ({ ...s, index: i, id: `seg_${String(i + 1).padStart(4, '0')}` }));
  return { segments: renumbered, report };
}

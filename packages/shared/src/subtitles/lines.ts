/**
 * Subtitle line-wrapping.
 *
 * Wraps subtitle text into lines of at most `maxCharsPerLine` display columns,
 * without splitting words. What happens when the text needs MORE than
 * `maxLines` lines is the caller's choice ({@link SubtitleOverflowPolicy}):
 *
 *   - `'truncate'` — keep `maxLines` lines and end with an ellipsis. This is a
 *     DISPLAY cap (the editor's "this line is long" warning), never a way to
 *     write a file.
 *   - `'wrap'` — keep every word, using as many lines as the text needs.
 *
 * The distinction exists because the two-line truncation was silently applied
 * to EXPORTED .srt/.vtt files: the default `srt-file` export dropped roughly
 * 45% of a typical Vietnamese cue ("…" mid-sentence) while the dubbed audio
 * spoke the full line, with no warning anywhere. Serialization must never
 * discard text — see srt.ts / vtt.ts, which both wrap.
 *
 * Where the lines break (the subtitle audit of 2026-11-17): a greedy fill left
 * two syllables or fewer on line 2 in 62–89% of two-line Vietnamese cues and cut
 * names in half ("Ngô Chi / Long"), and Chinese text, which has no spaces, was
 * never wrapped at all. So the text is laid out in the fewest lines it needs,
 * balanced, preferring a break after punctuation, never inside a run of
 * capitalised words, with the longer line at the bottom; CJK text may break
 * between characters (never before closing punctuation) and counts double width.
 */

/** Default target characters per line (tuned for Vietnamese readability). */
export const DEFAULT_MAX_CHARS_PER_LINE = 42;
/** Default maximum number of subtitle lines. */
export const DEFAULT_MAX_LINES = 2;

/**
 * What to do with text that does not fit in `maxLines` lines.
 *
 * `'truncate'` loses words and is only ever correct for on-screen display;
 * `'wrap'` keeps all of them and is what every file writer must use.
 */
export type SubtitleOverflowPolicy = 'truncate' | 'wrap';

/** Han, Kana and Hangul: written without spaces, a line may break between them. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** East Asian wide characters (CJK and fullwidth forms) take two columns. */
const WIDE_CHAR =
  /[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{20000}-\u{3FFFD}]/u;
/** Never at the start of a line: closing punctuation and marks that end a word. */
const NO_BREAK_BEFORE = /[,.;:!?…、。，．！？；：）」』】〉》”’)\]}%‰ー々〜～]/u;
/** Never at the end of a line: opening punctuation. */
const NO_BREAK_AFTER = /[（「『【〈《“‘([{]/u;
/** A good place to break: after the end of a clause or sentence. */
const CLAUSE_END = /[,.;:!?…、。，．！？；：]["'”’」』)）]*$/u;
const CAPITALISED = /^["'“‘([«]*\p{Lu}/u;

/** Display columns of a string (CJK counts double). */
export function subtitleTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 2 : 1;
  return width;
}

/** The smallest unit a line may break around; `space` = joined to the previous one by a space. */
interface Atom {
  text: string;
  width: number;
  space: boolean;
}

/** Split one space-free word into breakable pieces (only CJK text has more than one). */
function pieces(word: string): string[] {
  if (!CJK_CHAR.test(word)) return [word];
  const chars = [...word];
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const prev = chars[i - 1];
    const canBreak =
      cur !== '' &&
      prev !== undefined &&
      (CJK_CHAR.test(ch) || CJK_CHAR.test(prev)) &&
      !NO_BREAK_BEFORE.test(ch) &&
      !NO_BREAK_AFTER.test(prev);
    if (canBreak) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function atomsOf(normalized: string): Atom[] {
  const atoms: Atom[] = [];
  for (const word of normalized.split(' ')) {
    pieces(word).forEach((text, k) => atoms.push({ text, width: subtitleTextWidth(text), space: k === 0 && atoms.length > 0 }));
  }
  return atoms;
}

/** Width of atoms [i, j) laid on one line (the space before the first is dropped). */
function lineWidth(atoms: readonly Atom[], i: number, j: number): number {
  let w = 0;
  for (let m = i; m < j; m++) w += atoms[m]!.width + (m > i && atoms[m]!.space ? 1 : 0);
  return w;
}

function lineText(atoms: readonly Atom[], i: number, j: number): string {
  let s = '';
  for (let m = i; m < j; m++) s += (m > i && atoms[m]!.space ? ' ' : '') + atoms[m]!.text;
  return s;
}

/** Greedy fill: the fewest lines the text can take (and the truncation layout). */
function greedyBreaks(atoms: readonly Atom[], maxWidth: number): number[] {
  const starts = [0];
  let width = 0;
  for (let m = 0; m < atoms.length; m++) {
    const a = atoms[m]!;
    const lineStart = starts.at(-1)!;
    const add = m === lineStart ? a.width : a.width + (a.space ? 1 : 0);
    if (m > lineStart && width + add > maxWidth) {
      starts.push(m);
      width = a.width;
    } else {
      width += add;
    }
  }
  return starts;
}

/**
 * The best layout of `atoms` in exactly `count` lines: balanced, breaking after
 * punctuation where it can, never inside a run of capitalised words when it can
 * help it, and with the longer line at the bottom.
 */
function balancedBreaks(atoms: readonly Atom[], maxWidth: number, count: number): number[] | undefined {
  const n = atoms.length;
  const target = lineWidth(atoms, 0, n) / count;
  const unit = (0.3 * target) ** 2; // the cost of a line 30% off balance
  const breakCost = (j: number): number => {
    const prev = atoms[j - 1]!;
    const next = atoms[j]!;
    let cost = 0;
    if (CLAUSE_END.test(prev.text)) cost -= 2 * unit;
    if (next.space && CAPITALISED.test(prev.text) && CAPITALISED.test(next.text)) cost += 4 * unit;
    return cost;
  };
  const lineCost = (i: number, j: number, last: boolean): number => {
    const w = lineWidth(atoms, i, j);
    if (w > maxWidth && j - i > 1) return Number.POSITIVE_INFINITY;
    let cost = (w - target) ** 2;
    if (!last && w > target) cost += 0.5 * (w - target) ** 2; // bottom-heavy
    return last ? cost : cost + breakCost(j);
  };

  // best[l][j]: cheapest way to lay atoms [0, j) in l lines.
  const best: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
  const from: number[][] = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let l = 1; l <= count; l++) {
    for (let j = l; j <= n; j++) {
      for (let i = l - 1; i < j; i++) {
        const prior = best[l - 1]![i]!;
        if (!Number.isFinite(prior)) continue;
        const c = prior + lineCost(i, j, l === count);
        if (c < best[l]![j]!) {
          best[l]![j] = c;
          from[l]![j] = i;
        }
      }
    }
  }
  if (!Number.isFinite(best[count]![n]!)) return undefined;
  const starts: number[] = [];
  for (let l = count, j = n; l > 0; l--) {
    const i = from[l]![j]!;
    starts.unshift(i);
    j = i;
  }
  return starts;
}

function linesFrom(atoms: readonly Atom[], starts: readonly number[]): string[] {
  return starts.map((s, k) => lineText(atoms, s, starts[k + 1] ?? atoms.length));
}

/**
 * Word-wrap subtitle `text` into lines of at most `maxCharsPerLine` columns.
 *
 * Rules:
 *  - Collapses runs of whitespace to single spaces.
 *  - Uses the fewest lines the text needs, balanced (see the module comment).
 *  - Never splits a word across lines (a word longer than the limit occupies
 *    its own line as-is); CJK text breaks between characters.
 *  - With `overflow: 'truncate'` (the default, for DISPLAY), content past
 *    `maxLines` is dropped and the last line ends in an ellipsis (`…`).
 *  - With `overflow: 'wrap'`, `maxLines` is ignored and every word is kept.
 *
 * @param text            The text to wrap.
 * @param maxCharsPerLine Target max columns per line (default 42; CJK counts 2).
 * @param maxLines        Max number of lines (default 2); ignored when wrapping.
 * @param overflow        Overflow policy (default `'truncate'`).
 * @returns An array of line strings.
 */
export function splitSubtitleLines(
  text: string,
  maxCharsPerLine: number = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: number = DEFAULT_MAX_LINES,
  overflow: SubtitleOverflowPolicy = 'truncate',
): string[] {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];

  const maxWidth = Math.max(1, Math.floor(maxCharsPerLine));
  const atoms = atomsOf(normalized);
  const greedy = greedyBreaks(atoms, maxWidth);
  const fits = overflow === 'wrap' || greedy.length <= Math.max(1, Math.floor(maxLines));
  if (fits) {
    const starts = greedy.length === 1 ? greedy : (balancedBreaks(atoms, maxWidth, greedy.length) ?? greedy);
    return linesFrom(atoms, starts);
  }

  // Truncate (display only): the first maxLines greedy lines, the last one
  // ending in an ellipsis within the budget, keeping whole words.
  const limit = Math.max(1, Math.floor(maxLines));
  const lines = linesFrom(atoms, greedy).slice(0, limit);
  const ellipsis = '…';
  const lastStart = greedy[limit - 1]!;
  let end = greedy[limit]!;
  let last = lineText(atoms, lastStart, end);
  while (subtitleTextWidth(last) + 1 > maxWidth && end - lastStart > 1) {
    end--;
    last = lineText(atoms, lastStart, end);
  }
  if (subtitleTextWidth(last) + 1 > maxWidth) {
    // A single long word: hard-truncate it to fit the ellipsis.
    let cut = '';
    for (const ch of last) {
      if (subtitleTextWidth(cut + ch) + 1 > maxWidth) break;
      cut += ch;
    }
    last = cut;
  }
  lines[limit - 1] = last + ellipsis;
  return lines;
}

/**
 * Convenience wrapper that joins {@link splitSubtitleLines} with `\n`.
 *
 * @returns A single string: at most `maxLines` lines when truncating, as many
 *          as the text needs when wrapping.
 */
export function wrapSubtitleText(
  text: string,
  maxCharsPerLine: number = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: number = DEFAULT_MAX_LINES,
  overflow: SubtitleOverflowPolicy = 'truncate',
): string {
  return splitSubtitleLines(text, maxCharsPerLine, maxLines, overflow).join('\n');
}

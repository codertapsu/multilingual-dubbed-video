/**
 * Subtitle line-wrapping.
 *
 * Wraps subtitle text into lines of at most `maxCharsPerLine` characters,
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

/**
 * Word-wrap subtitle `text` into lines of at most `maxCharsPerLine` characters.
 *
 * Rules:
 *  - Collapses runs of whitespace to single spaces.
 *  - Never splits a word across lines (words longer than the limit occupy
 *    their own line as-is).
 *  - With `overflow: 'truncate'` (the default, for DISPLAY), content past
 *    `maxLines` is dropped and the last line ends in an ellipsis (`…`).
 *  - With `overflow: 'wrap'`, `maxLines` is ignored and every word is kept.
 *
 * @param text            The text to wrap.
 * @param maxCharsPerLine Target max characters per line (default 42).
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

  const safeMaxChars = Math.max(1, Math.floor(maxCharsPerLine));
  // 'wrap' keeps every word, so there is no line ceiling to break out at.
  const safeMaxLines = overflow === 'wrap' ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(maxLines));

  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= safeMaxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
      if (lines.length >= safeMaxLines) {
        // We've already filled all lines; the remaining words overflow.
        break;
      }
    }
  }

  // Push the trailing line if there's room.
  if (current !== '' && lines.length < safeMaxLines) {
    lines.push(current);
  }

  // Determine whether content was dropped (overflow beyond maxLines).
  const consumed = lines.join(' ');
  const overflowed = consumed.replace(/\s+/g, ' ').trim() !== normalized;

  if (overflowed && lines.length > 0) {
    // Truncate the last line so we can fit an ellipsis within the budget,
    // keeping whole words intact.
    const ellipsis = '…';
    let last = lines[lines.length - 1] as string;
    // If appending the ellipsis would exceed the budget, drop trailing words.
    while (last.length + ellipsis.length > safeMaxChars && last.includes(' ')) {
      last = last.slice(0, last.lastIndexOf(' '));
    }
    if (last.length + ellipsis.length > safeMaxChars) {
      // Single long word case: hard truncate to fit the ellipsis.
      last = last.slice(0, Math.max(0, safeMaxChars - ellipsis.length));
    }
    lines[lines.length - 1] = last + ellipsis;
  }

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

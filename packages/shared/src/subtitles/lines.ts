/**
 * Subtitle line-wrapping.
 *
 * Wraps subtitle text into at most `maxLines` lines, each targeting at most
 * `maxCharsPerLine` characters, without splitting words. If the text cannot
 * fit, it is truncated gracefully (whole words kept) with a trailing ellipsis
 * on the final line.
 */

/** Default target characters per line (tuned for Vietnamese readability). */
export const DEFAULT_MAX_CHARS_PER_LINE = 42;
/** Default maximum number of subtitle lines. */
export const DEFAULT_MAX_LINES = 2;

/**
 * Word-wrap subtitle `text` into at most `maxLines` lines of at most
 * `maxCharsPerLine` characters each.
 *
 * Rules:
 *  - Collapses runs of whitespace to single spaces.
 *  - Never splits a word across lines (words longer than the limit occupy
 *    their own line as-is).
 *  - If the content overflows `maxLines`, truncates whole words and appends an
 *    ellipsis (`…`) to the last line, keeping the line within the char budget.
 *
 * @param text            The text to wrap.
 * @param maxCharsPerLine Target max characters per line (default 42).
 * @param maxLines        Max number of lines (default 2).
 * @returns An array of 0..maxLines line strings.
 */
export function splitSubtitleLines(
  text: string,
  maxCharsPerLine: number = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: number = DEFAULT_MAX_LINES,
): string[] {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];

  const safeMaxChars = Math.max(1, Math.floor(maxCharsPerLine));
  const safeMaxLines = Math.max(1, Math.floor(maxLines));

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
 * @returns A single string with at most `maxLines` lines.
 */
export function wrapSubtitleText(
  text: string,
  maxCharsPerLine: number = DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: number = DEFAULT_MAX_LINES,
): string {
  return splitSubtitleLines(text, maxCharsPerLine, maxLines).join('\n');
}

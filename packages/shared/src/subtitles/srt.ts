/**
 * SubRip (.srt) serialization.
 */

import { splitSubtitleLines, DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES } from './lines.js';
import { toSrtTimestamp } from './timestamps.js';

/** A subtitle input segment for the SRT/VTT writers. */
export interface SubtitleSegmentInput {
  /** Optional explicit 1-based cue index (auto-assigned if omitted). */
  index?: number;
  /** Cue start time in integer milliseconds. */
  startMs: number;
  /** Cue end time in integer milliseconds. */
  endMs: number;
  /** Cue text (may already contain newlines). */
  text: string;
}

/** Options controlling SRT/VTT generation. */
export interface SubtitleWriteOptions {
  /**
   * When true (default), each cue's text is word-wrapped via
   * `splitSubtitleLines`. When false, the text is emitted verbatim (only
   * trimmed), preserving any existing newlines.
   */
  wrap?: boolean;
  /** Max characters per line when wrapping (default 42). */
  maxCharsPerLine?: number;
  /** Max lines per cue when wrapping (default 2). */
  maxLines?: number;
}

/** End-of-line for subtitle files (CRLF maximizes player compatibility). */
const EOL = '\r\n';

/**
 * Prepare a cue's display text: either word-wrapped or passed through.
 * Returns an array of physical lines.
 */
function renderLines(text: string, opts: Required<SubtitleWriteOptions>): string[] {
  if (opts.wrap) {
    return splitSubtitleLines(text, opts.maxCharsPerLine, opts.maxLines);
  }
  const trimmed = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (trimmed === '') return [];
  return trimmed.split('\n');
}

function resolveOptions(opts?: SubtitleWriteOptions): Required<SubtitleWriteOptions> {
  return {
    wrap: opts?.wrap ?? true,
    maxCharsPerLine: opts?.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE,
    maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
  };
}

/**
 * Serialize subtitle segments to a SubRip (.srt) document.
 *
 * Cue indices are 1-based and sequential (an explicit `index` is honored if
 * provided, otherwise auto-assigned). Each cue block is separated by a blank
 * line; the document ends with a trailing newline.
 *
 * @param segments Ordered subtitle segments.
 * @param opts     Wrapping options.
 * @returns The SRT document as a string.
 */
export function segmentsToSrt(
  segments: SubtitleSegmentInput[],
  opts?: SubtitleWriteOptions,
): string {
  const options = resolveOptions(opts);
  const blocks: string[] = [];
  let autoIndex = 1;

  for (const seg of segments) {
    const lines = renderLines(seg.text, options);
    if (lines.length === 0) continue;
    const index = seg.index ?? autoIndex;
    autoIndex = index + 1;
    const timing = `${toSrtTimestamp(seg.startMs)} --> ${toSrtTimestamp(seg.endMs)}`;
    const block = [String(index), timing, ...lines].join(EOL);
    blocks.push(block);
  }

  if (blocks.length === 0) return '';
  // Blank line between cues, plus a trailing newline at EOF.
  return blocks.join(EOL + EOL) + EOL;
}

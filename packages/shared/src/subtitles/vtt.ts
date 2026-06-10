/**
 * WebVTT (.vtt) serialization.
 */

import { splitSubtitleLines } from './lines.js';
import { toVttTimestamp } from './timestamps.js';
import type { SubtitleSegmentInput, SubtitleWriteOptions } from './srt.js';
import { DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES } from './lines.js';

/** End-of-line for subtitle files. */
const EOL = '\n';

function renderLines(
  text: string,
  opts: Required<SubtitleWriteOptions>,
): string[] {
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
 * Serialize subtitle segments to a WebVTT (.vtt) document.
 *
 * The document always begins with the `WEBVTT` header followed by a blank
 * line. Cue timestamps use a dot before the millisecond field. Cue identifiers
 * (the numeric index line) are included for readability/compatibility.
 *
 * @param segments Ordered subtitle segments.
 * @param opts     Wrapping options.
 * @returns The WebVTT document as a string.
 */
export function segmentsToVtt(
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
    const timing = `${toVttTimestamp(seg.startMs)} --> ${toVttTimestamp(seg.endMs)}`;
    const block = [String(index), timing, ...lines].join(EOL);
    blocks.push(block);
  }

  const header = 'WEBVTT';
  if (blocks.length === 0) {
    // A valid, empty WebVTT file is just the header.
    return header + EOL;
  }
  return header + EOL + EOL + blocks.join(EOL + EOL) + EOL;
}

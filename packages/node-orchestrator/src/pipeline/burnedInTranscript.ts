/**
 * The video's own burned-in subtitles as its transcript
 * (settings.useBurnedInSubtitles).
 *
 * The subtitle check already knows when each subtitle is on screen
 * (subtitleCoverage.ts, from the media worker's presence scan). One frame
 * inside each is cut from the band (media-worker readBandFrames) and read as
 * text by the subtitle reader (the ocr-rapid pack, providers/ocr/); each
 * subtitle becomes a line, timed by when it shows. The subtitles are the
 * script: 《反相之地》's speech-to-text heard 反向之地 where every file name and
 * subtitle says 反相之地, and lost ~780 lines its subtitles showed
 * (claude-dubber, 2026-11-25). Pure.
 */
import type { TranscriptSegment } from '@videodubber/shared';
import { padSegmentIndex } from '../workspace/paths.js';
import type { SubtitleSpan } from './subtitleCoverage.js';

/** Fewer subtitles on screen (or read) than this: the band is not the dialogue's, speech-to-text runs. */
export const MIN_SUBTITLES = 10;
/** A read this unsure is no line: the band showed something that is not a subtitle (a sign, scenery). */
export const MIN_READ_CONFIDENCE = 0.6;
/** At least this share of the subtitles must be readable, or speech-to-text runs. */
export const MIN_READ_SHARE = 0.3;
/** Two subtitles in a row that say the same this close together are one line (a flicker split it). */
const SAME_LINE_GAP_MS = 600;

/**
 * Where in a subtitle its frame is read: 40 % in, away from a fade at either
 * edge, and at least a frame (200 ms) from each edge when it is long enough.
 * Pure.
 */
export function readingTimeOf(e: SubtitleSpan): number {
  const len = Math.max(0, e.endMs - e.startMs);
  return Math.round(e.startMs + Math.max(Math.min(200, len / 2), Math.min(0.4 * len, len - 200)));
}

/** Text as compared: width, spaces and punctuation aside ("快 快跑！" is "快快跑!"). */
const comparable = (text: string): string => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');

/** What reading the subtitles gave. */
export interface BurnedInLines {
  lines: TranscriptSegment[];
  /** Subtitles that read as text. */
  read: number;
  /** Subtitles that did not (no text, too unsure). */
  unreadable: number;
  /** Repeats of the subtitle before joined into its line. */
  merged: number;
}

/**
 * The lines the subtitles make: `reads[i]` is what subtitle `events[i]` says
 * (undefined: not read). Unreadable ones are left out; a subtitle saying what
 * the one before it said, right after it, extends that line. Pure.
 */
export function linesFromSubtitles(
  events: readonly SubtitleSpan[],
  reads: readonly ({ text: string; confidence: number } | undefined)[],
  opts: { minConfidence?: number } = {},
): BurnedInLines {
  const min = opts.minConfidence ?? MIN_READ_CONFIDENCE;
  const out: { startMs: number; endMs: number; text: string }[] = [];
  let read = 0;
  let unreadable = 0;
  let merged = 0;
  events.forEach((e, i) => {
    const r = reads[i];
    const text = (r?.text ?? '').replace(/\s+/gu, ' ').trim();
    if (!r || r.confidence < min || comparable(text) === '') {
      unreadable += 1;
      return;
    }
    read += 1;
    const last = out[out.length - 1];
    if (last && e.startMs - last.endMs <= SAME_LINE_GAP_MS && comparable(last.text) === comparable(text)) {
      last.endMs = Math.max(last.endMs, e.endMs);
      merged += 1;
      return;
    }
    out.push({ startMs: e.startMs, endMs: e.endMs, text });
  });
  const lines: TranscriptSegment[] = out.map((l, k) => ({
    id: `seg_${padSegmentIndex(k + 1)}`,
    index: k,
    startMs: l.startMs,
    endMs: l.endMs,
    sourceText: l.text,
  }));
  return { lines, read, unreadable, merged };
}

/** Whether what was read is enough to be the transcript (else speech-to-text runs). Pure. */
export function enoughRead(result: Pick<BurnedInLines, 'lines'>, subtitles: number): boolean {
  return result.lines.length >= Math.max(MIN_SUBTITLES, MIN_READ_SHARE * subtitles);
}

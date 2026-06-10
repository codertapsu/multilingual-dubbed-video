/**
 * Subtitle cue type and adapters from transcript segments.
 */

import type { TranscriptSegment } from '../models/domain.js';

/** A minimal timed subtitle cue. Timestamps are integer milliseconds. */
export interface SubtitleCue {
  /** Cue start time in ms. */
  startMs: number;
  /** Cue end time in ms. */
  endMs: number;
  /** Cue text (single string; may contain newlines). */
  text: string;
}

/** Optional index alias used by the SRT/VTT writers. */
export interface IndexedCue extends SubtitleCue {
  /** 1-based display index (optional). */
  index?: number;
}

/**
 * Convert transcript segments to subtitle cues.
 *
 * For each segment, the cue text is `translatedText` when present and
 * non-empty, otherwise `sourceText`. Segments whose chosen text is empty are
 * skipped.
 *
 * @param segments Ordered transcript segments.
 * @returns Cues in segment order, each carrying the segment `index + 1`.
 */
export function transcriptSegmentsToCues(segments: TranscriptSegment[]): IndexedCue[] {
  const cues: IndexedCue[] = [];
  for (const seg of segments) {
    const translated = (seg.translatedText ?? '').trim();
    const source = (seg.sourceText ?? '').trim();
    const text = translated !== '' ? translated : source;
    if (text === '') continue;
    cues.push({
      index: seg.index + 1,
      startMs: seg.startMs,
      endMs: seg.endMs,
      text,
    });
  }
  return cues;
}

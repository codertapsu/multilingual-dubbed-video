import { describe, it, expect } from 'vitest';
import { transcriptSegmentsToCues } from './cues.js';
import type { TranscriptSegment } from '../models/domain.js';

function seg(partial: Partial<TranscriptSegment> & { index: number }): TranscriptSegment {
  return {
    id: `seg_${String(partial.index + 1).padStart(4, '0')}`,
    index: partial.index,
    startMs: partial.startMs ?? partial.index * 1000,
    endMs: partial.endMs ?? partial.index * 1000 + 900,
    sourceText: partial.sourceText ?? '',
    translatedText: partial.translatedText,
  };
}

describe('transcriptSegmentsToCues', () => {
  it('prefers translatedText when present', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'Hello', translatedText: 'Xin chào' }),
    ]);
    expect(cues[0]?.text).toBe('Xin chào');
  });

  it('falls back to sourceText when translatedText is absent', () => {
    const cues = transcriptSegmentsToCues([seg({ index: 0, sourceText: 'Hello' })]);
    expect(cues[0]?.text).toBe('Hello');
  });

  it('falls back to sourceText when translatedText is empty/whitespace', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'Hello', translatedText: '   ' }),
    ]);
    expect(cues[0]?.text).toBe('Hello');
  });

  it('assigns a 1-based index from the segment index', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'A' }),
      seg({ index: 1, sourceText: 'B' }),
    ]);
    expect(cues[0]?.index).toBe(1);
    expect(cues[1]?.index).toBe(2);
  });

  it('skips segments with no usable text', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: '' }),
      seg({ index: 1, sourceText: 'Keep me' }),
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Keep me');
  });

  it('preserves timing', () => {
    const cues = transcriptSegmentsToCues([
      seg({ index: 0, sourceText: 'A', startMs: 100, endMs: 200 }),
    ]);
    expect(cues[0]?.startMs).toBe(100);
    expect(cues[0]?.endMs).toBe(200);
  });
});

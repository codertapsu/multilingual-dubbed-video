import { describe, it, expect } from 'vitest';
import { segmentsToSrt } from './srt.js';

describe('segmentsToSrt', () => {
  const segments = [
    { startMs: 0, endMs: 1500, text: 'Hello' },
    { startMs: 1500, endMs: 3000, text: 'World' },
  ];

  it('produces sequential 1-based indices', () => {
    const srt = segmentsToSrt(segments);
    const lines = srt.split(/\r?\n/);
    expect(lines[0]).toBe('1');
    // find the second index line
    expect(srt).toContain('\r\n2\r\n');
  });

  it('uses SRT timing arrows with comma timestamps', () => {
    const srt = segmentsToSrt(segments);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,500');
    expect(srt).toContain('00:00:01,500 --> 00:00:03,000');
  });

  it('separates cues with a blank line', () => {
    const srt = segmentsToSrt(segments);
    // CRLF EOL; blank line between cues
    expect(srt).toContain('\r\n\r\n');
  });

  it('ends with a trailing newline', () => {
    const srt = segmentsToSrt(segments);
    expect(srt.endsWith('\r\n')).toBe(true);
  });

  it('honors explicit indices when provided', () => {
    const srt = segmentsToSrt([
      { index: 5, startMs: 0, endMs: 1000, text: 'A' },
      { startMs: 1000, endMs: 2000, text: 'B' },
    ]);
    const lines = srt.split(/\r?\n/);
    expect(lines[0]).toBe('5');
    // next auto index should follow the explicit one
    expect(srt).toContain('\r\n6\r\n');
  });

  it('skips empty-text segments', () => {
    const srt = segmentsToSrt([
      { startMs: 0, endMs: 1000, text: '   ' },
      { startMs: 1000, endMs: 2000, text: 'Real' },
    ]);
    expect(srt).toContain('Real');
    expect(srt.startsWith('1')).toBe(true);
  });

  it('returns empty string for no usable segments', () => {
    expect(segmentsToSrt([])).toBe('');
    expect(segmentsToSrt([{ startMs: 0, endMs: 1, text: '' }])).toBe('');
  });

  it('word-wraps long text to the char budget WITHOUT losing any of it', () => {
    // Regression: the writer used to truncate at 2 lines and append an ellipsis,
    // so the default `srt-file` export shipped cues that stopped mid-sentence
    // while the dub spoke the whole line. A file must never drop text.
    const text =
      'This is a very long subtitle line that definitely should be wrapped across two lines for readability';
    const srt = segmentsToSrt([{ startMs: 0, endMs: 4000, text }]);
    const block = srt.trim().split(/\r?\n/);
    const textLines = block.slice(2); // skip index + timing
    expect(textLines.length).toBeGreaterThan(2);
    expect(textLines.join(' ')).toBe(text);
    expect(srt).not.toContain('…');
    for (const line of textLines) expect(line.length).toBeLessThanOrEqual(42);
  });

  it('keeps every word of a long Vietnamese cue', () => {
    const vi =
      'Trong video hôm nay chúng ta sẽ cùng nhau tìm hiểu về cách mà các mô hình ngôn ngữ lớn hoạt động và tại sao chúng lại quan trọng đến vậy.';
    const srt = segmentsToSrt([{ startMs: 0, endMs: 6000, text: vi }]);
    const textLines = srt.trim().split(/\r?\n/).slice(2);
    expect(textLines.join(' ')).toBe(vi);
  });

  it('still truncates when the caller explicitly asks for a display cap', () => {
    const srt = segmentsToSrt(
      [{ startMs: 0, endMs: 4000, text: 'one two three four five six seven eight nine ten eleven twelve' }],
      { overflow: 'truncate', maxCharsPerLine: 10, maxLines: 2 },
    );
    expect(srt).toContain('…');
  });

  it('emits multiple physical lines verbatim when wrap=false', () => {
    const srt = segmentsToSrt(
      [{ startMs: 0, endMs: 1000, text: 'Line one\nLine two' }],
      { wrap: false },
    );
    expect(srt).toContain('Line one\r\nLine two');
  });
});

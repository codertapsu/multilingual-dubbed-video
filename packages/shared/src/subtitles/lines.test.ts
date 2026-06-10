import { describe, it, expect } from 'vitest';
import { splitSubtitleLines, wrapSubtitleText } from './lines.js';

describe('splitSubtitleLines', () => {
  it('returns empty array for empty / whitespace input', () => {
    expect(splitSubtitleLines('')).toEqual([]);
    expect(splitSubtitleLines('   ')).toEqual([]);
  });

  it('keeps short text on a single line', () => {
    expect(splitSubtitleLines('Hello world')).toEqual(['Hello world']);
  });

  it('collapses internal whitespace', () => {
    expect(splitSubtitleLines('Hello    world')).toEqual(['Hello world']);
  });

  it('wraps into at most 2 lines by default', () => {
    const text =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly';
    const lines = splitSubtitleLines(text);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('never exceeds maxLines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const lines = splitSubtitleLines(text, 10, 2);
    expect(lines.length).toBe(2);
  });

  it('does not split words across lines', () => {
    const text = 'antidisestablishmentarianism wonderful';
    const lines = splitSubtitleLines(text, 20, 2);
    for (const line of lines) {
      // each token in a line must be a whole word from the input
      for (const tok of line.replace('…', '').split(' ')) {
        if (tok === '') continue;
        expect(text.includes(tok)).toBe(true);
      }
    }
  });

  it('wraps long Vietnamese text to <= 2 lines, ~42 chars each, word-safe', () => {
    const vi =
      'Xin chào các bạn, hôm nay chúng ta sẽ cùng nhau tìm hiểu về cách lồng tiếng video một cách tự động và hiệu quả nhất';
    const lines = splitSubtitleLines(vi, 42, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(42);
    }
    // word safety: every non-ellipsis word appears in the original text
    for (const line of lines) {
      for (const tok of line.replace('…', '').trim().split(' ')) {
        if (tok === '') continue;
        expect(vi).toContain(tok);
      }
    }
  });

  it('appends an ellipsis when content overflows maxLines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const lines = splitSubtitleLines(text, 10, 2);
    expect(lines[lines.length - 1]).toContain('…');
  });

  it('does not add an ellipsis when everything fits', () => {
    const lines = splitSubtitleLines('short enough text', 42, 2);
    expect(lines.join(' ')).not.toContain('…');
  });

  it('keeps the ellipsis line within the char budget', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj';
    const lines = splitSubtitleLines(text, 12, 2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it('handles a single word longer than the line budget', () => {
    const lines = splitSubtitleLines('supercalifragilisticexpialidocious', 10, 2);
    expect(lines.length).toBe(1);
    // It occupies its own line (possibly hard-truncated only if overflow).
    expect(lines[0]).toBeDefined();
  });

  it('respects custom maxLines greater than 2', () => {
    const text = 'a b c d e f g h i j k l m n o p';
    const lines = splitSubtitleLines(text, 3, 4);
    expect(lines.length).toBe(4);
  });
});

describe('wrapSubtitleText', () => {
  it('joins wrapped lines with newlines', () => {
    const text = 'one two three four five six seven eight nine ten';
    const wrapped = wrapSubtitleText(text, 12, 2);
    expect(wrapped.split('\n').length).toBeLessThanOrEqual(2);
  });
});

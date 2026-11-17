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

  it("overflow:'wrap' keeps every word and ignores maxLines", () => {
    // The export path uses this policy: dropping words from a written subtitle
    // file is never acceptable (the dub speaks the full line).
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const lines = splitSubtitleLines(text, 10, 2, 'wrap');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe(text);
    expect(lines.join(' ')).not.toContain('…');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
  });

  it("overflow:'wrap' keeps a word longer than the budget on its own line", () => {
    const lines = splitSubtitleLines('supercalifragilisticexpialidocious tiny', 10, 2, 'wrap');
    expect(lines).toEqual(['supercalifragilisticexpialidocious', 'tiny']);
  });

  it('respects custom maxLines greater than 2', () => {
    const text = 'a b c d e f g h i j k l m n o p';
    const lines = splitSubtitleLines(text, 3, 4);
    expect(lines.length).toBe(4);
  });
});

describe('splitSubtitleLines: where lines break', () => {
  it('balances two lines instead of leaving a word or two on the second (the greedy fill did, in 62-89% of cues)', () => {
    const vi = 'Ngươi tưởng chỉ dựa vào chút pháp lực ấy mà có thể ngăn được ta sao?';
    const [top, bottom] = splitSubtitleLines(vi, 42, 2);
    expect(top!.length).toBeGreaterThan(20);
    expect(bottom!.split(' ').length).toBeGreaterThan(3);
    expect(Math.abs(top!.length - bottom!.length)).toBeLessThan(12);
    expect(`${top} ${bottom}`).toBe(vi);
  });

  it('prefers to break after punctuation near the middle, but not at the cost of a lopsided pair', () => {
    expect(splitSubtitleLines('Nếu ngươi còn dám quay lại, ta sẽ không tha cho ngươi nữa đâu', 42, 2)).toEqual([
      'Nếu ngươi còn dám quay lại,',
      'ta sẽ không tha cho ngươi nữa đâu',
    ]);
    // "Sư phụ," alone on top would leave 37 columns below.
    expect(splitSubtitleLines('Sư phụ, con đã trở về từ núi Côn Luân rồi đây', 42, 2)).toEqual([
      'Sư phụ, con đã trở về',
      'từ núi Côn Luân rồi đây',
    ]);
  });

  it('does not cut a name in half', () => {
    const lines = splitSubtitleLines('Kẻ đứng sau tất cả chuyện này chính là Ngô Chi Long', 42, 2);
    expect(lines.some((l) => l.includes('Ngô Chi Long'))).toBe(true);
  });

  it('puts the longer line at the bottom when the balance is otherwise equal', () => {
    const [top, bottom] = splitSubtitleLines('aaaa bbbb cccc dddd eeee ffff ggg', 20, 2);
    expect(top!.length).toBeLessThanOrEqual(bottom!.length);
  });

  it('wraps Chinese, which has no spaces, at double width and never before closing punctuation', () => {
    const zh = '我们已经退出青丘地界了，你们还想要怎么样呢？';
    const lines = splitSubtitleLines(zh, 42, 2);
    expect(lines).toEqual(['我们已经退出青丘地界了，', '你们还想要怎么样呢？']);
    // A longer line with no punctuation near the middle still never starts with a mark.
    const long = '我们已经按照约定退出青丘地界了，你们还想怎么样？';
    const split = splitSubtitleLines(long, 42, 2);
    expect(split.join('')).toBe(long);
    for (const l of split) {
      expect([...l].length).toBeLessThanOrEqual(21);
      expect(l).not.toMatch(/^[，。！？]/u);
    }
  });
});

describe('wrapSubtitleText', () => {
  it('joins wrapped lines with newlines', () => {
    const text = 'one two three four five six seven eight nine ten';
    const wrapped = wrapSubtitleText(text, 12, 2);
    expect(wrapped.split('\n').length).toBeLessThanOrEqual(2);
  });
});

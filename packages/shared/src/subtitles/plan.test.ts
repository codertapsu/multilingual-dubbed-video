import { describe, expect, it } from 'vitest';
import { planDisplayCues, type DisplayCueInput } from './plan.js';

const cue = (startMs: number, endMs: number, text: string, extra: Partial<DisplayCueInput> = {}): DisplayCueInput => ({
  startMs,
  endMs,
  text,
  ...extra,
});
const times = (cues: { startMs: number; endMs: number }[]) => cues.map((c) => [c.startMs, c.endMs]);

describe('planDisplayCues', () => {
  it('holds a fast cue into the following gap until it can be read (17 cps, 1 s minimum)', () => {
    const out = planDisplayCues([
      cue(0, 400, 'Còn ai nữa?'), // 11 columns: 1 s minimum
      cue(5000, 6000, 'Ta là người cuối cùng của tộc Hồ ở Thanh Khâu'), // 45 columns: ~2.65 s
      cue(7000, 9000, 'Đi thôi.'),
    ]);
    expect(times(out)).toEqual([
      [0, 1000],
      [5000, 7000], // held only up to the next cue
      [7000, 9000],
    ]);
    expect(out.map((c) => c.index)).toEqual([1, 2, 3]);
  });

  it('keeps a cue up until its dub voice has finished', () => {
    const [first] = planDisplayCues([cue(0, 1500, 'Ngươi dám!', { voiceEndMs: 2300 }), cue(4000, 5000, 'Dám chứ.')]);
    expect(times([first!])).toEqual([[0, 2300]]);
  });

  it('sorts cues that voice re-timing reordered, and merges one an overlap would squeeze', () => {
    // The audit's case: #86 starts after #87 and overlaps it; #87 showed for 245 ms.
    const out = planDisplayCues([
      cue(284_085, 286_000, 'Vậy thì sao?'),
      cue(283_840, 284_085 + 640, 'Còn ai nữa?'),
    ]);
    expect(out.map((c) => c.text)).toEqual(['Còn ai nữa? Vậy thì sao?']);
    expect(times(out)).toEqual([[283_840, 286_000]]);
  });

  it('ends a cue where the next begins when the overlap leaves enough of it', () => {
    const out = planDisplayCues([cue(0, 3000, 'Một hai ba bốn'), cue(2000, 4000, 'năm sáu')]);
    expect(times(out)).toEqual([
      [0, 2000],
      [2000, 4000],
    ]);
  });

  it('merges a still-too-fast cue with the next line of its synthesis group when they fit together', () => {
    const out = planDisplayCues([
      cue(1000, 1400, 'Sư phụ,', { groupId: 'g1' }),
      cue(1400, 2600, 'con đã về rồi đây.', { groupId: 'g1' }),
      cue(2600, 3600, 'Về là tốt.', { groupId: 'g2' }),
    ]);
    expect(out.map((c) => c.text)).toEqual(['Sư phụ, con đã về rồi đây.', 'Về là tốt.']);
    expect(times(out)).toEqual([
      [1000, 2600],
      [2600, 3600],
    ]);
  });

  it('never merges across synthesis groups, or beyond two lines of text', () => {
    const long = 'Ngươi tưởng rằng chỉ dựa vào chút pháp lực nhỏ nhoi ấy mà có thể ngăn được bổn tọa sao';
    expect(`Ngươi ${long}`.length).toBeGreaterThan(84); // more than two 42-column lines together
    const out = planDisplayCues([
      cue(0, 500, 'Hừ!', { groupId: 'a' }),
      cue(500, 2000, 'Đi.', { groupId: 'b' }),
      cue(3000, 3500, 'Ngươi', { groupId: 'c' }),
      cue(3500, 6000, long, { groupId: 'c' }),
    ]);
    expect(out.map((c) => c.text)).toEqual(['Hừ!', 'Đi.', 'Ngươi', long]);
  });

  it('caps a cue at 7 s unless reading it or its voice takes longer, and closes flicker gaps', () => {
    const out = planDisplayCues([
      cue(0, 99_000, 'Trương Tam Thế.'), // the audit's 99 s cue
      cue(100_000, 101_000, 'A'),
      cue(101_050, 102_500, 'B'), // a 50 ms gap only flickers
    ]);
    expect(times(out)).toEqual([
      [0, 7000],
      [100_000, 101_050],
      [101_050, 102_500],
    ]);
  });

  it('counts CJK as two columns and joins merged CJK text without a space', () => {
    const out = planDisplayCues([
      cue(0, 300, '你好', { groupId: 'g' }),
      cue(300, 900, '我们走吧', { groupId: 'g' }),
    ]);
    expect(out.map((c) => c.text)).toEqual(['你好我们走吧']);
    expect(times(out)).toEqual([[0, 1000]]);
  });

  it('drops empty cues and keeps every word', () => {
    const out = planDisplayCues([cue(0, 1000, '  '), cue(1000, 2000, 'Xin   chào')]);
    expect(out).toEqual([{ index: 1, startMs: 1000, endMs: 2000, text: 'Xin chào' }]);
  });
});

import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { isOverlongLine, mergeByOverlap, onDecoderWindow, type HeardLine } from './decodeMerge.js';

let n = 0;
const line = (startMs: number, endMs: number, sourceText: string): TranscriptSegment => ({ id: `seg_${++n}`, index: n, startMs, endMs, sourceText });
const heard = (clipStartMs: number, ...lines: TranscriptSegment[]): HeardLine[] => lines.map((l) => ({ line: l, clipStartMs }));
// Han characters at about four a second, as alignment/clipSpeech.ts reckons them.
const expectedSpeechMs = (text: string): number => Math.max(400, [...text].length * 250);
const opts = { expectedSpeechMs };
const spans = (lines: readonly TranscriptSegment[]) => lines.map((l) => [l.startMs, l.endMs, l.sourceText]);

describe('decoder windows', () => {
  it('a line sits on a window when it starts a whole number of 30 s after the decode began', () => {
    expect(onDecoderWindow(226_340, 226_340)).toBe(true);
    expect(onDecoderWindow(256_380, 226_340)).toBe(true);
    expect(onDecoderWindow(256_500, 226_340)).toBe(false);
    expect(onDecoderWindow(100, 226_340)).toBe(false);
  });

  it('a line far longer than its words: at least 6 s and four times their time', () => {
    expect(isOverlongLine(line(0, 19_800, '你还要再说一遍'), expectedSpeechMs)).toBe(true);
    expect(isOverlongLine(line(0, 5_000, '好'), expectedSpeechMs)).toBe(false);
    expect(isOverlongLine(line(0, 8_000, '我们今天一定要把这件事情说清楚不然谁也别想走'), expectedSpeechMs)).toBe(false);
  });
});

describe('two decodes paired by time (《反相之地》 3:46–4:20)', () => {
  it('keeps the first decode\'s words where both heard a line, however differently the second words it', () => {
    const first = [line(234_960, 236_500, '别喊'), line(243_640, 245_000, '打不开'), line(244_360, 246_500, '回606')];
    const second = heard(226_340, line(234_840, 236_300, '别看'), line(243_640, 244_300, '挡开'), line(244_360, 246_400, '回六六六 走'));
    const out = mergeByOverlap(first, second, opts);
    expect(out.lines.map((l) => l.sourceText)).toEqual(['别喊', '打不开', '回606']);
    expect(out).toMatchObject({ kept: 3, added: 0, dropped: 0, retimed: 0 });
  });

  it('adds what only the second decode heard, and drops what only the first did', () => {
    const first = [line(227_000, 229_000, '请继续观看'), line(250_000, 252_000, '等等我')];
    const second = heard(226_340, line(227_840, 230_000, '大家小点声 往前走'), line(250_100, 251_800, '等等我'));
    const out = mergeByOverlap(first, second, opts);
    // 请继续观看 and 大家小点声 overlap: one utterance, the first decode's words stay.
    expect(spans(out.lines)).toEqual([
      [227_000, 229_000, '请继续观看'],
      [250_000, 252_000, '等等我'],
    ]);
    const apart = mergeByOverlap([line(260_000, 262_000, '谢谢观看')], heard(226_340, line(247_000, 248_000, '进来 快')), opts);
    expect(spans(apart.lines)).toEqual([[247_000, 248_000, '进来 快']]);
    expect(apart).toMatchObject({ kept: 0, added: 1, dropped: 1 });
  });

  it('never keeps a credit line, and keeps a long unheard line only where asked', () => {
    const credit = mergeByOverlap([line(1000, 3000, '请不吝点赞 订阅 转发')], heard(0, line(1000, 2800, '快跑')), {
      ...opts,
      isCredit: (l) => l.sourceText.includes('点赞'),
    });
    // Heard alone and longer than its words: cut to them (two characters, about 1.4 s).
    expect(spans(credit.lines)).toEqual([[1000, 2400, '快跑']]);
    const long = line(30_000, 46_960, '我们走吧');
    expect(mergeByOverlap([long], [], opts).lines).toEqual([]);
    expect(mergeByOverlap([long], [], { ...opts, keepUnheard: () => true }).lines).toEqual([long]);
  });
});

describe('decoder artifacts', () => {
  it('a first-decode line on a window, far longer than its words, takes the second decode\'s timing (item C)', () => {
    // 楼下也说不准 at 27:41.1 is really at 27:44.2 (the decode's window started at 27:41.1).
    const first = [line(1_661_100, 1_686_000, '楼下也说不准')];
    const second = heard(1_640_000, line(1_664_200, 1_666_000, '楼下也说不准'));
    const out = mergeByOverlap(first, second, { ...opts, originalOnWindow: (ms) => ms === 1_661_100 });
    expect(spans(out.lines)).toEqual([[1_664_200, 1_666_000, '楼下也说不准']]);
    expect(out.retimed).toBe(1);
  });

  it('a second-decode line on a window that nobody else heard is left out (item D), or kept at its start for review', () => {
    // retranscribe_range 1:04:28–1:11:09: "我会帮你解决的" from the window start 1:06:28.00 to 1:06:57.98, over music.
    const artifact = heard(3_868_000, line(3_988_000, 4_017_980, '我会帮你解决的'));
    expect(mergeByOverlap([], artifact, opts)).toMatchObject({ lines: [], artifacts: 1, added: 0 });
    const flagged = mergeByOverlap([], artifact, { ...opts, artifacts: 'flag' }).lines;
    expect(flagged).toEqual([expect.objectContaining({ sourceText: '我会帮你解决的', loopSuspect: true })]);
    // Kept to its first seconds: the words come soon after the window start, the line's end is the window's.
    expect([flagged[0]!.startMs, flagged[0]!.endMs]).toEqual([3_988_000, 3_988_000 + Math.round(7 * 250 * 1.6 + 600) + 4000]);
  });

  it('one long line of one phrase over many heard lines gives way to them (item B)', () => {
    const first = [line(5_814_000, 5_833_800, '你还要再说一遍')];
    const second = heard(
      5_800_000,
      line(5_815_000, 5_816_000, '刀哥'),
      line(5_817_000, 5_819_500, '好像撞的不是咱们这边'),
      line(5_820_000, 5_821_500, '是隔壁吧'),
      line(5_823_000, 5_825_000, '还剩一分钟了'),
    );
    const out = mergeByOverlap(first, second, opts);
    expect(out.lines.map((l) => l.sourceText)).toEqual(['刀哥', '好像撞的不是咱们这边', '是隔壁吧', '还剩一分钟了']);
    expect(out).toMatchObject({ kept: 0, dropped: 1, added: 4 });
  });
});

import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { tidyTranscript } from './transcriptTidy.js';

const line = (startMs: number, endMs: number, sourceText: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment =>
  ({ id: 'x', index: 0, startMs, endMs, sourceText, ...extra }) as TranscriptSegment;

describe('the transcript\'s last tidy (the STT step\'s end)', () => {
  it('drops empty lines and fragments with no room, sizes the others from the gap after them', () => {
    const { lines, report } = tidyTranscript([
      line(0, 1000, '你好'),
      line(1500, 1500, '嗯'), // no length, 500 ms before the next line
      line(2000, 3000, '走吧'),
      line(3000, 3000, '啊'), // no length, no room before the next line
      line(3050, 4000, '快跑'),
      line(4500, 4800, '   '),
      // Nothing to say, but a line: silent in the dub, with its subtitle.
      line(5000, 6000, '♪'),
    ]);
    expect(lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual([
      [0, 1000, '你好'],
      [1500, 2000, '嗯'],
      [2000, 3000, '走吧'],
      [3050, 4000, '快跑'],
      [5000, 6000, '♪'],
    ]);
    expect(report).toMatchObject({ dropped: 2 });
    expect(lines.map((l) => l.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003', 'seg_0004', 'seg_0005']);
  });

  it('makes one line of the same words at the same moment', () => {
    const { lines, report } = tidyTranscript([line(0, 2000, '你还要再说一遍'), line(1800, 2600, '你还要再说一遍！')]);
    expect(lines.map((l) => [l.startMs, l.endMs])).toEqual([[0, 2600]]);
    expect(report.merged).toBe(1);
  });

  it('separates overlapping lines at the later one\'s start, keeping speakers', () => {
    const { lines, report } = tidyTranscript([
      line(0, 3000, '我们走', { speakerId: 'SPEAKER_01' }),
      line(2000, 4000, '等等我', { speakerId: 'SPEAKER_02' }),
    ]);
    expect(lines.map((l) => [l.startMs, l.endMs, l.speakerId])).toEqual([
      [0, 2000, 'SPEAKER_01'],
      [2000, 4000, 'SPEAKER_02'],
    ]);
    expect(report.separated).toBe(1);
  });

  it('starts a line that began with another after it, and folds a fragment inside a line into it', () => {
    const started = tidyTranscript([line(1000, 2000, '前面'), line(1050, 3000, '后面')]);
    expect(started.lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual([
      [1000, 2000, '前面'],
      [2000, 3000, '后面'],
    ]);
    const folded = tidyTranscript([line(0, 4000, '他说的话很长'), line(50, 3900, '很长')]);
    expect(folded.lines.map((l) => l.sourceText)).toEqual(['他说的话很长']);
    expect(folded.report.merged).toBe(1);
  });

  it('the leftovers of 《反相之地》: zero-length twins, a 20 ms line, a fragment inside its line, two spellings of one sound', () => {
    const { lines, report } = tidyTranscript([
      // seg_0985–0988 at 49:55.58: two lines, each twice, no length.
      line(2_995_580, 2_995_580, '兄弟们先别慌'),
      line(2_995_580, 2_995_580, '赶紧撤退'),
      line(2_995_580, 2_995_580, '兄弟们先别慌'),
      line(2_995_580, 2_995_580, '赶紧撤退'),
      line(3_000_000, 3_002_000, '走'),
      // A 20 ms line.
      line(3_010_000, 3_010_020, '咋了小潘伯牙'),
      line(3_020_000, 3_023_000, '里面外面的怪物听到了'),
      line(3_021_500, 3_023_400, '怪物听到了'),
      // 31:28.38: "盘子" and "潘子", one sound written twice.
      line(1_888_380, 1_889_100, '盘子'),
      line(1_888_380, 1_889_150, '潘子'),
    ]);
    expect(lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual([
      [1_888_380, 1_889_100, '盘子'],
      // Each said once, one after the other, in its words' time.
      [2_995_580, 2_995_580 + 1286, '兄弟们先别慌'],
      [2_995_580 + 1286, 2_995_580 + 1286 + 857, '赶紧撤退'],
      [3_000_000, 3_002_000, '走'],
      [3_010_000, 3_010_000 + 1286, '咋了小潘伯牙'],
      [3_020_000, 3_023_400, '里面外面的怪物听到了'],
    ]);
    expect(report).toEqual({ dropped: 0, merged: 4, separated: 0 });
  });

  it('keeps a whole line over the fragment it came after', () => {
    const { lines } = tidyTranscript([line(0, 1500, '怪物听到了'), line(200, 3000, '里面外面的怪物听到了')]);
    expect(lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual([[0, 3000, '里面外面的怪物听到了']]);
  });

  it('leaves a clean transcript as it was', () => {
    const clean = [line(0, 1000, '一'), line(1000, 2000, '二'), line(2500, 3000, '三')];
    const { lines, report } = tidyTranscript(clean);
    expect(lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual(clean.map((l) => [l.startMs, l.endMs, l.sourceText]));
    expect(report).toEqual({ dropped: 0, merged: 0, separated: 0 });
  });
});

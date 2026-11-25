import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { loopEdits } from './loopEdits.js';
import type { RepairedRange } from './loopRepair.js';

const line = (id: string, startMs: number, endMs: number, sourceText: string): TranscriptSegment => ({ id, index: 0, startMs, endMs, sourceText });
const range = (over: Partial<RepairedRange>): RepairedRange => ({ fromMs: 10_000, toMs: 20_000, kind: 'silence', status: 'replaced', before: 2, after: 1, ...over });

describe('the loop pass in the edit history', () => {
  it('records the ranges it changed, with the lines as they were and as they are now', () => {
    const originals = [[line('a', 10_000, 12_000, '大家小点声'), line('b', 15_000, 17_000, '请继续观看')]];
    const final = [line('seg_0001', 0, 9_000, '走吧'), line('seg_0002', 10_200, 12_000, '大家小点声'), line('seg_0003', 21_000, 22_000, '好')];
    const [entry] = loopEdits({ ranges: [range({})], originals }, final);
    expect(entry!.before.map((l) => l.sourceText)).toEqual(['大家小点声', '请继续观看']);
    expect(entry!.after.map((l) => l.sourceText)).toEqual(['大家小点声']);
  });

  it('a neighbour reaching into the range goes back as it is now, so undo never loses it', () => {
    const originals = [[line('a', 12_000, 14_000, '请继续观看')]];
    const final = [line('seg_0001', 8_000, 10_800, '走吧')];
    const [entry] = loopEdits({ ranges: [range({ status: 'removed', after: 0 })], originals }, final);
    expect(entry!.after.map((l) => l.sourceText)).toEqual(['走吧']);
    expect(entry!.before.map((l) => l.sourceText)).toEqual(['走吧', '请继续观看']);
  });

  it('leaves out what it did not change: a range kept as it was, or left for review', () => {
    const originals = [[line('a', 10_000, 12_000, 'x')], [line('b', 30_000, 32_000, 'y')], [line('c', 40_000, 42_000, 'z')]];
    const ranges = [
      range({ status: 'kept' }),
      range({ fromMs: 30_000, toMs: 32_000, status: 'left' }),
      range({ fromMs: 40_000, toMs: 42_000, status: 'kept', counts: { kept: 1, added: 0, dropped: 0, retimed: 1, artifacts: 0 } }),
    ];
    expect(loopEdits({ ranges, originals }, []).map((e) => e.range.fromMs)).toEqual([40_000]);
  });
});

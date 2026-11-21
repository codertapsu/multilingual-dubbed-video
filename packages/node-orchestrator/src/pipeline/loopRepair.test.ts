import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { creditPhrase, findLoopRanges, normalizeLine, repairLoops, type LoopRepairDeps } from './loopRepair.js';

/** Lines from [startMs, endMs, text]. */
function lines(spec: [number, number, string][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, sourceText], i) => ({ id: `seg_${String(i + 1).padStart(4, '0')}`, index: i, startMs, endMs, sourceText }));
}

/** `n` lines of `text`, one every `stepMs` from `fromMs`. */
function run(text: string, n: number, fromMs = 0, stepMs = 1000): [number, number, string][] {
  return Array.from({ length: n }, (_, i) => [fromMs + i * stepMs, fromMs + i * stepMs + 900, text] as [number, number, string]);
}

const never = new AbortController().signal;

describe('findLoopRanges', () => {
  it('finds a phrase repeated every 1.00 s (the field run: 回身缠住他们 to the chunk boundary)', () => {
    const t = lines([[0, 2000, '你认得老夫'], ...run('回身缠住他们', 30, 3000), [40_000, 42_000, '走吧']]);
    const found = findLoopRanges(t);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ start: 1, end: 31, kind: 'repeat', phrase: '回身缠住他们' });
  });

  it('does not flag a battle cry said a few times (顶住 ×3, 驾 ×2)', () => {
    const t = lines([...run('顶住', 3, 0), ...run('驾', 2, 5000), ...run('队长接应了', 2, 9000)]);
    expect(findLoopRanges(t)).toEqual([]);
  });

  it('does not flag the same answer said a few times far apart', () => {
    expect(findLoopRanges(lines(run('好的', 6, 0, 15_000)))).toEqual([]);
  });

  it('needs a longer run for a short phrase: 杀 ×10 in 10 s is a chant, ×12 is a loop', () => {
    expect(findLoopRanges(lines(run('杀！', 10)))).toEqual([]);
    expect(findLoopRanges(lines(run('杀！', 12)))[0]?.kind).toBe('repeat');
  });

  it('finds little variety in a minute (A B A B...)', () => {
    const ab: [number, number, string][] = Array.from({ length: 20 }, (_, i) => [i * 2500, i * 2500 + 2000, i % 2 ? '月亮代表我的心' : '你问我爱你有多深']);
    expect(findLoopRanges(lines(ab))[0]?.kind).toBe('low-diversity');
  });

  it('flags credit lines; a common word only twice in a line or where nobody speaks', () => {
    const t = lines([
      [0, 3000, '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'],
      [4000, 6000, '你转发给我'],
      [7000, 9000, '优优独播剧场——YoYo Television Series Exclusive'],
      [10_000, 12_000, '订阅了吗'],
    ]);
    const kinds = findLoopRanges(t, (from) => from === 10_000).map((r) => [r.start, r.kind]);
    expect(kinds).toEqual([
      [0, 'phrase'],
      [2, 'phrase'],
      [3, 'phrase'],
    ]);
  });

  it('keeps real dialogue that shares words with the credits', () => {
    const t = lines([
      [0, 2000, '请不吝赐教'],
      [3000, 5000, '大人心如明镜'],
    ]);
    expect(findLoopRanges(t)).toEqual([]);
  });

  it('normalizes punctuation, symbols and zero-width characters away', () => {
    expect(normalizeLine('  好！ 好？​')).toBe('好好');
    expect(creditPhrase('字幕')).toBeUndefined();
    expect(creditPhrase('字幕', true)).toBe('字幕');
  });
});

describe('repairLoops', () => {
  const deps = (redecoded: TranscriptSegment[] | Error): LoopRepairDeps & { calls: [number, number][] } => {
    const calls: [number, number][] = [];
    return {
      calls,
      redecode: async (from, to) => {
        calls.push([from, to]);
        if (redecoded instanceof Error) throw redecoded;
        return redecoded;
      },
      expectedSpeechMs: (text) => [...text].length * 250 + 400,
    };
  };

  it('replaces a loop with what a decode without context hears, trimming over-long lines', async () => {
    const t = lines([[0, 2000, '开始'], ...run('回身缠住他们', 25, 3000), [30_000, 31_000, '结束']]);
    const ranges = findLoopRanges(t);
    const d = deps(lines([[3000, 5000, '你认得老夫'], [5200, 25_000, '晚辈昔日有幸见过']]));
    const out = await repairLoops(t, ranges, d, never);
    expect(d.calls).toEqual([[2500, 28_400]]);
    expect(out.ranges[0]).toMatchObject({ status: 'replaced', before: 25, after: 2 });
    expect(out.lines.map((l) => l.sourceText)).toEqual(['开始', '你认得老夫', '晚辈昔日有幸见过', '结束']);
    // 8 characters: about 2.4 s to say, so 19.8 s was the loop's time, not the line's.
    expect(out.lines[2]!.endMs - out.lines[2]!.startMs).toBeLessThan(5000);
    expect(out.lines.map((l) => l.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003', 'seg_0004']);
  });

  it('keeps a real chant: it repeats without context too', async () => {
    const t = lines(run('杀！', 14));
    const out = await repairLoops(t, findLoopRanges(t), deps(lines(run('杀！', 14))), never);
    expect(out.ranges[0]).toMatchObject({ status: 'kept' });
    expect(out.lines).toHaveLength(14);
  });

  it('leaves silence when the decode hears only credits, and drops credit lines outright', async () => {
    const t = lines([...run('谢谢', 13), [20_000, 23_000, '请不吝点赞 订阅 转发 打赏']]);
    const out = await repairLoops(t, findLoopRanges(t), deps(lines([[0, 9000, '优优独播剧场——YoYo']])), never);
    expect(out.ranges.map((r) => r.status)).toEqual(['removed', 'removed']);
    expect(out.lines).toEqual([]);
  });

  it('leaves a range as it was, and says so, when the second decode fails', async () => {
    const t = lines(run('回身缠住他们', 10));
    const out = await repairLoops(t, findLoopRanges(t), deps(new Error('engine down')), never);
    expect(out.ranges[0]).toMatchObject({ status: 'left' });
    expect(out.ranges[0]!.reason).toMatch(/engine down/);
    expect(out.lines).toHaveLength(10);
  });
});

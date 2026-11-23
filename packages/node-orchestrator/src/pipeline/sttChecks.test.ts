import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';
import { findLoopRanges, repairLoops, type LoopRange, type LoopRepairDeps } from './loopRepair.js';
import {
  digitalSilenceFindings,
  findLinesOverSilence,
  heardNothing,
  inSilenceOf,
  linesCoverMs,
  mergeLoopRanges,
  MIN_SILENT_RUN,
  normalizeRegions,
  speechMsIn,
} from './sttChecks.js';

/** Lines from [startMs, endMs, text]. */
function lines(spec: [number, number, string][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, sourceText], i) => ({ id: `seg_${String(i + 1).padStart(4, '0')}`, index: i, startMs, endMs, sourceText }));
}

/** `n` varied lines (a hallucination is not a loop), one every 3 s from `fromMs`. */
function varied(n: number, fromMs: number): [number, number, string][] {
  const words = ['他走了', '天色已晚', '快回家吧', '你听我说', '明天再来', '这是谁的', '别担心', '我知道了', '小心点', '原来如此'];
  return Array.from({ length: n }, (_, i) => [fromMs + i * 3000, fromMs + i * 3000 + 2500, `${words[i % words.length]}${i}`]);
}

const never = new AbortController().signal;

describe('the speech the map heard', () => {
  const regions = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 9000 },
    { startMs: 20_000, endMs: 21_000 },
  ];

  it('speech inside a span, by binary search', () => {
    expect(speechMsIn(regions, 0, 30_000)).toBe(6000);
    expect(speechMsIn(regions, 1500, 6000)).toBe(1500);
    expect(speechMsIn(regions, 9000, 20_000)).toBe(0);
    expect(speechMsIn(regions, 8000, 8000)).toBe(0);
    expect(speechMsIn([], 0, 1000)).toBe(0);
  });

  it('an unsorted or overlapping map (a cached file) is sorted and merged first', () => {
    expect(normalizeRegions(regions)).toBe(regions);
    expect(
      normalizeRegions([
        { startMs: 20_000, endMs: 21_000 },
        { startMs: 1000, endMs: 3000 },
        { startMs: 2000, endMs: 2500 },
      ]),
    ).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 20_000, endMs: 21_000 },
    ]);
  });

  it('nothing heard: at most a tenth of the span, or 250 ms', () => {
    expect(heardNothing(regions, 9000, 20_000)).toBe(true);
    expect(heardNothing(regions, 1800, 4000)).toBe(true); // 200 ms
    expect(heardNothing(regions, 4000, 6000)).toBe(false); // 1 s of 2
    expect(heardNothing(regions, 10_000, 20_500)).toBe(true); // 500 ms of 10.5 s
    expect(inSilenceOf(regions)(9000, 20_000)).toBe(true);
  });
});

describe('lines written over silence (1.6a)', () => {
  // Three 10-minute STT chunks; speech everywhere except 600-1200 s.
  const chunks = [
    { startMs: 0, endMs: 600_000 },
    { startMs: 600_000, endMs: 1_200_000 },
    { startMs: 1_200_000, endMs: 1_800_000 },
  ];
  const speech = [
    { startMs: 0, endMs: 600_000 },
    { startMs: 1_200_000, endMs: 1_800_000 },
  ];

  it('flags the chunk that heard no speech and sends its lines to the loop pass', () => {
    const t = lines([...varied(5, 100_000), ...varied(20, 700_000), ...varied(5, 1_300_000)]);
    const { ranges, findings } = findLinesOverSilence(t, speech, chunks);
    // 20 lines every 3 s from 700 s: the last ends at 757 + 2.5 s.
    expect(ranges).toEqual([{ start: 5, end: 25, fromMs: 700_000, toMs: 759_500, kind: 'silence' }]);
    expect(findings).toEqual([{ firstChunk: 2, lastChunk: 2, chunks: 3, fromMs: 700_000, toMs: 759_500, lines: 20, speechMs: 0 }]);
  });

  it(`a few lines the map missed are not "many" (fewer than ${MIN_SILENT_RUN} in a row)`, () => {
    const t = lines([...varied(5, 100_000), ...varied(MIN_SILENT_RUN - 1, 700_000), ...varied(5, 1_300_000)]);
    expect(findLinesOverSilence(t, speech, chunks)).toEqual({ ranges: [], findings: [] });
  });

  it('a silent run across a chunk boundary is one finding over both chunks', () => {
    const t = lines(varied(12, 1_190_000 - 6 * 3000));
    const quiet = [{ startMs: 0, endMs: 1_000_000 }];
    const { ranges, findings } = findLinesOverSilence(t, quiet, chunks);
    expect(ranges).toHaveLength(1);
    expect(findings).toEqual([expect.objectContaining({ firstChunk: 2, lastChunk: 3, lines: 12 })]);
  });

  it('a line with nothing to say neither counts nor breaks a run; a heard line does', () => {
    const t = lines([...varied(3, 700_000), [720_000, 721_000, '…'], ...varied(3, 730_000)]);
    expect(findLinesOverSilence(t, speech, chunks).ranges).toEqual([{ start: 0, end: 7, fromMs: 700_000, toMs: 738_500, kind: 'silence' }]);
    const heard = [...speech, { startMs: 719_000, endMs: 722_000 }];
    const split = lines([...varied(3, 700_000), [719_500, 721_500, '有人吗'], ...varied(3, 730_000)]);
    expect(findLinesOverSilence(split, heard, chunks).ranges).toEqual([]);
  });

  it('one chunk (no chunking): the whole file', () => {
    const t = lines(varied(8, 30_000));
    const { findings } = findLinesOverSilence(t, [], [{ startMs: 0, endMs: 600_000 }]);
    expect(findings).toEqual([{ firstChunk: 1, lastChunk: 1, chunks: 1, fromMs: 30_000, toMs: 53_500, lines: 8, speechMs: 0 }]);
  });
});

describe('merging the loop finder with the silence check', () => {
  it('overlapping ranges become one, named "silence"; others stay apart, in order', () => {
    const loops: LoopRange[] = [
      { start: 2, end: 10, fromMs: 2000, toMs: 10_000, kind: 'repeat', phrase: '回身缠住他们' },
      { start: 30, end: 31, fromMs: 30_000, toMs: 31_000, kind: 'phrase', phrase: '字幕' },
    ];
    const silent: LoopRange[] = [{ start: 5, end: 20, fromMs: 5000, toMs: 20_000, kind: 'silence' }];
    expect(mergeLoopRanges(loops, silent)).toEqual([
      { start: 2, end: 20, fromMs: 2000, toMs: 20_000, kind: 'silence' },
      { start: 30, end: 31, fromMs: 30_000, toMs: 31_000, kind: 'phrase', phrase: '字幕' },
    ]);
    expect(mergeLoopRanges([], [])).toEqual([]);
  });
});

describe('the loop pass over silence', () => {
  const silent = lines(varied(10, 0));
  const range: LoopRange = { start: 0, end: 10, fromMs: 0, toMs: 29_500, kind: 'silence' };
  const deps = (redecoded: TranscriptSegment[], heard: { startMs: number; endMs: number }[] = []): LoopRepairDeps => ({
    redecode: async () => redecoded,
    expectedSpeechMs: (text) => [...text].length * 250 + 400,
    inSilence: inSilenceOf(heard),
  });

  it('a second decode that hears nothing removes the lines, however varied they were', async () => {
    const out = await repairLoops(silent, [range], deps([]), never);
    expect(out.ranges[0]).toMatchObject({ kind: 'silence', status: 'removed', before: 10, after: 0 });
    expect(out.lines).toEqual([]);
    // A varied range of another kind is kept on the same answer (unchanged).
    const kept = await repairLoops(silent, [{ ...range, kind: 'low-diversity' }], deps([]), never);
    expect(kept.ranges[0]).toMatchObject({ status: 'kept' });
  });

  it('what the second decode writes over silence is dropped; what it hears over speech replaces the run', async () => {
    const again = lines([
      [1000, 3000, '谢谢大家'],
      [12_000, 14_000, '你来了'],
    ]);
    const out = await repairLoops(silent, [range], deps(again, [{ startMs: 11_800, endMs: 14_200 }]), never);
    expect(out.ranges[0]).toMatchObject({ status: 'replaced', after: 1 });
    expect(out.lines.map((l) => l.sourceText)).toEqual(['你来了']);
  });

  it('a loop the second decode repeats over silence is not "really said"', async () => {
    const loop = lines(Array.from({ length: 12 }, (_, i) => [i * 1000, i * 1000 + 900, '回身缠住他们'] as [number, number, string]));
    const ranges = mergeLoopRanges(findLoopRanges(loop), [{ start: 0, end: 12, fromMs: 0, toMs: 11_900, kind: 'silence' }]);
    const out = await repairLoops(loop, ranges, deps(loop), never);
    expect(out.ranges[0]).toMatchObject({ kind: 'silence', status: 'removed' });
  });
});

describe('digital silence (1.6b)', () => {
  const twoHours = [{ startMs: 71_940_000, endMs: 91_140_000 }];
  it('a long silence in a talk-heavy video is a finding', () => {
    // 27.8 h, 5.3 h of it silent, speech in 40 % of the rest.
    const total = 100_080_000;
    const speech = 0.4 * (total - (91_140_000 - 71_940_000));
    expect(digitalSilenceFindings(twoHours, total, speech)).toEqual([{ fromMs: 71_940_000, toMs: 91_140_000 }]);
  });

  it('not in a video with little talk, and not under a minute', () => {
    expect(digitalSilenceFindings(twoHours, 100_080_000, 5_000_000)).toEqual([]);
    expect(digitalSilenceFindings([{ startMs: 0, endMs: 59_000 }], 600_000, 400_000)).toEqual([]);
    expect(digitalSilenceFindings([], 600_000, 400_000)).toEqual([]);
  });

  it('without a speech map, the lines tell how much is talk', () => {
    expect(linesCoverMs([{ startMs: 0, endMs: 1000 }, { startMs: 500, endMs: 2000 }, { startMs: 5000, endMs: 6000 }])).toBe(3000);
    expect(linesCoverMs([])).toBe(0);
  });
});

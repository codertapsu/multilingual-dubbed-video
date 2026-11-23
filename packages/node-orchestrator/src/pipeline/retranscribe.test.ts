import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import type { RepairedRange } from './loopRepair.js';
import {
  bigramSimilarity,
  carrySpeakers,
  fitToWindow,
  hearWindow,
  loopCounts,
  mergeLoopReports,
  planRetranscribeWindows,
  readSavedSpeechRegions,
  saveLoopReport,
  silenceTest,
  widenToLines,
  windowSummary,
} from './retranscribe.js';

/** Lines from [startMs, endMs, text, speakerId?]. */
function lines(spec: [number, number, string, string?][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, sourceText, speakerId], i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    index: i,
    startMs,
    endMs,
    sourceText,
    ...(speakerId ? { speakerId } : {}),
  }));
}

/** `n` lines of `text`, one every second from `fromMs`. */
function run(text: string, n: number, fromMs: number): [number, number, string][] {
  return Array.from({ length: n }, (_, i) => [fromMs + i * 1000, fromMs + i * 1000 + 900, text] as [number, number, string]);
}

const never = new AbortController().signal;
const MIN = 60_000;

describe('the range and its windows', () => {
  it('widens a range to the whole lines across its edges', () => {
    const t = lines([[0, 5000, 'a'], [9000, 12_000, 'b'], [20_000, 26_000, 'c']]);
    expect(widenToLines({ fromMs: 10_000, toMs: 24_000 }, t)).toEqual({ fromMs: 9000, toMs: 26_000 });
    // A line that only touches an edge is not across it.
    expect(widenToLines({ fromMs: 5000, toMs: 20_000 }, t)).toEqual({ fromMs: 5000, toMs: 20_000 });
  });

  it('cuts a long range in windows of up to 15 minutes, in the widest gap of the minute before each boundary', () => {
    // A line every 10 s (9 s long) up to 14:39, then a 7 s pause until 14:46.
    const t = lines([
      ...Array.from({ length: 88 }, (_, i) => [i * 10_000, i * 10_000 + 9_000, 'x'] as [number, number, string]),
      [14 * MIN + 46_000, 14 * MIN + 55_000, 'y'],
      ...Array.from({ length: 100 }, (_, i) => [15 * MIN + i * 10_000, 15 * MIN + i * 10_000 + 9_000, 'z'] as [number, number, string]),
    ]);
    const w = planRetranscribeWindows({ fromMs: 0, toMs: 31 * MIN }, t);
    expect(w).toHaveLength(3);
    // The middle of the 14:39-14:46 pause, not a cut through a line.
    expect(w[0]).toEqual({ fromMs: 0, toMs: 14 * MIN + 42_500 });
    expect(w[1]!.fromMs).toBe(w[0]!.toMs);
    expect(w[1]!.toMs - w[1]!.fromMs).toBeLessThanOrEqual(15 * MIN);
    expect(w[2]!.toMs).toBe(31 * MIN);
    // Up to 15 minutes is one window.
    expect(planRetranscribeWindows({ fromMs: 0, toMs: 15 * MIN }, t)).toEqual([{ fromMs: 0, toMs: 15 * MIN }]);
    // No lines at all: cut at the boundary.
    expect(planRetranscribeWindows({ fromMs: 0, toMs: 20 * MIN }, [])).toEqual([
      { fromMs: 0, toMs: 15 * MIN },
      { fromMs: 15 * MIN, toMs: 20 * MIN },
    ]);
  });
});

describe('speakers carried over', () => {
  it('measures text alike by character bigrams', () => {
    expect(bigramSimilarity('你认得老夫吗？', '你认得老夫吗')).toBe(1);
    expect(bigramSimilarity('晚辈昔日有幸见过', '回身缠住他们')).toBe(0);
    expect(bigramSimilarity('我是张三', '你好我是张三')).toBeCloseTo(0.75);
    expect(bigramSimilarity('嗯', '嗯')).toBe(1);
    expect(bigramSimilarity('', '嗯')).toBe(0);
  });

  it('keeps a speaker only where a new line overlaps an old one with alike text, and counts the rest', () => {
    const old = lines([
      [0, 2000, '你认得老夫吗', 'SPEAKER_01'],
      [2000, 4000, '晚辈昔日有幸见过', 'SPEAKER_02'],
      [4000, 9000, '回身缠住他们', 'SPEAKER_03'],
    ]);
    old[1]!.speakerLowConfidence = true;
    const heard = [
      { startMs: 100, endMs: 1900, text: '你认得老夫吗？' },
      { startMs: 2100, endMs: 3900, text: '晚辈昔日有幸见过前辈', speakerId: 'SPEAKER_09' },
      // Garbled audio heard right: the old text under it is unlike it.
      { startMs: 4100, endMs: 6000, text: '大人请留步' },
      { startMs: 6100, endMs: 8000, text: '此事另有隐情' },
    ];
    const out = carrySpeakers(heard, old, true);
    expect(out.lines.map((l) => l.speakerId)).toEqual(['SPEAKER_01', 'SPEAKER_02', undefined, undefined]);
    expect(out.lines[1]!.speakerLowConfidence).toBe(true);
    expect(out).toMatchObject({ carried: 2, unassigned: 2 });
    // A project never detected has no speakers to lose.
    expect(carrySpeakers(heard, lines([[0, 9000, 'x']]), false).unassigned).toBe(0);
  });
});

describe('fitting decoded lines into a window', () => {
  it('cuts them to the window, removes overlaps and slivers, and renumbers', () => {
    const decoded = lines([
      [900, 3000, ' 第一句 '],
      [2500, 5000, '第二句'],
      [5000, 5050, '碎'],
      [9500, 12_000, '越界'],
      [6000, 7000, '  '],
    ]);
    decoded[0]!.words = [{ word: '第一句', startMs: 900, endMs: 3000 }];
    const out = fitToWindow(decoded, { fromMs: 1000, toMs: 10_000 });
    expect(out.map((l) => [l.id, l.startMs, l.endMs, l.sourceText])).toEqual([
      ['seg_0001', 1000, 2500, '第一句'],
      ['seg_0002', 2500, 5000, '第二句'],
      ['seg_0003', 9500, 10_000, '越界'],
    ]);
    expect(out[0]!.words).toBeUndefined();
  });
});

describe('hearing a window through the loop pass', () => {
  it('removes credits, decodes a loop again without context (500 ms around it), and keeps what is varied', async () => {
    const calls: [number, number, boolean][] = [];
    const decode = async (from: number, to: number, noContext: boolean): Promise<TranscriptSegment[]> => {
      calls.push([from, to, noContext]);
      if (from === 60_000) {
        return lines([[61_000, 63_000, '你认得老夫吗'], ...run('回身缠住他们', 25, 64_000), [95_000, 97_000, '请不吝点赞 订阅 转发 打赏']]);
      }
      return lines([[64_500, 66_000, '晚辈昔日有幸见过'], [67_000, 70_000, '前辈风采依旧']]);
    };
    const heard = await hearWindow({ decode }, { fromMs: 60_000, toMs: 100_000 }, true, never);
    expect(calls[0]).toEqual([60_000, 100_000, true]);
    expect(calls[1]).toEqual([63_500, 89_400, true]);
    expect(heard.lines.map((l) => l.sourceText)).toEqual(['你认得老夫吗', '晚辈昔日有幸见过', '前辈风采依旧']);
    expect(loopCounts(heard.loops)).toEqual({ removed: 2, kept: 0, left: 0 });
  });

  it('marks the lines of a loop it could not check', async () => {
    let first = true;
    const decode = async (): Promise<TranscriptSegment[]> => {
      if (!first) throw new Error('engine down');
      first = false;
      return lines(run('回身缠住他们', 25, 1000));
    };
    const heard = await hearWindow({ decode }, { fromMs: 0, toMs: 30_000 }, true, never);
    expect(heard.lines.every((l) => l.loopSuspect)).toBe(true);
    expect(loopCounts(heard.loops)).toEqual({ removed: 0, kept: 0, left: 1 });
  });

  it('takes the common credit words for credits only where the speech map heard nobody', () => {
    const silent = silenceTest([{ startMs: 0, endMs: 10_000 }]);
    expect(silent(20_000, 25_000)).toBe(true);
    expect(silent(5000, 12_000)).toBe(false);
    expect(silent(9500, 20_000)).toBe(true);
  });
});

describe('the loop report and the history', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-retx-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const range = (fromMs: number, toMs: number, status: RepairedRange['status']): RepairedRange => ({ fromMs, toMs, kind: 'repeat', status, before: 10, after: 0 });

  it("replaces a window's old loop ranges with what its new pass found", async () => {
    expect(mergeLoopReports([range(0, 5000, 'left'), range(20_000, 30_000, 'replaced')], { fromMs: 15_000, toMs: 40_000 }, [range(16_000, 18_000, 'removed')])).toEqual([
      range(0, 5000, 'left'),
      range(16_000, 18_000, 'removed'),
    ]);
    const file = path.join(tmp, 'loop_ranges.json');
    await saveLoopReport(file, { fromMs: 0, toMs: 10_000 }, [range(1000, 2000, 'kept')]);
    expect((JSON.parse(await fsp.readFile(file, 'utf8')) as { ranges: RepairedRange[] }).ranges).toEqual([range(1000, 2000, 'kept')]);
    // Nothing left: no file, as the STT step leaves it.
    await saveLoopReport(file, { fromMs: 0, toMs: 10_000 }, []);
    await expect(fsp.stat(file)).rejects.toThrow();
  });

  it('says what a window did in a sentence', () => {
    expect(windowSummary({ fromMs: 87_124_000, toMs: 88_024_000 }, 14, { removed: 2, kept: 0, left: 0 }, 0)).toBe(
      'Re-transcribed 24:12:04–24:27:04: 14 lines, 2 loops removed',
    );
    expect(windowSummary({ fromMs: 0, toMs: 60_000 }, 1, { removed: 0, kept: 1, left: 1 }, 3)).toBe(
      'Re-transcribed 0:00–1:00: 1 line, 1 kept as really said, 1 left marked LOOP?, 3 without a speaker',
    );
  });

  it('reads the speech map only when it was measured on this very audio', async () => {
    const audio = path.join(tmp, 'a.wav');
    await fsp.writeFile(audio, Buffer.alloc(100));
    const stat = await fsp.stat(audio);
    const map = path.join(tmp, 'speech_regions.json');
    await fsp.writeFile(map, JSON.stringify({ audio: { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }, regions: [{ startMs: 0, endMs: 900 }, { startMs: 5, endMs: 1 }] }));
    expect(await readSavedSpeechRegions(audio, map)).toEqual([{ startMs: 0, endMs: 900 }]);
    await fsp.writeFile(map, JSON.stringify({ audio: { sizeBytes: 1, mtimeMs: 1 }, regions: [{ startMs: 0, endMs: 900 }] }));
    expect(await readSavedSpeechRegions(audio, map)).toBeUndefined();
    expect(await readSavedSpeechRegions(audio, path.join(tmp, 'none.json'))).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { TranscriptSegment, TranscriptWord } from '@videodubber/shared';
import { anchorSegmentsToSpeech, needsSpeechMap } from './segmentTiming.js';

const w = (word: string, startMs: number, endMs: number): TranscriptWord => ({ word, startMs, endMs });
const seg = (id: string, startMs: number, endMs: number, sourceText: string, words?: TranscriptWord[]): TranscriptSegment => ({
  id,
  index: Number(id.slice(4)) - 1,
  startMs,
  endMs,
  sourceText,
  ...(words ? { words } : {}),
});

describe('anchorSegmentsToSpeech', () => {
  it('faster-whisper: a first word stranded in the previous chunk\'s padding rejoins its line (the [7.06-49.80] case)', () => {
    const line = seg('seg_0001', 7060, 49800, '地方不在三界', [
      w('地方', 7060, 7380), // landed in the pad tail of the speech chunk ending at 7.38 s
      w('不', 49300, 49420),
      w('在', 49420, 49530),
      w('三', 49530, 49650),
      w('界', 49650, 49780),
    ]);
    const { segments, report } = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh' });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: 'seg_0001', sourceText: '地方不在三界', endMs: 49800 });
    // 地方 now sits right before 不 (its 320 ms kept), plus 100 ms of air.
    expect(segments[0]!.startMs).toBe(49300 - 320 - 100);
    expect(segments[0]!.words![0]).toMatchObject({ word: '地方', startMs: 48980, endMs: 49300 });
    expect(report).toMatchObject({ moved: 1, split: 0, byWords: 1 });
    expect(report.maxShiftMs).toBeGreaterThan(41_000);
  });

  it('a piece of one word split across the cut (狐|狸 12 s apart) is put back together', () => {
    const line = seg('seg_0001', 10_000, 23_500, '狐狸你别跑', [
      w('狐', 10_000, 10_150),
      w('狸', 22_200, 22_400),
      w('你', 22_400, 22_600),
      w('别', 22_600, 22_800),
      w('跑', 22_800, 23_100),
    ]);
    const [out] = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh' }).segments;
    expect(out!.startMs).toBe(22_200 - 150 - 100);
    expect(out!.endMs).toBe(23_200);
  });

  it('two real phrases across a long pause become two lines, each at its own time', () => {
    const line = seg('seg_0001', 1000, 6500, '你好啊我们走吧', [
      w('你', 1000, 1200), w('好', 1200, 1400), w('啊', 1400, 1900),
      w('我', 5000, 5300), w('们', 5300, 5600), w('走', 5600, 6000), w('吧', 6000, 6400),
    ]);
    const next = seg('seg_0002', 6600, 8000, '好', [w('好', 6700, 7900)]);
    const { segments, report } = anchorSegmentsToSpeech([line, next], { sourceLanguage: 'zh' });
    expect(segments.map((s) => [s.id, s.startMs, s.endMs, s.sourceText])).toEqual([
      ['seg_0001', 1000, 2000, '你好啊'],
      ['seg_0002', 4900, 6500, '我们走吧'],
      ['seg_0003', 6600, 8000, '好'],
    ]);
    expect(report).toMatchObject({ moved: 1, split: 1 });
  });

  it('an English first word stranded the same way rejoins its line too, without a speech map', () => {
    const line = seg('seg_0001', 7060, 49_800, 'Listen to me.', [
      w(' Listen', 7060, 7400),
      w(' to', 49_300, 49_450),
      w(' me.', 49_450, 49_700),
    ]);
    const { segments, report } = anchorSegmentsToSpeech([line], { sourceLanguage: 'en' });
    expect(segments.map((s) => [s.startMs, s.endMs, s.sourceText])).toEqual([[48_860, 49_800, 'Listen to me.']]);
    expect(report.split).toBe(0);
  });

  it('with a speech map, a lone word that WAS spoken before the pause keeps its own line', () => {
    const line = seg('seg_0001', 1000, 6100, 'Wait. I know you.', [
      w(' Wait.', 1000, 1400),
      w(' I', 5000, 5200),
      w(' know', 5200, 5500),
      w(' you.', 5500, 6000),
    ]);
    const regions = [
      { startMs: 900, endMs: 1500 },
      { startMs: 4900, endMs: 6100 },
    ];
    const { segments } = anchorSegmentsToSpeech([line], { sourceLanguage: 'en', regions });
    expect(segments.map((s) => [s.id, s.startMs, s.endMs, s.sourceText])).toEqual([
      ['seg_0001', 1000, 1500, 'Wait.'],
      ['seg_0002', 4900, 6100, 'I know you.'],
    ]);
  });

  it('with a speech map, a word that ends the first part but was never spoken there moves to the next part', () => {
    const line = seg('seg_0001', 1000, 6000, 'We should go home now', [
      w(' We', 1000, 1300),
      w(' should', 1300, 1600),
      w(' go', 1650, 1900), // in the cut's padding: no speech under it
      w(' home', 5000, 5400),
      w(' now', 5400, 5800),
    ]);
    const regions = [
      { startMs: 950, endMs: 1650 },
      { startMs: 4950, endMs: 5850 },
    ];
    const { segments } = anchorSegmentsToSpeech([line], { sourceLanguage: 'en', regions });
    expect(segments.map((s) => [s.startMs, s.endMs, s.sourceText])).toEqual([
      [1000, 1700, 'We should'],
      [4650, 5900, 'go home now'],
    ]);
  });

  it('whisper.cpp (no words): the speech map trims the line to the speech nearest its end (the [30.00-46.96] case)', () => {
    const line = seg('seg_0001', 30_000, 46_960, '虎哥 这啥地方啊');
    const regions = [
      { startMs: 31_000, endMs: 31_500 }, // a shout in the fight music
      { startMs: 44_500, endMs: 45_200 },
      { startMs: 45_300, endMs: 46_900 },
    ];
    const { segments, report } = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh', regions });
    expect([segments[0]!.startMs, segments[0]!.endMs]).toEqual([44_400, 46_960]);
    expect(report).toMatchObject({ moved: 1, bySpeechMap: 1 });
  });

  it('walks back through earlier speech when the text needs more time than the last run has', () => {
    // 16 characters ≈ 3.2 s of speech needed (x0.8); the last run alone has 1 s.
    const line = seg('seg_0001', 0, 20_000, '我们已经按照约定退出青丘地界了吧');
    const regions = [
      { startMs: 2_000, endMs: 4_500 },
      { startMs: 18_000, endMs: 19_000 },
    ];
    const [out] = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh', regions }).segments;
    expect([out!.startMs, out!.endMs]).toEqual([1_900, 19_100]);
  });

  it('never makes a word-less line shorter than its text takes to say (the VAD hears fragments under music)', () => {
    const line = seg('seg_0001', 1_099_630, 1_131_940, '你们真是不懂礼貌');
    const regions = [{ startMs: 1_131_320, endMs: 1_131_560 }]; // 240 ms heard under the music
    const [out] = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh', regions }).segments;
    // 8 characters ≈ 2 s, ending where the speech ends.
    expect([out!.startMs, out!.endMs]).toEqual([1_129_660, 1_131_660]);
  });

  it('a word-less line far longer than its text, with no speech found in it, trusts its end', () => {
    const line = seg('seg_0001', 1_201_400, 1_220_620, '谁是六五');
    const [out] = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh', regions: [{ startMs: 1_230_000, endMs: 1_231_000 }] })
      .segments;
    expect([out!.startMs, out!.endMs]).toEqual([1_219_120, 1_220_620]);
  });

  it('leaves alone: lines with no evidence, tight lines, and words that drifted outside the line', () => {
    const tight = seg('seg_0001', 1000, 2500, '你好', [w('你', 1050, 1300), w('好', 1300, 2400)]);
    const noEvidence = seg('seg_0002', 3000, 5500, '有人吗'); // plausible length: nothing to go on
    const staleWords = seg('seg_0003', 25_400, 26_000, '谢谢', [w('谢', 4400, 4600), w('谢', 4600, 7500)]);
    const input = [tight, noEvidence, staleWords];
    const { segments, report } = anchorSegmentsToSpeech(input, { sourceLanguage: 'zh', regions: [{ startMs: 30_000, endMs: 31_000 }] });
    expect(segments).toEqual(input);
    expect(report.moved).toBe(0);
  });

  it('never extends a line, never overlaps, never goes under 300 ms', () => {
    const line = seg('seg_0001', 5000, 9000, '嗯', [w('嗯', 8950, 8990)]);
    const [out] = anchorSegmentsToSpeech([line], { sourceLanguage: 'zh' }).segments;
    expect(out!.startMs).toBeGreaterThanOrEqual(5000);
    expect(out!.endMs).toBeLessThanOrEqual(9000);
    expect(out!.endMs - out!.startMs).toBeGreaterThanOrEqual(300);
  });
});

describe('needsSpeechMap', () => {
  it('asks for it only when a line has no words or a long pause inside', () => {
    const fine = seg('seg_0001', 0, 2000, '你好', [w('你', 0, 500), w('好', 500, 1900)]);
    const paused = seg('seg_0002', 3000, 9000, '你好', [w('你', 3000, 3300), w('好', 8000, 8900)]);
    const bare = seg('seg_0003', 10_000, 12_000, '你好');
    const silent = seg('seg_0004', 13_000, 14_000, ' ');
    expect(needsSpeechMap([fine, silent])).toBe(false);
    expect(needsSpeechMap([fine, paused])).toBe(true);
    expect(needsSpeechMap([fine, bare])).toBe(true);
  });
});

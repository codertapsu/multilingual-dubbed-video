import { describe, expect, it } from 'vitest';

import {
  candidateCuts,
  cutWindows,
  fallbackCut,
  partCount,
  partEffects,
  partsFromCuts,
  partTranscript,
  recapStart,
  validateCuts,
} from './seriesPlanner.js';

const MIN = 60_000;
/** A line every 5 s lasting 4 s, with a long pause after every 40th. */
function speech(durationMs: number): { startMs: number; endMs: number; sourceText: string }[] {
  const out = [];
  let t = 0;
  for (let i = 0; t < durationMs - 5000; i++) {
    out.push({ startMs: t, endMs: t + 4000, sourceText: `line ${i}` });
    t += i % 40 === 39 ? 8000 : 5000;
  }
  return out;
}

describe('candidateCuts', () => {
  it('scores pauses by length, and a scene change or a chapter mark nearby', () => {
    const lines = [
      { startMs: 0, endMs: 1000, sourceText: 'a' },
      { startMs: 1300, endMs: 2000, sourceText: 'b' }, // a breath: no cut
      { startMs: 4000, endMs: 5000, sourceText: 'c' }, // 2 s pause at 3000
      { startMs: 6000, endMs: 7000, sourceText: 'd' }, // 1 s pause at 5500
    ];
    expect(candidateCuts(lines, { scenes: [3200], chapters: [6500] })).toEqual([
      { ms: 3000, score: 4 },
      { ms: 5500, score: 4 },
    ]);
  });
});

describe('partCount', () => {
  it('aims at the middle of the chosen length and stays inside it', () => {
    expect(partCount(180 * MIN, 15, 20)).toBe(10);
    expect(partCount(40 * MIN, 15, 20)).toBe(2);
    expect(partCount(12 * MIN, 15, 20)).toBe(1);
    expect(partCount(180 * MIN, 60, 60)).toBe(3);
  });
});

describe('cut windows and the fallback', () => {
  it('takes the best pause near each evenly spaced target', () => {
    const lines = speech(60 * MIN);
    const candidates = candidateCuts(lines);
    const windows = cutWindows(60 * MIN, 3, { minMinutes: 15, maxMinutes: 20 }, candidates);
    expect(windows.map((w) => w.targetMs)).toEqual([20 * MIN, 40 * MIN]);
    for (const w of windows) {
      const cut = fallbackCut(w);
      expect(Math.abs(cut - w.targetMs)).toBeLessThan(w.toMs - w.targetMs + 1);
      // A long pause (score 4) beats a short one (score 1) when both are near.
      expect(w.candidates.find((c) => c.ms === cut)?.score).toBeGreaterThanOrEqual(1);
      // Never inside a line.
      expect(lines.some((l) => cut > l.startMs && cut < l.endMs)).toBe(false);
    }
  });
});

describe('recapStart', () => {
  const lines = [
    { startMs: 100_000, endMs: 103_000, sourceText: 'x' },
    { startMs: 103_500, endMs: 109_000, sourceText: 'y' },
  ];
  it('opens at the start of the line being said a few seconds before the cut', () => {
    // Ideal 106 s is inside "y" (started 2.5 s earlier): open at 103.5 s.
    expect(recapStart(110_000, 4, lines, 0)).toBe(103_500);
  });
  it('never opens before the previous part starts', () => {
    expect(recapStart(110_000, 4, lines, 105_000)).toBe(105_000);
  });
});

describe('partsFromCuts and partTranscript', () => {
  it('lays out parts with their recap, and gives each its lines in its own time', () => {
    const lines = [
      { id: 'seg_0001', index: 0, startMs: 1000, endMs: 4000, sourceText: 'a' },
      { id: 'seg_0002', index: 1, startMs: 96_000, endMs: 99_000, sourceText: 'b' },
      { id: 'seg_0003', index: 2, startMs: 101_000, endMs: 104_000, sourceText: 'c', words: [{ word: 'c', startMs: 101_000, endMs: 101_500 }] },
    ];
    const parts = partsFromCuts(200_000, [{ ms: 100_000, by: 'ai' }], 4, lines, [{ title: 'Mở đầu' }, { title: 'Tiếp' }]);
    expect(parts).toEqual([
      { index: 1, startMs: 0, endMs: 100_000, recapStartMs: 0, title: 'Mở đầu', summary: '', cutBy: 'start' },
      { index: 2, startMs: 100_000, endMs: 200_000, recapStartMs: 96_000, title: 'Tiếp', summary: '', cutBy: 'ai' },
    ]);
    const second = partTranscript(lines, parts[1]!);
    expect(second.map((l) => [l.id, l.startMs, l.endMs])).toEqual([
      ['seg_0001', 0, 3000],
      ['seg_0002', 5000, 8000],
    ]);
    expect(second[1]!.words![0]).toEqual({ word: 'c', startMs: 5000, endMs: 5500 });
  });

  it('refuses cuts that make a part shorter than a minute', () => {
    expect(validateCuts([30_000], 600_000)).toMatchObject({ ok: false });
    expect(validateCuts([300_000, 200_000], 600_000)).toEqual({ ok: true, cuts: [200_000, 300_000] });
  });
});

describe('partEffects', () => {
  it('titles the part, labels the recap, and says what comes next in the dub language', () => {
    const fx = partEffects({ index: 2, count: 7, seriesName: 'Tây Du Ký', title: 'Đại náo', recapEndMs: 4200, durationMs: 1_000_000, targetLanguage: 'vi-VN' });
    expect(fx.darkenUntilMs).toBe(4200);
    expect(fx.cards).toEqual([
      { kind: 'title', text: 'Tây Du Ký\nPhần 2/7: Đại náo', startMs: 300, endMs: 4200 },
      { kind: 'label', text: 'Phần trước', startMs: 0, endMs: 4200 },
      { kind: 'end', text: 'Còn tiếp · Phần 3', startMs: 996_500, endMs: 999_800 },
    ]);
    const last = partEffects({ index: 7, count: 7, seriesName: 'X', recapEndMs: 3000, durationMs: 60_000, targetLanguage: 'en-US' });
    expect(last.cards!.at(-1)!.text).toBe('The end');
  });
});

import { describe, expect, it } from 'vitest';

import { applySourceCorrections } from '../providers/translation/translationContext.js';
import { admissibleWindow, boundedWindow, partsOutsideBounds, type CutWindow } from './seriesPlanner.js';
import { seriesReviewReasons } from './seriesService.js';

const MIN = 60_000;

describe('cuts that keep every part within the bounds (field report B3)', () => {
  it('opens the first cut between min and max, and never leaves a remainder no split can fit', () => {
    // 50 min into 3 parts of 15-20 min: the first cut at 15..20 min, but
    // also leaving 30..40 min for the two parts after it: 15..20 min.
    expect(admissibleWindow(0, 1, 3, 50 * MIN, 15 * MIN, 20 * MIN)).toEqual({ fromMs: 15 * MIN, toMs: 20 * MIN });
    // After a first cut at 19 min, the second must leave 15..20 min for the last part: 34..35 min.
    expect(admissibleWindow(19 * MIN, 2, 3, 50 * MIN, 15 * MIN, 20 * MIN)).toEqual({ fromMs: 34 * MIN, toMs: 35 * MIN });
  });

  it('says when no cut can keep the bounds', () => {
    expect(admissibleWindow(0, 1, 2, 50 * MIN, 15 * MIN, 20 * MIN)).toBeUndefined();
  });

  it('narrows a window to the bounds and keeps only the pauses inside', () => {
    const w: CutWindow = { index: 1, targetMs: 25 * MIN, fromMs: 20 * MIN, toMs: 30 * MIN, candidates: [] };
    const candidates = [
      { ms: 21 * MIN, score: 2 },
      { ms: 24 * MIN, score: 1 },
      { ms: 29 * MIN, score: 3 },
    ];
    const b = boundedWindow(w, { fromMs: 22 * MIN, toMs: 26 * MIN }, candidates);
    expect(b).toMatchObject({ fromMs: 22 * MIN, toMs: 26 * MIN, targetMs: 25 * MIN });
    expect(b.candidates.map((c) => c.ms)).toEqual([24 * MIN]);
  });

  it('names the parts outside the bounds', () => {
    const parts = [
      { index: 1, startMs: 0, endMs: 18 * MIN },
      { index: 2, startMs: 18 * MIN, endMs: 44 * MIN },
      { index: 3, startMs: 44 * MIN, endMs: 52 * MIN },
    ];
    expect(partsOutsideBounds(parts, 15, 20).map((p) => p.index)).toEqual([2, 3]);
  });
});

describe('the review gate (Phase 4.1)', () => {
  const settings = (diarize: boolean) => ({ settings: { diarize } as never });
  const warning = (code: string) => ({ code, at: '', key: '', message: '' }) as never;

  it('is clean without warnings', () => {
    expect(seriesReviewReasons(settings(true), { warnings: [] })).toEqual([]);
  });

  it('stops when speakers were asked for and detection failed, or loops were left', () => {
    expect(seriesReviewReasons(settings(true), { warnings: [warning('speakers-failed')] })).toHaveLength(1);
    expect(seriesReviewReasons(settings(false), { warnings: [warning('speakers-failed')] })).toHaveLength(0);
    expect(seriesReviewReasons(settings(false), { warnings: [warning('loops-left')] })[0]).toMatchObject({ code: 'loops-left' });
    // A repaired loop, or a GPU fallback, is no reason to stop.
    expect(seriesReviewReasons(settings(true), { warnings: [warning('loops-repaired'), warning('gpu-fallback')] })).toEqual([]);
  });
});

describe('source corrections (heard as -> is)', () => {
  it('fixes every whole match, in order, and ignores empty or identical pairs', () => {
    const fixes = [
      { heard: '枪人', is: '羌人' },
      { heard: '', is: 'x' },
      { heard: '同', is: '同' },
    ];
    expect(applySourceCorrections('枪人来了，枪人走了', fixes)).toBe('羌人来了，羌人走了');
    expect(applySourceCorrections('没有', undefined)).toBe('没有');
  });
});

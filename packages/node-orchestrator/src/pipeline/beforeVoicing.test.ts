import { describe, expect, it } from 'vitest';
import type { AlignedSegment, ProjectWarning } from '@videodubber/shared';

import { flaggedLinesWarning, timingConflictWarning } from './beforeVoicing.js';
import { withFlaggedLinesNow } from './transcriptWarnings.js';

const aligned = (segmentId: string, status: AlignedSegment['status']): AlignedSegment =>
  ({ segmentId, status, startMs: 0, endMs: 1000, audioPath: '', generatedDurationMs: 1, placedDurationMs: 1, speedRatio: 1, overflowMs: 0 }) as AlignedSegment;

describe('what a dub would voice with a problem (claude-dubber H7)', () => {
  it('names the lines still failing the checks, and what to do about them', () => {
    const flagged = [
      { id: 'seg_0489', flags: ['pinyin' as const], text: 'Pan Bowen đến rồi' },
      { id: 'seg_0653', flags: ['no-diacritics' as const], text: 'Toi khong biet gi ca' },
    ];
    const voiced = flaggedLinesWarning(flagged, false);
    expect(voiced).toMatchObject({ code: 'lines-flagged', key: 'warning.lines-flagged', params: { count: 2, ids: 'seg_0489, seg_0653' } });
    expect(voiced.message).toContain('seg_0489 (a pinyin name), seg_0653 (no diacritics)');
    expect(voiced.message).toContain('holdFlaggedLines');
    expect(flaggedLinesWarning(flagged, true)).toMatchObject({ key: 'warning.lines-flagged-held' });
    expect(flaggedLinesWarning(flagged, true).message).toContain('stopped before voicing');
  });

  it('names the lines that cannot fit even at the fastest speed', () => {
    const units = [aligned('seg_0001', 'ok'), aligned('seg_0004', 'timing-conflict'), aligned('seg_0009', 'needs-review'), aligned('seg_0012', 'timing-conflict')];
    expect(timingConflictWarning(units, 1.6)).toMatchObject({
      code: 'timing-conflicts',
      key: 'warning.timing-conflicts',
      params: { count: 2, ids: 'seg_0004, seg_0012', speed: 1.6 },
    });
  });

  it('keeps the warning true as the lines are fixed: fewer, then none', () => {
    const raised: ProjectWarning = { ...flaggedLinesWarning([
      { id: 'seg_0001', flags: ['pinyin'], text: 'Kunlun' },
      { id: 'seg_0002', flags: ['alternatives'], text: 'thầy/cô' },
    ], true), step: 'refine', at: '2026-11-25T08:00:00.000Z' };
    const other: ProjectWarning = { code: 'gpu-fallback', key: 'warning.gpu-fallback', message: 'cpu', step: 'tts', at: 'x' };
    const one = withFlaggedLinesNow([other, raised], [
      { id: 'seg_0001', qualityFlags: ['pinyin'], translatedText: 'Kunlun' },
      { id: 'seg_0002', translatedText: 'Cảm ơn sư phụ', locked: true },
    ]);
    expect(one?.[1]).toMatchObject({ code: 'lines-flagged', key: 'warning.lines-flagged-held', params: { count: 1, ids: 'seg_0001' }, at: raised.at, step: 'refine' });
    expect(withFlaggedLinesNow([other, raised], [{ id: 'seg_0001', qualityFlags: ['pinyin'] }, { id: 'seg_0002', qualityFlags: ['alternatives'] }])).toBeUndefined();
    expect(withFlaggedLinesNow([other, raised], [{ id: 'seg_0001', translatedText: 'Côn Lôn' }, { id: 'seg_0002', qualityFlags: ['alternatives'], song: true }])).toEqual([other]);
    // Never raised outside a run.
    expect(withFlaggedLinesNow([other], [{ id: 'seg_0001', qualityFlags: ['pinyin'] }])).toBeUndefined();
  });
});

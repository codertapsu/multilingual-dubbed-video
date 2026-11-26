import { describe, expect, it } from 'vitest';

import type { AlignedSegment, TranscriptSegment } from '../models/domain.js';
import { lineIssueCounts, lineIssuesFrom, OVERRUN_REPORT_MS, warningDismissed } from './lineIssues.js';

const line = (id: string, over: Partial<TranscriptSegment> = {}): Pick<TranscriptSegment, 'id' | 'qualityFlags' | 'locked' | 'song'> => ({ id, ...over });
const unit = (segmentId: string, status: AlignedSegment['status'], overflowMs: number) => ({ segmentId, status, overflowMs });

describe('the lines to look at after a dub (H7, 2026-11-25)', () => {
  it('lists the lines still failing the checks, never a locked one (the user kept it) nor a song', () => {
    const issues = lineIssuesFrom(
      [
        line('seg_0001', { qualityFlags: ['pinyin'] }),
        line('seg_0002'),
        line('seg_0003', { qualityFlags: ['no-diacritics', 'alternatives'] }),
        line('seg_0004', { qualityFlags: ['wrong-script'], locked: true }),
        line('seg_0005', { qualityFlags: ['untranslated'], song: true }),
        line('seg_0006', { qualityFlags: [] }),
      ],
      undefined,
    );
    expect(issues).toEqual({
      flagged: [
        { id: 'seg_0001', flags: ['pinyin'] },
        { id: 'seg_0003', flags: ['no-diacritics', 'alternatives'] },
      ],
      overruns: [],
    });
  });

  it(`lists the voices running into the next line by more than ${OVERRUN_REPORT_MS} ms, not the ones that fit or barely run over`, () => {
    const issues = lineIssuesFrom(undefined, [
      unit('seg_0010', 'timing-conflict', 450.4),
      unit('seg_0011', 'timing-conflict', OVERRUN_REPORT_MS),
      unit('seg_0012', 'needs-review', 900),
      unit('seg_0013', 'ok', 0),
      unit('seg_0014', 'timing-conflict', 1200),
    ]);
    expect(issues.overruns).toEqual([
      { id: 'seg_0010', overflowMs: 450 },
      { id: 'seg_0014', overflowMs: 1200 },
    ]);
  });

  it('sets them aside when their warning was dismissed, until a run raises it again', () => {
    const lines = [line('seg_0001', { qualityFlags: ['pinyin'] })];
    const aligned = [unit('seg_0002', 'timing-conflict', 800)];
    const dismissed = { warnings: [], dismissedWarnings: [{ code: 'lines-flagged' }] };
    const issues = lineIssuesFrom(lines, aligned, dismissed);
    expect(issues).toMatchObject({ flaggedDismissed: true, flagged: [{ id: 'seg_0001' }] });
    expect(issues.overrunsDismissed).toBeUndefined();
    expect(lineIssueCounts(issues)).toEqual({ flagged: 0, overruns: 1 });

    const raisedAgain = { warnings: [{ code: 'lines-flagged' }], dismissedWarnings: [{ code: 'lines-flagged' }] };
    expect(warningDismissed(raisedAgain, 'lines-flagged')).toBe(false);
    expect(lineIssueCounts(lineIssuesFrom(lines, aligned, raisedAgain))).toEqual({ flagged: 1, overruns: 1 });
    expect(warningDismissed(undefined, 'lines-flagged')).toBe(false);
  });
});

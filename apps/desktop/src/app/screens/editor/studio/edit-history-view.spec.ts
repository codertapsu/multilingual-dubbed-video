import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from '../../../core/models';
import { clock, lineChanges, lineNumber, rangeView, refusalLines } from './edit-history-view';

const line = (id: string, startMs: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment =>
  ({ id, index: 0, startMs, endMs: startMs + 1500, sourceText: text, ...extra }) as TranscriptSegment;

describe('the History panel\'s views', () => {
  it('shows what each line of an entry changed, speaker included', () => {
    const before = [line('seg_0012', 41_000, '你好', { translatedText: 'Chào', speakerId: 'SPEAKER_01' })];
    const after = [line('seg_0012', 41_000, '你好', { translatedText: 'Xin chào', speakerId: 'SPEAKER_04', locked: true })];
    const { lines, more } = lineChanges({ before, after });
    expect(more).toBe(0);
    expect(lines).toEqual([
      {
        id: 'seg_0012',
        atMs: 41_000,
        fields: [
          { field: 'translatedText', before: 'Chào', after: 'Xin chào' },
          { field: 'speakerId', before: 'SPEAKER_01', after: 'SPEAKER_04' },
          { field: 'locked', before: 'no', after: 'yes' },
        ],
      },
    ]);
  });

  it('caps a long entry and says how many are left out', () => {
    const before = Array.from({ length: 40 }, (_, i) => line(`seg_${i}`, i * 2000, 'a'));
    const after = before.map((l) => ({ ...l, sourceText: 'b' }));
    expect(lineChanges({ before, after }, 30)).toMatchObject({ more: 10 });
    expect(lineChanges({ before, after }, 30).lines).toHaveLength(30);
  });

  it('shows a range as its lines before and after, in time order', () => {
    const v = rangeView({ before: [line('seg_0003', 5000, 'loop'), line('seg_0002', 3000, 'loop', { speakerId: 'SPEAKER_02' })], after: [line('seg_0002', 3000, 'fixed')] });
    expect(v.before).toEqual([
      { atMs: 3000, text: 'loop', speakerId: 'SPEAKER_02' },
      { atMs: 5000, text: 'loop' },
    ]);
    expect(v.after).toEqual([{ atMs: 3000, text: 'fixed' }]);
  });

  it('words a refused undo from the server\'s changes', () => {
    expect(
      refusalLines([
        { id: 'seg_0012', atMs: 41_000, what: 'translatedText', now: 'Ba', expected: 'Hai' },
        { id: 'seg_0013', atMs: 43_000, what: 'missing' },
        { what: 'count', now: '3', expected: '2' },
        { what: 'already-undone' },
      ]),
    ).toEqual([
      { key: 'history.change-field', params: { line: '12', at: '0:41', field: 'history.field-translation', now: 'Ba', expected: 'Hai' } },
      { key: 'history.change-missing', params: { line: '13', at: '0:43' } },
      { key: 'history.change-count', params: { now: '3', expected: '2' } },
      { key: 'history.refused-undone', params: {} },
    ]);
    expect(lineNumber('seg_0007')).toBe('7');
    expect(lineNumber('custom')).toBe('custom');
    expect(clock(3_725_000)).toBe('1:02:05');
  });
});

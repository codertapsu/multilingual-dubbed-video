import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from '../../../core/models';
import en from '../../../../i18n/en.json';
import vi from '../../../../i18n/vi.json';
import { clock, historySummary, lineChanges, lineNumber, rangeView, refusalLines, type Translate } from './edit-history-view';

/** TranslateService.instant over one bundled locale: the key itself on a miss. */
function translator(tree: unknown): Translate {
  return (key, params = {}) => {
    let node: unknown = tree;
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    if (typeof node !== 'string') return key;
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params[name] ?? ''));
  };
}

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
          // Yes/no values are translation keys, shown in the reader's language.
          { field: 'locked', before: 'history.flag-no', after: 'history.flag-yes' },
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

  it('shows each entry in the reader\'s language, the English summary for older ones', () => {
    const t = translator(vi);
    expect(
      historySummary(
        { summary: 'Changed the text of 2, timing of 1 line(s)', summaryKey: 'history.summary.changed', summaryParams: { text: 2, timing: 1, speaker: 0, voice: 0, pace: 0, lock: 0 } },
        t,
      ),
    ).toBe('Đổi lời của 2 câu, thời điểm của 1 câu');
    expect(
      historySummary(
        {
          summary: 'Re-transcribed 24:12:04–24:27:04: 14 lines, 2 loops removed',
          summaryKey: 'history.summary.retranscribed',
          summaryParams: { from: '24:12:04', to: '24:27:04', lines: 14, removed: 2, kept: 0, left: 0, unassigned: 0 },
        },
        t,
      ),
    ).toBe('Chép lời lại đoạn 24:12:04–24:27:04: 14 câu, bỏ 2 đoạn lặp');
    // Before 0.18.0 entries had no key: their English sentence is all there is.
    expect(historySummary({ summary: 'Replaced 3 line(s) with 2 at 0:10–0:20' }, t)).toBe('Replaced 3 line(s) with 2 at 0:10–0:20');
    // A key this version does not know (a newer app wrote it) falls back too.
    expect(historySummary({ summary: 'Something new', summaryKey: 'history.summary.from-the-future', summaryParams: {} }, t)).toBe('Something new');
    expect(historySummary({ summary: 'x', summaryKey: 'history.summary.translation-edited', summaryParams: { n: 4 } }, translator(en))).toBe(
      'Edited the translation of 4 line(s)',
    );
  });

  it('words an undo by the change it undid, an undo of an undo included', () => {
    const t = translator(vi);
    const undo = {
      summary: 'Undid: Kept 2 line(s) as the original song at 1:02',
      summaryKey: 'history.summary.undo',
      summaryParams: { n: 2, at: '1:02', of: 'history.summary.songs-kept', text: 'Kept 2 line(s) as the original song at 1:02' },
    };
    expect(historySummary(undo, t)).toBe('Đã hoàn tác: Giữ bài hát gốc cho 2 câu ở 1:02');
    expect(historySummary({ ...undo, summary: 'Undid: ' + undo.summary, summaryParams: { ...undo.summaryParams, depth: 2 } }, t)).toBe(
      'Đã hoàn tác: Đã hoàn tác: Giữ bài hát gốc cho 2 câu ở 1:02',
    );
    // The undone change was written before 0.18.0: its English text, under a translated "Undid".
    expect(historySummary({ summary: 'Undid: Old words', summaryKey: 'history.summary.undo', summaryParams: { of: '', text: 'Old words' } }, t)).toBe(
      'Đã hoàn tác: Old words',
    );
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

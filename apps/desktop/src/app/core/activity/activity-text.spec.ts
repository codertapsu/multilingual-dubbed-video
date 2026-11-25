import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { ActivityEntry } from './activity-models';
import { entryText, phraseText, type ActivityTranslate } from './activity-logic';

/** TranslateService.instant over one bundled locale: the key itself on a miss. */
function translator(tree: unknown): ActivityTranslate {
  return (key, params = {}) => {
    let node: unknown = tree;
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    if (typeof node !== 'string') return key;
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params[name] ?? ''));
  };
}

const entry = (over: Partial<ActivityEntry>): ActivityEntry =>
  ({ id: 'act_1', kind: 'dub.run', title: 'Dubbing “Clip”', initiator: { kind: 'ui' }, state: 'running', percent: 10, startedAt: '', updatedAt: '', ...over }) as ActivityEntry;

describe('the activity list in the reader\'s language', () => {
  const t = translator(vi);

  it('words a phrase with its parts, and a value that is itself a key', () => {
    expect(phraseText({ key: 'activity.text.revoice-progress', params: { n: 3 }, parts: [{ key: 'activity.text.part-failed', params: { n: 1 } }, { key: 'activity.text.part-left', params: { n: 2 } }] }, t)).toBe(
      'Đã tạo lại giọng cho 3 câu, 1 câu lỗi, còn 2 câu',
    );
    expect(phraseText({ key: 'activity.text.paused-at', params: { stepKey: 'opt.step.tts' } }, translator(en))).toBe(
      'Paused at “Synthesize speech (TTS)”: it continues where it stopped',
    );
  });

  it('keeps the English text for older entries, agents\' reports and keys it does not know', () => {
    expect(entryText(entry({ titlePhrase: { key: 'activity.text.dub-run', params: { name: 'Clip' } } }), 'title', t)).toBe('Lồng tiếng “Clip”');
    expect(entryText(entry({}), 'title', t)).toBe('Dubbing “Clip”');
    expect(entryText(entry({ result: 'Something new', resultPhrase: { key: 'activity.text.from-the-future' } }), 'result', t)).toBe('Something new');
    // A known head with an unknown part falls back whole, never half-translated.
    expect(entryText(entry({ message: 'Two', messagePhrase: { key: 'activity.text.starting', parts: [{ key: 'activity.text.nope' }] } }), 'message', t)).toBe('Two');
    expect(entryText(entry({}), 'result', t)).toBeUndefined();
  });
});

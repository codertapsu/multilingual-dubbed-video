import { describe, expect, it } from 'vitest';

import { REDUB_STAGES } from '../../../core/util/settings-options';
import { handLockedCount, retranslates } from './redub';

describe('redub (what a re-dub replaces)', () => {
  it('only the stages up to translation translate every line again', () => {
    expect(REDUB_STAGES.filter(retranslates)).toEqual(['stt', 'translation']);
    // The review pass and everything after it keep the lines as they are.
    for (const step of ['refine', 'tts', 'alignment', 'audio-mix', 'render'] as const) expect(retranslates(step)).toBe(false);
  });

  it('counts the lines written or locked by hand', () => {
    expect(handLockedCount([{ locked: true }, {}, { locked: false }, { locked: true }])).toBe(2);
    expect(handLockedCount([])).toBe(0);
  });
});

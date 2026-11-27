import { describe, expect, it } from 'vitest';

import { assertMainOnly, mainOnlyProblem } from './mainOnly.js';

const mine = new Map([['vp_1c5829eebcee717c', 'Giọng của tôi']]);

describe('a voice kept for one main character', () => {
  it('is never a default voice', () => {
    expect(mainOnlyProblem({ defaultMaleVoiceId: 'vp_1c5829eebcee717c' }, { speakerVoices: false, defaults: true }, mine)).toBe(
      '"Giọng của tôi" is kept for one main character, so it cannot be the voice of every male speaker who has none of their own.',
    );
    expect(mainOnlyProblem({ defaultFemaleVoiceId: 'vieneu38-my-duyen' }, { speakerVoices: false, defaults: true }, mine)).toBeUndefined();
  });

  it('speaks for one speaker at most', () => {
    const two = {
      speakerVoices: [
        { speakerId: 'SPEAKER_00', voiceId: 'vp_1c5829eebcee717c' },
        { speakerId: 'SPEAKER_07', voiceId: 'vp_1c5829eebcee717c' },
      ],
    };
    expect(mainOnlyProblem(two, { speakerVoices: true, defaults: false }, mine)).toContain('2 speakers would speak with it (SPEAKER_00, SPEAKER_07)');
    expect(mainOnlyProblem({ speakerVoices: two.speakerVoices.slice(0, 1) }, { speakerVoices: true, defaults: false }, mine)).toBeUndefined();
    // Only what the change touches is checked: an old table never blocks another edit.
    expect(mainOnlyProblem(two, { speakerVoices: false, defaults: false }, mine)).toBeUndefined();
    expect(mainOnlyProblem(two, { speakerVoices: true, defaults: true }, new Map())).toBeUndefined();
    // The two ids of one character (the sheet's), as a cast by character gives it to them (2026-11-27).
    const hero = new Map([
      ['SPEAKER_00', 'lục trần'],
      ['SPEAKER_07', 'lục trần'],
    ]);
    expect(mainOnlyProblem(two, { speakerVoices: true, defaults: false }, mine, hero)).toBeUndefined();
    expect(mainOnlyProblem(two, { speakerVoices: true, defaults: false }, mine, new Map([['SPEAKER_00', 'lục trần']]))).toContain('2 speakers would speak with it');
  });

  it('is refused as an edit, with the way out', () => {
    expect(() => assertMainOnly({ defaultMaleVoiceId: 'vp_1c5829eebcee717c' }, { speakerVoices: false, defaults: true }, mine)).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ code: 'INVALID_EDIT', remediation: expect.stringContaining('Only for one main character') }) }),
    );
  });
});

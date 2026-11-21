import { describe, expect, it } from 'vitest';

import { cosine, proposeCast, type CastSpeaker, type CastVoice } from './casting.js';

const speaker = (speakerId: string, minutes: number, gender: CastSpeaker['gender'], f0Hz?: number, print?: number[]): CastSpeaker => ({
  speakerId,
  minutes,
  ...(gender ? { gender } : {}),
  ...(f0Hz ? { f0Hz } : {}),
  ...(print ? { print } : {}),
});
const profile = (voiceId: string, gender: 'male' | 'female', f0Hz: number, confirmed = true, print?: number[]): CastVoice => ({
  voiceId,
  name: voiceId,
  kind: 'profile',
  gender,
  genderConfirmed: confirmed,
  f0Hz,
  ...(print ? { print } : {}),
});
const preset = (voiceId: string, gender: 'male' | 'female', f0Hz: number): CastVoice => ({ voiceId, name: voiceId, kind: 'preset', gender, f0Hz });

describe('proposeCast', () => {
  it('gives the most-heard speakers the user\'s clones first, paired by pitch rank, the rest a default per gender', () => {
    const speakers = [
      speaker('SPEAKER_00', 120, 'male', 110),
      speaker('SPEAKER_01', 90, 'male', 160),
      speaker('SPEAKER_02', 40, 'female', 230),
      speaker('SPEAKER_03', 5, 'male', 130),
      speaker('SPEAKER_04', 2, 'unknown'),
      speaker('SPEAKER_05', 1, 'male', 140),
    ];
    const voices = [preset('builtin-m', 'male', 120), profile('vp_thien', 'male', 116), profile('vp_quan', 'male', 153), profile('vp_vy', 'female', 213)];
    const cast = proposeCast(speakers, voices);
    const by = Object.fromEntries(cast.assignments.map((a) => [a.speakerId, a.voiceId]));
    // Two male clones for the two most-heard men, the lower voice to the lower speaker.
    expect(by['SPEAKER_00']).toBe('vp_thien');
    expect(by['SPEAKER_01']).toBe('vp_quan');
    expect(by['SPEAKER_02']).toBe('vp_vy');
    // The third man gets the built-in voice, the fourth shares the first male voice;
    // the unknown one keeps the project voice.
    expect(by['SPEAKER_03']).toBe('builtin-m');
    expect(cast.assignments.find((a) => a.speakerId === 'SPEAKER_05')).toMatchObject({ by: 'default', voiceId: 'vp_thien' });
    expect(cast.unassigned).toEqual(['SPEAKER_04']);
    expect(cast.defaults).toEqual({ male: 'vp_thien', female: 'vp_vy' });
  });

  it('never casts a clone whose gender the user has not confirmed, and names it', () => {
    const cast = proposeCast([speaker('SPEAKER_00', 10, 'male', 150)], [profile('vp_bon', 'male', 170, false), preset('builtin-m', 'male', 120)]);
    expect(cast.unconfirmed).toEqual([{ voiceId: 'vp_bon', name: 'vp_bon' }]);
    expect(cast.assignments[0]!.voiceId).toBe('builtin-m');
  });

  it('pairs by voice print only when it beats chance by two standard deviations', () => {
    const e = (i: number): number[] => Array.from({ length: 4 }, (_, j) => (j === i ? 1 : 0));
    // Each speaker's print matches exactly one voice, against their pitch order.
    const speakers = [speaker('S0', 50, 'female', 200, e(0)), speaker('S1', 40, 'female', 250, e(1)), speaker('S2', 30, 'female', 300, e(2))];
    const voices = [profile('vA', 'female', 300, true, e(0)), profile('vB', 'female', 250, true, e(1)), profile('vC', 'female', 200, true, e(2))];
    const cast = proposeCast(speakers, voices);
    expect(cast.assignments.map((a) => [a.speakerId, a.voiceId, a.by])).toEqual([
      ['S0', 'vA', 'print'],
      ['S1', 'vB', 'print'],
      ['S2', 'vC', 'print'],
    ]);
    // Noise-level prints: pitch rank decides.
    const flat = [0.5, 0.5, 0.5, 0.5];
    const noisy = proposeCast(
      speakers.map((s) => ({ ...s, print: flat })),
      voices.map((v) => ({ ...v, print: flat })),
    );
    expect(noisy.assignments.map((a) => [a.speakerId, a.voiceId, a.by])).toEqual([
      ['S0', 'vC', 'pitch-rank'],
      ['S1', 'vB', 'pitch-rank'],
      ['S2', 'vA', 'pitch-rank'],
    ]);
  });

  it('computes cosine similarity, 0 for a missing print', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine(undefined, [1])).toBe(0);
  });
});

describe('suggestGender', () => {
  it('suggests the gender whose built-in voices the clone sounds closest to, and abstains when unsure', async () => {
    const { suggestGender } = await import('./casting.js');
    const refs = [
      { gender: 'male' as const, print: [1, 0, 0] },
      { gender: 'male' as const, print: [0.9, 0.1, 0] },
      { gender: 'female' as const, print: [0, 1, 0] },
      { gender: 'female' as const, print: [0.1, 0.9, 0] },
    ];
    expect(suggestGender([0.95, 0.05, 0], refs)?.gender).toBe('male');
    expect(suggestGender([0.05, 0.95, 0], refs)?.gender).toBe('female');
    expect(suggestGender([0.7, 0.7, 0], refs)).toBeUndefined();
    expect(suggestGender([1, 0, 0], refs.filter((r) => r.gender === 'male'))).toBeUndefined();
  });
});

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
    // The third man gets the built-in voice; the fourth is a minor speaker: he
    // never gets a clone (F4: 59 minor men spoke with the user's own voice),
    // but the least-heard cast speaker's built-in voice, shared. The unknown
    // one keeps the project voice.
    expect(by['SPEAKER_03']).toBe('builtin-m');
    expect(cast.assignments.find((a) => a.speakerId === 'SPEAKER_05')).toMatchObject({ by: 'pool', voiceId: 'builtin-m' });
    expect(cast.pools.male?.voices).toEqual([
      { voiceId: 'builtin-m', name: 'builtin-m', from: 'reused', sharedWith: 'SPEAKER_03', speakers: ['SPEAKER_05'], minutes: 1 },
    ]);
    expect(cast.unassigned).toEqual(['SPEAKER_04']);
    // A speaker detected later gets the pool's voice; no female voice is free
    // (her one voice is a clone of a main speaker's), so no default is offered.
    expect(cast.defaults).toEqual({ male: 'builtin-m' });
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

describe('the minor speakers share a pool (F4)', () => {
  const unit = (i: number, dim = 40): number[] => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));
  const femalePreset = (id: string, f0: number, print: number[]): CastVoice => ({ voiceId: id, name: id, kind: 'preset', gender: 'female', f0Hz: f0, print });

  it('sizes the pool clamp(ceil(minor / 10), 3, 6), or as the setting says (1..12)', async () => {
    const { minorPoolSize } = await import('./casting.js');
    expect([1, 5, 25, 30, 31, 59, 100].map((n) => minorPoolSize(n))).toEqual([3, 3, 3, 3, 4, 6, 6]);
    expect(minorPoolSize(59, 8)).toBe(8);
    expect(minorPoolSize(59, 40)).toBe(12);
    expect(minorPoolSize(59, 0)).toBe(6);
  });

  // The 27.8-hour series in miniature (its voices: 6 male clones + 14 male
  // built-ins, two of them soundalikes of a clone; 5 female clones + 11
  // female built-ins, one a soundalike; 79 men, 14 women).
  const series = (): { speakers: CastSpeaker[]; voices: CastVoice[] } => {
    const voices: CastVoice[] = [
      ...Array.from({ length: 6 }, (_, i) => profile(`m-clone${i}`, 'male', 100 + i * 15, true, unit(i))),
      ...Array.from({ length: 12 }, (_, i) => ({ ...preset(`m-builtin${i}`, 'male', 95 + i * 7), print: unit(10 + i) })),
      { ...preset('m-soundalike0', 'male', 115), print: unit(0) },
      { ...preset('m-soundalike1', 'male', 160), print: unit(1) },
      ...Array.from({ length: 5 }, (_, i) => profile(`f-clone${i}`, 'female', 180 + i * 20, true, unit(5 + i, 40).map((x, j) => (j === 30 + i ? 1 : x)))),
      ...Array.from({ length: 10 }, (_, i) => femalePreset(`f-builtin${i}`, 170 + i * 8, unit(22 + i))),
      femalePreset('f-soundalike', 230, unit(5 + 0, 40).map((x, j) => (j === 30 ? 1 : x))),
    ];
    const men = Array.from({ length: 79 }, (_, i) => speaker(`SPEAKER_${String(i).padStart(2, '0')}`, i < 18 ? 200 - i : 6 - i * 0.05, 'male', 90 + ((i * 13) % 80)));
    const women = Array.from({ length: 14 }, (_, i) => speaker(`SPEAKER_${String(79 + i).padStart(2, '0')}`, 150 - i, 'female', 170 + ((i * 11) % 90)));
    return { speakers: [...men, ...women], voices };
  };

  it('the series\' men: 59+ minor speakers on 6 voices, never a clone, the soundalikes left out', () => {
    const { speakers, voices } = series();
    const cast = proposeCast(speakers, voices);
    const by = new Map(cast.assignments.map((a) => [a.speakerId, a]));
    const men = speakers.filter((s) => s.gender === 'male');
    // A crowd shares a pool anyway: the soundalikes voice no one (they would
    // make a main character sound like the one a clone speaks for).
    const mains = men.slice(0, 18).map((s) => by.get(s.speakerId)!);
    expect(mains.filter((a) => a.voiceId.startsWith('m-clone'))).toHaveLength(6);
    expect(mains.filter((a) => a.voiceId.startsWith('m-builtin'))).toHaveLength(12);
    expect(cast.assignments.some((a) => a.voiceId.startsWith('m-soundalike'))).toBe(false);
    expect(cast.soundalikes.map((s) => [s.voiceId, s.cloneId])).toEqual([
      ['m-soundalike0', 'm-clone0'],
      ['m-soundalike1', 'm-clone1'],
      ['f-soundalike', 'f-clone0'],
    ]);
    // 61 minor men -> 6 voices; no built-in is spare, so the 6 least-heard cast men's voices are shared.
    const pool = cast.pools.male!;
    expect(pool).toMatchObject({ minorSpeakers: 61, size: 6 });
    expect(pool.voices.map((v) => v.from)).toEqual(Array(6).fill('reused'));
    expect(pool.voices.map((v) => v.sharedWith)).toEqual(['SPEAKER_17', 'SPEAKER_16', 'SPEAKER_15', 'SPEAKER_14', 'SPEAKER_13', 'SPEAKER_12']);
    expect(pool.voices.map((v) => v.speakers.length).sort()).toEqual([10, 10, 10, 10, 10, 11]);
    for (const s of men.slice(18)) {
      const a = by.get(s.speakerId)!;
      expect(a.by).toBe('pool');
      expect(a.voiceId).toMatch(/^m-builtin/);
    }
    expect(cast.defaults.male).toBe(pool.voices[0]!.voiceId);
    expect(cast.notes).toContain('male: 61 minor speaker(s) share 6 voice(s), about 10 each; speakers who answer each other get different voices where possible.');
    expect(cast.notes.join(' ')).toMatch(/no spare built-in voice, so the voices of the least-heard cast speaker\(s\) SPEAKER_17, .* are shared too/);
  });

  it('the series\' women: 5 clones + 9 built-ins cast, 2 left; the clean spare is the default, the soundalike never', () => {
    const { speakers, voices } = series();
    const cast = proposeCast(speakers, voices);
    const women = cast.assignments.filter((a) => a.voiceId.startsWith('f-'));
    expect(women).toHaveLength(14);
    expect(women.filter((a) => a.voiceId.startsWith('f-clone'))).toHaveLength(5);
    expect(women.some((a) => a.voiceId === 'f-soundalike')).toBe(false);
    expect(cast.pools.female).toBeUndefined();
    expect(cast.defaults.female).toBe('f-builtin9');
    expect(cast.notes.join(' ')).toMatch(/Built-in voice "f-soundalike" is left out of shared use: it sounds like your cloned voice "f-clone0" \(1.00\)/);
  });

  it('gives speakers who answer each other different pool voices', async () => {
    const { dialogueAdjacency } = await import('./casting.js');
    const voices = [preset('voice-1', 'male', 100), preset('voice-2', 'male', 120)];
    const speakers = [speaker('M1', 60, 'male', 100), speaker('M2', 50, 'male', 120), speaker('A', 10, 'male', 120), speaker('B', 9, 'male', 125), speaker('C', 8, 'male', 130), speaker('D', 7, 'male', 135)];
    // The two voices of the least-heard cast men, in rotation (fewest
    // speakers first, then least heard): A and D end up sharing one.
    const plain = proposeCast(speakers, voices, { minorVoices: 2 });
    const voiceOf = (c: ReturnType<typeof proposeCast>, id: string): string => c.assignments.find((a) => a.speakerId === id)!.voiceId;
    expect(plain.pools.male!.voices.map((v) => [v.voiceId, v.speakers])).toEqual([
      ['voice-2', ['A', 'D']],
      ['voice-1', ['B', 'C']],
    ]);
    // A and D answer each other: D takes the other voice.
    const lines = [
      { speakerId: 'A', startMs: 0, endMs: 1000 },
      { speakerId: 'D', startMs: 1200, endMs: 2000 },
      { speakerId: 'A', startMs: 2100, endMs: 3000 },
      { speakerId: 'D', startMs: 3100, endMs: 4000 },
    ];
    const talk = proposeCast(speakers, voices, { minorVoices: 2, adjacency: dialogueAdjacency(lines) });
    expect(voiceOf(talk, 'A')).not.toBe(voiceOf(talk, 'D'));
    // And a minor speaker who answers the cast speaker a pool voice belongs to avoids it too.
    const withMain = proposeCast(speakers, voices, {
      minorVoices: 2,
      adjacency: dialogueAdjacency([
        { speakerId: 'M2', startMs: 0, endMs: 1000 },
        { speakerId: 'A', startMs: 1100, endMs: 2000 },
      ]),
    });
    expect(voiceOf(withMain, 'A')).not.toBe(voiceOf(withMain, 'M2'));
  });

  it('counts the turns that follow each other closely, between two different speakers', async () => {
    const { dialogueAdjacency } = await import('./casting.js');
    const adj = dialogueAdjacency([
      { speakerId: 'A', startMs: 0, endMs: 1000 },
      { speakerId: 'A', startMs: 1100, endMs: 2000 },
      { startMs: 2100, endMs: 2500 },
      { speakerId: 'B', startMs: 2600, endMs: 3000 },
      { speakerId: 'C', startMs: 9000, endMs: 9500 },
    ]);
    expect(adj.get('A')?.get('B')).toBe(1);
    expect(adj.get('B')?.get('A')).toBe(1);
    expect(adj.get('B')?.get('C')).toBeUndefined(); // 6 s apart: not an exchange
    expect(adj.get('A')?.get('A')).toBeUndefined();
  });

  it('never spends a clone on the crowd unless the user picks one', () => {
    const voices = [profile('clone-a', 'male', 110), profile('clone-b', 'male', 150)];
    const speakers = [speaker('S0', 50, 'male', 110), speaker('S1', 40, 'male', 150), speaker('S2', 3, 'male', 130)];
    const auto = proposeCast(speakers, voices);
    expect(auto.assignments.find((a) => a.speakerId === 'S2')).toBeUndefined();
    expect(auto.pools.male).toBeUndefined();
    expect(auto.defaults.male).toBeUndefined();
    expect(auto.notes).toContain('male: no built-in voice is free for 1 minor speaker(s): they keep the project voice (choose voices for them).');
    const picked = proposeCast(speakers, voices, { minorPool: { male: ['clone-b', 'not-a-voice'] } });
    expect(picked.assignments.find((a) => a.speakerId === 'S2')).toMatchObject({ voiceId: 'clone-b', by: 'pool' });
    expect(picked.pools.male!.voices).toMatchObject([{ voiceId: 'clone-b', from: 'picked', sharedWith: 'S1' }]);
  });

  it('never shares a voice kept for one main character, even picked for the pool, nor makes it a default', () => {
    const mine = { ...profile('vp_mine', 'male', 120), name: 'Giọng của tôi', mainOnly: true };
    const voices = [mine, preset('builtin-a', 'male', 100), preset('builtin-b', 'male', 140)];
    const speakers = [speaker('S0', 50, 'male', 120), speaker('S1', 20, 'male', 100), speaker('S2', 3, 'male', 130), speaker('S3', 2, 'male', 135)];
    const cast = proposeCast(speakers, voices, { minorPool: { male: ['vp_mine', 'builtin-b'] } });
    // The most-heard speaker gets it, and nobody else.
    expect(cast.assignments.filter((a) => a.voiceId === 'vp_mine').map((a) => a.speakerId)).toEqual(['S0']);
    expect(cast.pools.male!.voices.map((v) => v.voiceId)).toEqual(['builtin-b']);
    expect(cast.defaults.male).toBe('builtin-b');
    expect(cast.notes).toContain('"Giọng của tôi" is kept for one main character: it is not one of the voices the minor speakers share.');
  });

  it('casts a built-in that sounds like a clone only after the others', () => {
    const voices = [
      { ...preset('sounds-like-clone', 'male', 120), print: [1, 0, 0] },
      { ...preset('other', 'male', 125), print: [0, 0, 1] },
      profile('clone', 'male', 110, true, [0.99, 0.1, 0]),
    ];
    const cast = proposeCast([speaker('S0', 50, 'male', 110), speaker('S1', 40, 'male', 120)], voices);
    expect(cast.assignments.map((a) => [a.speakerId, a.voiceId])).toEqual([
      ['S0', 'clone'],
      ['S1', 'other'],
    ]);
    expect(cast.soundalikes.map((s) => s.voiceId)).toEqual(['sounds-like-clone']);
    // The spare soundalike is not even the default for a speaker found later.
    expect(cast.defaults.male).toBe('other');
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

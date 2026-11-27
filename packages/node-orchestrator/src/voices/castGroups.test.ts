import { describe, expect, it } from 'vitest';

import { castGroups, expandCast, groupGender, isVoiceOver } from './castGroups.js';

describe('the characters of a cast (claude-dubber, 2026-11-27)', () => {
  const minutes = new Map([
    ['SPEAKER_00', 30],
    ['SPEAKER_09', 2],
    ['SPEAKER_10', 1.8],
    ['SPEAKER_15', 0.6],
    ['SPEAKER_16', 0.5],
    ['SPEAKER_19', 0.4],
    ['SPEAKER_27', 0.5],
    ['SPEAKER_45', 0.4],
    ['SPEAKER_50', 0.1],
  ]);

  it('takes the ids the sheet gives one name as one character, the most-heard first, and every other id alone', () => {
    const sheet = {
      cast: [
        { name: 'Lục Trần', role: 'nhân vật chính, lãng khách mang hệ thống trảm yêu', speakerId: 'SPEAKER_00' },
        { name: 'Linh Nhi', role: 'Mộc tam tiểu thư', speakerId: 'SPEAKER_19' },
        { name: 'linh nhi', speakerId: 'SPEAKER_15' },
        { name: 'Linh Nhi', speakerId: 'SPEAKER_16' },
        { name: 'Linh Nhi', speakerId: 'SPEAKER_27' },
        { name: 'Linh Nhi', speakerId: 'SPEAKER_45' },
        { name: 'Hệ thống', role: 'giọng hệ thống báo thưởng', speakerId: 'SPEAKER_09' },
        { name: 'Người dẫn truyện', role: 'narrator', speakerId: 'SPEAKER_10' },
        // Not detected, and an id named twice: left out, the first name wins.
        { name: 'Ghost', speakerId: 'SPEAKER_99' },
        { name: 'Someone else', speakerId: 'SPEAKER_19' },
      ],
    };
    const groups = castGroups(sheet, minutes);
    expect(groups).toEqual([
      { name: 'Lục Trần', ids: ['SPEAKER_00'], voiceOver: false },
      { name: 'Linh Nhi', ids: ['SPEAKER_15', 'SPEAKER_16', 'SPEAKER_27', 'SPEAKER_19', 'SPEAKER_45'], voiceOver: false },
      { name: 'Hệ thống', ids: ['SPEAKER_09'], voiceOver: true },
      { name: 'Người dẫn truyện', ids: ['SPEAKER_10'], voiceOver: true },
      { ids: ['SPEAKER_50'], voiceOver: false },
    ]);
    // Without a sheet: every id alone.
    expect(castGroups(undefined, minutes)).toHaveLength(minutes.size);
  });

  it('knows a narrator or a system voice by its role or name, and keeps a lead who also narrates a lead', () => {
    expect(isVoiceOver({ name: 'Hệ thống', role: 'giọng hệ thống của đoàn tàu' })).toBe(true);
    expect(isVoiceOver({ name: 'X', role: 'narrator' })).toBe(true);
    expect(isVoiceOver({ name: '旁白' })).toBe(true);
    expect(isVoiceOver({ name: 'System' })).toBe(true);
    expect(isVoiceOver({ name: 'Lục Trần', role: 'nhân vật chính, học sinh mồ côi, kiêm người dẫn truyện' })).toBe(false);
    // A character who has a system (the hero's power), not a system voice.
    expect(isVoiceOver({ name: 'Lục Trần', role: 'lãng khách mang hệ thống trảm yêu' })).toBe(false);
    expect(isVoiceOver({ name: 'Mộc Linh Nhi', role: 'Mộc tam tiểu thư, người được hộ tống' })).toBe(false);
  });

  it("gives a character's voice to all its ids: assignments, the speakers left to the project voice, the pools", () => {
    const membersOf = new Map([['SPEAKER_15', ['SPEAKER_15', 'SPEAKER_16', 'SPEAKER_27']]]);
    const expanded = expandCast(
      {
        assignments: [
          { speakerId: 'SPEAKER_15', voiceId: 'vp_ha_my', voiceName: 'Duyên Hà My', by: 'lead' },
          { speakerId: 'SPEAKER_00', voiceId: 'vp_my_voice', voiceName: 'Giọng của tôi', by: 'lead' },
        ],
        defaults: {},
        unassigned: ['SPEAKER_15'],
        unconfirmed: [],
        notes: [],
        pools: { female: { minorSpeakers: 1, size: 3, voices: [{ voiceId: 'b', name: 'b', from: 'spare', speakers: ['SPEAKER_15'], minutes: 1 }] } },
        soundalikes: [],
      },
      membersOf,
    );
    expect(expanded.assignments.map((a) => [a.speakerId, a.voiceId])).toEqual([
      ['SPEAKER_15', 'vp_ha_my'],
      ['SPEAKER_16', 'vp_ha_my'],
      ['SPEAKER_27', 'vp_ha_my'],
      ['SPEAKER_00', 'vp_my_voice'],
    ]);
    expect(expanded.unassigned).toEqual(['SPEAKER_15', 'SPEAKER_16', 'SPEAKER_27']);
    expect(expanded.pools.female?.voices[0]?.speakers).toEqual(['SPEAKER_15', 'SPEAKER_16', 'SPEAKER_27']);
  });

  it("takes a character's gender from the ids heard longest", () => {
    const genders: Record<string, 'male' | 'female' | 'unknown'> = { SPEAKER_15: 'female', SPEAKER_16: 'male', SPEAKER_19: 'female', SPEAKER_27: 'unknown' };
    const of = (id: string) => genders[id];
    expect(groupGender(['SPEAKER_15', 'SPEAKER_16', 'SPEAKER_19', 'SPEAKER_27'], of, minutes)).toBe('female');
    expect(groupGender(['SPEAKER_27'], of, minutes)).toBeUndefined();
    expect(groupGender(['SPEAKER_27', 'SPEAKER_16'], of, new Map())).toBe('male');
  });
});

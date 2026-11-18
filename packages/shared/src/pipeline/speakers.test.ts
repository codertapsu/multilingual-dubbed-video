import { describe, expect, it } from 'vitest';
import { isSpeakerId, nextSpeakerId, sanitizeSpeakerVoices, speakerNumber, summarizeSpeakers, voiceForLine } from './speakers.js';

describe('speakers', () => {
  it('knows the one speaker id format', () => {
    expect(isSpeakerId('SPEAKER_00')).toBe(true);
    expect(isSpeakerId('SPEAKER_123')).toBe(true);
    for (const bad of ['speaker_00', 'SPEAKER_0', 'SPEAKER_1234', 'Anna', '', 7, null]) expect(isSpeakerId(bad)).toBe(false);
    expect(speakerNumber('SPEAKER_00')).toBe(1);
    expect(speakerNumber('SPEAKER_11')).toBe(12);
    expect(nextSpeakerId(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_03'])).toBe('SPEAKER_02');
    expect(nextSpeakerId([])).toBe('SPEAKER_00');
  });

  it("speaks a line in its own voice, else its speaker's, else the project's", () => {
    const settings = { ttsVoiceId: 'project', speakerVoices: [{ speakerId: 'SPEAKER_01', voiceId: 'anna' }] };
    expect(voiceForLine({ voiceId: 'own', speakerId: 'SPEAKER_01' }, settings)).toBe('own');
    expect(voiceForLine({ speakerId: 'SPEAKER_01' }, settings)).toBe('anna');
    expect(voiceForLine({ speakerId: 'SPEAKER_02' }, settings)).toBe('project');
    expect(voiceForLine({}, settings)).toBe('project');
    expect(voiceForLine({}, {})).toBeUndefined();
  });

  it('keeps only valid speaker voices, one per speaker', () => {
    expect(
      sanitizeSpeakerVoices([
        { speakerId: 'SPEAKER_01', voiceId: ' a ' },
        { speakerId: 'SPEAKER_00', voiceId: 'b' },
        { speakerId: 'SPEAKER_01', voiceId: 'c' },
        { speakerId: 'Anna', voiceId: 'd' },
        { speakerId: 'SPEAKER_02', voiceId: '' },
        { speakerId: 'SPEAKER_03', voiceId: 'x'.repeat(201) },
        null,
        'junk',
      ]),
    ).toEqual([
      { speakerId: 'SPEAKER_00', voiceId: 'b' },
      { speakerId: 'SPEAKER_01', voiceId: 'c' },
    ]);
    expect(sanitizeSpeakerVoices([])).toBeUndefined();
    expect(sanitizeSpeakerVoices('nope')).toBeUndefined();
  });

  it('lists speakers by how much they say', () => {
    expect(
      summarizeSpeakers([
        { speakerId: 'SPEAKER_00', startMs: 0, endMs: 1000 },
        { speakerId: 'SPEAKER_01', startMs: 1000, endMs: 4000 },
        { startMs: 4000, endMs: 9000 },
        { speakerId: 'SPEAKER_00', startMs: 9000, endMs: 10_500 },
      ]),
    ).toEqual([
      { speakerId: 'SPEAKER_01', lines: 1, speechMs: 3000 },
      { speakerId: 'SPEAKER_00', lines: 2, speechMs: 2500 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { voiceForLine } from '@videodubber/shared';
import type { TimelineSegment } from '../../../core/models';
import { applyFields, fieldsToPatch, patchToFields } from './line-fields';

const line = (id: string, over: Partial<TimelineSegment> = {}): TimelineSegment => ({
  id,
  index: 0,
  startMs: 0,
  endMs: 1000,
  sourceText: 's',
  translatedText: 't',
  ...over,
});

describe('line fields (the editor view of a patch)', () => {
  const settings = { ttsVoiceId: 'project', speakerVoices: [{ speakerId: 'SPEAKER_01', voiceId: 'anna' }] };
  const voiceOf = (l: TimelineSegment) => voiceForLine(l, settings);

  it('marks a new speaker as a new voice only when the voice really changes', () => {
    const segs = [line('a'), line('b', { voiceId: 'own' }), line('c', { speakerId: 'SPEAKER_01' })];
    const out = applyFields(
      segs,
      [
        { id: 'a', fields: { speakerId: 'SPEAKER_00' } }, // no voice of its own: still the project's
        { id: 'b', fields: { speakerId: 'SPEAKER_01' } }, // its own voice wins
        { id: 'c', fields: { speakerId: null } }, // Anna -> the project voice
      ],
      voiceOf,
    );
    expect(out.map((s) => [s.speakerId, s.ttsStale === true])).toEqual([
      ['SPEAKER_00', false],
      ['SPEAKER_01', false],
      [undefined, true],
    ]);
    // Clearing a line's own voice under an assigned speaker moves it to that speaker.
    const back = applyFields([line('d', { voiceId: 'own', speakerId: 'SPEAKER_01' })], [{ id: 'd', fields: { voiceId: null } }], voiceOf);
    expect(back[0]).toMatchObject({ speakerId: 'SPEAKER_01', ttsStale: true });
  });

  it('round-trips a speaker through the patch the server receives', () => {
    expect(fieldsToPatch({ speakerId: 'SPEAKER_02' })).toEqual({ speakerId: 'SPEAKER_02' });
    expect(fieldsToPatch({ speakerId: null })).toEqual({ speakerId: null });
    expect(patchToFields({ id: 'x', speakerId: null, locked: true })).toEqual({ id: 'x', fields: { speakerId: null, locked: true } });
  });
});

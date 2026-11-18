import { describe, expect, it } from 'vitest';
import { checkProjectVoices, describeVoiceProblem, projectVoiceRefs } from './projectVoices.js';

describe('project voices', () => {
  it('lists the project voice and every speaker voice', () => {
    expect(
      projectVoiceRefs({
        ttsVoiceId: 'vieneu38-hai-dang',
        speakerVoices: [{ speakerId: 'S1', voiceId: 'vieneu38-thuc-doan' }],
      }),
    ).toEqual([
      { voiceId: 'vieneu38-hai-dang', where: 'project' },
      { voiceId: 'vieneu38-thuc-doan', where: 'speaker', speakerId: 'S1' },
    ]);
  });

  it('accepts voices of the engine that speaks the project', () => {
    expect(checkProjectVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vieneu38-hai-dang' })).toEqual([]);
    expect(checkProjectVoices({ ttsProviderId: 'neural-tts', ttsVoiceId: 'vieneu-v3-ngoc-lan' })).toEqual([]);
    expect(checkProjectVoices({ ttsProviderId: 'piper-local', ttsVoiceId: 'vi_VN-vivos-x_low#4' })).toEqual([]);
    // No provider: the built-in Piper voice.
    expect(checkProjectVoices({ ttsVoiceId: 'vi_VN-vais1000-medium' })).toEqual([]);
    // Piper also loads .onnx files the user dropped in, and system voices.
    expect(checkProjectVoices({ ttsProviderId: 'piper-local', ttsVoiceId: 'my-own-voice' })).toEqual([]);
    expect(checkProjectVoices({ ttsProviderId: 'piper-local', ttsVoiceId: 'system:Alex' })).toEqual([]);
  });

  it("flags a voice from another engine, never letting it fall back to the engine's default", () => {
    // Ngọc Lan is gone from VieNeu 3.8: the old engine keeps it.
    const [p] = checkProjectVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vieneu-v3-ngoc-lan' });
    expect(p).toMatchObject({ kind: 'other-engine', voiceEngine: 'vieneu-classic', where: 'project' });
    const text = describeVoiceProblem(p!, 'vieneu');
    expect(text.message).toBe(
      'The voice "vieneu-v3-ngoc-lan" belongs to VieNeu v3 (the ten earlier voices), but this project\'s voice engine is VieNeu-TTS 3.8.',
    );
    expect(text.remediation).toContain('switch the project\'s voice engine to VieNeu v3');

    expect(
      checkProjectVoices({
        ttsProviderId: 'piper-local',
        ttsVoiceId: 'vi_VN-vais1000-medium',
        speakerVoices: [{ speakerId: 'S2', voiceId: 'kokoro-af_heart' }],
      }),
    ).toEqual([{ voiceId: 'kokoro-af_heart', where: 'speaker', speakerId: 'S2', kind: 'other-engine', voiceEngine: 'kokoro' }]);
  });

  it('flags a voice its engine does not have', () => {
    expect(checkProjectVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vieneu38-nobody' })).toEqual([
      { voiceId: 'vieneu38-nobody', where: 'project', kind: 'unknown' },
    ]);
  });

  it('leaves cloned voices and providers outside the library to their own checks', () => {
    expect(checkProjectVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vp_abc123' })).toEqual([]);
    expect(checkProjectVoices({ ttsProviderId: 'omnivoice', ttsVoiceId: 'whatever' })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AudioDrift } from '@videodubber/shared';
import { AUDIO_DRIFT_WARN_MS, audioDriftWarning, describeAudioDrift } from './audioDrift.js';

/** P4 of the 27.8-hour series, as the extract-audio step measures it. */
const p4: AudioDrift = {
  driftMs: 4810,
  audioMs: 9_831_167,
  pictureMs: 9_826_357,
  method: 'packets',
  claimedAudioMs: 9_826_354,
  count: { codec: 'aac', sampleRate: 48000, packets: 460_837, frameSize: 1024, primingSamples: 1024 },
  measuredAt: '2026-11-23T10:00:00.000Z',
};

describe('the audio against the picture', () => {
  it('warns from 0.5 s longer: P4 (+4.81 s) and P1/P2 (+0.56 s) yes, P3/P5 (+0.02/+0.14 s) no', () => {
    expect(AUDIO_DRIFT_WARN_MS).toBe(500);
    expect(audioDriftWarning(p4)).toMatchObject({ code: 'audio-drift', key: 'warning.audio-drift', params: { seconds: 4.8 } });
    expect(audioDriftWarning(p4)!.message).toMatch(/^The audio was 4\.8 s longer than the picture .*re-timed to the picture/);
    expect(audioDriftWarning({ ...p4, driftMs: 560 })?.params).toEqual({ seconds: 0.6 });
    expect(audioDriftWarning({ ...p4, driftMs: 20 })).toBeUndefined();
    expect(audioDriftWarning({ ...p4, driftMs: 140 })).toBeUndefined();
  });

  it('audio that ends before the picture is padded, not a warning', () => {
    expect(audioDriftWarning({ ...p4, driftMs: -1500 })).toBeUndefined();
  });

  it('logs what was counted, beside what the container claimed', () => {
    expect(describeAudioDrift(p4)).toBe(
      'Audio vs picture: the audio holds 9831.17 s, the picture lasts 9826.36 s: +4.81 s ' +
        "(460837 packets x 1024 samples - 1024 priming, aac 48000 Hz; the container claimed 9826.35 s). Both audio tracks follow the picture's clock and end with it.",
    );
    const part = describeAudioDrift({
      driftMs: -12,
      audioMs: 2_099_988,
      pictureMs: 2_100_000,
      method: 'decode',
      range: { startMs: 600_000, endMs: 2_700_000 },
      count: { codec: 'opus', sampleRate: 48000, samples: 100_799_424 },
      measuredAt: '2026-11-23T10:00:00.000Z',
    });
    expect(part).toContain("in this part's window (600.0-2700.0 s of the video)");
    expect(part).toContain(': -0.01 s (100799424 samples decoded, opus 48000 Hz)');
  });
});

import { describe, expect, it } from 'vitest';
import type { AudioDrift } from '@videodubber/shared';
import { audioDriftLines } from './format.js';

const drift = (driftMs: number, extra: Partial<AudioDrift> = {}): { audioDrift: AudioDrift } => ({
  audioDrift: { driftMs, audioMs: 10_000 + driftMs, pictureMs: 10_000, method: 'packets', measuredAt: '2026-11-23T10:00:00.000Z', ...extra },
});

describe('get_project: the audio against the picture', () => {
  it('says what the extract-audio step counted, and nothing before it ran', () => {
    expect(audioDriftLines(drift(4810))).toEqual([
      'Audio vs picture: the audio was 4.81 s longer than the picture, re-timed to it (counted from its decoded samples).',
    ]);
    expect(audioDriftLines(drift(20))).toEqual(['Audio vs picture: in step with the picture (+0.02 s) (counted from its decoded samples).']);
    expect(audioDriftLines(drift(-1500, { range: { startMs: 0, endMs: 60_000 } }))[0]).toBe(
      "Audio vs picture: the audio ends 1.50 s before the picture, silence fills the rest (counted from its decoded samples, in this part's window).",
    );
    expect(audioDriftLines(undefined)).toEqual([]);
    expect(audioDriftLines({})).toEqual([]);
  });
});

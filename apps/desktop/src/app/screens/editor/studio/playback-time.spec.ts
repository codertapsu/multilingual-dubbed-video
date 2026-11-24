import { describe, expect, it } from 'vitest';

import { timelineMs, videoSecondsAt } from './playback-time';

describe('the editor preview clock', () => {
  it('reads a whole video as it is, and a series part from its own window', () => {
    expect(timelineMs(12.5)).toBe(12_500);
    // Part 3 starts at 1:20:00 of its parent's video: its 0 is there.
    expect(timelineMs(4_812.5, 4_800_000)).toBe(12_500);
    expect(videoSecondsAt(12_500, 4_800_000)).toBe(4_812.5);
    expect(videoSecondsAt(timelineMs(37.04, 1_000), 1_000)).toBeCloseTo(37.04, 9);
  });
});

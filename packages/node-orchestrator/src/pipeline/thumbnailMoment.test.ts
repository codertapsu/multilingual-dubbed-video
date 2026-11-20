import { describe, expect, it } from 'vitest';

import { thumbnailMomentMs } from './thumbnailMoment.js';

describe('thumbnailMomentMs', () => {
  it('takes the middle of the longest quiet stretch between 15% and 60% of the video', () => {
    // 100 s: lines everywhere but a long pause at 40-50 s and a short one at 20-21 s.
    const spoken = [
      { startMs: 0, endMs: 20_000 },
      { startMs: 21_000, endMs: 40_000 },
      { startMs: 50_000, endMs: 100_000 },
    ];
    // Free from 41.2 s (40 s + the subtitle's hold) to 49.7 s (50 s - its lead).
    expect(thumbnailMomentMs(100_000, spoken)).toBe(45_450);
  });

  it('never picks the opening or the ending, where a series part has its cards', () => {
    // Silent except for a line in the middle: the free stretch is clipped to 15%-60%.
    const at = thumbnailMomentMs(600_000, [{ startMs: 200_000, endMs: 400_000 }]);
    expect(at).toBeGreaterThanOrEqual(90_000);
    expect(at).toBeLessThanOrEqual(360_000);
  });

  it('falls back to a third of the way in when nobody stops talking', () => {
    expect(thumbnailMomentMs(90_000, [{ startMs: 0, endMs: 90_000 }])).toBe(30_000);
    expect(thumbnailMomentMs(0, [])).toBe(0);
  });
});

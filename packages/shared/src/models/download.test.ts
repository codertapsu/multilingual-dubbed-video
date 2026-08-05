import { describe, expect, it } from 'vitest';

import { QUALITY_LADDER, pickClosestHeight } from './download.js';

describe('pickClosestHeight', () => {
  it('gives exactly what was asked for when it exists', () => {
    expect(pickClosestHeight([1080, 720, 480], 1080)).toBe(1080);
    expect(pickClosestHeight([1080, 720, 480], 720)).toBe(720);
  });

  it('steps DOWN to the best available below the target', () => {
    // The load-bearing case: asking for 1080p on a video capped at 720p must
    // download 720p, not fail and not jump above what was asked for.
    expect(pickClosestHeight([720, 480, 360], 1080)).toBe(720);
    expect(pickClosestHeight([480, 360], 2160)).toBe(480);
  });

  it('never exceeds the target when something at or below exists', () => {
    // 1440 is numerically closer to 1080 than 720 is, but returning it would
    // hand the user a bigger file than they asked for — the target is a
    // ceiling, not a midpoint.
    expect(pickClosestHeight([1440, 720], 1080)).toBe(720);
  });

  it('takes the smallest on offer when everything exceeds the target', () => {
    // Asking for 360p from a source that only serves 720p: the user asked for
    // "small", and the smallest available is the honest answer. Refusing to
    // download would not be.
    expect(pickClosestHeight([1080, 720], 360)).toBe(720);
  });

  it('takes the best available when no target is set', () => {
    expect(pickClosestHeight([480, 1080, 720])).toBe(1080);
  });

  it('does not care about input ordering or duplicates', () => {
    expect(pickClosestHeight([480, 1080, 1080, 720], 900)).toBe(720);
  });

  it('ignores heights it cannot rank', () => {
    // A stream with no reported height would otherwise sort as 0 and be
    // returned as "the smallest available".
    expect(pickClosestHeight([0, 720], 360)).toBe(720);
    expect(pickClosestHeight([0, 0])).toBeUndefined();
  });

  it('returns nothing when nothing is available', () => {
    expect(pickClosestHeight([], 1080)).toBeUndefined();
  });
});

describe('QUALITY_LADDER', () => {
  it('is ordered best first, so the UI can render it directly', () => {
    const heights = QUALITY_LADDER.map((q) => q.heightPx);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
  });

  it('covers the names people actually ask for', () => {
    expect(QUALITY_LADDER.map((q) => q.key)).toEqual([
      '4k',
      '2k',
      '1080p',
      '720p',
      '480p',
      '360p',
    ]);
  });

  it('every rung resolves against a rich source', () => {
    // A ladder rung that could never be satisfied by any source would be a
    // dead option; each one must at least map onto something here.
    const rich = [2160, 1440, 1080, 720, 480, 360];
    for (const rung of QUALITY_LADDER) {
      expect(pickClosestHeight(rich, rung.heightPx)).toBe(rung.heightPx);
    }
  });
});

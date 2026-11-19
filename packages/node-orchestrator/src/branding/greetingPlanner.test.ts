import { describe, expect, it } from 'vitest';

import { planGreetings, quietGaps, repeatCount, validatePlacements } from './greetingPlanner.js';

const MIN = 60_000;
/** Speech every 10 s for 8 s, except where `quiet` says (start, end in s). */
function talk(durationMs: number, quiet: [number, number][] = []): { startMs: number; endMs: number }[] {
  const out = [];
  for (let t = 0; t < durationMs; t += 10_000) {
    const s = t;
    const e = Math.min(durationMs, t + 8_000);
    if (quiet.some(([a, b]) => s < b * 1000 && e > a * 1000)) continue;
    out.push({ startMs: s, endMs: e });
  }
  return out;
}

describe('quietGaps', () => {
  it('is the complement of overlapping speech', () => {
    expect(quietGaps([{ startMs: 1000, endMs: 3000 }, { startMs: 2500, endMs: 4000 }, { startMs: 8000, endMs: 9000 }], 10_000)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 4000, endMs: 8000 },
      { startMs: 9000, endMs: 10_000 },
    ]);
  });
});

describe('repeatCount', () => {
  it('auto is about one per 10 minutes, at most 6', () => {
    expect(repeatCount('auto', 25 * MIN)).toBe(3);
    expect(repeatCount('auto', 3 * 60 * MIN)).toBe(6);
    expect(repeatCount('off', 60 * MIN)).toBe(0);
    expect(repeatCount(5, 60 * MIN)).toBe(5);
  });
});

describe('planGreetings', () => {
  const base = { assetId: 'greeting_x', greetingMs: 3000, settings: { atStart: true, startWindowSec: 60, repeat: 'off' as const } };

  it('plays the opening greeting in the first quiet moment of the opening, music or not', () => {
    // Talk throughout but for a 6-second pause at 20–26 s.
    const plan = planGreetings({ ...base, durationMs: 5 * MIN, busy: talk(5 * MIN, [[18, 30]]) });
    expect(plan.placements).toEqual([{ atMs: 18_400, kind: 'opening' }]);
    expect(plan.openingSkipped).toBeUndefined();
  });

  it('skips the opening greeting when the opening has no quiet moment (never before the video)', () => {
    const plan = planGreetings({ ...base, durationMs: 5 * MIN, busy: [{ startMs: 0, endMs: 5 * MIN }] });
    expect(plan.placements).toEqual([]);
    expect(plan.openingSkipped).toBe(true);
  });

  it('spreads repeats evenly, plays only as many as fit, and keeps 3 minutes apart', () => {
    const durationMs = 30 * MIN;
    // Quiet moments only at 9:58 and 10:40 (too close together) and at 20:00.
    const busy = talk(durationMs, [[598, 606], [640, 648], [1200, 1208]]);
    const plan = planGreetings({ ...base, durationMs, busy, settings: { atStart: false, startWindowSec: 60, repeat: 5 } });
    expect(plan.requested).toBe(5);
    expect(plan.found).toBe(2);
    expect(plan.placements.map((p) => p.kind)).toEqual(['repeat', 'repeat']);
    const [a, b] = plan.placements.map((p) => p.atMs);
    expect(b! - a!).toBeGreaterThanOrEqual(180_000);
  });

  it('keeps what the user placed and plans around it', () => {
    const durationMs = 30 * MIN;
    const busy = talk(durationMs, [[300, 330], [900, 930], [1500, 1530]]);
    const manual = [{ atMs: 905_000, kind: 'repeat' as const, manual: true }];
    const plan = planGreetings({ ...base, durationMs, busy, manual, settings: { atStart: false, startWindowSec: 60, repeat: 3 } });
    expect(plan.placements).toContainEqual({ atMs: 905_000, kind: 'repeat', manual: true });
    expect(plan.placements.filter((p) => !p.manual).every((p) => Math.abs(p.atMs - 905_000) >= 180_000)).toBe(true);
  });
});

describe('validatePlacements', () => {
  it('refuses a greeting outside the video or over another', () => {
    expect(validatePlacements([{ atMs: 59_000, kind: 'repeat' }], 60_000, 3000)).toMatchObject({ ok: false });
    expect(validatePlacements([{ atMs: 1000, kind: 'opening' }, { atMs: 2000, kind: 'repeat' }], 60_000, 3000)).toMatchObject({ ok: false });
    expect(validatePlacements([{ atMs: 30_000, kind: 'repeat' }, { atMs: 1000, kind: 'opening' }], 60_000, 3000)).toEqual({
      ok: true,
      placements: [
        { atMs: 1000, kind: 'opening', manual: true },
        { atMs: 30_000, kind: 'repeat', manual: true },
      ],
    });
  });
});

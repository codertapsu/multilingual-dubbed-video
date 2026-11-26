import { describe, expect, it } from 'vitest';

import { GpuHolds, holderName, holdView, MAX_LIVE_HOLDS, parseHoldRequest } from './gpuHolds.js';

/** A clock and a timer the test moves by hand. */
function fakeTime(start = Date.parse('2026-11-25T14:00:00.000Z')) {
  let now = start;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => !x.cancelled && x.at <= now)) {
        t.cancelled = true;
        t.fn();
      }
    },
  };
}

const ask = { holder: 'voice-mask', lanes: ['gpu'], reason: 'live session: translate my voice', ttlSec: 30 };

describe('a hold request (POST /scheduler/holds), checked', () => {
  it("takes Voice Mask's request as it sends it", () => {
    expect(parseHoldRequest(ask)).toEqual({ ok: true, value: { holder: 'voice-mask', lanes: ['gpu'], reason: 'live session: translate my voice', ttlSec: 30 } });
  });

  it('clamps the TTL to 5-120 s, and defaults it to 30', () => {
    const ttl = (ttlSec: unknown) => (parseHoldRequest({ ...ask, ttlSec }) as { value: { ttlSec: number } }).value.ttlSec;
    expect(ttl(1)).toBe(5);
    expect(ttl(999)).toBe(120);
    expect(ttl(12.6)).toBe(13);
    expect((parseHoldRequest({ holder: 'voice-mask', lanes: ['gpu'] }) as { value: { ttlSec: number; reason: string } }).value).toMatchObject({ ttlSec: 30, reason: '' });
  });

  it('refuses a bad holder, lane, reason or TTL with the reason why', () => {
    for (const bad of [
      null,
      [],
      { ...ask, holder: 'Voice Mask' },
      { ...ask, holder: '' },
      { ...ask, holder: 'x'.repeat(41) },
      { ...ask, lanes: [] },
      { ...ask, lanes: ['cpu'] },
      { ...ask, lanes: 'gpu' },
      { ...ask, reason: 'x'.repeat(201) },
      { ...ask, reason: 7 },
      { ...ask, ttlSec: 'long' },
    ]) {
      const r = parseHoldRequest(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect((r as { error: string }).error.length).toBeGreaterThan(10);
    }
  });
});

describe('the holds on the graphics card', () => {
  it('a hold lives for its TTL, is renewed, and is released', () => {
    const t = fakeTime();
    const changes: string[] = [];
    const holds = new GpuHolds({ now: t.now, setTimer: t.setTimer, onChange: () => changes.push('change') });
    const h = holds.create(parseHoldRequest(ask).ok ? (parseHoldRequest(ask) as { value: never }).value : (null as never));
    expect(h).not.toBe('full');
    const hold = h as Exclude<typeof h, 'full'>;
    expect(hold.holdId).toMatch(/^hold_[0-9a-f]{12}$/);
    expect(hold.expiresAt).toBe('2026-11-25T14:00:30.000Z');
    expect(holds.holding('gpu')?.holdId).toBe(hold.holdId);
    t.advance(20_000);
    expect(holds.renew(hold.holdId)?.expiresAt).toBe('2026-11-25T14:00:50.000Z');
    expect(holds.renew('hold_nope')).toBeUndefined();
    expect(holds.release(hold.holdId)).toBe(true);
    expect(holds.release(hold.holdId)).toBe(false);
    expect(holds.holding('gpu')).toBeUndefined();
    expect(changes).toEqual(['change', 'change']); // taken, released (a renewal changes nothing for the queue)
  });

  it('a hold its app stops renewing expires by itself, and the queue is told', () => {
    const t = fakeTime();
    const changes: number[] = [];
    const log: string[] = [];
    const holds = new GpuHolds({ now: t.now, setTimer: t.setTimer, onChange: () => changes.push(holds.live().length), log: (m) => log.push(m) });
    const hold = holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: 'live', ttlSec: 30 }) as { holdId: string };
    t.advance(29_000);
    expect(holds.holding('gpu')).toBeDefined();
    t.advance(2_000); // the expiry timer fires: no request needed
    expect(changes).toEqual([1, 0]);
    expect(holds.renew(hold.holdId)).toBeUndefined(); // 404: take a new one
    expect(log.join('\n')).toMatch(/Voice Mask's hold on the graphics card expired/);
  });

  it(`holds at most ${MAX_LIVE_HOLDS} at once, so a leaking holder cannot grow the list`, () => {
    const t = fakeTime();
    const holds = new GpuHolds({ now: t.now, setTimer: t.setTimer });
    for (let i = 0; i < MAX_LIVE_HOLDS; i++) expect(holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: '', ttlSec: 30 })).not.toBe('full');
    expect(holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: '', ttlSec: 30 })).toBe('full');
    t.advance(31_000);
    expect(holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: '', ttlSec: 30 })).not.toBe('full');
  });

  it('names the holder the way the screens do, and shows the hold as GET /queue lists it', () => {
    expect(holderName('voice-mask')).toBe('Voice Mask');
    expect(holderName('other-app')).toBe('other-app');
    const t = fakeTime();
    const holds = new GpuHolds({ now: t.now, setTimer: t.setTimer });
    const hold = holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: 'live', ttlSec: 30 }) as Parameters<typeof holdView>[0];
    expect(holdView(hold)).toEqual({
      holdId: hold.holdId,
      holder: 'voice-mask',
      name: 'Voice Mask',
      lanes: ['gpu'],
      reason: 'live',
      createdAt: '2026-11-25T14:00:00.000Z',
      expiresAt: '2026-11-25T14:00:30.000Z',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { SetupEventBus } from './setupBus.js';
import type { SetupEvent } from '@videodubber/shared';

/**
 * Replay-on-connect is the durable fix for the onboarding "Waiting for the
 * download to begin…" bug: a late SSE subscriber (the connect→install race)
 * must still receive the current per-item state, not an empty stream.
 */
describe('SetupEventBus replay-on-connect', () => {
  it('replays the latest progress per item to a late subscriber', () => {
    const bus = new SetupEventBus();
    bus.emit({ type: 'progress', item: 'whisper:small', percent: 10, message: 'a' });
    bus.emit({ type: 'progress', item: 'whisper:small', percent: 40, message: 'b' });
    bus.emit({ type: 'progress', item: 'argos:en->vi', percent: null, message: 'c' });

    const seen: SetupEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    expect(seen).toEqual([
      { type: 'progress', item: 'whisper:small', percent: 40, message: 'b' },
      { type: 'progress', item: 'argos:en->vi', percent: null, message: 'c' },
    ]);
    unsub();
  });

  it('replays a terminal event after the item snapshots', () => {
    const bus = new SetupEventBus();
    bus.emit({ type: 'progress', item: 'whisper:small', percent: 100, message: 'x' });
    bus.emit({ type: 'done', status: { firstRunComplete: false } as never });

    const seen: SetupEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(seen[seen.length - 1]?.type).toBe('done');
  });

  it('reset() drops the snapshot so a fresh run starts clean', () => {
    const bus = new SetupEventBus();
    bus.emit({ type: 'progress', item: 'whisper:small', percent: 50, message: 'x' });
    bus.reset();

    const seen: SetupEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(seen).toEqual([]);
  });

  it('still forwards live events after the replay', () => {
    const bus = new SetupEventBus();
    const seen: SetupEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.emit({ type: 'progress', item: 'whisper:small', percent: 1, message: 'y' });
    expect(seen).toHaveLength(1);
  });
});

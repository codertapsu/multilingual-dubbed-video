import { describe, expect, it } from 'vitest';
import { pauseQueueForUpdate, queueAfterUpdate } from './updatePause.js';

const now = new Date('2026-11-28T03:00:00.000Z');

describe('the queue paused for an app update', () => {
  it('pauses the queue and remembers that it was running', () => {
    expect(pauseQueueForUpdate({ mode: 'manual', maxProjects: 2, shareGpu: true }, { version: '0.23.0', now })).toEqual({
      mode: 'manual',
      maxProjects: 2,
      shareGpu: true,
      paused: true,
      pausedForUpdate: { at: now.toISOString(), version: '0.23.0', queueWasPaused: false },
    });
    expect(pauseQueueForUpdate(undefined, { now })).toEqual({
      mode: 'auto',
      paused: true,
      pausedForUpdate: { at: now.toISOString(), queueWasPaused: false },
    });
  });

  it('asked again before the app is back, keeps what the first ask recorded', () => {
    const first = pauseQueueForUpdate({ mode: 'auto' }, { version: '0.23.0', now });
    const again = pauseQueueForUpdate(first, { version: '0.23.1', now: new Date('2026-11-28T04:00:00.000Z') });
    // The queue was running before the first ask, not "paused" because the first ask paused it.
    expect(again.pausedForUpdate).toEqual(first.pausedForUpdate);
    expect(again.paused).toBe(true);
  });

  it('once the app is back, the queue goes on; paused again only if the user had paused it', () => {
    const wasRunning = pauseQueueForUpdate({ mode: 'auto' }, { now });
    expect(queueAfterUpdate(wasRunning)).toEqual({ mode: 'auto', paused: false });
    const wasPaused = pauseQueueForUpdate({ mode: 'auto', paused: true }, { now });
    expect(queueAfterUpdate(wasPaused)).toEqual({ mode: 'auto', paused: true });
  });

  it('a queue not paused for an update is left alone', () => {
    expect(queueAfterUpdate(undefined)).toBeUndefined();
    expect(queueAfterUpdate({ mode: 'auto', paused: true })).toBeUndefined();
  });
});

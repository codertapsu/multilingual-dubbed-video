import { describe, expect, it } from 'vitest';
import { defaultMixConcurrency, mapWithConcurrency, MAX_MIX_CONCURRENCY } from './concurrency.js';

/** A promise plus its resolve/reject, to finish tasks in a chosen order. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('defaultMixConcurrency', () => {
  it('leaves one CPU free and caps at the maximum', () => {
    expect(defaultMixConcurrency(16)).toBe(MAX_MIX_CONCURRENCY);
    expect(defaultMixConcurrency(4)).toBe(3);
    expect(defaultMixConcurrency(2)).toBe(1);
    expect(defaultMixConcurrency(1)).toBe(1);
    expect(defaultMixConcurrency(Number.NaN)).toBe(1);
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in INPUT order even when tasks finish out of order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = mapWithConcurrency([0, 1, 2], 3, (i) => gates[i]!.promise);
    gates[2]!.resolve('c');
    gates[0]!.resolve('a');
    gates[1]!.resolve('b');
    expect(await run).toEqual(['a', 'b', 'c']);
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
        return i * 2;
      },
    );
    expect(peak).toBe(3);
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('limit 1 is strictly sequential', async () => {
    const order: string[] = [];
    await mapWithConcurrency([0, 1, 2], 1, async (i) => {
      order.push(`start${i}`);
      await tick();
      order.push(`end${i}`);
    });
    expect(order).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  });

  it('on failure: kills the siblings, starts nothing new, rethrows the FIRST error (not the kills)', async () => {
    const started: number[] = [];
    const killed: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i, _idx, signal) => {
      started.push(i);
      if (i === 0) {
        await tick();
        throw new Error('chunk 0 failed');
      }
      // A sibling that only ends when it is killed — like an ffmpeg child.
      await new Promise<void>((_res, rej) =>
        signal.addEventListener('abort', () => {
          killed.push(i);
          rej(new Error('killed'));
        }, { once: true }),
      );
      return i;
    });
    await expect(run).rejects.toThrow('chunk 0 failed');
    expect(started).toEqual([0, 1]);
    expect(killed).toEqual([1]);
  });

  it('waits for in-flight siblings to settle before rejecting', async () => {
    const order: string[] = [];
    const run = mapWithConcurrency([0, 1], 2, async (i, _idx, signal) => {
      if (i === 0) throw new Error('boom');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await tick();
      order.push('sibling done');
      return i;
    }).catch((err: Error) => {
      order.push(`rejected: ${err.message}`);
    });
    await run;
    expect(order).toEqual(['sibling done', 'rejected: boom']);
  });

  it('cancelling the outer signal kills the in-flight calls and rejects with CANCELLED', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const run = mapWithConcurrency(
      [0, 1, 2, 3],
      2,
      async (i, _idx, signal) => {
        started.push(i);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return i;
      },
      controller.signal,
    );
    await tick();
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(started).toEqual([0, 1]);
  });

  it('starts nothing when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      mapWithConcurrency([1, 2], 2, async () => void (calls += 1), controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

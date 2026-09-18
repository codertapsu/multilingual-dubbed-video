import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyedMutex.js';

/** Resolve after the microtask/timer queue has drained a little. */
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedMutex', () => {
  it('serializes a read-modify-write on the same key (the lost-alignment bug)', async () => {
    const mutex = new KeyedMutex();
    // Stands in for translated.aligned.json: read whole, change one entry,
    // write whole. Unserialized, both readers see the empty array and the
    // second write erases the first entry.
    let file: string[] = [];
    const patch = (entry: string): Promise<void> =>
      mutex.run('project-1', async () => {
        const current = [...file];
        await tick(5); // the await that used to interleave the two writers
        file = [...current, entry];
      });

    await Promise.all([patch('seg_0001'), patch('seg_0002')]);

    expect(file).toEqual(['seg_0001', 'seg_0002']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.run('a', async () => {
        await tick(10);
        order.push('a');
      }),
      mutex.run('b', async () => {
        order.push('b');
      }),
    ]);
    // 'b' did not wait behind 'a'.
    expect(order).toEqual(['b', 'a']);
  });

  it('keeps the queue moving when one holder throws', async () => {
    const mutex = new KeyedMutex();
    const failed = mutex.run('k', async () => {
      throw new Error('boom');
    });
    const after = mutex.run('k', async () => 'ran');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ran');
  });

  it('releases keys so the map cannot grow without bound', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => undefined);
    await tick();
    expect(mutex.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { RENAME_RETRY_DELAYS_MS, renameReplacing } from './fsRename.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** A rename that fails with `codes` in order, then succeeds. */
function flaky(codes: string[]) {
  const calls: string[] = [];
  return {
    calls,
    rename: async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      const code = codes.shift();
      if (code) throw errno(code);
    },
  };
}

describe('renameReplacing', () => {
  it('retries the Windows "target is in use" codes until the handle goes away', async () => {
    const f = flaky(['EPERM', 'EACCES', 'EBUSY']);
    const slept: number[] = [];
    await renameReplacing('a.tmp', 'a', {
      rename: f.rename,
      sleep: async (ms) => void slept.push(ms),
      platform: 'win32',
    });
    expect(f.calls).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
  });

  it('gives up after the bounded schedule and throws the last error', async () => {
    const f = flaky(Array(100).fill('EPERM'));
    await expect(
      renameReplacing('a.tmp', 'a', {
        rename: f.rename,
        sleep: async () => undefined,
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls).toHaveLength(RENAME_RETRY_DELAYS_MS.length + 1);
    expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(3000);
  });

  it('throws real errors at once', async () => {
    const f = flaky(['ENOENT']);
    await expect(
      renameReplacing('a.tmp', 'a', {
        rename: f.rename,
        sleep: async () => undefined,
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toHaveLength(1);
  });

  it('never retries off Windows, where rename replaces regardless of open handles', async () => {
    const f = flaky(['EPERM']);
    await expect(
      renameReplacing('a.tmp', 'a', {
        rename: f.rename,
        sleep: async () => undefined,
        platform: 'darwin',
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls).toHaveLength(1);
  });
});

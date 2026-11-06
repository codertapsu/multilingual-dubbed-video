import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  partialPathFor,
  RENAME_RETRY_DELAYS_MS,
  renameReplacing,
  writeAtomically,
} from './atomic.js';

/**
 * Regression cover for the resume bug: a killed ffmpeg used to leave a
 * NON-EMPTY, truncated artifact at the final path, and the pipeline's resume
 * check (`size > 0`) then skipped that step and reported success — shipping a
 * half-length dub. `writeAtomically` is what makes "the file exists" mean "the
 * file is finished".
 */
describe('partialPathFor', () => {
  it('keeps the extension so ffmpeg still infers the muxer', () => {
    expect(partialPathFor(join('/a/b', 'output.mp4'))).toBe(join('/a/b', 'output.partial.mp4'));
    expect(partialPathFor(join('/a/b', 'final_mix.wav'))).toBe(
      join('/a/b', 'final_mix.partial.wav'),
    );
  });

  it('handles an extension-less destination', () => {
    expect(partialPathFor(join('/a/b', 'artifact'))).toBe(join('/a/b', 'artifact.partial'));
  });

  it('keeps the partial beside the destination (same filesystem => atomic rename)', () => {
    expect(partialPathFor(join('/vol/one', 'x.wav'))).toBe(join('/vol/one', 'x.partial.wav'));
  });
});

describe('writeAtomically', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-atomic-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes the artifact only after the write succeeds', async () => {
    const dest = join(dir, 'final_mix.wav');
    await writeAtomically(dest, async (partial) => {
      writeFileSync(partial, 'RIFF....', 'utf8');
      // Mid-write, the destination must not exist yet.
      expect(existsSync(dest)).toBe(false);
    });
    expect(readFileSync(dest, 'utf8')).toBe('RIFF....');
    expect(existsSync(partialPathFor(dest))).toBe(false);
  });

  it('leaves NO artifact behind when the write fails (the resume-skip bug)', async () => {
    const dest = join(dir, 'output.mp4');
    await expect(
      writeAtomically(dest, async (partial) => {
        writeFileSync(partial, 'truncated', 'utf8'); // what a killed ffmpeg leaves
        throw new Error('ffmpeg exited with code 255');
      }),
    ).rejects.toThrow('ffmpeg exited with code 255');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(partialPathFor(dest))).toBe(false);
  });

  it('keeps a previously-completed artifact intact when a re-run fails', async () => {
    const dest = join(dir, 'final_mix.wav');
    writeFileSync(dest, 'GOOD', 'utf8');
    await expect(
      writeAtomically(dest, async (partial) => {
        writeFileSync(partial, 'BAD', 'utf8');
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(readFileSync(dest, 'utf8')).toBe('GOOD');
  });

  it('overwrites the destination on a successful re-run (resume semantics)', async () => {
    const dest = join(dir, 'final_mix.wav');
    writeFileSync(dest, 'OLD', 'utf8');
    await writeAtomically(dest, async (partial) => writeFileSync(partial, 'NEW', 'utf8'));
    expect(readFileSync(dest, 'utf8')).toBe('NEW');
  });

  it('clears a stale partial from an earlier crash before writing', async () => {
    const dest = join(dir, 'tts_full.wav');
    writeFileSync(partialPathFor(dest), 'LEFTOVER', 'utf8');
    await writeAtomically(dest, async (partial) => {
      expect(existsSync(partial)).toBe(false);
      writeFileSync(partial, 'FRESH', 'utf8');
    });
    expect(readFileSync(dest, 'utf8')).toBe('FRESH');
  });

  it('returns the writer result', async () => {
    const dest = join(dir, 'x.wav');
    const result = await writeAtomically(dest, async (partial) => {
      writeFileSync(partial, 'y', 'utf8');
      return { exitCode: 0 };
    });
    expect(result).toEqual({ exitCode: 0 });
  });
});

describe('renameReplacing (Windows "target in use")', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it('retries EPERM/EACCES/EBUSY on win32 until the other handle lets go', async () => {
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    let calls = 0;
    const slept: number[] = [];
    await renameReplacing('p', 'd', {
      platform: 'win32',
      sleep: async (ms) => void slept.push(ms),
      rename: async () => {
        calls++;
        const c = codes.shift();
        if (c) throw errno(c);
      },
    });
    expect(calls).toBe(4);
    expect(slept).toEqual([10, 20, 40]);
  });

  it('is bounded, throws other codes at once, and never retries off Windows', async () => {
    let calls = 0;
    const always = async () => {
      calls++;
      throw errno('EPERM');
    };
    await expect(
      renameReplacing('p', 'd', {
        platform: 'win32',
        sleep: async () => undefined,
        rename: always,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1);

    calls = 0;
    await expect(
      renameReplacing('p', 'd', {
        platform: 'linux',
        sleep: async () => undefined,
        rename: always,
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(1);

    calls = 0;
    const missing = async () => {
      calls++;
      throw errno('ENOENT');
    };
    await expect(
      renameReplacing('p', 'd', {
        platform: 'win32',
        sleep: async () => undefined,
        rename: missing,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });
});

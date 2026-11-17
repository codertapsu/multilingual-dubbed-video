import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptOutputDir,
  ensureWritableDir,
  freeOutputBaseName,
  moveOutputFiles,
  samePath,
} from './outputFolder.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-outdir-test-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A path VideoDubber cannot create a folder at, on every OS: below a file. */
async function underAFile(): Promise<string> {
  const file = path.join(tmp, 'a-file');
  await fsp.writeFile(file, 'x');
  return path.join(file, 'Dubs');
}

describe('acceptOutputDir', () => {
  it('creates a missing folder and returns it as a full path', async () => {
    const dir = path.join(tmp, 'new', 'Dubs');
    await expect(acceptOutputDir(`  ${dir}  `)).resolves.toBe(path.resolve(dir));
    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
    // The write probe leaves nothing behind.
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('refuses a relative path rather than guessing what it is relative to', async () => {
    await expect(acceptOutputDir('Dubs')).rejects.toMatchObject({ appError: { code: 'OUTPUT_NOT_WRITABLE' } });
  });

  it('refuses a folder it cannot write in, naming the folder and the reason', async () => {
    const dir = await underAFile();
    const err = await acceptOutputDir(dir).catch((e: unknown) => e);
    expect(err).toMatchObject({ appError: { code: 'OUTPUT_NOT_WRITABLE' } });
    const { message, cause, docsRef } = (err as { appError: { message: string; cause?: string; docsRef?: string } }).appError;
    expect(message).toContain(dir);
    expect(cause).toBeTruthy();
    expect(docsRef).toBe('docs/TROUBLESHOOTING.md#output-not-writable');
  });
});

describe('ensureWritableDir', () => {
  it('accepts an existing folder', async () => {
    await expect(ensureWritableDir(tmp)).resolves.toBeUndefined();
  });
});

describe('freeOutputBaseName', () => {
  it('skips a name any of the finished files already uses there', async () => {
    expect(freeOutputBaseName(tmp, 'Clip', 'vi-VN')).toBe('Clip.vi');
    await fsp.writeFile(path.join(tmp, 'Clip.vi.mp4'), 'x');
    expect(freeOutputBaseName(tmp, 'Clip', 'vi-VN')).toBe('Clip (2).vi');
    // A subtitle file alone takes the name too: the render would overwrite it.
    await fsp.writeFile(path.join(tmp, 'Clip (2).vi.srt'), 'x');
    expect(freeOutputBaseName(tmp, 'Clip', 'vi-VN')).toBe('Clip (3).vi');
  });
});

describe('moveOutputFiles', () => {
  it('moves the files that exist and skips the ones that were never made', async () => {
    const from = path.join(tmp, 'render');
    const to = path.join(tmp, 'Dubs');
    await fsp.mkdir(from);
    await fsp.mkdir(to);
    await fsp.writeFile(path.join(from, 'output.mp4'), 'video');

    await moveOutputFiles([
      [path.join(from, 'output.mp4'), path.join(to, 'Clip.vi.mp4')],
      [path.join(from, 'output.srt'), path.join(to, 'Clip.vi.srt')],
    ]);
    expect(await fsp.readFile(path.join(to, 'Clip.vi.mp4'), 'utf8')).toBe('video');
    expect(await fsp.readdir(from)).toEqual([]);
    expect(await fsp.readdir(to)).toEqual(['Clip.vi.mp4']);
  });

  it('puts every file back when one will not move', async () => {
    const from = path.join(tmp, 'render');
    const to = path.join(tmp, 'Dubs');
    await fsp.mkdir(from);
    await fsp.mkdir(to);
    await fsp.writeFile(path.join(from, 'output.mp4'), 'video');
    await fsp.writeFile(path.join(from, 'output.srt'), 'subs');

    const err = await moveOutputFiles([
      [path.join(from, 'output.mp4'), path.join(to, 'Clip.vi.mp4')],
      // Its folder does not exist: this rename fails after the video moved.
      [path.join(from, 'output.srt'), path.join(to, 'missing', 'Clip.vi.srt')],
    ]).catch((e: unknown) => e);

    expect(err).toMatchObject({ appError: { code: 'OUTPUT_NOT_WRITABLE' } });
    expect(await fsp.readFile(path.join(from, 'output.mp4'), 'utf8')).toBe('video');
    expect(await fsp.readFile(path.join(from, 'output.srt'), 'utf8')).toBe('subs');
    expect(await fsp.readdir(to)).toEqual([]);
  });
});

describe('samePath', () => {
  it('ignores a trailing separator', () => {
    expect(samePath(path.join(tmp, 'Dubs') + path.sep, path.join(tmp, 'Dubs'))).toBe(true);
    expect(samePath(path.join(tmp, 'Dubs'), path.join(tmp, 'Other'))).toBe(false);
  });

  it.runIf(process.platform !== 'linux')('ignores letter case where the file system does', () => {
    expect(samePath(path.join(tmp, 'Dubs'), path.join(tmp, 'DUBS'))).toBe(true);
  });
});

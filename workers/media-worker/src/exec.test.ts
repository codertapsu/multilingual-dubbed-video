import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forceWavInputs, opensAsWav } from './exec.js';

describe('forceWavInputs', () => {
  const wavs = new Set(['a.wav', 'b.wav']);
  const isWav = (f: string): boolean => wavs.has(f);

  it('names the format of every WAV input, and nothing else', () => {
    expect(forceWavInputs(['-y', '-i', 'a.wav', '-i', 'video.mp4', '-i', 'b.wav', '-c', 'copy', 'out.mp4'], isWav)).toEqual([
      '-y', '-f', 'wav', '-i', 'a.wav', '-i', 'video.mp4', '-f', 'wav', '-i', 'b.wav', '-c', 'copy', 'out.mp4',
    ]);
  });

  it('keeps the input options in front of -f and leaves an input that names its format alone', () => {
    expect(forceWavInputs(['-ss', '1', '-i', 'a.wav', '-f', 'lavfi', '-i', 'anullsrc', '-f', 's16le', '-i', 'b.wav'], isWav)).toEqual([
      '-ss', '1', '-f', 'wav', '-i', 'a.wav', '-f', 'lavfi', '-i', 'anullsrc', '-f', 's16le', '-i', 'b.wav',
    ]);
  });

  it('does not take an output -f for an input one', () => {
    // `-f wav out.wav` names the OUTPUT's format; the next input still needs its own.
    expect(forceWavInputs(['-i', 'a.wav', '-f', 'wav', 'out.wav'], isWav)).toEqual(['-f', 'wav', '-i', 'a.wav', '-f', 'wav', 'out.wav']);
  });

  it('copes with a trailing -i and leaves argument lists without inputs as they are', () => {
    expect(forceWavInputs(['-version'], isWav)).toEqual(['-version']);
    expect(forceWavInputs(['-i'], isWav)).toEqual(['-i']);
  });
});

describe('opensAsWav', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-wavhead-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const header = (riff: string, kind: string): Buffer =>
    Buffer.concat([Buffer.from(riff, 'latin1'), Buffer.alloc(4), Buffer.from(kind, 'latin1'), Buffer.alloc(32)]);

  it('recognises RIFF and RF64 WAVE files, whatever their name', async () => {
    await fsp.writeFile(path.join(dir, 'tone.wav'), header('RIFF', 'WAVE'));
    await fsp.writeFile(path.join(dir, 'long.data'), header('RF64', 'WAVE'));
    expect(opensAsWav(path.join(dir, 'tone.wav'))).toBe(true);
    expect(opensAsWav(path.join(dir, 'long.data'))).toBe(true);
  });

  it('says no for other files, short files and missing ones', async () => {
    await fsp.writeFile(path.join(dir, 'avi.wav'), header('RIFF', 'AVI '));
    await fsp.writeFile(path.join(dir, 'ts.wav'), Buffer.alloc(376, 0x47));
    await fsp.writeFile(path.join(dir, 'short.wav'), Buffer.from('RIFF'));
    expect(opensAsWav(path.join(dir, 'avi.wav'))).toBe(false);
    expect(opensAsWav(path.join(dir, 'ts.wav'))).toBe(false);
    expect(opensAsWav(path.join(dir, 'short.wav'))).toBe(false);
    expect(opensAsWav(path.join(dir, 'missing.wav'))).toBe(false);
  });
});

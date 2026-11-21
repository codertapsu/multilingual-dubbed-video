import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { hasSpeakableText, silentWav, writeSilentClip } from './speakable.js';

describe('hasSpeakableText', () => {
  it('finds letters in any script, and digits', () => {
    for (const t of ['Xin chào', '你好', 'ok', '3', 'Đ']) expect(hasSpeakableText(t)).toBe(true);
  });

  it('finds nothing to say in punctuation, symbols and zero-width characters', () => {
    for (const t of ['…', '.', '-', '♪', '♪ ♪', '​', '​‌', '？！', '', '   ']) expect(hasSpeakableText(t)).toBe(false);
    expect(hasSpeakableText(undefined)).toBe(false);
  });
});

describe('silentWav / writeSilentClip', () => {
  it('writes a valid mono 16-bit WAV of the asked length, atomically', async () => {
    const buf = silentWav(100, 24_000);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.readUInt32LE(40)).toBe(2400 * 2);
    expect(buf.subarray(44).every((b) => b === 0)).toBe(true);

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-silent-'));
    try {
      const dest = path.join(dir, 'tts', 'segment_0001.wav');
      expect(await writeSilentClip(dest, 200)).toBe(200);
      expect((await fsp.stat(dest)).size).toBe(44 + 4800 * 2);
      expect(await fsp.readdir(path.dirname(dest))).toEqual(['segment_0001.wav']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

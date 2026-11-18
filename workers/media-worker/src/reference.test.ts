import { describe, expect, it } from 'vitest';
import { buildReferenceClipArgs, REFERENCE_MAX_MS } from './reference.js';

describe('buildReferenceClipArgs', () => {
  it('cuts a window to 48 kHz mono PCM and levels it', () => {
    expect(buildReferenceClipArgs('in.m4a', 'out.wav', { startMs: 1250, endMs: 9250, loudnessLufs: -20 })).toEqual([
      '-y',
      '-ss',
      '1.250',
      '-i',
      'in.m4a',
      '-t',
      '8.000',
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-af',
      'loudnorm=I=-20:TP=-2:LRA=11',
      '-c:a',
      'pcm_s16le',
      'out.wav',
    ]);
  });

  it('never decodes more than the cap from a long import', () => {
    const args = buildReferenceClipArgs('film.mkv', 'out.wav', { sampleRate: 16000 });
    expect(args).not.toContain('-ss');
    expect(args[args.indexOf('-t') + 1]).toBe((REFERENCE_MAX_MS / 1000).toFixed(3));
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args).not.toContain('-af');
    expect(buildReferenceClipArgs('a.wav', 'o.wav', { startMs: 0, endMs: 90 * 60_000, maxMs: 60_000 })).toContain('60.000');
  });

  it('keeps the input before the output, as an argv array', () => {
    const args = buildReferenceClipArgs('C:\\Users\\me\\My Voice.wav', 'D:\\out dir\\ref.wav', { startMs: 500, endMs: 4500 });
    expect(args.indexOf('-i')).toBeLessThan(args.length - 1);
    expect(args[args.indexOf('-i') + 1]).toBe('C:\\Users\\me\\My Voice.wav');
    expect(args.at(-1)).toBe('D:\\out dir\\ref.wav');
  });
});

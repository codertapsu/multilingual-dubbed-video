import { describe, expect, it } from 'vitest';
import { buildFilmstripArgs, planFilmstrip } from './filmstrip.js';
import { buildFittedClipArgs } from './fittedclip.js';
import { buildWaveformArgs, PeakAccumulator } from './waveform.js';

function s16le(samples: number[]): Uint8Array {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return new Uint8Array(buf);
}

describe('PeakAccumulator', () => {
  it('folds samples into (min, max) pairs scaled to int8', () => {
    const acc = new PeakAccumulator(4);
    acc.push(s16le([0, 32767, -32768, 100, 50, 60, 70, 80]));
    expect(Array.from(acc.finish())).toEqual([-127, 127, 0, 0]);
    expect(acc.samples).toBe(8);
  });

  it('reassembles a sample split across two chunks', () => {
    const bytes = s16le([-20000, 20000, 1000, -1000]);
    const whole = new PeakAccumulator(2);
    whole.push(bytes);
    const split = new PeakAccumulator(2);
    split.push(bytes.subarray(0, 3)); // ends mid-sample
    split.push(bytes.subarray(3));
    expect(Array.from(split.finish())).toEqual(Array.from(whole.finish()));
  });

  it('emits a trailing partial bucket', () => {
    const acc = new PeakAccumulator(10);
    acc.push(s16le([1000, -1000, 3000]));
    expect(Array.from(acc.finish())).toEqual([-4, 12]);
  });
});

describe('buildWaveformArgs', () => {
  it('decodes to mono s16le on stdout, never touching video/subtitle streams', () => {
    const args = buildWaveformArgs('/in/original.wav', 8000);
    expect(args).toEqual(expect.arrayContaining(['-i', '/in/original.wav', '-vn', '-sn', '-ac', '1', '-ar', '8000', '-f', 's16le']));
    expect(args.at(-1)).toBe('pipe:1');
  });
});

describe('planFilmstrip', () => {
  it('aims for a thumbnail every ~2 s within 8..240 tiles', () => {
    expect(planFilmstrip(20_000).count).toBe(10);
    expect(planFilmstrip(3_000).count).toBe(8);
    expect(planFilmstrip(7_200_000).count).toBe(240);
  });

  it('tiles into at most 16 columns', () => {
    const layout = planFilmstrip(7_200_000);
    expect(layout.columns).toBe(16);
    expect(layout.rows).toBe(15);
    expect(layout.intervalMs).toBe(30_000);
  });
});

describe('buildFilmstripArgs', () => {
  it('decodes keyframes only, keeps the final sample, and writes one image', () => {
    const layout = planFilmstrip(20_000);
    const args = buildFilmstripArgs('/in.mp4', '/out.partial.jpg', 20_000, layout);
    // -skip_frame is a DECODER option: it must come before -i to apply.
    expect(args.indexOf('-skip_frame')).toBeLessThan(args.indexOf('-i'));
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('fps=10/20.000:eof_action=pass');
    expect(vf).toContain('tile=10x1');
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', '-update', '1']));
    expect(args.at(-1)).toBe('/out.partial.jpg');
  });
});

describe('buildFittedClipArgs', () => {
  it('applies the SAME atempo chain the final mix uses', () => {
    const args = buildFittedClipArgs('/seg.wav', '/out.partial.wav', 1.3);
    expect(args[args.indexOf('-filter:a') + 1]).toBe('atempo=1.3000');
    expect(args.at(-1)).toBe('/out.partial.wav');
  });

  it('chains past atempo\'s 2x per-instance limit', () => {
    const args = buildFittedClipArgs('/seg.wav', '/o.wav', 3);
    expect(args[args.indexOf('-filter:a') + 1]).toBe('atempo=2.0000,atempo=1.5000');
  });

  it('is a plain copy-to-PCM at 1x', () => {
    expect(buildFittedClipArgs('/seg.wav', '/o.wav', 1)).not.toContain('-filter:a');
  });
});

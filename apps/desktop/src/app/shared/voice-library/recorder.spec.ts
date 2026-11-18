import { describe, expect, it } from 'vitest';
import { blockLevel, encodeWav, recorderErrorOf } from './recorder';

describe('recorder', () => {
  it('encodes float samples as a 16-bit mono PCM WAV', () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -1]), new Float32Array([1, 2, -2])], 48_000);
    const v = new DataView(wav);
    const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(wav, at, n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(48_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(12); // 6 samples
    const samples = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true));
    // Out-of-range samples are clipped, not wrapped.
    expect(samples).toEqual([0, 16383, -32768, 32767, 32767, -32768]);
  });

  it('measures a block for the level meter', () => {
    expect(blockLevel(new Float32Array(128))).toBe(0);
    expect(blockLevel(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });

  it('turns microphone failures into explainable reasons', () => {
    expect(recorderErrorOf({ name: 'NotAllowedError' })).toBe('mic-denied');
    expect(recorderErrorOf({ name: 'NotFoundError' })).toBe('mic-none');
    expect(recorderErrorOf({ name: 'NotReadableError' })).toBe('mic-busy');
    expect(recorderErrorOf(new Error('boom'))).toBe('mic-failed');
  });
});

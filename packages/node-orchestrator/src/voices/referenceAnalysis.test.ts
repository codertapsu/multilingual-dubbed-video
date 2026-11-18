import { describe, expect, it } from 'vitest';
import {
  checkReference,
  energySpeechRegions,
  frameStats,
  longestPauseMs,
  overlapMs,
  parseWavPcm16,
  suggestWindow,
  waveformPeaks,
  type PcmMono,
} from './referenceAnalysis.js';

const RATE = 16_000;
const POLICY = { minSpeechMs: 3000, idealMs: 8000, maxMs: 8000 };

/** Build a PCM signal from parts: [ms, amplitude 0..1 ("speech" tone) or noise level]. */
function signal(parts: Array<{ ms: number; amp?: number; noise?: number; clip?: boolean }>): PcmMono {
  const total = parts.reduce((n, p) => n + Math.round((p.ms * RATE) / 1000), 0);
  const samples = new Int16Array(total);
  let at = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (const p of parts) {
    const n = Math.round((p.ms * RATE) / 1000);
    for (let i = 0; i < n; i++, at++) {
      const tone = p.amp ? p.amp * Math.sin((2 * Math.PI * 220 * at) / RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * at) / RATE)) : 0;
      const v = (tone + (p.noise ?? 0.001) * rnd()) * 32767;
      samples[at] = Math.max(-32768, Math.min(32767, Math.round(p.clip ? Math.sign(v) * 32767 : v)));
    }
  }
  return { sampleRate: RATE, samples };
}

function wav(pcm: PcmMono, channels = 1): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2 * channels);
  pcm.samples.forEach((s, i) => {
    for (let c = 0; c < channels; c++) data.writeInt16LE(s, (i * channels + c) * 2);
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(pcm.sampleRate, 24);
  head.writeUInt32LE(pcm.sampleRate * 2 * channels, 28);
  head.writeUInt16LE(2 * channels, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

describe('reference analysis', () => {
  it('reads PCM-16 WAV, mono or stereo, and refuses anything else', () => {
    const pcm = signal([{ ms: 500, amp: 0.3 }]);
    expect(parseWavPcm16(wav(pcm)).samples).toEqual(pcm.samples);
    expect(parseWavPcm16(wav(pcm, 2)).samples).toEqual(pcm.samples);
    expect(() => parseWavPcm16(Buffer.from('ID3 not a wav at all'))).toThrow(/not a WAV/);
    const eightBit = wav(pcm);
    eightBit.writeUInt16LE(8, 34);
    expect(() => parseWavPcm16(eightBit)).toThrow(/unsupported/);
  });

  it('finds speech by level when no voice detector is running', () => {
    const pcm = signal([
      { ms: 600 },
      { ms: 2000, amp: 0.3 },
      { ms: 1000 },
      { ms: 1500, amp: 0.3 },
      { ms: 400 },
    ]);
    const regions = energySpeechRegions(frameStats(pcm).db);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.startMs).toBeGreaterThanOrEqual(560);
    expect(regions[0]!.startMs).toBeLessThanOrEqual(640);
    expect(Math.abs(regions[1]!.endMs - 5100)).toBeLessThanOrEqual(60);
    expect(overlapMs(regions, 0, 10_000)).toBeGreaterThan(3300);
    expect(longestPauseMs(regions, 0, 10_000)).toBeGreaterThan(900);
  });

  it('proposes the window with the most clean speech, snapped to it', () => {
    // 3 s of clipped speech, a gap, then 7 s of clean speech.
    const pcm = signal([
      { ms: 500 },
      { ms: 3000, amp: 0.9, clip: true },
      { ms: 2500 },
      { ms: 7000, amp: 0.3 },
      { ms: 1000 },
    ]);
    const stats = frameStats(pcm);
    const regions = energySpeechRegions(stats.db);
    const w = suggestWindow(14_000, regions, stats.clipped, POLICY);
    expect(w.endMs - w.startMs).toBeLessThanOrEqual(8000);
    expect(w.startMs).toBeGreaterThanOrEqual(5800); // the clean part, not the clipped one
    expect(overlapMs(regions, w.startMs, w.endMs)).toBeGreaterThan(6500);
  });

  it('says what is wrong in plain findings, and refuses only too little speech', () => {
    const check = (pcm: PcmMono) => {
      const stats = frameStats(pcm);
      const regions = energySpeechRegions(stats.db);
      const total = Math.floor((pcm.samples.length * 1000) / RATE);
      return checkReference(stats, RATE, regions, { startMs: 0, endMs: total }, POLICY);
    };
    const good = check(signal([{ ms: 300 }, { ms: 7000, amp: 0.3 }, { ms: 300 }]));
    expect(good.warnings).toEqual([]);
    expect(good.speechMs).toBeGreaterThan(6500);
    expect(good.snrDb!).toBeGreaterThan(30);

    expect(check(signal([{ ms: 300 }, { ms: 2000, amp: 0.3 }, { ms: 300 }])).warnings).toContain('too-short');
    expect(check(signal([{ ms: 300 }, { ms: 4000, amp: 0.3 }, { ms: 300 }])).warnings).toEqual(['short']);
    expect(check(signal([{ ms: 300 }, { ms: 7000, amp: 0.01, noise: 0.0001 }, { ms: 300, noise: 0.0001 }])).warnings).toContain(
      'too-quiet',
    );
    expect(check(signal([{ ms: 300 }, { ms: 7000, amp: 0.9, clip: true }, { ms: 300 }])).warnings).toContain('clipped');
    expect(check(signal([{ ms: 300, noise: 0.08 }, { ms: 7000, amp: 0.3, noise: 0.08 }, { ms: 300, noise: 0.08 }])).warnings).toContain(
      'noisy',
    );
    expect(
      check(signal([{ ms: 300 }, { ms: 3000, amp: 0.3 }, { ms: 2500 }, { ms: 3000, amp: 0.3 }, { ms: 300 }])).warnings,
    ).toContain('long-pause');
  });

  it('draws a waveform of the requested resolution', () => {
    const peaks = waveformPeaks(signal([{ ms: 1000, amp: 0.5 }]), 100);
    expect(peaks).toHaveLength(100);
    expect(Math.max(...peaks)).toBeGreaterThan(0.4);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
  });
});

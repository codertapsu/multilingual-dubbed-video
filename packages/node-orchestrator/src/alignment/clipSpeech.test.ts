import { describe, expect, it } from 'vitest';
import type { PipelineMediaService } from '../media.js';
import {
  applyClipTiming,
  expectedSpeechMs,
  measureClip,
  speechKeepWindow,
  type ClipSpeech,
} from './clipSpeech.js';

/** A measurement from its silences (sorted), as the media worker derives it. */
function measured(durationMs: number, silences: Array<[number, number]>) {
  const list = silences.map(([startMs, endMs]) => ({ startMs, endMs }));
  const silent = list.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const speechMs = durationMs - silent;
  const first = list[0];
  const last = list[list.length - 1];
  return {
    durationMs,
    silences: list,
    speechStartMs: speechMs === 0 ? 0 : first && first.startMs === 0 ? first.endMs : 0,
    speechEndMs: speechMs === 0 ? 0 : last && last.endMs === durationMs ? last.startMs : durationMs,
    speechMs,
  } satisfies ClipSpeech;
}

describe('expectedSpeechMs', () => {
  it('counts letters, weighting Han characters as syllables', () => {
    expect(expectedSpeechMs('Thua')).toBe(400); // one syllable: the floor
    expect(expectedSpeechMs('Sức mạnh gần như vô hạn.')).toBe(1286); // 18 letters / 14 per s
    expect(expectedSpeechMs('你好世界')).toBe(857); // 4 × 3 letters
  });

  it('does not take a language written without spaces for one word', () => {
    // Thai has no spaces between words; a word count would call this "1".
    expect(expectedSpeechMs('สวัสดีครับวันนี้อากาศดีมาก')).toBeGreaterThan(1000);
  });
});

describe('speechKeepWindow', () => {
  it('trims the lead-in and the tail of a healthy clip', () => {
    // p50 VieNeu edges: ~100 ms before the voice, ~230 ms after it.
    const m = measured(3000, [
      [0, 98],
      [2774, 3000],
    ]);
    expect(speechKeepWindow(m, 'Ta không đi đâu cả, cứ ở đây.')).toEqual({ startMs: 48, endMs: 2854, cut: false });
  });

  it('cuts the noise a botched clip carries after its word ("Thua", 12.3 s)', () => {
    const m = measured(12_300, [
      [0, 85],
      [566, 6398],
      [6600, 12_300],
    ]);
    expect(speechKeepWindow(m, 'Thua')).toEqual({ startMs: 35, endMs: 646, cut: true });
  });

  it('keeps every sentence of a long line with a long pause in it', () => {
    // Two sentences, an 800 ms pause between them, nothing after: not botched.
    const m = measured(6000, [
      [0, 90],
      [2600, 3400],
      [5700, 6000],
    ]);
    const text = 'Ngươi đã đến muộn rồi. Bọn chúng đi từ sáng sớm.';
    expect(speechKeepWindow(m, text)).toEqual({ startMs: 40, endMs: 5780, cut: false });
  });

  it('cuts after the sentence whose length matches the text, not at the first pause', () => {
    // A two-sentence line spoken in ~3.4 s, then 5 s of nothing and a burst.
    const m = measured(12_000, [
      [0, 80],
      [1700, 2500],
      [3500, 8500],
      [9100, 12_000],
    ]);
    const text = 'Ngươi đã đến muộn rồi. Bọn chúng đi từ sáng sớm.';
    expect(speechKeepWindow(m, text)).toEqual({ startMs: 30, endMs: 3580, cut: true });
  });

  it('only trims the edges of a clip whose short sound is all at the start', () => {
    // "Sức mạnh gần như vô hạn." came back 24 s long with 0.6 s of sound.
    const m = measured(24_000, [
      [0, 90],
      [690, 24_000],
    ]);
    expect(speechKeepWindow(m, 'Sức mạnh gần như vô hạn.')).toEqual({ startMs: 40, endMs: 770, cut: false });
  });

  it('keeps a botched clip whole when no long silence separates speech from noise', () => {
    const m = measured(9000, [
      [0, 100],
      [8800, 9000],
    ]);
    expect(speechKeepWindow(m, 'Thua')).toEqual({ startMs: 50, endMs: 8880, cut: false });
  });

  it('plays silent, click-only and untrimmable clips whole', () => {
    expect(speechKeepWindow(measured(3000, [[0, 3000]]), 'Thua')).toBeUndefined();
    // 60 ms of sound: more likely speech under the threshold than the line.
    expect(
      speechKeepWindow(
        measured(3000, [
          [0, 1000],
          [1060, 3000],
        ]),
        'Thua',
      ),
    ).toBeUndefined();
    // Sound from the first to the last millisecond.
    expect(speechKeepWindow(measured(2000, []), 'Thua')).toBeUndefined();
    // Edges under the trim threshold.
    expect(
      speechKeepWindow(
        measured(2000, [
          [0, 55],
          [1925, 2000],
        ]),
        'Thua',
      ),
    ).toBeUndefined();
  });
});

describe('measureClip', () => {
  const probeOnly = (durationMs: number): Pick<PipelineMediaService, 'probe' | 'measureSpeech'> => ({
    probe: () => Promise.resolve({ durationMs } as Awaited<ReturnType<PipelineMediaService['probe']>>),
  });

  it('measures and trims when the media service can', async () => {
    const m = measured(12_300, [
      [0, 85],
      [566, 6398],
      [6600, 12_300],
    ]);
    const media = { ...probeOnly(12_300), measureSpeech: () => Promise.resolve({ ...m, noiseDb: -40, minSilenceMs: 50 }) };
    await expect(measureClip(media, 'a.wav', 'Thua')).resolves.toEqual({
      generatedDurationMs: 611,
      trimStartMs: 35,
      trimEndMs: 646,
      clipDurationMs: 12_300,
      outcome: 'cut',
    });
  });

  it('falls back to the plain duration without measurement, or when it fails', async () => {
    await expect(measureClip(probeOnly(2500), 'a.wav', 'Thua')).resolves.toEqual({
      generatedDurationMs: 2500,
      clipDurationMs: 2500,
      outcome: 'unmeasured',
    });
    const failing = { ...probeOnly(2500), measureSpeech: () => Promise.reject(new Error('ffmpeg exited 1')) };
    await expect(measureClip(failing, 'a.wav', 'Thua')).resolves.toMatchObject({ outcome: 'unmeasured' });
  });

  it('never swallows a cancel', async () => {
    const ac = new AbortController();
    ac.abort();
    const cancelled = { ...probeOnly(2500), measureSpeech: () => Promise.reject(new Error('aborted')) };
    await expect(measureClip(cancelled, 'a.wav', 'Thua', ac.signal)).rejects.toThrow('aborted');
  });

  it('reports a silent clip and plays it whole', async () => {
    const m = measured(3000, [[0, 3000]]);
    const media = { ...probeOnly(3000), measureSpeech: () => Promise.resolve({ ...m, noiseDb: -40, minSilenceMs: 50 }) };
    await expect(measureClip(media, 'a.wav', 'Thua')).resolves.toEqual({
      generatedDurationMs: 3000,
      clipDurationMs: 3000,
      outcome: 'silent',
    });
  });
});

describe('applyClipTiming', () => {
  it('sets a fresh trim and clears a stale one', () => {
    const input: { generatedDurationMs: number; trimStartMs?: number; trimEndMs?: number } = {
      generatedDurationMs: 0,
    };
    applyClipTiming(input, { generatedDurationMs: 611, trimStartMs: 35, trimEndMs: 646 });
    expect(input).toEqual({ generatedDurationMs: 611, trimStartMs: 35, trimEndMs: 646 });
    applyClipTiming(input, { generatedDurationMs: 2500 });
    expect(input).toEqual({ generatedDurationMs: 2500 });
  });
});

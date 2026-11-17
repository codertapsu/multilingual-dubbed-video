import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  budgetPhrase,
  clipRates,
  countSpeechUnits,
  defaultVoiceRate,
  FileVoiceRateBook,
  voiceRateBookFor,
  fitBudget,
  fitWindowMs,
  MAX_SAMPLES_PER_VOICE,
  mergeSamples,
  MIN_SAMPLES_FOR_RATE,
  resolveVoiceRate,
  robustMedian,
  voiceRateKey,
  withFitWindows,
  type VoiceRateBook,
} from './speechFit.js';

describe('countSpeechUnits (mirrors the MCP server spokenLength)', () => {
  it('counts Vietnamese syllables, CJK characters, else words', () => {
    expect(countSpeechUnits('Côn Lôn Khư ngày nào cũng suýt chết.', 'vi-VN')).toBe(8);
    expect(countSpeechUnits('  — Có mặt! —  ', 'vi')).toBe(2);
    expect(countSpeechUnits('你好，世界！', 'zh')).toBe(4);
    expect(countSpeechUnits('Hello there, friend.', 'en')).toBe(3);
    expect(countSpeechUnits('', 'vi')).toBe(0);
  });
});

describe('fit windows', () => {
  it('credits the pause after a cue, minus a breath, capped at one second', () => {
    expect(fitWindowMs({ startMs: 0, endMs: 2000 })).toBe(2000);
    expect(fitWindowMs({ startMs: 0, endMs: 2000 }, 2000)).toBe(2000); // no pause
    expect(fitWindowMs({ startMs: 0, endMs: 2000 }, 2100)).toBe(2000); // under the breath
    expect(fitWindowMs({ startMs: 0, endMs: 2000 }, 2650)).toBe(2500);
    expect(fitWindowMs({ startMs: 0, endMs: 2000 }, 9000)).toBe(3000); // a scene break is not room to talk
  });

  it('measures every window against its real successor before any batching', () => {
    const out = withFitWindows([
      { id: 'a', startMs: 0, endMs: 1000 },
      { id: 'b', startMs: 1500, endMs: 2500 },
      { id: 'c', startMs: 2500, endMs: 3000, fitMs: 9999 },
      { id: 'd' },
    ]);
    expect(out.map((s) => s.fitMs)).toEqual([1350, 1000, 9999, undefined]);
  });
});

describe('fitBudget', () => {
  it('targets the natural pace and caps at the comfortable 1.15× speed-up', () => {
    expect(fitBudget('vi', 3000, 3.5)).toEqual({ target: 11, max: 12, unit: 'syllables' });
    // Without a voice rate the shared language default (4.6) applies.
    expect(fitBudget('vi', 3000)).toEqual({ target: 14, max: 16, unit: 'syllables' });
    expect(fitBudget('vi', 0)).toBeUndefined();
    expect(fitBudget('vi', undefined)).toBeUndefined();
  });

  it('phrases the range the way every prompt quotes it', () => {
    expect(budgetPhrase({ target: 11, max: 12, unit: 'syllables' }, 'vi')).toBe(
      'about 11 syllables (âm tiết), never more than 12',
    );
    expect(budgetPhrase({ target: 1, max: 1, unit: 'words' }, 'en')).toBe('about 1 words, never more');
  });
});

describe('voice rates', () => {
  it('learns only from clips long enough to show pace, and drops engine failures', () => {
    const rates = clipRates(
      [
        { text: 'một hai ba bốn năm sáu bảy', durationMs: 2000 }, // 3.5/s
        { text: 'Có mặt!', durationMs: 900 }, // too short to say anything about pace
        { text: 'Sức mạnh gần như vô hạn.', durationMs: 24_000 }, // VieNeu hallucination: 0.25/s
        { text: 'một hai ba bốn', durationMs: 500 }, // under 800 ms
      ],
      'vi',
    );
    expect(rates).toEqual([3.5]);
  });

  it('takes a robust median', () => {
    expect(robustMedian([3.2, 3.4, 9, 3.6])).toBeCloseTo(3.5);
    expect(robustMedian([])).toBeUndefined();
  });

  it('keeps the newest samples per voice', () => {
    const existing = Array.from({ length: MAX_SAMPLES_PER_VOICE }, () => 1);
    const merged = mergeSamples(existing, [5, 6]);
    expect(merged).toHaveLength(MAX_SAMPLES_PER_VOICE);
    expect(merged.slice(-2)).toEqual([5, 6]);
  });

  it('has engine defaults measured on real dubs, keyed by TTS provider', () => {
    expect(defaultVoiceRate('neural-tts', 'vi-VN')).toBe(3.5);
    expect(defaultVoiceRate('piper-local', 'vi')).toBeGreaterThan(3.5);
    expect(defaultVoiceRate('openai-tts', 'vi')).toBeUndefined();
    expect(defaultVoiceRate(undefined, 'vi')).toBeUndefined();
  });

  it('resolves measured > engine default > language default', async () => {
    const book: VoiceRateBook = {
      rate: async (key) => (key === voiceRateKey('neural-tts', 'trong-huu', 'vi') ? 3.3 : undefined),
      record: async () => {},
    };
    expect(await resolveVoiceRate(book, 'neural-tts', 'trong-huu', 'vi-VN')).toEqual({ perSecond: 3.3, source: 'measured' });
    expect(await resolveVoiceRate(book, 'neural-tts', 'thai-son', 'vi')).toEqual({ perSecond: 3.5, source: 'engine-default' });
    expect(await resolveVoiceRate(undefined, 'openai-tts', 'alloy', 'vi')).toEqual({ source: 'language-default' });
  });
});

describe('FileVoiceRateBook', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-voice-rates-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('answers only once a voice has enough samples, and persists them', async () => {
    const file = path.join(dir, 'voice_rates.json');
    const book = new FileVoiceRateBook(file);
    const key = voiceRateKey('neural-tts', 'v', 'vi');
    await book.record(key, Array.from({ length: MIN_SAMPLES_FOR_RATE - 1 }, () => 3.4));
    expect(await book.rate(key)).toBeUndefined();
    await book.record(key, [3.6]);
    expect(await book.rate(key)).toBeCloseTo(3.4);
    // A second instance (the next run) reads the same history.
    expect(await new FileVoiceRateBook(file).rate(key)).toBeCloseTo(3.4);
  });

  it('serializes concurrent records instead of losing one', async () => {
    const book = new FileVoiceRateBook(path.join(dir, 'voice_rates.json'));
    await Promise.all([book.record('a', [1, 2]), book.record('b', [3]), book.record('a', [4])]);
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'voice_rates.json'), 'utf8'));
    expect(saved.voices.a.samples).toEqual([1, 2, 4]);
    expect(saved.voices.b.samples).toEqual([3]);
  });

  it('is one book per file, so two dubs recording together keep both', async () => {
    // Each dub used to get its own instance, whose queue ordered only its own writes.
    expect(voiceRateBookFor(dir)).toBe(voiceRateBookFor(dir));
    await Promise.all([voiceRateBookFor(dir).record('a', [1]), voiceRateBookFor(dir).record('b', [2])]);
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'voice_rates.json'), 'utf8'));
    expect(Object.keys(saved.voices).sort()).toEqual(['a', 'b']);
  });

  it('refuses to record over a file it could not read', async () => {
    // A directory in the file's place: EISDIR, not "missing" — as a transient
    // read error, it must not let the write replace every voice's history.
    const file = path.join(dir, 'voice_rates.json');
    await fsp.mkdir(file);
    await expect(new FileVoiceRateBook(file).record('a', [3])).rejects.toThrow();
  });

  it('treats a corrupt file as no history (it is a cache of measurements)', async () => {
    const file = path.join(dir, 'voice_rates.json');
    await fsp.writeFile(file, '{not json', 'utf8');
    const book = new FileVoiceRateBook(file);
    expect(await book.rate('a')).toBeUndefined();
    await book.record('a', [3]);
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).voices.a.samples).toEqual([3]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSilenceDetectArgs,
  deriveSpeechMeasurement,
  parseSilenceDetect,
  SPEECH_MIN_SILENCE_MS,
  SPEECH_NOISE_DB,
} from './speech.js';

/** Real ffmpeg 9.0.2 output for clips from real dubs, at the default -40 dB / 50 ms. */
const detectorLog = (pairs: Array<[number, number]>): string =>
  [
    "Input #0, wav, from 'segment.wav':",
    '  Duration: 00:00:12.32, bitrate: 768 kb/s',
    ...pairs.flatMap(([s, e]) => [
      `[Parsed_silencedetect_0 @ 00000274dfc84480] silence_start: ${s}`,
      `[Parsed_silencedetect_0 @ 00000274dfc84480] silence_end: ${e} | silence_duration: ${(e - s).toFixed(6)}`,
    ]),
    '[out#0/null @ 000002] video:0KiB audio:2310KiB subtitle:0KiB other streams:0KiB global headers:0KiB',
  ].join('\r\n');

const measure = (durationMs: number, log: string) =>
  deriveSpeechMeasurement(durationMs, parseSilenceDetect(log));

describe('buildSilenceDetectArgs', () => {
  it('runs silencedetect at INFO level (where it logs), writes nothing, no progress noise', () => {
    const args = buildSilenceDetectArgs('/clips/segment_0314.wav', -40, 50);
    expect(args[args.indexOf('-af') + 1]).toBe('silencedetect=noise=-40dB:duration=0.050');
    expect(args[args.indexOf('-v') + 1]).toBe('info');
    expect(args).toContain('-nostats');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args[args.indexOf('-i') + 1]).toBe('/clips/segment_0314.wav');
  });

  it('defaults to the thresholds tuned on VieNeu clips', () => {
    expect(SPEECH_NOISE_DB).toBe(-40);
    expect(SPEECH_MIN_SILENCE_MS).toBe(50);
  });
});

describe('parseSilenceDetect', () => {
  it('reads start/end events in order, ignoring every other line', () => {
    const events = parseSilenceDetect(detectorLog([[0, 0.0853542], [0.346792, 6.396271]]));
    expect(events).toEqual([
      { kind: 'start', seconds: 0 },
      { kind: 'end', seconds: 0.0853542 },
      { kind: 'start', seconds: 0.346792 },
      { kind: 'end', seconds: 6.396271 },
    ]);
  });

  it('accepts negative and exponent forms some builds print', () => {
    const events = parseSilenceDetect('silence_start: -0.0123\nsilence_end: 1.5e-2 | silence_duration: 0.03');
    expect(events).toEqual([
      { kind: 'start', seconds: -0.0123 },
      { kind: 'end', seconds: 0.015 },
    ]);
  });
});

describe('deriveSpeechMeasurement (real clips)', () => {
  it('"Thua": 12.3 s clip, the word at 85-347 ms and a stray burst at 6.4 s', () => {
    const m = measure(12_320, detectorLog([[0, 0.0853542], [0.346792, 6.396271], [6.615, 12.32]]));
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 85 },
      { startMs: 347, endMs: 6396 },
      { startMs: 6615, endMs: 12_320 },
    ]);
    expect(m.speechStartMs).toBe(85);
    expect(m.speechEndMs).toBe(6615);
    // 481 ms of sound in a 12.3 s clip: the signature of a broken synthesis.
    expect(m.speechMs).toBe(481);
    expect(m).toMatchObject({ durationMs: 12_320, noiseDb: -40, minSilenceMs: 50 });
  });

  it('"Ở.": a 0.17 ms click splitting one silence is folded back in', () => {
    const m = measure(
      4080,
      detectorLog([[0, 0.10525], [0.631042, 1.822688], [1.822854, 2.687417], [3.359062, 3.510354], [3.824333, 4.08]]),
    );
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 105 },
      { startMs: 631, endMs: 2687 },
      { startMs: 3359, endMs: 3510 },
      { startMs: 3824, endMs: 4080 },
    ]);
    expect(m.speechStartMs).toBe(105);
    expect(m.speechEndMs).toBe(3824);
    expect(m.speechMs).toBe(1512);
  });

  it('a healthy "Kệ nó đi": lead-in and tail only', () => {
    const m = measure(1120, detectorLog([[0, 0.0881458], [0.880875, 1.12]]));
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 88 },
      { startMs: 881, endMs: 1120 },
    ]);
    expect(m.speechStartMs).toBe(88);
    expect(m.speechEndMs).toBe(881);
    expect(m.speechMs).toBe(793);
  });

  it('a healthy two-phrase line: keeps the real pause, merges a 1 ms click in the tail', () => {
    const m = measure(2640, detectorLog([[0, 0.0731042], [0.861229, 1.280979], [2.3985, 2.491125], [2.492479, 2.64]]));
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 73 },
      { startMs: 861, endMs: 1281 },
      { startMs: 2399, endMs: 2640 },
    ]);
    expect(m.speechEndMs).toBe(2399);
    expect(m.speechMs).toBe(1906);
  });
});

describe('deriveSpeechMeasurement (edge cases)', () => {
  it('a clip with no silence at all: speech spans it', () => {
    const m = measure(900, detectorLog([]));
    expect(m).toMatchObject({ silences: [], speechStartMs: 0, speechEndMs: 900, speechMs: 900 });
  });

  it('a silent clip: speechMs 0 and both bounds 0', () => {
    const m = measure(3000, detectorLog([[0, 3]]));
    expect(m).toMatchObject({ silences: [{ startMs: 0, endMs: 3000 }], speechStartMs: 0, speechEndMs: 0, speechMs: 0 });
  });

  it('a final silence with no silence_end (older ffmpeg builds) runs to the end', () => {
    const log = 'silence_start: 0\nsilence_end: 0.1 | silence_duration: 0.1\nsilence_start: 0.8\n';
    const m = measure(1000, log);
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 800, endMs: 1000 },
    ]);
    expect(m.speechEndMs).toBe(800);
  });

  it('clamps a negative start and anything past the duration', () => {
    const m = measure(1000, 'silence_start: -0.02\nsilence_end: 0.1\nsilence_start: 0.9\nsilence_end: 1.05\n');
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 900, endMs: 1000 },
    ]);
  });

  it('folds a click at either END of the clip into the silence next to it', () => {
    // 10 ms of click before the lead-in silence, 5 ms after the tail silence.
    const m = measure(1000, 'silence_start: 0.01\nsilence_end: 0.1\nsilence_start: 0.8\nsilence_end: 0.995\n');
    expect(m.speechStartMs).toBe(100);
    expect(m.speechEndMs).toBe(800);
    expect(m.silences).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 800, endMs: 1000 },
    ]);
  });

  it('keeps a real (>= 20 ms) burst of sound between silences', () => {
    const m = measure(2000, 'silence_start: 0\nsilence_end: 1\nsilence_start: 1.03\nsilence_end: 2\n');
    expect(m.silences).toHaveLength(2);
    expect(m.speechMs).toBe(30);
    expect(m.speechStartMs).toBe(1000);
    expect(m.speechEndMs).toBe(1030);
  });

  it('records the thresholds it was given', () => {
    const m = deriveSpeechMeasurement(100, [], { noiseDb: -35, minSilenceMs: 80 });
    expect(m).toMatchObject({ noiseDb: -35, minSilenceMs: 80 });
  });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock the ffmpeg/ffprobe shells so duckAndMix's two-pass logic is testable
// without real binaries. The pure helpers (loudnormMeasurementsUsable,
// parseLoudnormJson, buildMixFilterComplex) don't touch these.
vi.mock('./exec.js', () => ({
  runFfmpeg: vi.fn(),
  assertInputReadable: vi.fn(),
  assertOutputWritable: vi.fn(),
}));
vi.mock('./probe.js', () => ({ probeDurationMs: vi.fn(async () => 1234) }));

import { runFfmpeg } from './exec.js';
import {
  buildMixFilterComplex,
  duckAndMix,
  loudnormMeasurementsUsable,
  parseLoudnormJson,
  type DuckAndMixInput,
  type LoudnormMeasurements,
} from './mix.js';

const runFfmpegMock = vi.mocked(runFfmpeg);

const measurements = (o: Partial<LoudnormMeasurements> = {}): LoudnormMeasurements => ({
  input_i: '-18.0',
  input_tp: '-2.0',
  input_lra: '7.0',
  input_thresh: '-28.0',
  target_offset: '0.5',
  ...o,
});

describe('loudnorm silent-input guard (regression: measured_I=-inf, exit 222)', () => {
  it('accepts finite, in-range measurements (normal program)', () => {
    expect(loudnormMeasurementsUsable(measurements())).toBe(true);
  });

  it('rejects -inf measurements from a silent/near-silent program', () => {
    // A digitally-silent dub measures input_i / thresh / TP as "-inf"; ffmpeg then
    // rejects measured_I=-inf as out of [-99, 0] and aborts (exit 222). The guard
    // makes duckAndMix fall back to single-pass loudnorm instead of crashing.
    expect(loudnormMeasurementsUsable(measurements({ input_i: '-inf' }))).toBe(false);
    expect(loudnormMeasurementsUsable(measurements({ input_thresh: '-inf' }))).toBe(false);
    expect(loudnormMeasurementsUsable(measurements({ input_tp: '-inf' }))).toBe(false);
  });

  it('rejects an integrated loudness outside loudnorm’s [-99, 0] range', () => {
    expect(loudnormMeasurementsUsable(measurements({ input_i: '-120' }))).toBe(false);
    expect(loudnormMeasurementsUsable(measurements({ input_i: '3' }))).toBe(false);
  });

  it('rejects out-of-range input_lra / target_offset (also forwarded to pass 2)', () => {
    // loudnormApplyFilter forwards these too, so a degenerate value aborts pass 2.
    expect(loudnormMeasurementsUsable(measurements({ input_lra: '-inf' }))).toBe(false);
    expect(loudnormMeasurementsUsable(measurements({ input_lra: '-1' }))).toBe(false); // LRA must be >= 0
    expect(loudnormMeasurementsUsable(measurements({ target_offset: 'inf' }))).toBe(false);
  });

  it('parses a real ffmpeg-8.x silent-program block (input_i/tp=-inf, offset=inf) and rejects it', () => {
    // What ffmpeg 8.x actually prints for digital silence: I and TP are "-inf",
    // threshold is the finite -70 default, and target_offset is "inf".
    const stderr =
      'frame=… \n{\n  "input_i" : "-inf",\n  "input_tp" : "-inf",\n  "input_lra" : "0.00",\n' +
      '  "input_thresh" : "-70.00",\n  "target_offset" : "inf"\n}\n';
    const m = parseLoudnormJson(stderr);
    expect(m?.input_i).toBe('-inf');
    expect(loudnormMeasurementsUsable(m!)).toBe(false);
  });
});

describe('mix filtergraph (unchanged behavior sanity)', () => {
  const base: DuckAndMixInput = {
    originalAudio: 'orig.wav',
    ttsTimeline: 'tts.wav',
    output: 'out.wav',
    duckingLevelDb: -15,
    ttsGainDb: 0,
    includeBackground: false,
    duck: false,
  };

  it('no-background mix is just the normalized TTS', () => {
    const fc = buildMixFilterComplex(base);
    expect(fc).toContain('[1:a]');
    expect(fc).toContain('[tts]loudnorm');
    expect(fc).not.toContain('[0:a]'); // original unused
  });
});

describe('duckAndMix two-pass loudnorm + silent fallback', () => {
  // duckAndMix writes through writeAtomically (ffmpeg -> `<dest>.partial.wav`,
  // renamed on success), so the fake ffmpeg has to actually produce the file it
  // was told to write — that rename IS the behavior protecting resume from a
  // truncated mix.
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-mix-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const base: DuckAndMixInput = {
    originalAudio: 'orig.wav',
    ttsTimeline: 'tts.wav',
    get output(): string {
      return join(dir, 'out.wav');
    },
    duckingLevelDb: -15,
    ttsGainDb: 0,
    includeBackground: false,
    duck: false,
    twoPassLoudnorm: true,
  };

  afterEach(() => runFfmpegMock.mockReset());

  /** Stand in for ffmpeg: emit the requested WAV, then report `stderr`. */
  const fakeFfmpeg = (stderr: string) => async (args: string[]) => {
    const out = args[args.length - 1] ?? '';
    if (out.endsWith('.wav')) writeFileSync(out, 'RIFF', 'utf8');
    return { stdout: '', stderr, exitCode: 0 };
  };

  it('applies the measured second pass when the program loudness is usable', async () => {
    runFfmpegMock.mockImplementation(
      fakeFfmpeg(
        JSON.stringify({ input_i: '-18', input_tp: '-2', input_lra: '7', input_thresh: '-28', target_offset: '0.5' }),
      ) as never,
    );
    await duckAndMix(base);
    expect(runFfmpegMock).toHaveBeenCalledTimes(2); // measure + apply
    expect(runFfmpegMock.mock.calls[1]![0].join(' ')).toContain('measured_I=-18');
  });

  it('falls back to single-pass (no measured values) when the program is silent', async () => {
    // ffmpeg-8.x silent analysis: I/TP=-inf, offset=inf -> unusable -> single pass.
    runFfmpegMock.mockImplementation(
      fakeFfmpeg('{ "input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70.00","target_offset":"inf" }') as never,
    );
    await duckAndMix(base);
    expect(runFfmpegMock).toHaveBeenCalledTimes(2);
    expect(runFfmpegMock.mock.calls[0]![0]).toContain('-f'); // pass 1 = `-f null` measure
    const apply = runFfmpegMock.mock.calls[1]![0].join(' ');
    expect(apply).toContain('loudnorm'); // single-pass dynamic loudnorm
    expect(apply).not.toContain('measured_I'); // NOT the two-pass apply
  });

  it('writes to <dest>.partial.wav and leaves nothing behind when ffmpeg fails', async () => {
    // Regression: a cancelled/crashed mix used to leave a truncated, NON-EMPTY
    // final_mix.wav that the pipeline's resume check accepted as a finished
    // step — the next run skipped Mix Audio and shipped a half-length dub.
    const dest = join(dir, 'fails.wav');
    const seen: string[] = [];
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      const out = args[args.length - 1] ?? '';
      seen.push(out);
      if (out.endsWith('.wav')) writeFileSync(out, 'TRUNCATED', 'utf8');
      throw new Error('ffmpeg exited with code 255');
    }) as never);

    await expect(duckAndMix({ ...base, output: dest, twoPassLoudnorm: false })).rejects.toThrow(
      'ffmpeg exited with code 255',
    );
    expect(seen).toEqual([join(dir, 'fails.partial.wav')]);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(dir, 'fails.partial.wav'))).toBe(false);
  });
});

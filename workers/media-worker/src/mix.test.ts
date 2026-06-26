import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const base: DuckAndMixInput = {
    originalAudio: 'orig.wav',
    ttsTimeline: 'tts.wav',
    output: 'out.wav',
    duckingLevelDb: -15,
    ttsGainDb: 0,
    includeBackground: false,
    duck: false,
    twoPassLoudnorm: true,
  };

  afterEach(() => runFfmpegMock.mockReset());

  it('applies the measured second pass when the program loudness is usable', async () => {
    runFfmpegMock.mockResolvedValue({
      stdout: '',
      stderr: JSON.stringify({ input_i: '-18', input_tp: '-2', input_lra: '7', input_thresh: '-28', target_offset: '0.5' }),
    } as never);
    await duckAndMix(base);
    expect(runFfmpegMock).toHaveBeenCalledTimes(2); // measure + apply
    expect(runFfmpegMock.mock.calls[1]![0].join(' ')).toContain('measured_I=-18');
  });

  it('falls back to single-pass (no measured values) when the program is silent', async () => {
    // ffmpeg-8.x silent analysis: I/TP=-inf, offset=inf -> unusable -> single pass.
    runFfmpegMock.mockResolvedValue({
      stdout: '',
      stderr: '{ "input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70.00","target_offset":"inf" }',
    } as never);
    await duckAndMix(base);
    expect(runFfmpegMock).toHaveBeenCalledTimes(2);
    expect(runFfmpegMock.mock.calls[0]![0]).toContain('-f'); // pass 1 = `-f null` measure
    const apply = runFfmpegMock.mock.calls[1]![0].join(' ');
    expect(apply).toContain('loudnorm'); // single-pass dynamic loudnorm
    expect(apply).not.toContain('measured_I'); // NOT the two-pass apply
  });
});

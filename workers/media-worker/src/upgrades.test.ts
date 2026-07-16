import { describe, expect, it } from 'vitest';
import {
  buildMixFilterComplex,
  buildMixMeasureArgs,
  loudnormApplyFilter,
  loudnormFilter,
  parseLoudnormJson,
  type DuckAndMixInput,
} from './mix.js';
import { parseFfmpegEncoders } from './exec.js';
import { selectVideoCodec } from './render.js';
import { buildRubberbandArgs, shouldUseRubberband } from './stretch.js';

const baseMix: DuckAndMixInput = {
  originalAudio: '/p/original.wav',
  ttsTimeline: '/p/tts_full.wav',
  output: '/p/final_mix.wav',
  duckingLevelDb: -12,
  ttsGainDb: 0,
  includeBackground: true,
  duck: true,
};

describe('two-pass loudnorm', () => {
  it('single-pass graph uses dynamic loudnorm', () => {
    const g = buildMixFilterComplex(baseMix);
    expect(g).toContain(loudnormFilter());
    expect(g).not.toContain('measured_I');
  });

  it('apply filter seeds measured values for linear normalization', () => {
    const measured = {
      input_i: '-18.2',
      input_tp: '-2.1',
      input_lra: '7.5',
      input_thresh: '-28.9',
      target_offset: '0.4',
    };
    const f = loudnormApplyFilter(measured);
    expect(f).toContain('measured_I=-18.2');
    expect(f).toContain('measured_TP=-2.1');
    expect(f).toContain('linear=true');
  });

  it('measure-pass argv discards output via -f null', () => {
    const args = buildMixMeasureArgs(baseMix);
    expect(args).toContain('-f');
    expect(args).toContain('null');
    expect(args.join(' ')).toContain('print_format=json');
  });

  it('parses the loudnorm JSON block out of ffmpeg stderr', () => {
    const stderr = [
      'frame= 100 ...',
      '[Parsed_loudnorm_0 @ 0x] ',
      '{',
      '  "input_i" : "-18.20",',
      '  "input_tp" : "-2.10",',
      '  "input_lra" : "7.50",',
      '  "input_thresh" : "-28.90",',
      '  "output_i" : "-16.0",',
      '  "target_offset" : "0.40"',
      '}',
    ].join('\n');
    const m = parseLoudnormJson(stderr);
    expect(m?.input_i).toBe('-18.20');
    expect(m?.target_offset).toBe('0.40');
  });

  it('returns undefined when no JSON block is present', () => {
    expect(parseLoudnormJson('no json here')).toBeUndefined();
  });
});

describe('replace-vocals / keep M&E bed mix', () => {
  it('mixes the bed at full volume when duck=false and level=0', () => {
    const g = buildMixFilterComplex({ ...baseMix, duck: false, duckingLevelDb: 0 });
    expect(g).toContain('volume=0dB[bg]');
    expect(g).toContain('amix=inputs=2');
  });
});

describe('hardware encoder selection', () => {
  const all = new Set(['libx264', 'h264_videotoolbox', 'h264_nvenc']);

  it('quality always uses software x264 CRF', () => {
    const sel = selectVideoCodec('quality', 'darwin', all);
    expect(sel.codec).toBe('libx264');
    expect(sel.extraArgs).toContain('-crf');
  });

  it('fast uses VideoToolbox on macOS when available', () => {
    const sel = selectVideoCodec('fast', 'darwin', all);
    expect(sel.codec).toBe('h264_videotoolbox');
    expect(sel.extraArgs).toContain('-q:v');
  });

  it('fast uses NVENC off-macOS when available', () => {
    const sel = selectVideoCodec('fast', 'win32', all);
    expect(sel.codec).toBe('h264_nvenc');
    expect(sel.extraArgs).toContain('-cq');
  });

  it('falls back to x264 when the hardware encoder is absent', () => {
    const sel = selectVideoCodec('fast', 'win32', new Set(['libx264']));
    expect(sel.codec).toBe('libx264');
  });

  it('parses encoder names from ffmpeg -encoders output', () => {
    const stdout = [
      'Encoders:',
      ' V..... libx264              libx264 H.264 / AVC',
      ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder',
      ' A..... aac                  AAC (Advanced Audio Coding)',
    ].join('\n');
    const enc = parseFfmpegEncoders(stdout);
    expect(enc.has('libx264')).toBe(true);
    expect(enc.has('h264_videotoolbox')).toBe(true);
    expect(enc.has('aac')).toBe(true);
  });
});

describe('Rubber Band time-stretch', () => {
  it('never used when the binary is unavailable', () => {
    expect(shouldUseRubberband(1.6, 'rubberband', false)).toBe(false);
  });
  it('"rubberband" engine uses it for any non-unity ratio', () => {
    expect(shouldUseRubberband(1.1, 'rubberband', true)).toBe(true);
    expect(shouldUseRubberband(1.0, 'rubberband', true)).toBe(false);
  });
  it('"auto" only above the threshold (1.1 — atempo is transparent below ~10%)', () => {
    expect(shouldUseRubberband(1.05, 'auto', true)).toBe(false);
    expect(shouldUseRubberband(1.2, 'auto', true)).toBe(true);
    // Slow-downs mirror the threshold (ratio <= 1/1.1).
    expect(shouldUseRubberband(0.85, 'auto', true)).toBe(true);
    expect(shouldUseRubberband(0.95, 'auto', true)).toBe(false);
  });
  it('"ffmpeg-atempo" never uses it', () => {
    expect(shouldUseRubberband(1.8, 'ffmpeg-atempo', true)).toBe(false);
  });
  it('builds R3 + formant-preserving argv with inverted time multiplier', () => {
    const args = buildRubberbandArgs('/in.wav', '/out.wav', 1.5);
    expect(args).toContain('--fine');
    expect(args).toContain('--formant');
    const t = args[args.indexOf('--time') + 1];
    expect(Number(t)).toBeCloseTo(0.6667, 3);
  });
});

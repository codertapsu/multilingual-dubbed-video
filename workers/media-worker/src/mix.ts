/**
 * Mix the dubbed TTS timeline with the original audio, producing final_mix.wav.
 *
 * Behaviors (driven by ProjectSettings):
 *   - includeBackground=false  -> output is essentially just the TTS timeline,
 *     loudness-normalized. The original audio is dropped.
 *   - includeBackground=true, duck=true -> the original is side-chain ducked by
 *     the TTS signal (sidechaincompress), then mixed under the (gained) TTS.
 *   - includeBackground=true, duck=false -> original is attenuated by a fixed
 *     volume (duckingLevelDb) and mixed under the (gained) TTS.
 *
 * Final loudness pass: `loudnorm` (EBU R128) gives consistent output level;
 * if a future caller wants a lighter pass they can switch to dynaudnorm.
 *
 * The filtergraph builder is pure and unit-tested. Output is 48k stereo WAV.
 */

import {
  assertInputReadable,
  assertOutputWritable,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { probeDurationMs } from './probe.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

export interface DuckAndMixInput {
  /** Path to the original full-rate audio (original.wav). */
  originalAudio: string;
  /** Path to the TTS timeline (tts_full.wav). */
  ttsTimeline: string;
  /** Output path (final_mix.wav). */
  output: string;
  /** How far to attenuate the original when ducking (e.g. -15). Negative dB. */
  duckingLevelDb: number;
  /** Gain applied to the TTS bus (e.g. 0 or +2). dB. */
  ttsGainDb: number;
  /** Keep the original background audio in the mix at all. */
  includeBackground: boolean;
  /** Use dynamic sidechain ducking (true) vs. fixed attenuation (false). */
  duck: boolean;
  /**
   * Two-pass EBU R128 loudness normalization: measure first, then apply with
   * the measured values (linear, transparent) instead of the single-pass
   * dynamic mode. Higher quality for the final mix; one extra analysis pass.
   */
  twoPassLoudnorm?: boolean;
}

/** Target loudness for the final mix (streaming-friendly, dialogue-anchored). */
const LOUDNORM_TARGET = { I: -16, TP: -1.5, LRA: 11 } as const;

/** Measured loudness from a first `loudnorm` analysis pass (print_format=json). */
export interface LoudnormMeasurements {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** The single-pass loudnorm filter fragment (dynamic mode). */
export function loudnormFilter(): string {
  return `loudnorm=I=${LOUDNORM_TARGET.I}:TP=${LOUDNORM_TARGET.TP}:LRA=${LOUDNORM_TARGET.LRA}`;
}

/**
 * The second-pass loudnorm filter fragment, seeded with measured values for a
 * linear (transparent) normalization. Pure (testable).
 */
export function loudnormApplyFilter(m: LoudnormMeasurements): string {
  return (
    `loudnorm=I=${LOUDNORM_TARGET.I}:TP=${LOUDNORM_TARGET.TP}:LRA=${LOUDNORM_TARGET.LRA}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`
  );
}

/**
 * True when the analysis produced USABLE measurements for a linear second pass.
 *
 * A silent/near-silent program (an all-silence dub, or a fully-ducked bed with no
 * speech) reports degenerate values — on ffmpeg 8.x specifically, `input_i` and
 * `input_tp` come back `"-inf"` and `target_offset` `"inf"` (while `input_thresh`
 * is a finite -70 default and `input_lra` 0). loudnormApplyFilter() forwards ALL
 * of input_i/tp/lra/thresh + target_offset into pass 2, and ffmpeg aborts on ANY
 * out-of-range value ("Value … out of range", exit 222) — not just measured_I. So
 * we validate every forwarded field against ffmpeg's accepted ranges; if any
 * fails, the caller falls back to the single-pass dynamic loudnorm (no measured
 * values, so it can't trip the range check).
 */
export function loudnormMeasurementsUsable(m: LoudnormMeasurements): boolean {
  const i = Number.parseFloat(m.input_i);
  const tp = Number.parseFloat(m.input_tp);
  const thresh = Number.parseFloat(m.input_thresh);
  const lra = Number.parseFloat(m.input_lra);
  const offset = Number.parseFloat(m.target_offset);
  return (
    Number.isFinite(i) && i >= -99 && i <= 0 &&
    Number.isFinite(tp) && tp >= -99 && tp <= 99 &&
    Number.isFinite(thresh) && thresh >= -99 && thresh <= 0 &&
    Number.isFinite(lra) && lra >= 0 && lra <= 99 &&
    Number.isFinite(offset) && offset >= -99 && offset <= 99
  );
}

/** Parse the JSON block ffmpeg's loudnorm prints to stderr on an analysis pass. */
export function parseLoudnormJson(stderr: string): LoudnormMeasurements | undefined {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasurements>;
    if (obj.input_i && obj.input_tp && obj.input_lra && obj.input_thresh && obj.target_offset) {
      return obj as LoudnormMeasurements;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Common normalization applied to each source before mixing. */
function normalizeChain(): string {
  return `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

/** Convert a dB value into an ffmpeg `volume` argument string (e.g. "-15dB"). */
export function dbToVolumeArg(db: number): string {
  const v = Number.isFinite(db) ? db : 0;
  return `${v}dB`;
}

/**
 * Build the `filter_complex` for the mix.
 * Convention: input 0 = original audio, input 1 = tts timeline.
 *
 * Pure function so it can be asserted in tests without ffmpeg.
 */
export function buildMixFilterComplex(opts: DuckAndMixInput, loudnorm?: string): string {
  const ttsGain = dbToVolumeArg(opts.ttsGainDb);

  // TTS bus is always prepared (it's the voice we want to hear).
  const ttsChain = `[1:a]${normalizeChain()},volume=${ttsGain}[tts]`;

  // The final loudness stage. Defaults to single-pass dynamic loudnorm; the
  // two-pass path passes a measured-values fragment for transparent linear
  // normalization (see duckAndMix).
  const loudness = loudnorm ?? loudnormFilter();

  // --- No background: output is just the (gained) TTS, normalized. ---
  if (!opts.includeBackground) {
    return [ttsChain, `[tts]${loudness}[out]`].join(';');
  }

  const origChain = `[0:a]${normalizeChain()}[orig]`;

  if (opts.duck) {
    // Dynamic ducking: the TTS signal drives a compressor on the original.
    // sidechaincompress needs the sidechain as its SECOND input.
    // threshold/ratio tuned so speech clearly pushes background down; the
    // requested duckingLevelDb additionally hard-attenuates the ducked bg.
    const duckAttenuate = dbToVolumeArg(Math.min(0, opts.duckingLevelDb));
    return [
      origChain,
      ttsChain,
      // Split tts: one copy to the mix, one copy as the sidechain key.
      `[tts]asplit=2[tts_mix][tts_key]`,
      `[orig][tts_key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300:makeup=1[ducked]`,
      `[ducked]volume=${duckAttenuate}[bg]`,
      `[tts_mix][bg]amix=inputs=2:normalize=0:dropout_transition=0[mixed]`,
      `[mixed]${loudness}[out]`,
    ].join(';');
  }

  // Static mix: attenuate the original by duckingLevelDb and mix. With
  // duckingLevelDb=0 this is the "replace-vocals / keep M&E bed" case — the
  // separated music+effects sit at full volume under the dub.
  const bgVolume = dbToVolumeArg(opts.duckingLevelDb);
  return [
    origChain,
    ttsChain,
    `[orig]volume=${bgVolume}[bg]`,
    `[tts][bg]amix=inputs=2:normalize=0:dropout_transition=0[mixed]`,
    `[mixed]${loudness}[out]`,
  ].join(';');
}

/**
 * Build the full ffmpeg argv for the mix.
 * Input 0 = original audio, input 1 = tts timeline. When includeBackground is
 * false we still pass the original as input 0 (it is simply unused by the
 * filtergraph) to keep the input indices stable and the builder simple.
 */
export function buildMixArgs(opts: DuckAndMixInput, loudnorm?: string): string[] {
  return [
    '-y',
    '-i',
    opts.originalAudio,
    '-i',
    opts.ttsTimeline,
    '-filter_complex',
    buildMixFilterComplex(opts, loudnorm),
    '-map',
    '[out]',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    opts.output,
  ];
}

/**
 * Build the analysis-pass argv: the same mix graph, but loudnorm runs in
 * print_format=json mode and the output is discarded (-f null). Pure.
 */
export function buildMixMeasureArgs(opts: DuckAndMixInput): string[] {
  const measure = `${loudnormFilter()}:print_format=json`;
  return [
    '-y',
    '-i',
    opts.originalAudio,
    '-i',
    opts.ttsTimeline,
    '-filter_complex',
    buildMixFilterComplex(opts, measure),
    '-map',
    '[out]',
    '-f',
    'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
}

/** Duck (optional) and mix original + TTS into final_mix.wav. */
export async function duckAndMix(
  input: DuckAndMixInput,
  runOpts: RunOptions = {},
): Promise<{ output: string; durationMs: number }> {
  assertInputReadable(input.ttsTimeline);
  if (input.includeBackground) {
    assertInputReadable(input.originalAudio);
  }
  assertOutputWritable(input.output);

  if (input.twoPassLoudnorm) {
    // Pass 1: measure the mixed program loudness.
    const measureRes = await runFfmpeg(buildMixMeasureArgs(input), runOpts);
    const measured = parseLoudnormJson(measureRes.stderr);
    if (measured && loudnormMeasurementsUsable(measured)) {
      // Pass 2: apply with measured values (linear/transparent).
      await runFfmpeg(buildMixArgs(input, loudnormApplyFilter(measured)), runOpts);
      return { output: input.output, durationMs: await probeDurationMs(input.output) };
    }
    // Measurement failed (unusual ffmpeg build) OR the program is (near-)silent
    // (measured_I=-inf, which loudnorm rejects as a measured value) — fall back to
    // the single-pass dynamic loudnorm below (no measured values, can't crash).
  }

  await runFfmpeg(buildMixArgs(input), runOpts);
  return { output: input.output, durationMs: await probeDurationMs(input.output) };
}

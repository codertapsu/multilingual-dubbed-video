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
export function buildMixFilterComplex(opts: DuckAndMixInput): string {
  const ttsGain = dbToVolumeArg(opts.ttsGainDb);

  // TTS bus is always prepared (it's the voice we want to hear).
  const ttsChain = `[1:a]${normalizeChain()},volume=${ttsGain}[tts]`;

  // --- No background: output is just the (gained) TTS, normalized. ---
  if (!opts.includeBackground) {
    return [ttsChain, `[tts]loudnorm=I=-16:TP=-1.5:LRA=11[out]`].join(';');
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
      `[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    ].join(';');
  }

  // Static ducking: just attenuate the original by duckingLevelDb and mix.
  const bgVolume = dbToVolumeArg(opts.duckingLevelDb);
  return [
    origChain,
    ttsChain,
    `[orig]volume=${bgVolume}[bg]`,
    `[tts][bg]amix=inputs=2:normalize=0:dropout_transition=0[mixed]`,
    `[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
  ].join(';');
}

/**
 * Build the full ffmpeg argv for the mix.
 * Input 0 = original audio, input 1 = tts timeline. When includeBackground is
 * false we still pass the original as input 0 (it is simply unused by the
 * filtergraph) to keep the input indices stable and the builder simple.
 */
export function buildMixArgs(opts: DuckAndMixInput): string[] {
  return [
    '-y',
    '-i',
    opts.originalAudio,
    '-i',
    opts.ttsTimeline,
    '-filter_complex',
    buildMixFilterComplex(opts),
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
  await runFfmpeg(buildMixArgs(input), runOpts);
  return { output: input.output, durationMs: await probeDurationMs(input.output) };
}

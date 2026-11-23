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

import { rm, writeFile } from 'node:fs/promises';

import { writeAtomically } from './atomic.js';
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
   * When the original soundtrack is dropped (includeBackground=false), lay a
   * very quiet pink-noise room tone under the dub so the pauses between lines
   * are never pure digital silence (which reads as "broken audio" and makes the
   * synthetic joins obvious). Ignored while the original bed is kept.
   */
  roomTone?: boolean;
  /**
   * Two-pass EBU R128 loudness normalization: measure first, then apply with
   * the measured values (linear, transparent) instead of the single-pass
   * dynamic mode. Higher quality for the final mix; one extra analysis pass.
   */
  twoPassLoudnorm?: boolean;
  /**
   * Windows (ms) where the original plays as it is: the lines kept as the
   * original song (the orchestrator's songs/songLines.ts). There the original
   * is not lowered (keep), is there at all (remove), and, with
   * `originalVocals`, gets its voices back (replace-vocals mixes the M&E bed).
   * Outside them nothing changes. A sung OST would otherwise have been dubbed
   * as speech, or (replace-vocals) lost its singer everywhere (F7).
   */
  keepOriginal?: readonly { startMs: number; endMs: number }[];
  /** The separated vocal stem of the original (input 2), restored inside `keepOriginal`. */
  originalVocals?: string;
}

/**
 * How long the original takes to rise to full level before a song window and
 * to fall back after it (outside the window, so the song itself is whole).
 */
export const SONG_RAMP_SEC = 0.25;

/** A filter graph longer than this goes through a file (`-/filter_complex`): Windows caps a command line at 32,767 characters. */
export const MAX_INLINE_GRAPH_CHARS = 20_000;

const sec = (ms: number): string => String(Math.round(ms) / 1000);

/** Terms per parenthesised group of a long sum (see balancedSum). */
const SUM_GROUP = 16;

/**
 * `a+b+c+…` as a shallow tree of parenthesised groups. ffmpeg's expression
 * evaluator refuses a chain deeper than about 100 (measured on 8.1.1: a sum
 * of 101 terms parses, 150 do not), and a dub with a hundred song windows
 * makes exactly that chain. Pure.
 */
export function balancedSum(terms: readonly string[]): string {
  if (terms.length <= SUM_GROUP) return terms.join('+');
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += SUM_GROUP) groups.push(`(${terms.slice(i, i + SUM_GROUP).join('+')})`);
  return balancedSum(groups);
}

/**
 * An ffmpeg expression of `t` (seconds): 1 inside the windows, 0 away from
 * them, rising and falling linearly over `rampSec` just outside each one.
 * For `volume=...:eval=frame`. Pure.
 */
export function songGateExpr(windows: readonly { startMs: number; endMs: number }[], rampSec = SONG_RAMP_SEC): string {
  const ramp = String(rampSec);
  const terms = windows
    .filter((w) => w.endMs > w.startMs)
    .map((w) => `clip(min(t-${sec(w.startMs - rampSec * 1000)},${sec(w.endMs + rampSec * 1000)}-t)/${ramp},0,1)`);
  return terms.length > 0 ? `min(1,${balancedSum(terms)})` : '0';
}

/** The song windows of a mix, when it has any. */
function songWindowsOf(opts: DuckAndMixInput): readonly { startMs: number; endMs: number }[] {
  return (opts.keepOriginal ?? []).filter((w) => w.endMs > w.startMs);
}

/**
 * The original's bed at `db` away from the songs and at full level in them:
 * a frame-wise volume of lin + (1 - lin) × gate. Unchanged without songs.
 */
function bedVolume(db: number, songs: readonly { startMs: number; endMs: number }[]): string {
  if (songs.length === 0 || !(db < 0)) return `volume=${dbToVolumeArg(db)}`;
  const lin = Math.round(10 ** (db / 20) * 1e6) / 1e6;
  return `volume='${lin}+${Math.round((1 - lin) * 1e6) / 1e6}*${songGateExpr(songs)}':eval=frame`;
}

/**
 * Room-tone level: pink noise at ~-55 dBFS peak — comfortably below dialogue,
 * just enough that "silence" still sounds like a room and not a dropout.
 */
export const ROOM_TONE_AMPLITUDE = 0.0018;

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
 * Convention: input 0 = original audio, input 1 = tts timeline, input 2 = the
 * original's vocal stem (only with song windows and `originalVocals`).
 *
 * Song windows (`keepOriginal`) leave the graph exactly as it was without
 * them; with them the original is gated in frame by frame (songGateExpr).
 *
 * Pure function so it can be asserted in tests without ffmpeg.
 */
export function buildMixFilterComplex(opts: DuckAndMixInput, loudnorm?: string): string {
  const ttsGain = dbToVolumeArg(opts.ttsGainDb);
  const songs = songWindowsOf(opts);

  // TTS bus is always prepared (it's the voice we want to hear).
  const ttsChain = `[1:a]${normalizeChain()},volume=${ttsGain}[tts]`;

  // The final loudness stage. Defaults to single-pass dynamic loudnorm; the
  // two-pass path passes a measured-values fragment for transparent linear
  // normalization (see duckAndMix).
  const loudness = loudnorm ?? loudnormFilter();

  // --- No background: output is just the (gained) TTS, normalized — with an
  // optional room-tone bed so gaps between lines never fall to digital black.
  // anoisesrc is a filter source (no extra -i input); duration=first pins the
  // bed to the TTS timeline's exact length. A song kept as the original is the
  // original there, even with the original removed.
  if (!opts.includeBackground) {
    const song = songs.length > 0 ? [`[0:a]${normalizeChain()},volume='${songGateExpr(songs)}':eval=frame[song]`] : [];
    const songIn = songs.length > 0 ? '[song]' : '';
    if (opts.roomTone) {
      return [
        ttsChain,
        ...song,
        `anoisesrc=color=pink:amplitude=${ROOM_TONE_AMPLITUDE}:sample_rate=${SAMPLE_RATE},` +
          `aformat=sample_fmts=fltp:channel_layouts=stereo[room]`,
        `[tts][room]${songIn}amix=inputs=${songs.length > 0 ? 3 : 2}:duration=first:normalize=0:dropout_transition=0[bedded]`,
        `[bedded]${loudness}[out]`,
      ].join(';');
    }
    if (songs.length > 0) {
      return [
        ttsChain,
        ...song,
        `[tts][song]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[bedded]`,
        `[bedded]${loudness}[out]`,
      ].join(';');
    }
    return [ttsChain, `[tts]${loudness}[out]`].join(';');
  }

  const origChain = `[0:a]${normalizeChain()}[orig]`;
  // The separated voices, back where a song is kept (replace-vocals).
  const vocals = songs.length > 0 && opts.originalVocals ? [`[2:a]${normalizeChain()},volume='${songGateExpr(songs)}':eval=frame[voc]`] : [];
  const mixOf = (tts: string, bg: string): string =>
    vocals.length > 0
      ? `[${tts}][${bg}][voc]amix=inputs=3:normalize=0:dropout_transition=0[mixed]`
      : `[${tts}][${bg}]amix=inputs=2:normalize=0:dropout_transition=0[mixed]`;

  if (opts.duck) {
    // Dynamic ducking: the TTS signal drives a compressor on the original.
    // sidechaincompress needs the sidechain as its SECOND input.
    // threshold/ratio tuned so speech clearly pushes background down; the
    // requested duckingLevelDb additionally hard-attenuates the ducked bg,
    // except in a song's window, where no dub plays to duck it either.
    return [
      origChain,
      ttsChain,
      ...vocals,
      // Split tts: one copy to the mix, one copy as the sidechain key.
      `[tts]asplit=2[tts_mix][tts_key]`,
      `[orig][tts_key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300:makeup=1[ducked]`,
      `[ducked]${bedVolume(Math.min(0, opts.duckingLevelDb), songs)}[bg]`,
      mixOf('tts_mix', 'bg'),
      `[mixed]${loudness}[out]`,
    ].join(';');
  }

  // Static mix: attenuate the original by duckingLevelDb and mix. With
  // duckingLevelDb=0 this is the "replace-vocals / keep M&E bed" case — the
  // separated music+effects sit at full volume under the dub.
  return [
    origChain,
    ttsChain,
    ...vocals,
    `[orig]${bedVolume(opts.duckingLevelDb, songs)}[bg]`,
    mixOf('tts', 'bg'),
    `[mixed]${loudness}[out]`,
  ].join(';');
}

/** The inputs of a mix: original, timeline, and the vocal stem when the graph reads it. */
function mixInputs(opts: DuckAndMixInput): string[] {
  const vocals = opts.includeBackground && opts.originalVocals && songWindowsOf(opts).length > 0;
  return ['-i', opts.originalAudio, '-i', opts.ttsTimeline, ...(vocals ? ['-i', opts.originalVocals!] : [])];
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
    ...mixInputs(opts),
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
    // RF64 past 4 GiB (~6.2 h at 48 kHz stereo) only; see tts-timeline.ts.
    '-rf64',
    'auto',
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
    ...mixInputs(opts),
    '-filter_complex',
    buildMixFilterComplex(opts, measure),
    '-map',
    '[out]',
    '-f',
    'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ];
}

/**
 * Duck (optional) and mix original + TTS into final_mix.wav.
 *
 * The mix is written through {@link writeAtomically}: cancelling (or crashing)
 * during this step used to leave a non-empty, HALF-LENGTH final_mix.wav, which
 * the pipeline's `size > 0` resume check then accepted as a finished step — the
 * user got a dub that stops halfway and a report of success. The measure pass
 * writes nothing (`-f null`), so only the apply pass needs the partial.
 */
export async function duckAndMix(
  input: DuckAndMixInput,
  runOpts: RunOptions = {},
): Promise<{ output: string; durationMs: number }> {
  assertInputReadable(input.ttsTimeline);
  const songs = songWindowsOf(input).length > 0;
  if (input.includeBackground || songs) {
    assertInputReadable(input.originalAudio);
  }
  if (input.includeBackground && songs && input.originalVocals) {
    assertInputReadable(input.originalVocals);
  }
  assertOutputWritable(input.output);

  if (input.twoPassLoudnorm) {
    // Pass 1: measure the mixed program loudness.
    const measureRes = await runMixFfmpeg(buildMixMeasureArgs(input), input.output, runOpts);
    const measured = parseLoudnormJson(measureRes.stderr);
    if (measured && loudnormMeasurementsUsable(measured)) {
      // Pass 2: apply with measured values (linear/transparent).
      await writeAtomically(input.output, (partial) =>
        runMixFfmpeg(buildMixArgs({ ...input, output: partial }, loudnormApplyFilter(measured)), input.output, runOpts),
      );
      return { output: input.output, durationMs: await probeDurationMs(input.output) };
    }
    // Measurement failed (unusual ffmpeg build) OR the program is (near-)silent
    // (measured_I=-inf, which loudnorm rejects as a measured value) — fall back to
    // the single-pass dynamic loudnorm below (no measured values, can't crash).
  }

  await writeAtomically(input.output, (partial) =>
    runMixFfmpeg(buildMixArgs({ ...input, output: partial }), input.output, runOpts),
  );
  return { output: input.output, durationMs: await probeDurationMs(input.output) };
}

/**
 * The graph inline when it is short (always, without songs), else from a
 * file beside the output (`-/filter_complex`, ffmpeg 7+; the app bundles 9):
 * an unsplit feature-length project with hundreds of song windows would
 * outgrow Windows' 32,767-character command line. Pure argv rewrite.
 */
export function graphFromFile(args: readonly string[], graphFile: string): { args: string[]; graph: string } | undefined {
  const at = args.indexOf('-filter_complex');
  const graph = at >= 0 ? args[at + 1] : undefined;
  if (graph === undefined || graph.length <= MAX_INLINE_GRAPH_CHARS) return undefined;
  return { args: [...args.slice(0, at), '-/filter_complex', graphFile, ...args.slice(at + 2)], graph };
}

async function runMixFfmpeg(args: string[], output: string, runOpts: RunOptions): ReturnType<typeof runFfmpeg> {
  const file = `${output}.graph-${process.pid}-${Date.now()}.txt`;
  const viaFile = graphFromFile(args, file);
  if (!viaFile) return runFfmpeg(args, runOpts);
  await writeFile(file, viaFile.graph, 'utf8');
  try {
    return await runFfmpeg(viaFile.args, runOpts);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

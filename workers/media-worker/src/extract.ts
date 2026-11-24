/**
 * Audio extraction.
 *
 *  - extractAudio: full-rate stereo 48k WAV ("original.wav") for mixing.
 *  - extract16kMono: 16k mono pcm_s16le WAV for STT (faster-whisper).
 *
 * Both follow the PICTURE's clock (pictureClockFilter): the audio is placed by
 * its timestamps, not by counting its samples, and cut (or padded) to exactly
 * the picture's length. Part 4 of the 27.8-hour series held 4.8 s more audio
 * samples than its timestamps said (+4.81 s over 2.73 h, claude-dubber report
 * 2026-11-23); decoding every sample baked that drift into both WAVs, so the
 * dub drifted behind the picture, and the mix (amix `longest`) made the
 * finished video longer than its picture.
 *
 * Arg-builders are pure (testable); the exported async functions spawn ffmpeg
 * and then probe the result for its real duration.
 */

import type { AudioExtractResult } from '@videodubber/shared';
import { writeAtomically } from './atomic.js';
import {
  assertInputReadable,
  assertOutputWritable,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { pictureDurationMs, probe } from './probe.js';

/** A window of the input (a series part), in ms. */
export interface MediaWindow {
  startMs: number;
  endMs: number;
}

/** `-ss`/`-t` before `-i`: an input seek, sample-accurate when the audio is decoded. Pure. */
export function windowArgs(range?: MediaWindow): string[] {
  if (!range) return [];
  const start = Math.max(0, range.startMs);
  return ['-ss', (start / 1000).toFixed(3), '-t', (Math.max(0, range.endMs - start) / 1000).toFixed(3)];
}

/**
 * Most samples per second aresample may add or drop to keep the audio on its
 * timestamps (its `async`). P4's drift was 0.05 % (~24 samples/s at 48 kHz);
 * a gap or overlap above aresample's hard limit (0.1 s) is filled or cut at once.
 */
export const AUDIO_ASYNC_SAMPLES_PER_SEC = 1000;

/**
 * How long the extracted audio must be, ms: the picture's length, or for a
 * window (a series part) its share of the picture. Undefined when the input
 * has no picture of known length (audio only): then nothing is cut. Pure.
 */
export function extractKeepMs(range: MediaWindow | undefined, pictureMs: number | undefined): number | undefined {
  if (!range) return pictureMs !== undefined && pictureMs > 0 ? pictureMs : undefined;
  const start = Math.max(0, range.startMs);
  const end = pictureMs !== undefined && pictureMs > start ? Math.min(range.endMs, pictureMs) : range.endMs;
  return end > start ? end - start : undefined;
}

/**
 * The audio filter that puts the audio on the picture's clock. Pure.
 *
 * `aresample=<rate>:async=1000:first_pts=0` places every sample by its
 * timestamp (stretching or squeezing up to 1000 samples/s, padding gaps,
 * dropping overlaps) from time 0, so audio that starts late is preceded by
 * silence and the encoder's priming is dropped. `apad,atrim=end_sample=N`
 * then makes it exactly N samples: padded with silence when the audio ends
 * before the picture, cut where it runs past it. Without a picture length
 * (audio-only input) only the re-timing applies.
 */
export function pictureClockFilter(sampleRate: number, keepMs: number | undefined): string {
  const retime = `aresample=${sampleRate}:async=${AUDIO_ASYNC_SAMPLES_PER_SEC}:first_pts=0`;
  if (keepMs === undefined || !(keepMs > 0)) return retime;
  return `${retime},apad,atrim=end_sample=${Math.round((keepMs * sampleRate) / 1000)}`;
}

/**
 * ffmpeg args: input -> 48kHz stereo WAV (pcm_s16le), drop video, on the
 * picture's clock and exactly its length (`pictureMs`: pictureDurationMs of the input).
 */
export function buildExtractAudioArgs(
  inputPath: string,
  outputPath: string,
  range?: MediaWindow,
  pictureMs?: number,
): string[] {
  return [
    '-y', // overwrite output (idempotent for resume)
    ...windowArgs(range),
    '-i',
    inputPath,
    '-vn', // no video
    '-af',
    pictureClockFilter(48000, extractKeepMs(range, pictureMs)),
    '-ac',
    '2', // stereo
    '-ar',
    '48000', // 48kHz
    '-c:a',
    'pcm_s16le',
    // A plain RIFF header overflows past 4 GiB (~6.2 h at 48 kHz stereo);
    // `auto` writes RF64 only then, so every shorter file is unchanged.
    '-rf64',
    'auto',
    outputPath,
  ];
}

/** ffmpeg args: input -> 16kHz mono WAV (pcm_s16le) for STT, on the picture's clock like the 48k track. */
export function buildExtract16kMonoArgs(
  inputPath: string,
  outputPath: string,
  range?: MediaWindow,
  pictureMs?: number,
): string[] {
  return [
    '-y',
    ...windowArgs(range),
    '-i',
    inputPath,
    '-vn',
    '-af',
    pictureClockFilter(16000, extractKeepMs(range, pictureMs)),
    '-ac',
    '1', // mono
    '-ar',
    '16000', // 16kHz
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

/**
 * The input's picture length, ms (pictureDurationMs), or undefined: audio-only
 * input, or a probe that failed. Never fails the extraction: without it the
 * audio is still re-timed, only not cut.
 */
async function inputPictureMs(inputPath: string, opts: RunOptions): Promise<number | undefined> {
  try {
    return pictureDurationMs(await probe(inputPath, opts));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return undefined;
  }
}

/**
 * Extract full-rate stereo 48k audio. Returns the measured result.
 *
 * Written via {@link writeAtomically}: a kill mid-extraction must not leave a
 * truncated `original.wav` behind, because the pipeline's resume check treats
 * any non-empty artifact as a finished step (see atomic.ts).
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  opts: RunOptions = {},
  range?: MediaWindow,
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  const pictureMs = await inputPictureMs(inputPath, opts);
  await writeAtomically(outputPath, (partial) =>
    runFfmpeg(buildExtractAudioArgs(inputPath, partial, range, pictureMs), opts),
  );
  return measure(outputPath);
}

/**
 * Extract 16k mono PCM audio for STT. Returns the measured result.
 *
 * Atomic for the same reason as {@link extractAudio} — and it bites hardest
 * here: a truncated `original_16k_mono.wav` that a resume accepts makes STT
 * transcribe only part of the video, and every downstream artifact is then
 * silently short with no error anywhere.
 */
export async function extract16kMono(
  inputPath: string,
  outputPath: string,
  opts: RunOptions = {},
  range?: MediaWindow,
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  const pictureMs = await inputPictureMs(inputPath, opts);
  await writeAtomically(outputPath, (partial) =>
    runFfmpeg(buildExtract16kMonoArgs(inputPath, partial, range, pictureMs), opts),
  );
  return measure(outputPath);
}

/**
 * ffmpeg args: extract the `[startMs, endMs)` window of `inputPath` as a 16kHz
 * mono PCM WAV. Input-seek (`-ss` before `-i`) is fast and, for PCM, sample
 * accurate; `-t` bounds the output to exactly the requested window. Used to cut
 * long audio into bounded STT chunks.
 */
export function buildClip16kMonoArgs(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
): string[] {
  // Clamp the start to 0, then derive the duration from the CLAMPED start so a
  // negative start never makes the window over-read past `endMs`.
  const startClamped = Math.max(0, startMs);
  const ssSec = startClamped / 1000;
  const durSec = Math.max(0, endMs - startClamped) / 1000;
  return [
    '-y',
    '-ss',
    ssSec.toFixed(3),
    '-i',
    inputPath,
    '-t',
    durSec.toFixed(3),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

/**
 * Extract a `[startMs, endMs)` window as a 16k mono WAV (for chunked STT of long
 * audio). The return value's `durationMs` is the requested window length (the
 * caller doesn't need a probe here), so this performs a single ffmpeg pass.
 */
export async function clip16kMono(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
  opts: RunOptions = {},
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  await writeAtomically(outputPath, (partial) =>
    runFfmpeg(buildClip16kMonoArgs(inputPath, partial, startMs, endMs), opts),
  );
  return { audioPath: outputPath, sampleRate: 16000, channels: 1, durationMs: Math.max(0, endMs - startMs) };
}

/** Probe an extracted WAV and report sampleRate/channels/duration. */
async function measure(outputPath: string): Promise<AudioExtractResult> {
  const info = await probe(outputPath);
  const audio = info.audioStreams[0];
  return {
    audioPath: outputPath,
    sampleRate: audio?.sampleRate ?? 0,
    channels: audio?.channels ?? 0,
    durationMs: info.durationMs,
  };
}

/**
 * Audio extraction.
 *
 *  - extractAudio: full-rate stereo 48k WAV ("original.wav") for mixing.
 *  - extract16kMono: 16k mono pcm_s16le WAV for STT (faster-whisper).
 *
 * Arg-builders are pure (testable); the exported async functions spawn ffmpeg
 * and then probe the result for its real duration.
 */

import type { AudioExtractResult } from '@videodubber/shared';
import {
  assertInputReadable,
  assertOutputWritable,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { probe } from './probe.js';

/** ffmpeg args: input -> 48kHz stereo WAV (pcm_s16le), drop video. */
export function buildExtractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y', // overwrite output (idempotent for resume)
    '-i',
    inputPath,
    '-vn', // no video
    '-ac',
    '2', // stereo
    '-ar',
    '48000', // 48kHz
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

/** ffmpeg args: input -> 16kHz mono WAV (pcm_s16le) for STT. */
export function buildExtract16kMonoArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1', // mono
    '-ar',
    '16000', // 16kHz
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

/** Extract full-rate stereo 48k audio. Returns the measured result. */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  opts: RunOptions = {},
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  await runFfmpeg(buildExtractAudioArgs(inputPath, outputPath), opts);
  return measure(outputPath);
}

/** Extract 16k mono PCM audio for STT. Returns the measured result. */
export async function extract16kMono(
  inputPath: string,
  outputPath: string,
  opts: RunOptions = {},
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  await runFfmpeg(buildExtract16kMonoArgs(inputPath, outputPath), opts);
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
  const ssSec = Math.max(0, startMs) / 1000;
  const durSec = Math.max(0, endMs - startMs) / 1000;
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
  await runFfmpeg(buildClip16kMonoArgs(inputPath, outputPath, startMs, endMs), opts);
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

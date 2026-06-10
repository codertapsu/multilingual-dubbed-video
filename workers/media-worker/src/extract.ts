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

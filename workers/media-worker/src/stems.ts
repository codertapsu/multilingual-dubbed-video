/**
 * Audio into and out of vocal separation (HTDemucs through audio.cpp).
 *
 * HTDemucs works at 44.1 kHz stereo and refuses anything else ("sample rate
 * mismatch: expected 44100, got 48000"), while the mix works at 48 kHz stereo.
 * So the track is converted once on the way in, and the stems come back as the
 * two 48 kHz files the mix uses: the voices, and everything else (drums, bass
 * and the rest summed unscaled, so the score keeps its level). Written
 * atomically like every other artifact.
 */

import type { AudioExtractResult } from '@videodubber/shared';
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';
import { probe } from './probe.js';

/** ffmpeg args: any input -> the 44.1 kHz stereo WAV HTDemucs takes. Pure. */
export function buildStemInputArgs(inputPath: string, outputPath: string): string[] {
  return ['-y', '-i', inputPath, '-vn', '-sn', '-dn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outputPath];
}

/**
 * ffmpeg args: one or more stems -> one 48 kHz stereo WAV. Several are summed
 * without normalising (amix would otherwise divide each by their number and
 * the music would come back quieter than it went in). Pure.
 */
export function buildStemMixArgs(inputPaths: readonly string[], outputPath: string): string[] {
  if (inputPaths.length === 0) throw new Error('no stems to mix');
  const args = ['-y'];
  for (const p of inputPaths) args.push('-i', p);
  if (inputPaths.length > 1) args.push('-filter_complex', `amix=inputs=${inputPaths.length}:normalize=0:duration=longest`);
  args.push('-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', outputPath);
  return args;
}

async function described(outputPath: string, sampleRate: number): Promise<AudioExtractResult> {
  const info = await probe(outputPath).catch(() => undefined);
  return { audioPath: outputPath, sampleRate, channels: 2, durationMs: info?.durationMs ?? 0 };
}

/** The 44.1 kHz stereo input HTDemucs needs. */
export async function prepareStemInput(inputPath: string, outputPath: string, run: RunOptions = {}): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  await writeAtomically(outputPath, (partial) => runFfmpeg(buildStemInputArgs(inputPath, partial), run));
  return described(outputPath, 44_100);
}

/** One 48 kHz stereo WAV from stems (one: converted; several: summed). */
export async function mixStems(inputPaths: readonly string[], outputPath: string, run: RunOptions = {}): Promise<AudioExtractResult> {
  for (const p of inputPaths) assertInputReadable(p);
  assertOutputWritable(outputPath);
  await writeAtomically(outputPath, (partial) => runFfmpeg(buildStemMixArgs(inputPaths, partial), run));
  return described(outputPath, 48_000);
}

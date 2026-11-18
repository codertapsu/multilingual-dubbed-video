/**
 * Reference clips for voice cloning.
 *
 * A voice is cloned from a few seconds of someone speaking. Whatever the user
 * brings (a phone's M4A, a WAV recorded in the app, a video), the engines want
 * mono PCM at a known rate, and VieNeu's own training data was levelled to
 * about -20 LUFS, so the window the user keeps is cut, mixed down and levelled
 * here, in one ffmpeg pass, written atomically like every other artifact.
 */

import type { AudioExtractResult } from '@videodubber/shared';
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';

export interface ReferenceClipOptions {
  /** Where to start reading (ms); default 0. */
  startMs?: number;
  /** Where to stop (ms); default: the end, capped by `maxMs`. */
  endMs?: number;
  /** Never read more than this (ms) — an imported film must not be decoded whole. */
  maxMs?: number;
  /** Output rate (Hz); default 48000. */
  sampleRate?: number;
  /** Level to this integrated loudness (LUFS) with ffmpeg's loudnorm; unset = untouched. */
  loudnessLufs?: number;
}

/** Default cap on what an import decodes: ten minutes is plenty to find 8 s of speech. */
export const REFERENCE_MAX_MS = 10 * 60_000;

/** ffmpeg args for {@link referenceClip}. Pure. */
export function buildReferenceClipArgs(inputPath: string, outputPath: string, opts: ReferenceClipOptions = {}): string[] {
  const start = Math.max(0, opts.startMs ?? 0);
  const cap = Math.max(1, opts.maxMs ?? REFERENCE_MAX_MS);
  const wanted = opts.endMs !== undefined ? Math.max(0, opts.endMs - start) : cap;
  const durMs = Math.min(wanted, cap);
  const args = ['-y'];
  if (start > 0) args.push('-ss', (start / 1000).toFixed(3));
  args.push('-i', inputPath, '-t', (durMs / 1000).toFixed(3), '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(opts.sampleRate ?? 48_000));
  if (opts.loudnessLufs !== undefined) {
    // Single-pass loudnorm: a few seconds of speech is too short for the
    // two-pass measurement to differ audibly, and the true-peak ceiling keeps
    // a hot recording from clipping on the way up.
    args.push('-af', `loudnorm=I=${opts.loudnessLufs}:TP=-2:LRA=11`);
  }
  args.push('-c:a', 'pcm_s16le', outputPath);
  return args;
}

/**
 * Cut, mix down, resample and optionally level a reference clip. The result's
 * duration is the requested window (loudnorm resamples internally but keeps
 * the length).
 */
export async function referenceClip(
  inputPath: string,
  outputPath: string,
  opts: ReferenceClipOptions = {},
  run: RunOptions = {},
): Promise<AudioExtractResult> {
  assertInputReadable(inputPath);
  assertOutputWritable(outputPath);
  await writeAtomically(outputPath, (partial) => runFfmpeg(buildReferenceClipArgs(inputPath, partial, opts), run));
  const start = Math.max(0, opts.startMs ?? 0);
  const cap = opts.maxMs ?? REFERENCE_MAX_MS;
  const durationMs = opts.endMs !== undefined ? Math.min(Math.max(0, opts.endMs - start), cap) : cap;
  return { audioPath: outputPath, sampleRate: opts.sampleRate ?? 48_000, channels: 1, durationMs };
}

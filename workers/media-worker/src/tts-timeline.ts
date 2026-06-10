/**
 * Build a single full-length WAV ("tts_full.wav") from per-segment TTS audio.
 *
 * Each aligned segment's audio is placed at its `startMs` on a common timeline.
 * Between/around segments there is silence. The result is exactly
 * `totalDurationMs` long, 48kHz stereo.
 *
 * Strategy:
 *   For N segments, build a filtergraph:
 *     [i]adelay=startMs|startMs[ai]   for each input i
 *     mix all [ai] with amix=inputs=N:normalize=0:dropout_transition=0
 *     then apad to total + atrim to total to pin the exact length.
 *
 * Robustness: amix with a very large number of inputs is fragile and the
 * filtergraph string can blow up. When there are more than MAX_INPUTS_PER_MIX
 * segments we mix in chunks: each chunk produces an intermediate WAV, then the
 * intermediates are amix'd together. The chunking is recursive-friendly but we
 * keep it to a single extra level which is plenty (e.g. 64*64 = 4096 segments).
 *
 * Arg-builders are pure and unit-tested. The orchestrator passes already-
 * aligned segments (with absolute audio paths). Segments with an empty/missing
 * audioPath are skipped (they contribute only silence).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlignedSegment } from '@videodubber/shared';
import {
  assertInputReadable,
  assertOutputWritable,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { probeDurationMs } from './probe.js';

/** Max real audio inputs to feed a single amix node before chunking. */
export const MAX_INPUTS_PER_MIX = 32;

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

/** A placed clip: a source WAV that starts at `startMs` on the timeline. */
export interface TimelineClip {
  audioPath: string;
  startMs: number;
  /**
   * Optional tempo factor (>1 = faster/shorter) applied via `atempo` BEFORE the
   * clip is delayed into place. Used by alignment to fit slightly-too-long TTS
   * into its subtitle window. Omitted/1 = no time-stretch.
   */
  speedRatio?: number;
}

/**
 * Build an `atempo` filter chain for a tempo factor. `atempo` only accepts
 * 0.5–2.0 per instance, so larger/smaller factors are decomposed into a chain.
 * Returns a trailing-comma-terminated fragment (or '' for a no-op factor) so it
 * can be spliced directly in front of `adelay`.
 */
export function buildAtempoChain(ratio?: number): string {
  if (!ratio || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-3) return '';
  let r = ratio;
  const factors: number[] = [];
  while (r > 2.0) {
    factors.push(2.0);
    r /= 2.0;
  }
  while (r < 0.5) {
    factors.push(0.5);
    r /= 0.5;
  }
  factors.push(r);
  return factors.map((f) => `atempo=${f.toFixed(4)}`).join(',') + ',';
}

/** Extract placeable clips from aligned segments (skips empty audio paths). */
export function alignedSegmentsToClips(segments: AlignedSegment[]): TimelineClip[] {
  return segments
    .filter((s) => typeof s.audioPath === 'string' && s.audioPath.length > 0)
    .map((s) => ({ audioPath: s.audioPath, startMs: Math.max(0, Math.round(s.startMs)) }))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Build the filter_complex string for a single-pass mix of `clips`.
 * Inputs are referenced as [0], [1], ... in the SAME order as `clips`.
 * Produces a final labeled pad `[out]` exactly `totalDurationMs` long.
 *
 * Pure function — used by the single-pass path and by each chunk.
 */
export function buildTimelineFilterComplex(
  clips: TimelineClip[],
  totalDurationMs: number,
): string {
  if (clips.length === 0) {
    // No audio at all: emit silence of the right length from a generated source.
    // The caller wires anullsrc as input 0 in that case (see buildAnullsrcArgs).
    return `[0:a]atrim=0:${msToSec(totalDurationMs)},asetpts=N/SR/TB[out]`;
  }

  const parts: string[] = [];
  const delayedLabels: string[] = [];

  clips.forEach((clip, i) => {
    const label = `a${i}`;
    const delay = Math.max(0, Math.round(clip.startMs));
    // adelay needs one value per channel; resample/format to a common layout
    // first so amix never has to reconcile mismatched sample rates/layouts.
    parts.push(
      `[${i}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `${buildAtempoChain(clip.speedRatio)}adelay=${delay}|${delay}[${label}]`,
    );
    delayedLabels.push(`[${label}]`);
  });

  const mixInputs = delayedLabels.length;
  // normalize=0 keeps absolute levels (we manage gain explicitly in mix.ts).
  // dropout_transition=0 avoids volume ramps when inputs end.
  parts.push(
    `${delayedLabels.join('')}amix=inputs=${mixInputs}:normalize=0:dropout_transition=0[mixed]`,
  );
  // Pin exact total length: pad to total, then hard-trim.
  parts.push(
    `[mixed]apad=whole_dur=${msToSec(totalDurationMs)},atrim=0:${msToSec(totalDurationMs)},` +
      `asetpts=N/SR/TB[out]`,
  );

  return parts.join(';');
}

/**
 * Build the full ffmpeg argv for a single-pass timeline mix.
 * Each clip becomes an `-i <path>` input in order; output is 48k stereo WAV.
 */
export function buildTimelineMixArgs(
  clips: TimelineClip[],
  totalDurationMs: number,
  outputPath: string,
): string[] {
  const args: string[] = ['-y'];

  if (clips.length === 0) {
    // Single silent input sized to the timeline.
    args.push(
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
    );
  } else {
    for (const clip of clips) {
      args.push('-i', clip.audioPath);
    }
  }

  args.push(
    '-filter_complex',
    buildTimelineFilterComplex(clips, totalDurationMs),
    '-map',
    '[out]',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    outputPath,
  );

  return args;
}

/** Split clips into chunks of at most MAX_INPUTS_PER_MIX. */
export function chunkClips(clips: TimelineClip[], size = MAX_INPUTS_PER_MIX): TimelineClip[][] {
  if (size < 1) size = 1;
  const chunks: TimelineClip[][] = [];
  for (let i = 0; i < clips.length; i += size) {
    chunks.push(clips.slice(i, i + size));
  }
  return chunks;
}

function msToSec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/** A placed segment for {@link buildTtsTimeline}. */
export interface TimelineSegmentInput {
  audioPath: string;
  startMs: number;
  /** Tempo factor to apply before placement (1/undefined = none). */
  speedRatio?: number;
}

/** Input object for {@link buildTtsTimeline}. */
export interface BuildTtsTimelineInput {
  segments: TimelineSegmentInput[];
  totalDurationMs: number;
  outputPath: string;
}

/**
 * Build a single full-length TTS timeline WAV ("tts_full.wav") by placing each
 * per-segment WAV at its `startMs` (with optional `atempo` time-stretch) and
 * padding/trimming to exactly `totalDurationMs`.
 *
 * Signature matches the orchestrator's `PipelineMediaService.buildTtsTimeline`:
 * a single input object in, `{ outputPath, durationMs }` out.
 */
export async function buildTtsTimeline(
  input: BuildTtsTimelineInput,
  opts: RunOptions = {},
): Promise<{ outputPath: string; durationMs: number }> {
  const { totalDurationMs, outputPath } = input;
  assertOutputWritable(outputPath);

  const clips: TimelineClip[] = input.segments
    .filter((s) => typeof s.audioPath === 'string' && s.audioPath.length > 0)
    .map((s) => ({
      audioPath: s.audioPath,
      startMs: Math.max(0, Math.round(s.startMs)),
      speedRatio: s.speedRatio,
    }))
    .sort((a, b) => a.startMs - b.startMs);

  // Validate every source clip exists before we spend time on ffmpeg.
  for (const clip of clips) {
    assertInputReadable(clip.audioPath);
  }

  // Single-pass path: few enough inputs to mix at once.
  if (clips.length <= MAX_INPUTS_PER_MIX) {
    await runFfmpeg(buildTimelineMixArgs(clips, totalDurationMs, outputPath), opts);
    return { outputPath, durationMs: await probeDurationMs(outputPath) };
  }

  // Chunked path: mix each chunk to an intermediate full-length WAV, then mix
  // the intermediates (which already start at t=0) together.
  const tmpDir = mkdtempSync(join(tmpdir(), 'vd-tts-'));
  try {
    const chunks = chunkClips(clips);
    const intermediates: TimelineClip[] = [];

    for (const [c, chunk] of chunks.entries()) {
      const chunkOut = join(tmpDir, `chunk_${String(c).padStart(4, '0')}.wav`);
      await runFfmpeg(buildTimelineMixArgs(chunk, totalDurationMs, chunkOut), opts);
      // Intermediates are already on the absolute timeline -> startMs 0.
      intermediates.push({ audioPath: chunkOut, startMs: 0 });
    }

    // If the number of intermediates ALSO exceeds the limit, mix them in a
    // second level. One extra level supports MAX^2 segments which is ample.
    if (intermediates.length <= MAX_INPUTS_PER_MIX) {
      await runFfmpeg(
        buildTimelineMixArgs(intermediates, totalDurationMs, outputPath),
        opts,
      );
    } else {
      const superChunks = chunkClips(intermediates);
      const level2: TimelineClip[] = [];
      for (const [c, superChunk] of superChunks.entries()) {
        const superOut = join(tmpDir, `super_${String(c).padStart(4, '0')}.wav`);
        await runFfmpeg(
          buildTimelineMixArgs(superChunk, totalDurationMs, superOut),
          opts,
        );
        level2.push({ audioPath: superOut, startMs: 0 });
      }
      await runFfmpeg(buildTimelineMixArgs(level2, totalDurationMs, outputPath), opts);
    }

    return { outputPath, durationMs: await probeDurationMs(outputPath) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

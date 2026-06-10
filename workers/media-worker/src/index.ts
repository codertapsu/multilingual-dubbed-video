/**
 * @videodubber/media-worker
 *
 * FFmpeg/ffprobe wrapper implementing the shared MediaService contract, plus
 * mixing, TTS-timeline, subtitle, and render helpers used by the orchestrator.
 *
 * Design note: every command is built by a PURE arg-builder (exported and
 * unit-tested) and executed by a thin spawn wrapper in exec.ts. There is never
 * a shell command string — only argv arrays — so untrusted paths/text cannot be
 * shell-interpreted.
 */

import type {
  AudioExtractResult,
  MediaInfo,
  MediaService,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
} from '@videodubber/shared';

import { extractAudio } from './extract.js';
import { probe } from './probe.js';
import { renderFinalVideo } from './render.js';
import { checkBinaryAvailable, type RunOptions } from './exec.js';

/**
 * Concrete MediaService backed by FFmpeg/ffprobe.
 *
 * The interface methods (probe/extractAudio/renderFinalVideo) match the shared
 * MediaService exactly. Additional capabilities (16k extraction, TTS timeline,
 * mixing) are exported as standalone functions because the orchestrator drives
 * them at specific pipeline steps rather than through the MediaService surface.
 */
export class FfmpegMediaService implements MediaService {
  /** Optional log sink applied to every spawned ffmpeg/ffprobe process. */
  constructor(private readonly defaultRunOpts: RunOptions = {}) {}

  probe(inputPath: string): Promise<MediaInfo> {
    return probe(inputPath);
  }

  extractAudio(inputPath: string, outputPath: string): Promise<AudioExtractResult> {
    return extractAudio(inputPath, outputPath, this.defaultRunOpts);
  }

  renderFinalVideo(input: RenderFinalVideoInput): Promise<RenderFinalVideoResult> {
    return renderFinalVideo(input, this.defaultRunOpts);
  }
}

/**
 * Health snapshot for the orchestrator's /workers/health endpoint.
 * Reports whether ffmpeg/ffprobe are runnable and (when available) a version
 * detail line.
 */
export async function checkAvailability(): Promise<{
  ffmpeg: { available: boolean; detail?: string };
  ffprobe: { available: boolean; detail?: string };
}> {
  const [ffmpeg, ffprobe] = await Promise.all([
    checkBinaryAvailable('ffmpeg'),
    checkBinaryAvailable('ffprobe'),
  ]);
  return { ffmpeg, ffprobe };
}

// ---- Re-exports: helpers + pure arg-builders (consumed by orchestrator/tests) ----

export {
  resolveBinaries,
  resolveFfmpegBinary,
  resolveFfprobeBinary,
  checkBinaryAvailable,
  listFfmpegFilters,
  ffmpegHasFilter,
  parseFfmpegFilters,
  runFfmpeg,
  runFfprobe,
  assertInputReadable,
  assertOutputWritable,
  type RunOptions,
  type RunResult,
  type LogCallback,
} from './exec.js';

export {
  probe,
  probeDurationMs,
  buildProbeArgs,
  ffprobeJsonToMediaInfo,
  parseFrameRate,
} from './probe.js';

export {
  extractAudio,
  extract16kMono,
  buildExtractAudioArgs,
  buildExtract16kMonoArgs,
} from './extract.js';

export {
  buildTtsTimeline,
  buildTimelineMixArgs,
  buildTimelineFilterComplex,
  alignedSegmentsToClips,
  chunkClips,
  MAX_INPUTS_PER_MIX,
  type TimelineClip,
} from './tts-timeline.js';

export {
  duckAndMix,
  buildMixArgs,
  buildMixFilterComplex,
  dbToVolumeArg,
  type DuckAndMixInput,
} from './mix.js';

export {
  escapeSubtitlePathForFilter,
  buildBurnSubtitlesStyle,
  buildSubtitlesFilter,
  hexToAssColor,
  alignmentToAssCode,
} from './subtitles.js';

export {
  renderFinalVideo,
  buildRenderArgs,
  sidecarDestinationPath,
  type RenderArgsContext,
} from './render.js';

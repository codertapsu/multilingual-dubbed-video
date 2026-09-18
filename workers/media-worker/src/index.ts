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

import { clip16kMono, extract16kMono, extractAudio } from './extract.js';
import { probe } from './probe.js';
import { renderFinalVideo } from './render.js';
import { buildTtsTimeline, type BuildTtsTimelineInput, type TimelineStretchSummary } from './tts-timeline.js';
import { duckAndMix, type DuckAndMixInput } from './mix.js';
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

  /**
   * Merge the caller's per-call options (notably the run's AbortSignal) over the
   * service-wide defaults. Every method takes them, because a cancel that does
   * not reach the ffmpeg CHILD leaves it encoding in the background long after
   * the UI says the run stopped.
   */
  private opts(callOpts?: RunOptions): RunOptions {
    return callOpts ? { ...this.defaultRunOpts, ...callOpts } : this.defaultRunOpts;
  }

  probe(inputPath: string, opts?: RunOptions): Promise<MediaInfo> {
    return probe(inputPath, this.opts(opts));
  }

  extractAudio(inputPath: string, outputPath: string, opts?: RunOptions): Promise<AudioExtractResult> {
    return extractAudio(inputPath, outputPath, this.opts(opts));
  }

  extract16kMono(inputPath: string, outputPath: string, opts?: RunOptions): Promise<AudioExtractResult> {
    return extract16kMono(inputPath, outputPath, this.opts(opts));
  }

  clip16kMono(
    inputPath: string,
    outputPath: string,
    startMs: number,
    endMs: number,
    opts?: RunOptions,
  ): Promise<AudioExtractResult> {
    return clip16kMono(inputPath, outputPath, startMs, endMs, this.opts(opts));
  }

  buildTtsTimeline(
    input: BuildTtsTimelineInput,
    opts?: RunOptions,
  ): Promise<{ outputPath: string; durationMs: number; stretch: TimelineStretchSummary }> {
    return buildTtsTimeline(input, this.opts(opts));
  }

  duckAndMix(input: DuckAndMixInput, opts?: RunOptions): Promise<{ output: string; durationMs: number }> {
    return duckAndMix(input, this.opts(opts));
  }

  renderFinalVideo(input: RenderFinalVideoInput, opts?: RunOptions): Promise<RenderFinalVideoResult> {
    return renderFinalVideo(input, this.opts(opts));
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
  listFfmpegEncoders,
  ffmpegHasEncoder,
  parseFfmpegEncoders,
  runFfmpeg,
  runFfprobe,
  assertInputReadable,
  assertOutputWritable,
  type RunOptions,
  type RunResult,
  type LogCallback,
} from './exec.js';

export { partialPathFor, writeAtomically } from './atomic.js';

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
  clip16kMono,
  buildExtractAudioArgs,
  buildExtract16kMonoArgs,
  buildClip16kMonoArgs,
} from './extract.js';

export {
  buildTtsTimeline,
  type TimelineStretchSummary,
  buildTimelineMixArgs,
  buildTimelineFilterComplex,
  alignedSegmentsToClips,
  chunkClips,
  estimateTimelineTmpBytes,
  MAX_INPUTS_PER_MIX,
  type TimelineClip,
} from './tts-timeline.js';

export {
  duckAndMix,
  buildMixArgs,
  buildMixMeasureArgs,
  buildMixFilterComplex,
  loudnormFilter,
  loudnormApplyFilter,
  parseLoudnormJson,
  dbToVolumeArg,
  type DuckAndMixInput,
  type LoudnormMeasurements,
} from './mix.js';

export {
  shouldUseRubberband,
  buildRubberbandArgs,
  RUBBERBAND_THRESHOLD,
} from './stretch.js';

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
  selectVideoCodec,
  sidecarDestinationPath,
  type RenderArgsContext,
} from './render.js';

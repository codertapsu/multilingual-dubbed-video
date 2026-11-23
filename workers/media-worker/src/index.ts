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

import type { AudioExtractResult, MediaInfo, MediaService } from '@videodubber/shared';

import { clip16kMono, extract16kMono, extractAudio, type MediaWindow } from './extract.js';
import { measureAudioDrift } from './drift.js';
import { detectSilences, type DetectSilencesOptions } from './silences.js';
import { probe } from './probe.js';
import { renderFinalVideo, type RenderFinalVideoOptions, type RenderFinalVideoReport } from './render.js';
import { measureSpeech, type MeasureSpeechOptions, type SpeechMeasurement } from './speech.js';
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

  extractAudio(inputPath: string, outputPath: string, opts?: RunOptions, range?: MediaWindow): Promise<AudioExtractResult> {
    return extractAudio(inputPath, outputPath, this.opts(opts), range);
  }

  extract16kMono(inputPath: string, outputPath: string, opts?: RunOptions, range?: MediaWindow): Promise<AudioExtractResult> {
    return extract16kMono(inputPath, outputPath, this.opts(opts), range);
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

  renderFinalVideo(input: RenderFinalVideoOptions, opts?: RunOptions): Promise<RenderFinalVideoReport> {
    return renderFinalVideo(input, this.opts(opts));
  }

  /** Where the speech is inside a clip (silences + speech bounds); see speech.ts. */
  measureSpeech(
    inputPath: string,
    options?: Omit<MeasureSpeechOptions, 'signal'>,
    opts?: RunOptions,
  ): Promise<SpeechMeasurement> {
    const run = this.opts(opts);
    return measureSpeech(inputPath, { ...options, ...(run.signal ? { signal: run.signal } : {}) });
  }

  /** The input's audio against its picture, from its decoded samples; see drift.ts. */
  measureAudioDrift(inputPath: string, opts?: RunOptions, range?: MediaWindow): ReturnType<typeof measureAudioDrift> {
    return measureAudioDrift(inputPath, { ...this.opts(opts), ...(range ? { range } : {}) });
  }

  /** Long silent stretches of a whole track; see silences.ts. */
  detectSilences(
    inputPath: string,
    options: Omit<DetectSilencesOptions, 'signal'>,
    opts?: RunOptions,
  ): ReturnType<typeof detectSilences> {
    const run = this.opts(opts);
    return detectSilences(inputPath, { ...options, ...(run.signal ? { signal: run.signal } : {}) });
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
  computeWaveformPeaks,
  buildWaveformArgs,
  PeakAccumulator,
  DEFAULT_PEAKS_PER_SECOND,
  WAVEFORM_DECODE_RATE,
  type WaveformOptions,
  type WaveformPeaks,
} from './waveform.js';

export { renderFittedClip, buildFittedClipArgs, type FittedClipTrim } from './fittedclip.js';

export {
  renderFilmstrip,
  buildFilmstripArgs,
  planFilmstrip,
  type FilmstripLayout,
  type FilmstripResult,
} from './filmstrip.js';

export {
  probe,
  probeDurationMs,
  probeVideoGeometry,
  parseVideoGeometry,
  buildProbeArgs,
  buildVideoGeometryArgs,
  ffprobeJsonToMediaInfo,
  parseFrameRate,
  pictureDurationMs,
  streamDurationMs,
  type VideoGeometry,
} from './probe.js';

export {
  extractAudio,
  extract16kMono,
  clip16kMono,
  buildExtractAudioArgs,
  buildExtract16kMonoArgs,
  buildClip16kMonoArgs,
  extractKeepMs,
  pictureClockFilter,
  AUDIO_ASYNC_SAMPLES_PER_SEC,
} from './extract.js';

export {
  measureAudioDrift,
  buildAudioPacketsArgs,
  buildAudioHeadArgs,
  buildDecodedSamplesArgs,
  parseAudioPackets,
  parseAudioHead,
  parseDecodedSamples,
  steadyFrameSize,
  primingSamples,
  packetsToMs,
  type AudioPackets,
  type AudioHead,
  type MeasureAudioDriftOptions,
} from './drift.js';

export { detectSilences, silenceTimeoutMs, type DetectSilencesOptions } from './silences.js';

export { referenceClip, buildReferenceClipArgs, REFERENCE_MAX_MS, type ReferenceClipOptions } from './reference.js';
export { prepareLogo, prepareGreeting, buildPrepareLogoArgs, buildPrepareGreetingArgs, MAX_GREETING_MS } from './brand.js';
export { buildCardsAss, buildFilteredRenderArgs, buildLogoFilter, logoPlacement } from './overlay.js';
export {
  renderThumbnail,
  detectSceneChanges,
  buildThumbnailArgs,
  buildSceneArgs,
  parseSceneTimes,
  mergeSpans,
  THUMBNAIL_MAX_WIDTH,
  SCENE_THRESHOLD,
  type FrameSpan,
} from './frames.js';
export { windowArgs, type MediaWindow } from './extract.js';
export { prepareStemInput, mixStems, buildStemInputArgs, buildStemMixArgs } from './stems.js';

export {
  buildTtsTimeline,
  type TimelineStretchSummary,
  buildTimelineMixArgs,
  buildTimelineFilterComplex,
  buildTrimChain,
  alignedSegmentsToClips,
  chunkClips,
  estimateTimelineTmpBytes,
  MAX_INPUTS_PER_MIX,
  type TimelineClip,
  type BuildTtsTimelineInput,
} from './tts-timeline.js';

export { defaultMixConcurrency, mapWithConcurrency, MAX_MIX_CONCURRENCY } from './concurrency.js';

export {
  measureSpeech,
  buildSilenceDetectArgs,
  parseSilenceDetect,
  deriveSpeechMeasurement,
  SPEECH_NOISE_DB,
  SPEECH_MIN_SILENCE_MS,
  SPEECH_MAX_ISLAND_MS,
  type SpeechMeasurement,
  type SilenceInterval,
  type MeasureSpeechOptions,
} from './speech.js';

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
  parseSubtitleCues,
  cueTextToAss,
  computeAssLayout,
  buildAssDocument,
  formatAssTime,
  type SubtitleCue,
  type AssLayout,
} from './ass.js';

export {
  resolveFontsDir,
  packagedFontsDir,
  chooseBurnFont,
  BUNDLED_FONT_FAMILY,
  BUNDLED_FONT_FILE,
  FALLBACK_FONT_FAMILY,
  type BurnFont,
} from './fonts.js';

export {
  renderFinalVideo,
  buildRenderArgs,
  sidecarDestinationPath,
  type RenderArgsContext,
  type RenderFinalVideoOptions,
  type RenderFinalVideoReport,
  type RenderDeps,
} from './render.js';

export {
  LIBX264,
  hardwareEncoderCandidates,
  hardwareEncoderArgs,
  buildEncoderProbeArgs,
  probeHardwareEncoders,
  cachedHardwareEncoderProbe,
  resetHardwareEncoderProbeCache,
  planVideoEncode,
  encodeWithFallback,
  wantsHardwareEncoder,
  type VideoEncoderChoice,
  type VideoEncodePlan,
  type VideoEncodeReport,
  type HardwareEncoderProbe,
  type EncoderProbeAttempt,
} from './encoder.js';

/**
 * Media abstraction used by the pipeline.
 *
 * The shared {@link MediaService} interface only covers probe / extractAudio /
 * renderFinalVideo. The dubbing pipeline additionally needs to:
 *   - extract a 16k mono WAV for STT,
 *   - build a single full-length TTS timeline WAV (with per-segment atempo),
 *   - duck the original audio and mix in the TTS track.
 *
 * Those live in `@videodubber/media-worker`. To keep the runner testable
 * WITHOUT ffmpeg, the runner depends on this {@link PipelineMediaService}
 * interface (a superset of MediaService) and we inject either the real
 * ffmpeg-backed implementation or a fake in tests.
 */
import type {
  AudioExtractResult,
  MediaInfo,
  MediaService,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  TimeStretchEngine,
} from '@videodubber/shared';

/** A single placed segment for the TTS timeline build. */
export interface TimelineSegmentInput {
  /** Path to the synthesized WAV. */
  audioPath: string;
  /** Placement start on the timeline (ms). */
  startMs: number;
  /** Time-stretch factor to apply before placement (1 = none). */
  speedRatio: number;
  /** Measured clip duration (ms), pre-stretch — lets the worker place the
   * join-smoothing fade-out without re-probing every clip. */
  durationMs?: number;
}

/** Options for {@link PipelineMediaService.buildTtsTimeline}. */
export interface BuildTtsTimelineInput {
  segments: TimelineSegmentInput[];
  totalDurationMs: number;
  outputPath: string;
  /** Stretcher policy for fitting clips (default `auto`: rubberband when
   * available and the ratio warrants it, else atempo). */
  timeStretchEngine?: TimeStretchEngine;
}

/**
 * Which stretcher fitted this run's clips (reported by the media worker).
 * Mirrors media-worker's `TimelineStretchSummary`; optional so an older worker
 * still satisfies the interface.
 */
export interface TimelineStretchReport {
  stretched: number;
  rubberbandFilter: number;
  rubberbandCli: number;
  atempo: number;
  capabilities: { ffmpegFilter: boolean; cli: boolean };
}

/**
 * One line for pipeline.log describing which stretcher fitted the clips. Pure
 * (unit-tested) — it is the only record of a capability that is chosen at
 * runtime and otherwise leaves no trace.
 */
export function describeStretch(report: TimelineStretchReport): string {
  if (report.stretched === 0) return 'Time-stretch: no clip needed stretching.';
  const how: string[] = [];
  if (report.rubberbandFilter > 0) how.push(`${report.rubberbandFilter} via the ffmpeg rubberband filter`);
  if (report.rubberbandCli > 0) how.push(`${report.rubberbandCli} via the rubberband CLI`);
  if (report.atempo > 0) how.push(`${report.atempo} via atempo`);
  const caps = `rubberband available: filter=${report.capabilities.ffmpegFilter ? 'yes' : 'no'}, cli=${
    report.capabilities.cli ? 'yes' : 'no'
  }`;
  return `Time-stretch: ${report.stretched} clip(s) stretched — ${how.join(', ')} (${caps}).`;
}

/** Options for {@link PipelineMediaService.duckAndMix}. */
export interface DuckAndMixInput {
  originalAudio: string;
  ttsTimeline: string;
  output: string;
  duckingLevelDb: number;
  ttsGainDb: number;
  includeBackground: boolean;
  duck: boolean;
  /** Lay a very quiet pink-noise room tone under the dub when the original
   * soundtrack is removed, so pauses are never pure digital silence. */
  roomTone?: boolean;
  /** Two-pass EBU R128 loudness normalization for a transparent final mix. */
  twoPassLoudnorm?: boolean;
}

/**
 * Optional source-separation service (delivered as an engine pack). Splits the
 * original audio into a vocal stem and a music+effects (M&E) bed so the dub can
 * replace only the voices and keep the original score. Returns null when no
 * separation engine is installed (the caller falls back to ducking).
 */
export interface SeparationService {
  separate(
    audioPath: string,
    outputDir: string,
    signal?: AbortSignal,
  ): Promise<{ vocalsPath: string; accompanimentPath: string } | null>;
}

/**
 * Superset of {@link MediaService} with the extra operations the pipeline
 * needs. The media-worker's `FfmpegMediaService` is expected to implement at
 * least the {@link MediaService} part plus these methods; the composition root
 * adapts it to this interface.
 */
export interface PipelineMediaService extends MediaService {
  /**
   * Every method takes the run's cancellation signal, because POST /cancel used
   * to abort only the orchestrator's own await: ffmpeg kept running (a full
   * re-encode is minutes of pinned CPU) and kept writing the output file long
   * after the UI reported the run as stopped. The implementations pass it down
   * to the spawned child, which is the only place a cancel can actually land.
   */
  probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo>;
  extractAudio(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<AudioExtractResult>;
  renderFinalVideo(input: RenderFinalVideoInput, signal?: AbortSignal): Promise<RenderFinalVideoResult>;
  /** Extract a 16 kHz mono PCM WAV suitable for faster-whisper. */
  extract16kMono(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<AudioExtractResult>;
  /**
   * Extract a `[startMs, endMs)` window as a 16 kHz mono WAV — used to cut long
   * audio into bounded STT chunks. Optional so older adapters still satisfy the
   * type; the runner falls back to single-shot transcription when it's absent.
   */
  clip16kMono?(
    inputPath: string,
    outputPath: string,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<AudioExtractResult>;
  /**
   * Build the full-length TTS timeline WAV.
   *
   * `stretch` (when the worker reports it) says which time-stretcher actually
   * ran — Rubber Band is chosen from runtime capability detection, so the same
   * app stretches with atempo on one machine and Rubber Band on another. The
   * runner logs it so that difference is visible in pipeline.log instead of only
   * audible.
   */
  buildTtsTimeline(
    input: BuildTtsTimelineInput,
    signal?: AbortSignal,
  ): Promise<{ outputPath: string; durationMs: number; stretch?: TimelineStretchReport }>;
  /** Duck the original audio and mix the TTS timeline into the final track. */
  duckAndMix(input: DuckAndMixInput, signal?: AbortSignal): Promise<{ output: string; durationMs: number }>;
}

/**
 * EVERY method name on {@link PipelineMediaService}, optional ones included.
 *
 * This list is the single source of truth for "what a media service exposes",
 * and it exists because a hand-written forwarder silently dropped a capability:
 * `createLazyMediaService()` in server.ts listed six methods by hand and omitted
 * `clip16kMono`, so `runner.ts`'s `typeof media.clip16kMono === 'function'`
 * chunking gate was ALWAYS false in the real orchestrator — every long video was
 * transcribed as one un-checkpointed request that could outrun
 * WORKER_REQUEST_TIMEOUT_MS. The fixture media service implements clip16kMono,
 * so no runner test could ever catch it.
 *
 * The table below is typed `Record<keyof PipelineMediaService, true>`, so adding
 * a method to the interface without listing it here FAILS THE BUILD; every
 * forwarder derives its surface from this list, so a future capability cannot be
 * dropped by hand again.
 */
const MEDIA_SERVICE_METHOD_TABLE: Record<keyof PipelineMediaService, true> = {
  probe: true,
  extractAudio: true,
  renderFinalVideo: true,
  extract16kMono: true,
  clip16kMono: true,
  buildTtsTimeline: true,
  duckAndMix: true,
};

/** A method name of {@link PipelineMediaService}. */
export type MediaServiceMethod = keyof PipelineMediaService;

/** Every method name on {@link PipelineMediaService} (see the table above). */
export const MEDIA_SERVICE_METHODS = Object.keys(MEDIA_SERVICE_METHOD_TABLE) as MediaServiceMethod[];

/** Re-export for convenience. */
export type { MediaService, RenderFinalVideoInput, RenderFinalVideoResult };

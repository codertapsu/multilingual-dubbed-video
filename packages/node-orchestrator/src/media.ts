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
  MediaService,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
} from '@videodubber/shared';

/** A single placed segment for the TTS timeline build. */
export interface TimelineSegmentInput {
  /** Path to the synthesized WAV. */
  audioPath: string;
  /** Placement start on the timeline (ms). */
  startMs: number;
  /** Atempo factor to apply before placement (1 = none). */
  speedRatio: number;
}

/** Options for {@link PipelineMediaService.buildTtsTimeline}. */
export interface BuildTtsTimelineInput {
  segments: TimelineSegmentInput[];
  totalDurationMs: number;
  outputPath: string;
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
  /** Extract a 16 kHz mono PCM WAV suitable for faster-whisper. */
  extract16kMono(inputPath: string, outputPath: string): Promise<AudioExtractResult>;
  /** Build the full-length TTS timeline WAV. */
  buildTtsTimeline(input: BuildTtsTimelineInput): Promise<{ outputPath: string; durationMs: number }>;
  /** Duck the original audio and mix the TTS timeline into the final track. */
  duckAndMix(input: DuckAndMixInput): Promise<{ output: string; durationMs: number }>;
}

/** Re-export for convenience. */
export type { MediaService, RenderFinalVideoInput, RenderFinalVideoResult };

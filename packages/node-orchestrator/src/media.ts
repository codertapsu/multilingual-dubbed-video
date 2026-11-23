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
  AudioDrift,
  AudioExtractResult,
  MediaInfo,
  MediaService,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  TimeStretchEngine,
  TimelineFilmstrip,
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
   * join-smoothing fade-out without re-probing every clip. The trimmed part's
   * length when the clip is trimmed. */
  durationMs?: number;
  /** The part of the clip that plays, in ms of the clip (alignment/clipSpeech.ts). */
  trimStartMs?: number;
  trimEndMs?: number;
}

/** The part of a dub clip that plays, in ms of the clip. */
export interface ClipTrim {
  startMs: number;
  endMs: number;
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
  /**
   * Whether `separate` can do anything here (an engine is installed). Admission
   * asks this: a service that is merely wired, with no engine behind it, must
   * not put a run in the heavy lane.
   */
  available?(): Promise<boolean>;
}

/**
 * Superset of {@link MediaService} with the extra operations the pipeline
 * needs. The media-worker's `FfmpegMediaService` is expected to implement at
 * least the {@link MediaService} part plus these methods; the composition root
 * adapts it to this interface.
 */
/** A window of an input, in ms (a series part's share of the video). */
export interface MediaRange {
  startMs: number;
  endMs: number;
}

export interface PipelineMediaService extends MediaService {
  /**
   * Every method takes the run's cancellation signal, because POST /cancel used
   * to abort only the orchestrator's own await: ffmpeg kept running (a full
   * re-encode is minutes of pinned CPU) and kept writing the output file long
   * after the UI reported the run as stopped. The implementations pass it down
   * to the spawned child, which is the only place a cancel can actually land.
   */
  probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo>;
  /** `range`: only that window of the input (a series part). */
  extractAudio(inputPath: string, outputPath: string, signal?: AbortSignal, range?: MediaRange): Promise<AudioExtractResult>;
  renderFinalVideo(input: RenderFinalVideoInput, signal?: AbortSignal): Promise<RenderFinalVideoResult>;
  /** Extract a 16 kHz mono PCM WAV suitable for faster-whisper (`range`: only that window). */
  extract16kMono(inputPath: string, outputPath: string, signal?: AbortSignal, range?: MediaRange): Promise<AudioExtractResult>;
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
  /**
   * Waveform peaks (interleaved int8 min/max) for the editor's audio tracks.
   * Optional: without it the editor simply draws no waveform.
   */
  computeWaveformPeaks?(
    inputPath: string,
    opts?: { peaksPerSecond?: number },
    signal?: AbortSignal,
  ): Promise<{ peaksPerSecond: number; durationMs: number; peaks: Int8Array }>;
  /**
   * The editor's filmstrip: one JPEG sprite of evenly spaced thumbnails, written
   * atomically. Optional: without it the editor shows no filmstrip.
   */
  renderFilmstrip?(
    inputPath: string,
    outputPath: string,
    durationMs: number,
    signal?: AbortSignal,
    range?: MediaRange,
  ): Promise<Omit<TimelineFilmstrip, 'path'> & { path: string }>;
  /** Brand kit: any picture → a PNG at most 1024 px wide; its size. */
  prepareLogo?(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<{ width: number; height: number }>;
  /** Brand kit: any audio/video → a trimmed, levelled 48 kHz stereo WAV; its length. */
  prepareGreeting?(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<{ durationMs: number }>;
  /** A finished video's thumbnail: one JPEG at `atMs`, written atomically. */
  renderThumbnail?(inputPath: string, atMs: number, outputPath: string, signal?: AbortSignal): Promise<{ path: string }>;
  /**
   * Changes of shot (ms, sorted) inside the given spans of a video: series/
   * ranks a pause with one higher as a place to cut. Only the spans are decoded.
   */
  detectSceneChanges?(inputPath: string, spans: readonly MediaRange[], signal?: AbortSignal): Promise<number[]>;
  /**
   * Trim and tempo-fit one dub clip exactly as the timeline mix will (atrim,
   * atempo), for the editor's WebAudio preview — which can only resample, i.e.
   * shift pitch, and would otherwise play the edge silence the mix drops.
   */
  renderFittedClip?(
    inputPath: string,
    outputPath: string,
    ratio: number,
    trim?: ClipTrim,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Where the speech is inside a synthesized clip: ffmpeg `silencedetect`
   * (default -40 dBFS, silences >= 50 ms, clicks < 20 ms folded in) plus the
   * exact duration. Measures only — what to do about a clip that is mostly
   * silence ("Thua": 12.3 s with 0.5 s of sound) is the caller's decision.
   * Optional: an older media worker does not have it.
   */
  measureSpeech?(
    wavPath: string,
    opts?: { noiseDb?: number; minSilenceMs?: number },
    signal?: AbortSignal,
  ): Promise<{
    /** Whole clip, ms. */
    durationMs: number;
    /** Silent stretches, sorted and non-overlapping, within [0, durationMs]. */
    silences: Array<{ startMs: number; endMs: number }>;
    /** First ms of sound (0 if the clip opens on sound or has none). */
    speechStartMs: number;
    /** End of the last sound (durationMs if it runs to the end; 0 if none). */
    speechEndMs: number;
    /** Total non-silent ms; 0 = silent throughout. */
    speechMs: number;
    /** Thresholds actually used. */
    noiseDb: number;
    minSilenceMs: number;
  }>;
  /**
   * How long the input's audio really is against its picture (`range`: inside
   * that window), from its decoded sample count, never the container's
   * durations (media-worker drift.ts). Undefined for audio-only input.
   * Optional: an older media worker cannot measure, and the extraction
   * re-times the audio either way.
   */
  measureAudioDrift?(
    inputPath: string,
    signal?: AbortSignal,
    range?: MediaRange,
  ): Promise<Omit<AudioDrift, 'measuredAt'> | undefined>;
  /**
   * Silent stretches of a whole track below `noiseDb` lasting `minSilenceMs`
   * or more (media-worker silences.ts): the speech-to-text step's
   * digital-silence check. Optional, like measureSpeech.
   */
  detectSilences?(
    wavPath: string,
    opts: { noiseDb: number; minSilenceMs: number },
    signal?: AbortSignal,
  ): Promise<{ durationMs: number; silences: Array<{ startMs: number; endMs: number }> }>;
  /**
   * A voice-cloning reference: cut `[startMs, endMs)` (at most `maxMs`) of any
   * audio or video, mixed down to mono at `sampleRate`, levelled to
   * `loudnessLufs` when given, written atomically. Optional: an older media
   * worker does not have it, and cloning then says so.
   */
  referenceClip?(
    inputPath: string,
    outputPath: string,
    opts: { startMs?: number; endMs?: number; maxMs?: number; sampleRate?: number; loudnessLufs?: number },
    signal?: AbortSignal,
  ): Promise<AudioExtractResult>;
  /** The 44.1 kHz stereo WAV vocal separation (HTDemucs) insists on. */
  prepareStemInput?(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<AudioExtractResult>;
  /** One 48 kHz stereo WAV from separated stems: one converted, several summed unscaled. */
  mixStems?(inputPaths: readonly string[], outputPath: string, signal?: AbortSignal): Promise<AudioExtractResult>;
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
  computeWaveformPeaks: true,
  renderFilmstrip: true,
  renderFittedClip: true,
  prepareLogo: true,
  prepareGreeting: true,
  measureSpeech: true,
  measureAudioDrift: true,
  detectSilences: true,
  referenceClip: true,
  prepareStemInput: true,
  mixStems: true,
  renderThumbnail: true,
  detectSceneChanges: true,
};

/** A method name of {@link PipelineMediaService}. */
export type MediaServiceMethod = keyof PipelineMediaService;

/** Every method name on {@link PipelineMediaService} (see the table above). */
export const MEDIA_SERVICE_METHODS = Object.keys(MEDIA_SERVICE_METHOD_TABLE) as MediaServiceMethod[];

/** Re-export for convenience. */
export type { MediaService, RenderFinalVideoInput, RenderFinalVideoResult };

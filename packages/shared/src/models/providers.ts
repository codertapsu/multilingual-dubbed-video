/**
 * Service and provider interfaces plus their request/response payloads.
 *
 * These are the contracts implemented by the media worker (FFmpeg),
 * the Python workers (STT/translation/TTS), and the orchestrator.
 */

import type {
  AlignedSegment,
  CreateProjectInput,
  LanguageCode,
  PipelineStepId,
  Project,
  RenderQuality,
  SubtitleExportMode,
  SubtitleStyle,
  TranscriptSegment,
  TtsSegment,
} from './domain.js';
import type { AudioExtractResult, MediaInfo } from './media.js';

// ---------------------------------------------------------------------------
// Media service (FFmpeg/ffprobe)
// ---------------------------------------------------------------------------

/** Input to render the final dubbed video. */
export interface RenderFinalVideoInput {
  /** Absolute path to the original input video. */
  inputVideoPath: string;
  /** Absolute path to the final mixed audio track. */
  audioPath: string;
  /** Absolute path for the rendered output file. */
  outputPath: string;
  /** Subtitle export mode for this render. */
  subtitleExportMode: SubtitleExportMode;
  /** Absolute path to the subtitle file (SRT/VTT), when applicable. */
  subtitlePath?: string;
  /** Style for burned-in subtitles, when mode is "burned-in". */
  burnSubtitleStyle?: SubtitleStyle;
  /** Copy the source video stream without re-encoding when possible. */
  copyVideoStream?: boolean;
  /**
   * Encode quality/speed when a re-encode is unavoidable (burned-in subtitles):
   * "quality" => software x264 CRF (default); "fast" => hardware encode
   * (VideoToolbox/NVENC) when available.
   */
  renderQuality?: RenderQuality;
}

/** Result of rendering the final dubbed video. */
export interface RenderFinalVideoResult {
  /** Absolute path to the rendered output. */
  outputPath: string;
  /** Output duration in integer milliseconds. */
  durationMs: number;
  /** Absolute paths to any sidecar subtitle files written. */
  sidecarSubtitlePaths: string[];
}

/** FFmpeg-backed media operations. */
export interface MediaService {
  /** Probe a media file for container/stream metadata. */
  probe(inputPath: string): Promise<MediaInfo>;
  /** Extract the primary audio track to a WAV file. */
  extractAudio(inputPath: string, outputPath: string): Promise<AudioExtractResult>;
  /** Render the final dubbed (and optionally subtitled) video. */
  renderFinalVideo(input: RenderFinalVideoInput): Promise<RenderFinalVideoResult>;
}

// ---------------------------------------------------------------------------
// Speech-to-text (STT)
// ---------------------------------------------------------------------------

/** Request payload for transcription. */
export interface SttInput {
  /** Absolute path to the audio file to transcribe. */
  audioPath: string;
  /** Optional source language hint (auto-detect if omitted). */
  language?: LanguageCode;
  /** Model name, e.g. "small". */
  model: string;
  /** Whether to emit per-word timestamps. */
  wordTimestamps: boolean;
}

/** Result of a transcription request. */
export interface SttResult {
  /** Transcribed segments in order. */
  segments: TranscriptSegment[];
  /** Detected (or echoed) source language. */
  detectedLanguage: LanguageCode;
  /** Total transcribed duration in integer milliseconds. */
  durationMs: number;
}

/** A pluggable speech-to-text provider. */
export interface SttProvider {
  /** Stable provider id. */
  id: string;
  /** Human-readable provider name. */
  displayName: string;
  /** Whether the provider runs fully locally. */
  isLocal: boolean;
  /** Transcribe audio to timed segments. */
  transcribe(input: SttInput): Promise<SttResult>;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** A single segment to translate. */
export interface TranslationSegmentInput {
  /** Segment id (preserved in the result). */
  id: string;
  /** Source text to translate. */
  sourceText: string;
  /** Segment start time in ms (context, preserved). */
  startMs: number;
  /** Segment end time in ms (context, preserved). */
  endMs: number;
}

/**
 * Document-level translation context — the project's "character sheet".
 *
 * Carries what a single segment can never determine: who is talking to whom
 * (which fixes Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con…), the
 * terminology that must stay consistent, and the overall register. Generated
 * once per project by an LLM analysis pass, persisted, and user-editable in
 * the editor; context-capable providers inject it into every request.
 */
export interface TranslationDocContext {
  /** One/two-sentence summary of what the video is about. */
  synopsis?: string;
  /** Speakers/characters inferred from (or corrected by) the user. */
  cast?: { name: string; role?: string }[];
  /** Terms/names that must be translated the same way everywhere. */
  glossary?: { source: string; target: string }[];
  /** Target-language pronoun/address plan (per speaker pair where known). */
  pronounGuide?: string;
}

/** Request payload for batch segment translation. */
export interface TranslationInput {
  /** Source language code. */
  sourceLanguage: LanguageCode;
  /** Target language code. */
  targetLanguage: LanguageCode;
  /** Segments to translate. */
  segments: TranslationSegmentInput[];
  /** Optional glossary applied as case-insensitive whole-word replacement. */
  glossary?: Record<string, string>;
  /**
   * The project's character sheet. When present, context-capable providers use
   * it verbatim (no analysis pass of their own); when absent they may generate
   * one and return it via {@link TranslationResult.analysis} for persistence.
   */
  documentContext?: TranslationDocContext;
}

/** A single translated segment. */
export interface TranslationResultSegment {
  /** Segment id (matches the input). */
  id: string;
  /** Translated text. */
  translatedText: string;
}

/** Result of a batch translation request. */
export interface TranslationResult {
  /** Translated segments in input order. */
  segments: TranslationResultSegment[];
  /**
   * The character sheet the provider generated for this job (only when the
   * request carried no {@link TranslationInput.documentContext}). The caller
   * persists it so the user can review/edit it and later runs reuse it.
   */
  analysis?: TranslationDocContext;
}

/** A pluggable translation provider. */
export interface TranslationProvider {
  /** Stable provider id. */
  id: string;
  /** Human-readable provider name. */
  displayName: string;
  /** Whether the provider runs fully locally. */
  isLocal: boolean;
  /** Translate a batch of segments, preserving ids and order. */
  translateSegments(input: TranslationInput): Promise<TranslationResult>;
}

// ---------------------------------------------------------------------------
// Text-to-speech (TTS)
// ---------------------------------------------------------------------------

/** A single segment to synthesize. */
export interface TtsSegmentInput {
  /** Segment id (drives output file naming). */
  id: string;
  /** Text to synthesize. */
  text: string;
  /** Intended placement start in ms. */
  startMs: number;
  /** Intended placement end in ms. */
  endMs: number;
}

/** Request payload for batch segment synthesis. */
export interface TtsInput {
  /** Target language code. */
  language: LanguageCode;
  /** Optional explicit voice id. */
  voiceId?: string;
  /** Segments to synthesize. */
  segments: TtsSegmentInput[];
  /** Absolute directory to write per-segment WAV files into. */
  outputDir: string;
  /** Optional speaking-rate multiplier (1.0 = default). */
  speed?: number;
}

/** Result of a batch synthesis request. */
export interface TtsResult {
  /** Synthesized segments. */
  segments: TtsSegment[];
  /**
   * Engine that produced the batch ("piper" | "system" | "fallback" for the
   * local worker). "fallback" means the audio is SILENT placeholders — no
   * voice for the target language was available.
   */
  engine?: string;
  /**
   * Segments silently replaced by placeholder audio after the selected engine
   * errored at runtime. Non-zero output deserves a user-facing warning.
   */
  fallbackSegments?: number;
}

/** A pluggable text-to-speech provider. */
export interface TtsProvider {
  /** Stable provider id. */
  id: string;
  /** Human-readable provider name. */
  displayName: string;
  /** Whether the provider runs fully locally. */
  isLocal: boolean;
  /**
   * True when the engine honors {@link TtsInput.speed} natively (Piper's
   * length_scale, OpenAI's speed param). The pipeline then re-synthesizes
   * over-long lines at the required rate — which sounds far more natural than
   * post-hoc time-stretching — before falling back to the stretcher.
   * Absent/false = the engine speaks at its natural rate only (e.g. VieNeu).
   */
  supportsSpeedControl?: boolean;
  /** Synthesize a batch of segments to audio clips. */
  synthesizeSegments(input: TtsInput): Promise<TtsResult>;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** High-level job orchestration surface (maps to the HTTP API / Tauri cmds). */
export interface JobOrchestrator {
  /** Create a new project from input + settings. */
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Run (or resume) the full pipeline for a project. */
  runPipeline(projectId: string): Promise<void>;
  /** Pause a running job. */
  pauseJob(jobId: string): Promise<void>;
  /** Cancel a running job. */
  cancelJob(jobId: string): Promise<void>;
  /** Reset a step (and everything downstream) and rerun from there. */
  retryStep(projectId: string, stepId: PipelineStepId): Promise<void>;
}

// Re-export the alignment type for convenience to providers consumers.
export type { AlignedSegment };

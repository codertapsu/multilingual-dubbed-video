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
  /** A logo drawn over the picture (branding); forces a video re-encode. */
  logo?: RenderLogo;
  /**
   * Only this window of the input video (a series part). The audio and the
   * subtitles are already the window's; the video is cut with an accurate seek.
   */
  range?: { startMs: number; endMs: number };
  /** Opening and closing of a series part: fades, a darker recap, text cards. */
  effects?: RenderEffects;
}

/** A logo for {@link RenderFinalVideoInput}. */
export interface RenderLogo {
  imagePath: string;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  widthPct: number;
  marginPct: number;
  opacity: number;
  /** Shown only in these windows (output time, ms); absent = the whole video. */
  periods?: { startMs: number; endMs: number }[];
}

/** Text over the picture for a while, drawn by libass (reliable Vietnamese on Windows). */
export interface RenderCard {
  text: string;
  startMs: number;
  endMs: number;
  /** `title` (large, centred), `label` (small, top left), `end` (centred, lower). */
  kind: 'title' | 'label' | 'end';
}

export interface RenderEffects {
  /** Picture and sound fade in from the start, ms. */
  fadeInMs?: number;
  /** Picture and sound fade out at the end, ms. */
  fadeOutMs?: number;
  /** Darken the picture slightly until this time (the recap of the previous part), ms. */
  darkenUntilMs?: number;
  cards?: RenderCard[];
}

/** Result of rendering the final dubbed video. */
export interface RenderFinalVideoResult {
  /** Absolute path to the rendered output. */
  outputPath: string;
  /** Output duration in integer milliseconds. */
  durationMs: number;
  /** Absolute paths to any sidecar subtitle files written. */
  sidecarSubtitlePaths: string[];
  /**
   * Burned-in only: the encoder that made the video stream, chosen per machine
   * at run time (a hardware encoder that failed hands the encode to x264).
   */
  videoEncoder?: { codec: string; hardware: boolean; fallbackFrom?: string; fallbackReason?: string };
  /** Burned-in only: the subtitle font libass was asked for, and the folder it was given. */
  burnFont?: { family: string; fontsDir?: string };
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
  /**
   * Decode without the previous text as a prompt (whisper.cpp `max_context=0`,
   * faster-whisper `condition_on_previous_text=False`): how a range where the
   * model looped is decoded again (pipeline/loopRepair.ts).
   */
  noContext?: boolean;
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
  /**
   * Diarization speaker id, when known (matches `TranscriptSegment.speakerId`).
   *
   * Context-capable providers put it in the prompt: WHO is speaking is what
   * decides Vietnamese xưng hô (thầy/cô vs anh/chị vs em), and without it a
   * batch of alternating lines reads as one voice talking to itself — the model
   * picks a register per line instead of per relationship.
   */
  speakerId?: string;
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
  /**
   * Speakers/characters inferred from (or corrected by) the user. `speakerId`
   * ties a character to a detected speaker (SPEAKER_03), so the translation
   * knows who says a line: the ids decide the Vietnamese forms of address.
   */
  cast?: { name: string; role?: string; speakerId?: string }[];
  /**
   * What speech-to-text mishears, fixed in the source text before translating:
   * "枪人" heard where "羌人" is said. Applied to whole matches, in order.
   */
  corrections?: { heard: string; is: string }[];
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
  /**
   * Segments the engine answered from its clip cache (text and voice unchanged
   * since an earlier run) without synthesizing them again.
   */
  reusedSegments?: number;
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
  /**
   * The most units one {@link synthesizeSegments} call may carry. The pipeline
   * splits a longer run into consecutive calls of at most this many and
   * reports progress between them, so no single request has to outlast the
   * worker timeout however long the video is. Absent = the pipeline default.
   * Slow engines (CPU neural TTS) set a small value.
   */
  maxSegmentsPerRequest?: number;
  /**
   * Start and warm the engine before the first request (optional). Lets a
   * provider learn what it is running on, e.g. whether a GPU took the job, so
   * {@link maxSegmentsPerRequest} is right from the first batch.
   */
  prepare?(signal?: AbortSignal): Promise<void>;
  /** Where synthesis actually runs, once prepared: "cuda" | "cpu", the GPU's
   * name, and why a GPU engine fell back to the CPU. For the run log. */
  readonly activeDevice?: { device?: string; name?: string; note?: string };
  /** Synthesize a batch of segments to audio clips. */
  synthesizeSegments(input: TtsInput): Promise<TtsResult>;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Outcome of scheduling a run: it either started, or was QUEUED because the
 * machine is already at its simultaneous-dub capacity (see CapacityRecommendation).
 */
export interface RunScheduleResult {
  started: boolean;
  queued: boolean;
  /** 1-based queue position when `queued`. */
  position?: number;
}

/** High-level job orchestration surface (maps to the HTTP API / Tauri cmds). */
export interface JobOrchestrator {
  /** Create a new project from input + settings. */
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Run (or resume) the full pipeline — starts now, or queues behind others. */
  runPipeline(projectId: string): Promise<RunScheduleResult>;
  /** Pause a running job. */
  pauseJob(jobId: string): Promise<void>;
  /** Cancel a running (or queued) job. */
  cancelJob(jobId: string): Promise<void>;
  /** Reset a step (and everything downstream) and rerun from there. */
  retryStep(projectId: string, stepId: PipelineStepId): Promise<RunScheduleResult>;
}

// Re-export the alignment type for convenience to providers consumers.
export type { AlignedSegment };

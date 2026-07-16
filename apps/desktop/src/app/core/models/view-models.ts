/**
 * UI-only view models for orchestrator response envelopes that are not a
 * single canonical shared type. Kept here (not in @videodubber/shared) because
 * they describe the HTTP/IPC transport shape consumed only by the UI.
 */
import type {
  AlignedSegment,
  AppError,
  LanguageCode,
  PipelineState,
  PipelineStepState,
  Project,
  PipelineStepId,
  SubtitleExportMode,
  SubtitleStyle,
  TranscriptSegment,
  TtsSegment,
} from './index';

/** GET /projects/:id -> { project, pipeline } */
export interface ProjectWithPipeline {
  project: Project;
  pipeline: PipelineState;
}

/** A single dependency's availability, as reported by /workers/health. */
export interface ServiceHealth {
  available: boolean;
  detail?: string;
}

/** GET /workers/health */
export interface WorkersHealth {
  stt: ServiceHealth;
  translation: ServiceHealth;
  tts: ServiceHealth;
  ffmpeg: ServiceHealth;
  ffprobe: ServiceHealth;
}

/** A language pair the translation worker can handle (from/to base subtags). */
export interface LanguagePair {
  from: LanguageCode;
  to: LanguageCode;
}

/** A curated, human-labelled language entry from COMMON_LANGUAGES. */
export interface CommonLanguage {
  /** Normalized locale code, e.g. "vi-VN", "en-US". */
  code: LanguageCode;
  /** Human label, e.g. "Vietnamese (vi-VN)". */
  label: string;
}

/** GET /languages -> proxied translation worker languages + curated list. */
export interface LanguagesResponse {
  /** Installed Argos translation pairs. */
  installed: LanguagePair[];
  /** Optionally available (not yet installed) pairs. */
  available?: LanguagePair[];
  /** Curated common languages for the source/target selects. */
  common: CommonLanguage[];
  /** Languages Argos can actually translate (English-hub reachable) — the
   * dropdowns prefer these so users can't pick an untranslatable pair. */
  translatable?: CommonLanguage[];
}

/**
 * Fallback curated language list used when the orchestrator does not return a
 * `common` array (older worker) or when offline. Codes are normalized locales.
 */
export const FALLBACK_COMMON_LANGUAGES: ReadonlyArray<CommonLanguage> = [
  { code: 'en-US', label: 'English (en-US)' },
  { code: 'vi-VN', label: 'Vietnamese (vi-VN)' },
  { code: 'es-ES', label: 'Spanish (es-ES)' },
  { code: 'fr-FR', label: 'French (fr-FR)' },
  { code: 'de-DE', label: 'German (de-DE)' },
  { code: 'it-IT', label: 'Italian (it-IT)' },
  { code: 'pt-PT', label: 'Portuguese (pt-PT)' },
  { code: 'ru-RU', label: 'Russian (ru-RU)' },
  { code: 'ja-JP', label: 'Japanese (ja-JP)' },
  { code: 'ko-KR', label: 'Korean (ko-KR)' },
  { code: 'zh-CN', label: 'Chinese, Simplified (zh-CN)' },
  { code: 'hi-IN', label: 'Hindi (hi-IN)' },
  { code: 'ar-SA', label: 'Arabic (ar-SA)' },
] as const;

/** POST /projects/:id/segments/:segId/tts -> { segment, alignment } */
export interface SynthesizeSingleSegmentResult {
  segment: TtsSegment;
  alignment: AlignedSegment;
}

/**
 * GET /projects/:id/segments -> transcript segments, each optionally carrying
 * its alignment result (status/note/audioPath/generatedDurationMs) once the
 * alignment step has run. The editor reads everything from `alignment`.
 */
export type SegmentWithAlignment = TranscriptSegment & { alignment?: AlignedSegment };

/** Body for synthesize_single_segment (all optional overrides). */
export interface SynthesizeSingleSegmentBody {
  text?: string;
  voiceId?: string;
  speed?: number;
}

/** Body for save_translated_segments. */
export interface SaveTranslatedSegmentsBody {
  segments: Array<{ id: string; translatedText: string }>;
}

/** Body for render_final_video (overrides; falls back to project settings). */
export interface RenderFinalVideoBody {
  subtitleExportMode?: SubtitleExportMode;
  burnSubtitleStyle?: SubtitleStyle;
}

/** Body for retry_pipeline_step. */
export interface RetryStepBody {
  stepId: PipelineStepId;
}

/**
 * A transcript segment enriched for the editor list. Computed warnings live
 * here so the template stays declarative.
 */
export interface EditorSegmentVm {
  segment: SegmentWithAlignment;
  /** Wrapped lines of the text shown for warning calculation. */
  wrappedLines: string[];
  /** True when the (translated) text exceeds 2 lines / ~84 chars. */
  longSubtitle: boolean;
  /** True when the translation is identical to the source (likely skipped by
   * the translator) while the project translates between different languages. */
  untranslated: boolean;
  /** Alignment-derived flags. */
  needsReview: boolean;
  timingConflict: boolean;
  /** Optional alignment note to surface. */
  alignmentNote?: string;
}

/** Discriminated union of pipeline SSE events. */
export type PipelineEvent =
  | { type: 'state'; pipeline: PipelineState }
  | { type: 'log'; level: LogLevel; message: string; ts: string }
  | { type: 'step'; step: PipelineStepState }
  | { type: 'done' }
  | { type: 'error'; error: AppError };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A log line accumulated in the processing screen. */
export interface LogLine {
  level: LogLevel;
  message: string;
  ts: string;
}

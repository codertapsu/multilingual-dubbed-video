/**
 * UI-facing re-export of the shared domain types.
 *
 * Every component imports its domain types from here (`core/models`) rather
 * than reaching into `@videodubber/shared` directly. This keeps a single
 * seam we can adapt if the shared package's surface ever shifts, and lets us
 * co-locate UI-only view models alongside the canonical contracts.
 *
 * NOTE: these are type-only re-exports — no runtime code is pulled from the
 * shared package into the UI bundle here (the UI "imports types only" per the
 * dependency rules). Runtime utilities (e.g. splitSubtitleLines, subtitle
 * timestamp helpers) are imported directly from `@videodubber/shared` at the
 * point of use.
 */
import type {
  VoiceEngineInfo as VoiceEngineInfoBase,
  VoiceReferenceChecks as VoiceReferenceChecksBase,
} from '@videodubber/shared';

export type {
  // Primitive aliases / unions
  LanguageCode,
  SubtitleExportMode,
  ProcessingMode,
  OriginalAudioMode,
  RenderQuality,
  TimeStretchEngine,
  SpeakerVoiceAssignment,
  PipelineStepId,
  // Settings / style
  SubtitleStyle,
  ProjectSettings,
  // Engine packs
  EnginePackInfo,
  InstalledEnginePack,
  ActivePackSelection,
  EnginePrerequisites,
  EnginesResponse,
  EngineInstallEvent,
  EnginePackRecommendation,
  EngineRecommendationsResponse,
  LocalizedText,
  // Storage management
  StorageCategory,
  StorageLocation,
  StorageInfo,
  StorageClearRequest,
  StorageClearResult,
  // Media
  MediaInfo,
  VideoStreamInfo,
  AudioStreamInfo,
  // Project
  Project,
  CreateProjectInput,
  // Transcript / segments
  TranscriptWord,
  TranscriptSegment,
  TtsSegment,
  AlignmentStatus,
  AlignedSegment,
  SegmentPatch,
  // Editor timeline
  TimelineSegment,
  TimelineUnit,
  TimelineMedia,
  TimelineDocument,
  TimelineWaveform,
  TimelineFilmstrip,
  // Pipeline
  PipelineStepState,
  PipelineState,
  // Media service IO
  AudioExtractResult,
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  // Worker IO contracts
  SttInput,
  SttResult,
  TranslationDocContext,
  TranslationInput,
  TranslationResult,
  TranslationResultSegment,
  TranslationSegmentInput,
  TtsInput,
  TtsResult,
  TtsSegmentInput,
  RunScheduleResult,
  // Errors
  ErrorCode,
  AppError,
  // Voices (library, cloning)
  VoiceEngineId,
  VoiceEngineInfo,
  VoiceEntry,
  VoiceLibraryItem,
  VoiceLibraryResponse,
  VoiceLicense,
  VoiceLicenseCategory,
  VoiceInstallResult,
  VoiceProfile,
  VoiceConsent,
  VoiceReferenceChecks,
} from '@videodubber/shared';

/** One engine pack as the voice screens show it (GET /voices/engines). */
export interface VoicePackState {
  id: string;
  displayName: string;
  /** 'cuda' (NVIDIA GPU), 'metal' (Apple chip), 'cpu'… */
  accel?: string;
  approxSizeMb: number;
  installed: boolean;
  available: boolean;
  fits: boolean;
  installing: boolean;
}

/** A window of a recording (ms). */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** POST /voice-profiles/analyze — what is in a recording, and the best window. */
export interface VoiceReferenceAnalysis {
  analysisId: string;
  durationMs: number;
  regions: TimeRange[];
  detector: 'vad' | 'energy';
  window: TimeRange;
  checks: VoiceReferenceChecksBase;
  peaks: number[];
  sourceName?: string;
}

/** GET /voice-profiles/consent */
export interface VoiceConsentStatements {
  version: string;
  statements: Record<'self' | 'authorized' | 'source-video', string>;
}

/** A voice engine with its packs and install state (GET /voices/engines). */
export interface VoiceEngineState extends VoiceEngineInfoBase {
  installed: boolean;
  available: boolean;
  packs: VoicePackState[];
}

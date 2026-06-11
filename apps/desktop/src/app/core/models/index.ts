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
  EnginePrerequisites,
  EnginesResponse,
  EngineInstallEvent,
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
  TranslationInput,
  TranslationResult,
  TranslationResultSegment,
  TranslationSegmentInput,
  TtsInput,
  TtsResult,
  TtsSegmentInput,
  // Errors
  ErrorCode,
  AppError,
} from '@videodubber/shared';

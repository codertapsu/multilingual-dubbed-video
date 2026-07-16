/**
 * @videodubber/shared
 *
 * Foundational TypeScript types and utilities shared across the VideoDubber
 * monorepo: domain/media/pipeline/provider types, the error model, and
 * subtitle / language / pipeline-state helpers.
 *
 * All public symbols are re-exported here; consumers should import from
 * `@videodubber/shared` rather than reaching into subpaths.
 */

// ---- Error model -----------------------------------------------------------
export type { ErrorCode, AppError } from './errors.js';
export {
  REMEDIATIONS,
  AppErrorException,
  toAppError,
  makeAppError,
  isAppError,
} from './errors.js';

// ---- Domain types ----------------------------------------------------------
export type {
  LanguageCode,
  SubtitleExportMode,
  ProcessingMode,
  OriginalAudioMode,
  RenderQuality,
  TimeStretchEngine,
  SpeakerVoiceAssignment,
  PipelineStepId,
  SubtitleStyle,
  ProjectSettings,
  ProjectStatus,
  Project,
  TranscriptWord,
  TranscriptSegment,
  TtsSegment,
  AlignmentStatus,
  AlignedSegment,
  CreateProjectInput,
} from './models/domain.js';

// ---- Engine packs ----------------------------------------------------------
export type {
  EngineKind,
  EnginePackKind,
  EngineAccel,
  EnginePackArtifact,
  EnginePackInfo,
  InstalledEnginePack,
  EnginePrerequisites,
  EnginesResponse,
  EnginePackInstallRequest,
  EnginePackUninstallRequest,
  EngineInstallEvent,
  StorageCategory,
  StorageLocation,
  StorageInfo,
  StorageClearRequest,
  StorageClearResult,
} from './models/engines.js';

// ---- Media types -----------------------------------------------------------
export type {
  MediaInfo,
  VideoStreamInfo,
  AudioStreamInfo,
  AudioExtractResult,
} from './models/media.js';

// ---- Pipeline-state types --------------------------------------------------
export type {
  PipelineStepStatus,
  PipelineStepState,
  PipelineStatus,
  PipelineState,
} from './models/pipeline.js';

// ---- Setup / update types --------------------------------------------------
export type {
  PreflightCheck,
  PreflightResult,
  WhisperModelInfo,
  PiperVoiceInfo,
  ArgosPair,
  SetupCatalog,
  InstalledModels,
  SetupStatus,
  SetupInstallRequest,
  SetupEvent,
  UpdatePreferences,
  ProviderDefaults,
  UpdateInfo,
  CloudServiceId,
  CloudCredentialInfo,
  SaveCredentialRequest,
  CredentialTestResult,
  ProviderInfo,
  ProvidersResponse,
  GpuInfo,
  SystemProfile,
  HardwareTier,
  HardwareRecommendation,
  SystemProfileResponse,
} from './models/setup.js';
export { ALL_CLOUD_SERVICES } from './models/setup.js';

// ---- Provider / service contracts -----------------------------------------
export type {
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  MediaService,
  SttInput,
  SttResult,
  SttProvider,
  TranslationSegmentInput,
  TranslationDocContext,
  TranslationInput,
  TranslationResultSegment,
  TranslationResult,
  TranslationProvider,
  TtsSegmentInput,
  TtsInput,
  TtsResult,
  TtsProvider,
  JobOrchestrator,
} from './models/providers.js';

// ---- Subtitle utilities ----------------------------------------------------
export { toSrtTimestamp, toVttTimestamp } from './subtitles/timestamps.js';
export {
  splitSubtitleLines,
  wrapSubtitleText,
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_LINES,
} from './subtitles/lines.js';
export type { SubtitleCue, IndexedCue } from './subtitles/cues.js';
export { transcriptSegmentsToCues } from './subtitles/cues.js';
export { segmentsToSrt } from './subtitles/srt.js';
export type { SubtitleSegmentInput, SubtitleWriteOptions } from './subtitles/srt.js';
export { segmentsToVtt } from './subtitles/vtt.js';

// ---- Language utilities ----------------------------------------------------
export {
  normalizeLanguageCode,
  toWhisperLanguage,
  toArgosLanguage,
  argosPivotLegs,
  isValidLanguageCode,
  COMMON_LANGUAGES,
} from './language/normalize.js';
export type { CommonLanguage } from './language/normalize.js';

// ---- Pipeline utilities ----------------------------------------------------
export {
  PIPELINE_STEP_DEFS,
  PIPELINE_STEP_IDS,
  pipelineStepLabel,
  pipelineStepIndex,
} from './pipeline/steps.js';
export type { PipelineStepDef } from './pipeline/steps.js';
export {
  createInitialPipelineState,
  setStepStatus,
} from './pipeline/state.js';
export type { StepPatch } from './pipeline/state.js';

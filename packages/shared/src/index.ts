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
  ProjectQueueEntry,
  Project,
  ProjectInputFile,
  TranscriptWord,
  TranscriptSegment,
  SegmentPatch,
  TtsSegment,
  AlignmentStatus,
  AlignedSegment,
  CreateProjectInput,
  PublishedRecord,
  ReviseProjectInput,
} from './models/domain.js';

// ---- Editor timeline -------------------------------------------------------
export type {
  TimelineSegment,
  TimelineUnit,
  TimelineMedia,
  TimelineDocument,
  TimelineWaveform,
  TimelineFilmstrip,
} from './models/timeline.js';

// ---- Engine packs ----------------------------------------------------------
export type {
  EngineKind,
  EnginePackKind,
  EngineAccel,
  EngineFamilyId,
  EnginePackArtifact,
  EnginePackInfo,
  InstalledEnginePack,
  EnginePrerequisites,
  EnginesResponse,
  EnginePackRecommendation,
  EngineRecommendationsResponse,
  ActivePackSelection,
  EnginePackInstallRequest,
  EnginePackUninstallRequest,
  EngineInstallEvent,
  StorageCategory,
  StorageLocation,
  StorageInfo,
  StorageClearRequest,
  StorageClearResult,
  ProjectsFolderInfo,
  ProjectsFolderRequest,
} from './models/engines.js';
export { compareDriverVersions, outdatedNvidiaDriver, NVIDIA_GPU_RE } from './models/engines.js';
export type { UpdateNotice } from './models/setup.js';
export { updateNoticeFor } from './models/setup.js';
export type { GpuBudgetInput } from './models/engines.js';
export {
  gpuWeightBudgetMb,
  gpuResidentFraction,
  gpuWorkingSetMb,
  MIN_GPU_RESIDENT_FRACTION,
} from './models/engines.js';

// ---- Joining several videos into one project (New project → "Join several videos")
export type {
  JoinCheck,
  JoinFileInfo,
  JoinMismatch,
  JoinMode,
  JoinProjectRequest,
  JoinProjectResult,
  JoinState,
  JoinStatus,
} from './models/join.js';

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
  DownloadPreferences,
  DownloadsWhileDubbing,
  ProviderDefaults,
  UpdateInfo,
  CloudServiceId,
  CloudCredentialInfo,
  ClaudeConnection,
  SaveCredentialRequest,
  CredentialTestResult,
  ProviderInfo,
  ProvidersResponse,
  GpuInfo,
  SystemProfile,
  CapacityRecommendation,
  ConcurrencyPreferences,
  LocalModelPreferences,
  QueueReason,
  QueueEntry,
  RunningEntry,
  QueueState,
  HardwareTier,
  HardwareRecommendation,
  LocalizedText,
  SystemProfileResponse,
} from './models/setup.js';
export { ALL_CLOUD_SERVICES, MOTHER_CLAUDE_DEFAULT_URL } from './models/setup.js';
export { QUALITY_LADDER, pickClosestHeight } from './models/download.js';
export type {
  QualityTarget,
  DownloadItem,
  DownloadQueueEvent,
  DownloadRequest,
  DownloadSource,
  DownloadState,
  DubDownloadResult,
  DubDownloadsRequest,
  DubPreset,
} from './models/download.js';
export type {
  BrandAsset,
  BrandingSettings,
  GreetingPlacement,
  GreetingPlan,
  GreetingSettings,
  LogoCorner,
  LogoSettings,
  TimeSpan,
} from './models/branding.js';
export { DEFAULT_GREETING, DEFAULT_LOGO, logoPeriods } from './models/branding.js';
export type {
  SeriesAiOption,
  SeriesCandidate,
  SeriesInfo,
  SeriesParentInfo,
  SeriesPartInfo,
  SeriesPlan,
  SeriesPlanPart,
  SeriesReviewReason,
  SeriesSettings,
  SeriesState,
  SeriesView,
} from './models/series.js';
export { DEFAULT_SERIES_SETTINGS } from './models/series.js';
export type { BlurRegion } from './models/picture.js';
export type {
  ActivityEntry,
  ActivityInitiator,
  ActivityInitiatorKind,
  ActivityState,
  EditHistoryEntry,
} from './models/activity.js';
export type {
  BackendCrash,
  BackendHealth,
  HealthSample,
  ProjectWarning,
  ProjectWarningCode,
  StepDetail,
} from './models/diagnostics.js';

// ---- Provider / service contracts -----------------------------------------
export type {
  RenderFinalVideoInput,
  RenderFinalVideoResult,
  RenderCard,
  RenderEffects,
  RenderLogo,
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
  RunScheduleResult,
} from './models/providers.js';
export type {
  VoiceAccent,
  VoiceConsent,
  VoiceEngineId,
  VoiceEngineInfo,
  VoiceEnrollment,
  VoiceEntry,
  VoiceFile,
  VoiceInstallResult,
  VoiceLibraryItem,
  VoiceLibraryResponse,
  VoiceLicense,
  VoiceLicenseCategory,
  VoicePreview,
  VoiceProfile,
  VoiceProfileGender,
  VoiceReferenceChecks,
  VoiceReferencePolicy,
  VoiceCheckWarning,
  VoiceSpeaker,
} from './models/voices.js';
export {
  VOICE_ENGINE_PROVIDER,
  isVoiceProfileId,
  splitSpeakerVoiceId,
  voiceEngineOfId,
  voiceEngineOfProvider,
} from './models/voices.js';

// ---- Subtitle utilities ----------------------------------------------------
export { toSrtTimestamp, toVttTimestamp } from './subtitles/timestamps.js';
export {
  splitSubtitleLines,
  wrapSubtitleText,
  subtitleTextWidth,
  DEFAULT_MAX_CHARS_PER_LINE,
  DEFAULT_MAX_LINES,
} from './subtitles/lines.js';
export type { SubtitleOverflowPolicy } from './subtitles/lines.js';
export type { SubtitleCue, IndexedCue } from './subtitles/cues.js';
export { transcriptSegmentsToCues } from './subtitles/cues.js';
export { planDisplayCues } from './subtitles/plan.js';
export type { DisplayCueInput, DisplayCueOptions } from './subtitles/plan.js';
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
export {
  PROJECT_OUTPUT_EXTENSIONS,
  chosenOutputBaseName,
  projectOutputBaseName,
  projectOutputFiles,
  projectOutputVideoPath,
  projectOutputThumbnailPath,
  safeFileStem,
} from './pipeline/output.js';
export {
  speechBudget,
  languageSpeechRate,
  budgetUnitLabel,
  countSpeechUnits,
  fitWindowMs,
  fitBudget,
  FIT_COMFORT_RATIO,
  GAP_BREATH_MS,
  MAX_GAP_CREDIT_MS,
} from './language/speechBudget.js';
export type { BudgetUnit, FitBudget, SpeechBudgetOptions } from './language/speechBudget.js';

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
  normalizePipelineState,
  pausePipelineState,
  resumePipelineState,
  setStepStatus,
} from './pipeline/state.js';
export type { StepPatch } from './pipeline/state.js';
export {
  SPEAKER_ID_RE,
  isSpeakerId,
  nextSpeakerId,
  sanitizeSpeakerGenders,
  sanitizeSpeakerVoices,
  speakerNumber,
  summarizeSpeakers,
  voiceForLine,
} from './pipeline/speakers.js';
export type { LineVoiceSettings, SpeakerSummary } from './pipeline/speakers.js';

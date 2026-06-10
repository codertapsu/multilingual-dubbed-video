/**
 * @videodubber/node-orchestrator
 *
 * The VideoDubber orchestration engine: an HTTP service implementing the
 * resumable dubbing pipeline, provider registry, project workspace management,
 * SSE progress, and worker health checks.
 *
 * Public API surface re-exported for embedding and testing.
 */

// ---- Configuration ---------------------------------------------------------
export { loadConfig, defaultProjectsDir } from './config.js';
export type { OrchestratorConfig } from './config.js';

// ---- Server ----------------------------------------------------------------
export { createServer, startServer } from './server.js';
export type { CreateServerOptions } from './server.js';

// ---- Orchestrator ----------------------------------------------------------
export { LocalJobOrchestrator } from './orchestrator.js';
export type { OrchestratorDeps, SegmentWithAlignment } from './orchestrator.js';

// ---- Pipeline --------------------------------------------------------------
export { PipelineRunner } from './pipeline/runner.js';
export type { RunnerDeps, RunOptions } from './pipeline/runner.js';

// ---- Alignment -------------------------------------------------------------
export { alignSegment, alignSegments, summarizeAlignment } from './alignment/align.js';
export type { AlignInputSegment, AlignSettings, AlignmentSummary } from './alignment/align.js';

// ---- Providers -------------------------------------------------------------
export { ProviderRegistry, createDefaultRegistry, DEFAULT_PROVIDER_IDS } from './providers/registry.js';
export type { ProviderDescriptor } from './providers/registry.js';
export { FasterWhisperProvider } from './providers/stt/fasterWhisperProvider.js';
export { ArgosTranslationProvider } from './providers/translation/argosProvider.js';
export { LocalTtsProvider } from './providers/tts/localTtsProvider.js';
export {
  OpenAiSttProvider,
  DeeplTranslationProvider,
  GoogleTranslationProvider,
  AzureTtsProvider,
  ElevenLabsTtsProvider,
} from './providers/cloudPlaceholders.js';

// ---- Workspace -------------------------------------------------------------
export { ProjectStore, generateProjectId } from './workspace/projectStore.js';
export {
  workspacePaths,
  ensureWorkspaceDirs,
  padSegmentIndex,
  segmentIdToIndex,
  fileExists,
  fileExistsNonEmpty,
} from './workspace/paths.js';
export type { WorkspacePaths } from './workspace/paths.js';

// ---- Events & logging ------------------------------------------------------
export { EventBusRegistry, ProjectEventBus } from './events.js';
export type { PipelineEvent, LogLevel } from './events.js';
export { ProjectLogger } from './logging.js';

// ---- Media abstraction -----------------------------------------------------
export { createFfmpegMediaService } from './mediaAdapter.js';
export type {
  PipelineMediaService,
  BuildTtsTimelineInput,
  DuckAndMixInput,
  TimelineSegmentInput,
} from './media.js';

// ---- Health ----------------------------------------------------------------
export { checkWorkersHealth, probeBinary } from './health.js';
export type { WorkersHealth, AvailabilityResult } from './health.js';

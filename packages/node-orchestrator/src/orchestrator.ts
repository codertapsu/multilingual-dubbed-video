/**
 * LocalJobOrchestrator: the public engine API.
 *
 * Implements the shared {@link JobOrchestrator} contract plus the extra
 * operations the HTTP API exposes (save translated segments, re-synthesize a
 * single segment, render, project listing, probe, get-with-pipeline).
 *
 * It owns the running-jobs map (one active run per project, each with its own
 * AbortController) and composes the {@link PipelineRunner} from injected deps.
 */
import type { WarningInbox } from './diagnostics/warningInbox.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  toAppError,
  segmentsToSrt,
  toWhisperLanguage,
  segmentsToVtt,
  pausePipelineState,
  chosenOutputBaseName,
  projectOutputFiles,
  projectOutputVideoPath,
  sanitizeSpeakerVoices,
  sanitizeSpeakerGenders,
  voiceForLine,
  type AlignedSegment,
  type CreateProjectInput,
  type ReviseProjectInput,
  type JobOrchestrator,
  type MediaInfo,
  type PipelineState,
  type ProjectWarning,
  type PipelineStepId,
  type CapacityRecommendation,
  type Project,
  type ProjectQueueEntry,
  type ProjectSettings,
  type QueueState,
  type RunScheduleResult,
  type SegmentPatch,
  type SubtitleStyle,
  type SystemProfile,
  type TimelineDocument,
  type TimelineFilmstrip,
  type TimelineUnit,
  type TimelineWaveform,
  type TranscriptSegment,
  type TranslationDocContext,
  type TtsSegment,
} from '@videodubber/shared';
import { alignSegments, type AlignSettings } from './alignment/align.js';
import { formatClock, recordEdit } from './activity/history.js';
import { copySpeakerLabels, redetectSpeakers, redetectSpeakersInRange, remapSpeakerVoices } from './pipeline/diarization.js';
import { activity, said } from './activity/registry.js';
import { changesOnlyMixAndRender, SUBTITLE_FILE_KEYS } from './series/partWork.js';
import {
  RETRANSCRIBE_JOBS_KEPT,
  RETRANSCRIBE_WINDOW_MS,
  carrySpeakers,
  hearWindow,
  heardLine,
  loopCounts,
  planRetranscribeWindows,
  readSavedSpeechRegions,
  saveLoopReport,
  silenceTest,
  widenToLines,
  windowSummary,
  windowPhrase,
  windowSummaryParams,
  type HearDeps,
  type RetranscribeJobView,
  type RetranscribeOutcome,
  type RetranscribeResult,
  type RetranscribeWindowResult,
  type TimeRange,
} from './pipeline/retranscribe.js';
import {
  detectionRange,
  readSpeakerJob,
  saveSpeakerJob,
  speakerJobFile,
  speakerJobPhrase,
  speakerJobSummary,
  speakerJobView,
  type SpeakerJobState,
  type SpeakerJobView,
} from './pipeline/speakerJob.js';
import { refreshTranscriptWarnings } from './pipeline/transcriptWarnings.js';
import { runAsScheduler } from './activity/context.js';
import { dubRuns } from './activity/dubRuns.js';
import { measureClip, type ClipTiming } from './alignment/clipSpeech.js';
import {
  rateForGroup,
  voiceForGroup,
  type SynthesisGroup,
  type SynthesisGroupsArtifact,
} from './pipeline/grouping.js';
import type { OrchestratorConfig } from './config.js';
import type { EngineManager } from './engines/engineManager.js';
import { withEngineOwner } from './engines/engineOwner.js';
import { decideAdmissions, type RunningRun } from './scheduler/admit.js';
import { classifyWorkload, lastHeavyStep, type RunWorkload } from './scheduler/workload.js';
import { effectiveCapacity, POINTS_PER_LOCAL_RUN, recommendCapacity } from './system/capacity.js';
import { getSystemProfile } from './system/systemProfile.js';
import type { SetupStore } from './setup/setupStore.js';
import type { EventBusRegistry} from './events.js';
import { type ProjectEventBus } from './events.js';
import { KeyedMutex } from './keyedMutex.js';
import { ProjectLogger } from './logging.js';
import type { ClipTrim, PipelineMediaService, SeparationService } from './media.js';
import type { AlignmentService } from './providers/alignment/whisperxProvider.js';
import type { DiarizationService } from './providers/diarization/sherpaDiarizationProvider.js';
import type { SubtitleOcrService } from './providers/ocr/rapidOcrProvider.js';
import type { ProviderRegistry } from './providers/registry.js';
import { assertRunReady, type ProviderReadiness } from './providers/readiness.js';
import {
  BUILT_IN_CHAT_PROVIDER_ID,
  contextEngineCandidates,
  FallbackContextChat,
  type ContextCapableProvider,
} from './providers/translation/contextEngine.js';
import {
  readTranslationReport,
  tightenOneLine,
  translationReportPath,
  type TranslationReport,
} from './providers/translation/dubPasses.js';
import { fitWindowMs, resolveVoiceRate, voiceRateBookFor } from './providers/translation/speechFit.js';
import { PipelineRunner, type RunnerDeps } from './pipeline/runner.js';
import type { SpeechMapService } from './pipeline/speechMap.js';
import type { ProjectStore } from './workspace/projectStore.js';
import { fileExistsNonEmpty, segmentIdToIndex, type WorkspacePaths } from './workspace/paths.js';
import { hasSpeakableText, writeSilentClip } from './pipeline/speakable.js';
import { mixFingerprint, readMixFingerprint } from './pipeline/mixFingerprint.js';
import type { BrandKit } from './branding/brandKit.js';
import { greetingSettingsKey, readGreetingPlan } from './branding/greetingMix.js';
import { sanitizeBranding } from './branding/sanitize.js';
import { sanitizeBlurRegions, sanitizeCoverFields, withoutClearedCoverFields } from './picture/pictureSanitize.js';
import { sanitizeWatermarkAuto } from './picture/watermarkAuto.js';
import { assertMainOnly } from './voices/mainOnly.js';
import { rangedMediaInfo } from './series/seriesRange.js';
import { acceptOutputDir, moveOutputFiles, samePath } from './workspace/outputFolder.js';
import { clearCueOverridesFor, displayCuesFor, readCueOverrides, songSubtitlesOn } from './workspace/subtitleTiming.js';
import { isSong, setSongFlags, songMixPlan, songTargets, songUnits, type SongMarkRequest, type SongMarkResult } from './songs/songLines.js';
import { MAX_MINOR_VOICES } from './voices/casting.js';
import { writeJsonAtomic, writeTextAtomic } from './workspace/projectStore.js';
import {
  alignmentInputsForUnits,
  applySegmentPatches,
  reconcileGroups,
  singletonUnits,
} from './workspace/timelineEdit.js';

/** Injected dependencies for the orchestrator (all mockable in tests). */
/**
 * Seconds left in a run, from the time so far and how far it is: rough (steps
 * do not take equal time), and absent before 3 % when it would only guess. Pure.
 */
export function etaSeconds(startedAtIso: string, progressPercent: number, now = Date.now()): number | undefined {
  const elapsed = (now - Date.parse(startedAtIso)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed <= 0 || progressPercent < 3 || progressPercent >= 100) return undefined;
  return Math.round((elapsed * (100 - progressPercent)) / progressPercent);
}

export interface OrchestratorDeps {
  /**
   * The user's voices kept for one main character (VoiceProfile.mainOnly), id
   * to name: a settings change that makes one a default voice or gives it to
   * two speakers is refused (voices/mainOnly.ts). Absent: not checked.
   */
  mainOnlyVoices?: (projectId: string) => Promise<ReadonlyMap<string, string>>;
  /**
   * Finding a project's watermark (picture/pictureDetection.ts), for a render
   * whose settings ask for it to be hidden by itself (watermarkAuto). Absent:
   * such a render hides only the boxes it was given, and says so.
   */
  watermark?: RunnerDeps['watermark'];
  /**
   * The computer is under pressure now (HealthMonitor.pressure: little free
   * memory, or the app stalling): renders then wait for a full dub running
   * beside them (scheduler/admit.ts). Absent: never.
   */
  pressure?: () => boolean;
  config: OrchestratorConfig;
  /** Warnings raised outside a run (engine fallbacks), for its steps to keep. */
  warningInbox?: WarningInbox;
  store: ProjectStore;
  media: PipelineMediaService;
  registry: ProviderRegistry;
  bus: EventBusRegistry;
  /** Optional vocal-separation engine for the "replace-vocals" mix mode. */
  separation?: SeparationService;
  /** The brand kit projects take their logo and greeting from (branding/brandKit.ts). */
  brandKit?: Pick<BrandKit, 'get'>;
  /** A series parent finished analysing its video (series/seriesService.ts plans the parts). */
  seriesAnalysed?: (projectId: string) => Promise<void>;
  /** Optional forced-alignment/diarization engine for tighter timing. */
  alignment?: AlignmentService;
  /** Optional speaker detection: who says each line (the diarize setting). */
  diarization?: DiarizationService;
  /** Optional reader of burned-in subtitles (settings.useBurnedInSubtitles). */
  ocr?: SubtitleOcrService;
  /** Where speech is in a project's audio, to anchor transcript lines (see RunnerDeps). */
  speechMap?: SpeechMapService;
  /** Engine lifecycle manager, so a finished run releases its heavy-engine lane. */
  engines?: EngineManager;
  /**
   * Engine families that will run on a GPU pack here (see ClassifyOptions
   * `gpuFamilies`). Optional: without it, runs are classified from the launch
   * specs alone, as before.
   */
  gpuEngineFamilies?: () => Promise<ReadonlySet<string>>;
  /**
   * Whether the built-in Gemma chat model can run here (a llama.cpp runtime and
   * a chat model pack are installed). Admission needs it: a project without a
   * review model does its repairs and auto-fit with that model
   * (contextEngine.ts), which takes the heavy lane. Optional: without it the
   * model is taken to be absent, as before.
   */
  localChatAvailable?: () => Promise<boolean>;
  /** Preferences store (the user's concurrency limit / queue-paused flag). */
  setup?: Pick<SetupStore, 'getPreferences'>;
  /**
   * Optional readiness checker. When present, a run is gated on it: the selected
   * providers (for the phases that will execute) are checked BEFORE the run is
   * scheduled, so an unready provider (e.g. Ollama with no daemon) fails fast
   * with an actionable error instead of dying deep in a step. Returns one entry
   * per checked phase; the gate throws if any is not ready.
   */
  checkReadiness?: (project: Project, fromStep?: PipelineStepId) => Promise<ProviderReadiness[]>;
}

/**
 * Profile assumed when hardware detection fails: a modest 4-core / 8 GB
 * machine, which yields the safe minimum of 1 simultaneous dub.
 */
const FALLBACK_PROFILE: SystemProfile = {
  platform: process.platform,
  arch: process.arch,
  cpuModel: 'unknown',
  cpuCores: 4,
  totalRamMb: 8192,
  freeRamMb: 0,
  gpus: [],
  appleSilicon: false,
};

/** How long to wait before retrying a dispatch blocked by a booting worker. */
const QUEUE_RETRY_MS = 2000;

/**
 * A speaker detection job outside a run (the editor's Detect, MCP
 * detect_speakers), whole or over a range; saved in the project's folder as
 * it goes (pipeline/speakerJob.ts), so a restart shows it as interrupted.
 */
export interface SpeakerJob extends SpeakerJobState {
  abort: AbortController;
}

/** Work on a project's lines outside a run (a re-transcription), which a dub must not start under. */
interface LineJob {
  kind: 'retranscribe';
  abort: AbortController;
  /** Its entry in the activity list. */
  activityId: string;
}

/** A tracked, in-flight pipeline run. */
interface RunningJob {
  projectId: string;
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * The project-settings fields the editor may change after creation (then re-dub
 * from the affected stage). Excludes structural/complex fields (burnSubtitleStyle,
 * speakerVoices) that aren't part of the change-and-re-dub flow.
 */
const EDITABLE_SETTING_KEYS = [
  'sourceLanguage',
  'targetLanguage',
  'processingMode',
  'sttProviderId',
  'sttModel',
  'translationProviderId',
  'refineProviderId',
  'ttsProviderId',
  'ttsVoiceId',
  'includeOriginalBackgroundAudio',
  'duckOriginalAudio',
  'duckingLevelDb',
  'originalAudioMode',
  'ttsGainDb',
  'maxSpeedRatio',
  'allowedOverflowMs',
  'autoFitOverflow',
  'timeStretchEngine',
  'synthesisGrouping',
  'syncSubtitlesToVoice',
  'reviewBeforeSynthesis',
  'holdFlaggedLines',
  'roomTone',
  'renderQuality',
  'subtitleExportMode',
  'forcedAlignment',
  'diarize',
  'transcriptSpotCheck',
  'subtitleCoverageCheck',
  'useBurnedInSubtitles',
  'useSourceSubtitles',
] as const satisfies readonly (keyof ProjectSettings)[];

/**
 * A clip trim from outside (the editor's preview request), or undefined when it
 * is missing or not a plausible window: whole milliseconds, start before end,
 * inside the longest clip an engine produces (an hour is far beyond it).
 */
export function validClipTrim(trim: Partial<ClipTrim> | undefined): ClipTrim | undefined {
  const start = trim?.startMs;
  const end = trim?.endMs;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end <= start || end > 3_600_000) return undefined;
  return { startMs: start, endMs: end };
}

/**
 * Keep only well-formed {@link SubtitleStyle} fields (a client may send
 * anything), or undefined when nothing is left. Out-of-range numbers are
 * dropped, not clamped: the renderer's defaults are better than a guess.
 */
export function sanitizeSubtitleStyle(input: unknown): SubtitleStyle | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const s = input as Record<string, unknown>;
  const out: SubtitleStyle = {};
  const num = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const color = (v: unknown): string | undefined => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
  if (s.position === 'bottom' || s.position === 'raised' || s.position === 'top') out.position = s.position;
  // The band over the source's subtitles: solid or blurred, where, how strong (picture/pictureSanitize.ts).
  Object.assign(out, sanitizeCoverFields(s));
  const opacity = num(s.coverOpacity, 0, 1);
  if (opacity !== undefined) out.coverOpacity = opacity;
  const band = num(s.coverHeightPercent, 5, 50);
  if (band !== undefined) out.coverHeightPercent = band;
  const size = num(s.sizePercent, 2, 15);
  if (size !== undefined) out.sizePercent = size;
  if (typeof s.fontFamily === 'string' && s.fontFamily.trim() && s.fontFamily.length <= 100) out.fontFamily = s.fontFamily.trim();
  const primary = color(s.primaryColor);
  if (primary) out.primaryColor = primary;
  const outline = color(s.outlineColor);
  if (outline) out.outlineColor = outline;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The transcript segment shape merged with optional alignment status. */
export interface SegmentWithAlignment extends TranscriptSegment {
  /** Alignment outcome for this segment, if alignment has run. */
  alignment?: AlignedSegment;
}

/** Installed/available language pairs as reported by the translation worker. */
export interface TranslationLanguages {
  installed: { from: string; to: string }[];
  available?: { from: string; to: string }[];
}

/** A translation provider that can also enumerate language pairs. */
interface ListLanguagesCapable {
  listLanguages(): Promise<TranslationLanguages>;
}

/** Structural guard for providers exposing `listLanguages` (e.g. Argos). */
function hasListLanguages(value: unknown): value is ListLanguagesCapable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { listLanguages?: unknown }).listLanguages === 'function'
  );
}

/** Local, offline-first orchestration engine. */
export class LocalJobOrchestrator implements JobOrchestrator {
  private readonly running = new Map<string, RunningJob>();
  /** Queued project ids in dispatch order (oldest `queue.queuedAt` first). */
  private queue: string[] = [];
  /** O(1) membership for the queue (kept in step with {@link queue}). */
  private readonly queued = new Set<string>();
  /** Workload classification per scheduled project (running + queued). */
  private readonly workloads = new Map<string, RunWorkload>();
  /** Serializes {@link pump}; `pumpAgain` coalesces requests that arrive mid-pump. */
  private pumping = false;
  /** The app is closing (pauseAll): no queued dub may start any more. */
  private closing = false;
  /** Projects whose finished files are moving to another folder (setProjectOutputDir). */
  private readonly movingOutput = new Set<string>();
  /** Callers holding the queue (whileQueueHeld): while any does, nothing queued starts. */
  private queueHolds = 0;
  private pumpAgain = false;
  /** Memoized hardware capacity (specs don't change while the app runs). */
  private capacityPromise: Promise<CapacityRecommendation> | undefined;
  /** Pending re-pump for a transient dispatch failure (worker still booting). */
  private queueRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight editor actions per owner id, so the LAST one frees the lane. */
  /** Speaker detection jobs outside runs (startSpeakerDetection), by project. */
  private readonly speakerJobs = new Map<string, SpeakerJob>();
  /** Re-transcriptions in progress (retranscribeRange), by project: one at a time. */
  private readonly lineJobs = new Map<string, LineJob>();
  /** Re-transcription jobs (ranges over 15 minutes) by id, the last ones kept for their result. */
  private readonly retranscribeJobs = new Map<string, RetranscribeJobView>();
  /** Jobs in progress per lane owner outside a run (`editor:<id>`, `preview:<voice>`). */
  private readonly laneRefs = new Map<string, number>();
  /**
   * Serializes read-modify-write updates of a project's artifacts.
   *
   * The editor allows concurrent actions on different segments (by design — see
   * withEditorLane), and every artifact update reads a whole JSON file, changes
   * one entry and writes it back. Two "Regenerate" clicks therefore interleaved
   * and one segment's alignment entry was silently dropped, leaving that clip in
   * the mix with stale timing. Taken only around the leaf writers below, never
   * around a region that calls one, so it can never wait on itself.
   */
  private readonly artifactLock = new KeyedMutex();
  /** In-flight editor media builds (waveform/filmstrip), so concurrent opens share one ffmpeg. */
  private readonly editorMediaInFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: OrchestratorDeps) {
    // A lane whose owner is gone (a run that ended, an editor action or a
    // preview that never released it) is free: the engine manager asks us.
    deps.engines?.setOwnerLiveness?.((owner) => this.laneOwnerAlive(owner));
  }

  /** Build a per-project logger bound to the project's event bus. */
  private loggerFor(projectId: string): ProjectLogger {
    const paths = this.deps.store.paths(projectId);
    const bus = this.deps.bus.get(projectId);
    return new ProjectLogger(paths.pipelineLog, bus);
  }

  /** Assemble the runner dependencies for a project. */
  private runnerDeps(projectId: string): { runner: PipelineRunner; bus: ProjectEventBus; logger: ProjectLogger } {
    const bus = this.deps.bus.get(projectId);
    const logger = this.loggerFor(projectId);
    const deps: RunnerDeps = {
      store: this.deps.store,
      media: this.deps.media,
      registry: this.deps.registry,
      bus,
      logger,
      ...(this.deps.separation ? { separation: this.deps.separation } : {}),
      ...(this.deps.alignment ? { alignment: this.deps.alignment } : {}),
      ...(this.deps.diarization ? { diarization: this.deps.diarization } : {}),
      ...(this.deps.ocr ? { ocr: this.deps.ocr } : {}),
      ...(this.deps.speechMap ? { speechMap: this.deps.speechMap } : {}),
      // How fast each voice really speaks, measured from its clips and kept
      // between runs, so the next translation budgets lines at the voice's pace.
      voiceRates: voiceRateBookFor(this.deps.config.configDir),
      ...(this.deps.brandKit ? { brandKit: this.deps.brandKit } : {}),
      ...(this.deps.warningInbox ? { warningInbox: this.deps.warningInbox } : {}),
      ...(this.deps.watermark ? { watermark: this.deps.watermark } : {}),
    };
    return { runner: new PipelineRunner(deps), bus, logger };
  }

  // ----- JobOrchestrator contract ------------------------------------------

  /**
   * A change asked of a project while its dub runs: taken when it only
   * touches the mix and the render (series/partWork.ts MIX_AND_RENDER_KEYS)
   * and nothing has used those yet: a series parent (its run only transcribes;
   * its parts are made from its settings afterwards), or a run that has not
   * started mixing (the mix and the render read the settings when they start).
   * claude-dubber asked for it (2026-11-25): the watermark boxes it found while
   * a 30-hour series was being transcribed were refused for hours.
   */
  private async takesMixChangeWhileRunning(projectId: string, patch: Partial<ProjectSettings>): Promise<boolean> {
    if (!changesOnlyMixAndRender(patch)) return false;
    const project = await this.deps.store.getProject(projectId).catch(() => undefined);
    if (project?.series?.role === 'parent') return true;
    const pipeline = await this.deps.store.getPipeline(projectId).catch(() => undefined);
    const status = (id: PipelineStepId) => pipeline?.steps.find((s) => s.id === id)?.status;
    // The subtitle files are written at the alignment: what shapes them must come before it.
    const shapesSubtitles = (Object.keys(patch) as (keyof ProjectSettings)[]).some((k) => patch[k] !== undefined && SUBTITLE_FILE_KEYS.has(k));
    if (shapesSubtitles && status('alignment') !== 'pending') return false;
    // Not started mixing in this run: a mix done in an earlier run (a redo of the render) would not take it.
    return status('audio-mix') === 'pending' && status('render') === 'pending';
  }

  /** Create a project workspace and persist its initial state. */
  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.deps.store.createProject(input);
  }

  /**
   * The projects something is working on now: dubbing (a render from Export
   * is a run too), waiting in the queue, moving their finished files, or an editor action
   * (re-voicing a line, separating a voice). Deleting or moving a project
   * under any of them would pull its files from under the work.
   */
  busyProjects(): string[] {
    const editing = [...this.laneRefs.keys()].filter((owner) => owner.startsWith('editor:')).map((owner) => owner.slice('editor:'.length));
    const detecting = [...this.speakerJobs].filter(([, j]) => j.state === 'running').map(([id]) => id);
    return [...new Set([...this.running.keys(), ...this.queued, ...this.movingOutput, ...editing, ...detecting, ...this.lineJobs.keys()])];
  }

  /**
   * What works on a project now, the most binding first ({@link busyProjects}
   * with its reason): a series part that only waits in the queue is rebuilt
   * or renamed where it waits and keeps its turn (series/seriesService.ts);
   * anything else working on it leaves it alone.
   */
  workOn(projectId: string): 'running' | 'moving' | 'editing' | 'detecting' | 'queued' | undefined {
    if (this.running.has(projectId)) return 'running';
    if (this.movingOutput.has(projectId)) return 'moving';
    if (this.laneRefs.has(`editor:${projectId}`)) return 'editing';
    if (this.speakerJobs.get(projectId)?.state === 'running') return 'detecting';
    if (this.queued.has(projectId)) return 'queued';
    return undefined;
  }

  /**
   * Run `fn` while nothing queued starts, then let the queue go on. A part
   * changed where it waits (its transcript rebuilt, its name and files
   * changed) must not start half-changed, and taking it out of the queue to
   * change it lost its turn: the agent of the 27.8-hour series paused all 48
   * parts to rebuild two. Only seconds of file writes, never a run.
   */
  async whileQueueHeld<T>(fn: () => Promise<T>): Promise<T> {
    this.queueHolds += 1;
    try {
      return await fn();
    } finally {
      this.queueHolds -= 1;
      if (this.queueHolds === 0) void this.pump();
    }
  }

  /**
   * Delete a project from the list (ProjectStore.deleteProject: its folder,
   * and its finished files only when they are in it). Refused while anything
   * works on it: pause the dub, or wait for the editor action, first.
   */
  async deleteProject(projectId: string): Promise<void> {
    if (this.busyProjects().includes(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'This project is dubbing, waiting in the queue, or busy in the editor.', {
        remediation: 'Pause it (or wait for it to finish), then delete it.',
      });
    }
    await this.deps.store.deleteProject(projectId);
    this.workloads.delete(projectId);
  }

  /**
   * New project after Back: give the project its Continue created the form as
   * it is now (ProjectStore.reviseProject). Continue used to create another
   * project every time, so fixing one choice after Start refused it left a
   * duplicate in the list. Only a project that has never run: its work would
   * not match the new choices, and the editor is where a started one changes.
   */
  async reviseProject(projectId: string, input: ReviseProjectInput): Promise<Project> {
    this.assertOutputIdle(projectId);
    const [project, pipeline] = await Promise.all([
      this.deps.store.getProject(projectId),
      this.deps.store.getPipeline(projectId),
    ]);
    if (!neverRun(project, pipeline)) {
      throw new AppErrorException('INVALID_EDIT', `"${project.name}" has already started dubbing, so New project can no longer change it.`, {
        remediation: 'Open it from Projects and change its settings in the editor, or create a new project.',
      });
    }
    // Again after the awaits: nothing may start it while it changes.
    this.assertOutputIdle(projectId);
    return this.deps.store.reviseProject(project, input);
  }

  /**
   * Start the pipeline for a project asynchronously (resumable). Returns once
   * the run is scheduled; progress is observed via SSE. Idempotent guard: a
   * second call while a run is active is a no-op.
   */
  async runPipeline(projectId: string): Promise<RunScheduleResult> {
    this.assertNotMoving(projectId);
    if (this.speakerJobs.get(projectId)?.state === 'running') {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Speakers are being detected in this project: start the dub when that is done.');
    }
    if (this.lineJobs.has(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'A range of this project is being transcribed again: start the dub when that is done.');
    }
    if (this.running.has(projectId)) return { started: true, queued: false };
    if (this.queued.has(projectId)) return { started: false, queued: true, position: this.queuePosition(projectId) };
    const project = await this.deps.store.getProject(projectId);
    // Gate the run: refuse to start (with an actionable error) if a selected
    // provider isn't ready, so the run never dies deep in a step. Done at
    // ENQUEUE time (not only at dispatch) so the user gets the actionable error
    // while they are standing there, exactly as before queueing existed.
    if (this.deps.checkReadiness) assertRunReady(await this.deps.checkReadiness(project));
    // Re-check after the await(s): a concurrent run() request may have started
    // one while we were loading/validating. startRun() registers the job
    // synchronously (no await before this.running.set), so this guard is safe.
    if (this.running.has(projectId)) return { started: true, queued: false };
    return this.scheduleRun(project, undefined);
  }

  /**
   * Pause a dub: stop it at once and keep everything it has done, so it can
   * continue later — also after VideoDubber is closed or the computer turned
   * off. The runner saves it as `paused` at its step (finished steps and the
   * step's own saved work are reused; runner.ts). Resolves once that is on
   * disk. A QUEUED project just leaves the queue, its previous status restored.
   */
  async pauseJob(jobId: string): Promise<void> {
    if (this.queued.has(jobId)) {
      await this.dequeue(jobId);
      return;
    }
    const job = this.running.get(jobId);
    if (!job) {
      // Nothing runs it, yet it may still read "running" (the app died mid-run
      // and has not restarted since): Pause settles it.
      const project = await this.deps.store.getProject(jobId).catch(() => undefined);
      if (project) await this.settleStaleRun(project);
      return;
    }
    job.controller.abort(new AppErrorException('CANCELLED', 'Paused by the user.'));
    try {
      await job.promise;
    } catch {
      /* the run handles its own errors */
    }
  }

  /** Stopping a dub is pausing it: nothing done is thrown away (POST /cancel, the MCP cancel_dubbing). */
  async cancelJob(jobId: string): Promise<void> {
    await this.pauseJob(jobId);
  }

  /**
   * The app is closing: pause every running dub, so each saves its progress
   * and continues at the next start (POST /shutdown, SIGTERM). Bounded, and
   * the shell gives the whole stop 8 s: a step that does not answer its
   * signal in time is left as it is, and the next start finds it "running"
   * with nothing running and marks it paused too (reconcileQueue).
   */
  async pauseAll(timeoutMs = 4000): Promise<void> {
    this.closing = true;
    this.stopScheduler();
    const jobs = [...this.running.values()];
    if (jobs.length === 0) return;
    for (const job of jobs) job.controller.abort(new AppErrorException('CANCELLED', 'Paused: VideoDubber is closing.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(jobs.map((j) => j.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Reset a step + downstream and re-run from there (resumable retry). */
  async retryStep(projectId: string, stepId: PipelineStepId): Promise<RunScheduleResult> {
    this.assertNotMoving(projectId);
    if (this.running.has(projectId)) {
      // Cancel the current run before retrying to avoid overlap.
      await this.cancelJob(projectId);
    }
    // A QUEUED project must leave the queue before being re-scheduled: without
    // this it would be enqueued twice (and its `previousStatus` poisoned to
    // 'queued', so cancelling could never restore a real status).
    if (this.queued.has(projectId)) await this.dequeue(projectId);
    const project = await this.deps.store.getProject(projectId);
    // Gate the retry too — but only on the providers whose phases will actually
    // re-run from `stepId` (a retry-from-render isn't blocked by the translator).
    if (this.deps.checkReadiness) assertRunReady(await this.deps.checkReadiness(project, stepId));
    return this.scheduleRun(project, stepId);
  }

  /**
   * Update a whitelisted subset of a project's settings after creation, then
   * persist. This is the engine behind the editor's "change an engine / model /
   * voice and re-dub from that stage" flow: the caller updates settings here,
   * then calls {@link retryStep} from the appropriate step so earlier stages are
   * reused. Refuses while a run is active (cancel first) so we never mutate the
   * config out from under an in-flight pipeline. Returns the updated project +
   * pipeline so the UI can re-render its summary.
   */
  async updateProjectSettings(
    projectId: string,
    patch: Partial<ProjectSettings>,
    /**
     * `whileQueued`: a series part waiting in the queue may take a change that
     * only touches its mix and render (series/partWork.ts MIX_AND_RENDER_KEYS),
     * which the queue's classification never reads. The caller holds the queue
     * ({@link whileQueueHeld}) so the part cannot start half-changed.
     */
    opts: { whileQueued?: boolean } = {},
  ): Promise<{ project: Project; pipeline: PipelineState }> {
    if (this.running.has(projectId) && !(await this.takesMixChangeWhileRunning(projectId, patch))) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        'Cannot change settings while the pipeline is running. Cancel the run first.',
        {
          remediation:
            'Only what changes the mix and the render (the picture boxes, the watermark blur, logo and greeting, subtitles, levels, render quality) can change while a dub runs, and only until it starts mixing. Pause the dub (it keeps its work), change the setting, then continue.',
        },
      );
    }
    // Queued runs are frozen too: the scheduler classified this project's cost
    // (heavy engine? cloud-only?) at enqueue time, and letting the settings
    // change underneath would make that classification — and therefore the
    // queue's ordering decisions — silently wrong.
    if (this.queued.has(projectId) && !(opts.whileQueued === true && changesOnlyMixAndRender(patch))) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        'This project is waiting in the dubbing queue. Cancel it to change settings.',
      );
    }
    const project = await this.deps.store.getProject(projectId);
    const next: ProjectSettings = { ...project.settings };
    // Apply only the known-safe keys (ignore anything else a client might send).
    for (const key of EDITABLE_SETTING_KEYS) {
      const value = patch[key];
      if (value !== undefined) {
        (next as unknown as Record<string, unknown>)[key] = value;
      }
    }
    // The burned-in subtitle style is an object, so it is checked field by field
    // (position + the band that hides a source's own hardsubs; see SubtitleStyle).
    // Validate the patch BEFORE merging, so a bad value cannot erase a good one.
    if (patch.burnSubtitleStyle !== undefined) {
      const style = withoutClearedCoverFields(
        sanitizeSubtitleStyle({ ...next.burnSubtitleStyle, ...sanitizeSubtitleStyle(patch.burnSubtitleStyle) }),
        patch.burnSubtitleStyle,
      );
      if (style) next.burnSubtitleStyle = style;
      else delete next.burnSubtitleStyle;
    }
    // Watermarks hidden in the render, checked box by box; [] or null clears them.
    if (patch.blurRegions !== undefined) {
      const regions = sanitizeBlurRegions(patch.blurRegions);
      if (regions) next.blurRegions = regions;
      else {
        delete next.blurRegions;
        // Cleared on purpose: the automatic blur would only find the same
        // mark again at the next render and bring the box back.
        if (patch.watermarkAuto === undefined) delete next.watermarkAuto;
      }
    }
    // Find the watermark and hide it (picture/watermarkAuto.ts); null or false turns it off.
    if (patch.watermarkAuto !== undefined) {
      const auto = sanitizeWatermarkAuto(patch.watermarkAuto);
      if (auto) next.watermarkAuto = auto;
      else delete next.watermarkAuto;
    }
    // Logo and greeting: checked field by field; null or {} turns both off.
    if (patch.branding !== undefined) {
      const branding = sanitizeBranding(patch.branding);
      if (branding) next.branding = branding;
      else delete next.branding;
    }
    // A known speaker count: a whole number of people, or nothing (automatic).
    if (patch.diarizeSpeakers !== undefined) {
      const n = Number(patch.diarizeSpeakers);
      if (Number.isInteger(n) && n >= 2 && n <= 20) next.diarizeSpeakers = n;
      else delete next.diarizeSpeakers;
    }
    // Speaker voices replace the table whole (an empty list clears it). The
    // lines whose voice that moves are marked for re-voicing, as a voice picked
    // for one line is, so the editor re-voices exactly those instead of asking
    // for the whole dub again.
    if (patch.speakerVoices !== undefined) {
      const voices = sanitizeSpeakerVoices(patch.speakerVoices);
      if (voices) next.speakerVoices = voices;
      else delete next.speakerVoices;
    }
    // Default voices per gender, and the genders they follow (cast_voices).
    if (patch.speakerGenders !== undefined) {
      const genders = sanitizeSpeakerGenders(patch.speakerGenders);
      if (genders) next.speakerGenders = genders;
      else delete next.speakerGenders;
    }
    for (const key of ['defaultMaleVoiceId', 'defaultFemaleVoiceId'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value === 'string' && value.trim() && value.length <= 200) next[key] = value.trim();
      else delete next[key];
    }
    // Voices the minor speakers share per gender (voices/casting.ts): 1..12,
    // anything else is automatic again; subtitles for song lines: on or off.
    if (patch.minorVoices !== undefined) {
      const n = Number(patch.minorVoices);
      if (Number.isInteger(n) && n >= 1 && n <= MAX_MINOR_VOICES) next.minorVoices = n;
      else delete next.minorVoices;
    }
    if (patch.songSubtitles !== undefined) {
      if (patch.songSubtitles === true) next.songSubtitles = true;
      else delete next.songSubtitles;
    }
    // A voice kept for one main character (voices/mainOnly.ts): never a
    // default, never on two speakers. Checked only when those change, so an
    // unrelated edit never trips over a table made before the voice was kept.
    const voicesChanged = patch.speakerVoices !== undefined;
    const defaultsChanged = patch.defaultMaleVoiceId !== undefined || patch.defaultFemaleVoiceId !== undefined;
    if ((voicesChanged || defaultsChanged) && this.deps.mainOnlyVoices) {
      assertMainOnly(next, { speakerVoices: voicesChanged, defaults: defaultsChanged }, await this.deps.mainOnlyVoices(projectId));
    }
    if (
      patch.speakerVoices !== undefined ||
      patch.speakerGenders !== undefined ||
      patch.defaultMaleVoiceId !== undefined ||
      patch.defaultFemaleVoiceId !== undefined
    ) {
      await this.markLinesWhoseVoiceMoved(projectId, project.settings, next);
    }
    const saved = await this.deps.store.saveProject({
      ...project,
      settings: next,
      updatedAt: new Date().toISOString(),
    });
    // The subtitle files follow the song setting at once (displayCuesFor reads
    // it), so "Render again" draws what was chosen without a new alignment.
    if ((next.songSubtitles === true) !== (project.settings.songSubtitles === true)) await this.rewriteSubtitleFiles(projectId);
    const pipeline = await this.deps.store.getPipeline(projectId);
    return { project: saved, pipeline };
  }

  /**
   * Detect who says each line again, on the lines as they are: no new
   * transcript, no timing change (lines are only labelled), translations
   * kept. A JOB: it returns at once and runs in the background (hours of
   * audio take an hour or more: 10-minute parts, resumable), followed with
   * {@link speakerJob} (GET /projects/:id/speakers, the editor, get_speakers).
   * Each line's own voice is kept; voices chosen per speaker follow their
   * people to the new ids (matched by voice print); the speakers' genders are
   * recorded for the default voices; lines whose voice moves are marked for
   * re-voicing. Throws ENGINE_PACK_MISSING without the engine.
   *
   * With `fromMs`/`toMs`, only the lines in that range are labelled again,
   * linked to the project's known speakers by voice print (after a
   * re-transcription left them without one): see redetectSpeakersInRange.
   * The job reports in the activity list (`speakers.detect`) and is saved in
   * the project's folder as it goes, so a restart shows it interrupted.
   */
  async startSpeakerDetection(
    projectId: string,
    opts: { numSpeakers?: number; fromMs?: number; toMs?: number } = {},
  ): Promise<{ started: boolean; running?: boolean }> {
    this.assertNotRunning(projectId, 'detect speakers');
    if (this.queued.has(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'This project is waiting in the dubbing queue: take it out of the queue first.');
    }
    if (this.speakerJobs.get(projectId)?.state === 'running') return { started: false, running: true };
    if (this.lineJobs.has(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'A range of this project is being transcribed again: detect speakers when that is done.');
    }
    const range = detectionRange(opts);
    await this.deps.store.getProject(projectId);
    const service = this.deps.diarization;
    if (!service || !(await service.available().catch(() => false))) {
      throw new AppErrorException('ENGINE_PACK_MISSING', 'Speaker detection is not installed.', {
        remediation: 'Install "Speaker detection" in Settings → Engines (about 135 MB), then try again.',
      });
    }
    const paths = this.deps.store.paths(projectId);
    if (!(await this.tryReadSegments(paths.sourceJson))) {
      throw new AppErrorException('INVALID_EDIT', 'This project has no transcript yet: speakers are detected over its lines.');
    }
    const n = Number(opts.numSpeakers);
    const numSpeakers = Number.isInteger(n) && n >= 2 && n <= 50 ? n : undefined;
    const job: SpeakerJob = {
      state: 'running',
      done: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
      ...(range ? { range } : {}),
      ...(numSpeakers ? { numSpeakers } : {}),
    };
    const handle = activity.start({
      kind: 'speakers.detect',
      title: range
        ? said(`Detecting speakers at ${formatClock(range.fromMs)}–${formatClock(range.toMs)}`, 'activity.text.speakers-range', {
            from: formatClock(range.fromMs),
            to: formatClock(range.toMs),
          })
        : said('Detecting speakers', 'activity.text.speakers'),
      projectId,
    });
    job.activityId = handle.id;
    this.speakerJobs.set(projectId, job);
    const save = this.speakerJobSaver(speakerJobFile(paths), job);
    save();
    const onProgress = (done: number, total: number): void => {
      job.done = done;
      job.total = total;
      const percent = total > 0 ? (done / total) * 100 : null;
      handle.progress(
        percent,
        total > 1 ? said(`Part ${done}/${total}`, 'activity.text.part-of', { done, total }) : undefined,
        percent === null ? undefined : etaSeconds(job.startedAt, percent),
      );
      save();
    };
    const work = range
      ? this.runRangedSpeakerDetection(projectId, range, numSpeakers, job, onProgress)
      : this.runSpeakerDetection(projectId, numSpeakers, job, onProgress);
    void work
      .then((outcome) => {
        Object.assign(job, { state: 'done', finishedAt: new Date().toISOString(), ...outcome });
        handle.done({ text: speakerJobSummary(job), phrase: speakerJobPhrase(job) });
        save();
      })
      .catch((err: unknown) => {
        Object.assign(job, { state: 'failed', finishedAt: new Date().toISOString(), error: toAppError(err).message });
        handle.fail(err);
        save();
        this.deps.bus.get(projectId).emit({ type: 'log', level: 'warn', message: `Speaker detection failed: ${toAppError(err).message}`, ts: new Date().toISOString() });
      });
    return { started: true };
  }

  /** Where a speaker detection job is (undefined: none since the app started; speakerJobState also reads the saved one). */
  speakerJob(projectId: string): Omit<SpeakerJob, 'abort'> | undefined {
    const job = this.speakerJobs.get(projectId);
    if (!job) return undefined;
    const { abort: _abort, ...rest } = job;
    return rest;
  }

  /**
   * Where a project's speaker detection job is: this process's, else the one
   * saved in the project's folder, which says `interrupted` when the app died
   * while it ran (Retry resumes from the parts already saved).
   */
  async speakerJobState(projectId: string): Promise<SpeakerJobView | undefined> {
    const live = this.speakerJob(projectId);
    if (live) return speakerJobView(live, true);
    const paths = this.deps.store.paths(projectId);
    const saved = await readSpeakerJob(speakerJobFile(paths));
    if (!saved) return undefined;
    // One that failed or was cut off, then a detection that finished after it
    // (a dub's own, in its STT step): "try again" is no longer true.
    if (saved.state !== 'done') {
      const detectedAt = await fsp.stat(paths.diarizationJson).then((s) => s.mtimeMs, () => 0);
      if (detectedAt > Date.parse(saved.finishedAt ?? saved.startedAt)) return undefined;
    }
    return speakerJobView(saved, false);
  }

  /** Save a detection job's state as it changes: one write at a time, in order. */
  private speakerJobSaver(file: string, job: SpeakerJob): () => void {
    let chain: Promise<void> = Promise.resolve();
    return () => {
      const { abort: _abort, ...state } = job;
      const snapshot: SpeakerJobState = { ...state };
      chain = chain.then(() => saveSpeakerJob(file, snapshot));
    };
  }

  private async runSpeakerDetection(
    projectId: string,
    numSpeakers: number | undefined,
    job: SpeakerJob,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ speakers: number; lowConfidence: number; remapped: number }> {
    const service = this.deps.diarization!;
    const paths = this.deps.store.paths(projectId);
    const source = (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const found = await redetectSpeakers({
      service,
      audioPath: paths.original16kMonoWav,
      cachePath: paths.diarizationJson,
      checkpointDir: paths.diarizationChunksDir,
      segments: source,
      ...(numSpeakers ? { numSpeakers } : {}),
      onProgress,
      signal: job.abort.signal,
    });
    if (!found) throw new AppErrorException('ENGINE_PACK_MISSING', 'Speaker detection is not installed.');
    const project = await this.deps.store.getProject(projectId);
    const genders: Record<string, 'female' | 'male'> = {};
    for (const sp of found.speakers) if (sp.gender === 'male' || sp.gender === 'female') genders[sp.speakerId] = sp.gender;
    // Voices follow their people to the new ids. A voice set for an id no
    // line carried yet (set ahead over MCP) stays on that id.
    const remapped = remapSpeakerVoices(project.settings.speakerVoices, found.remap);
    const hadLines = new Set(source.map((l) => l.speakerId).filter(Boolean));
    const ahead = (project.settings.speakerVoices ?? []).filter(
      (v) => !hadLines.has(v.speakerId) && !(v.speakerId in found.remap) && !remapped.some((r) => r.speakerId === v.speakerId),
    );
    const voices = [...remapped, ...ahead].sort((x, y) => x.speakerId.localeCompare(y.speakerId));
    const { speakerGenders: _g, speakerVoices: _v, diarizeSpeakers: _n, ...rest } = project.settings;
    const settings: ProjectSettings = {
      ...rest,
      diarize: true,
      ...(numSpeakers ? { diarizeSpeakers: numSpeakers } : {}),
      ...(voices.length > 0 ? { speakerVoices: voices } : {}),
      ...(Object.keys(genders).length > 0 ? { speakerGenders: genders } : {}),
    };
    await this.artifactLock.run(projectId, async () => {
      await writeJsonAtomic(paths.sourceJson, { segments: found.segments });
      await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(found.segments, { songSubtitles: await songSubtitlesOn(paths.projectJson) })));
      const translated = await this.tryReadSegments(paths.translatedJson);
      let after: TranscriptSegment[] = found.segments;
      if (translated) {
        const voiced = (await this.deps.store.getPipeline(projectId)).steps.find((s) => s.id === 'tts')?.status === 'completed';
        const relabelled = copySpeakerLabels(translated, found.segments);
        after = relabelled.map((s, i) =>
          voiced && voiceForLine(s, settings) !== voiceForLine(translated[i]!, project.settings) ? { ...s, ttsStale: true } : s,
        );
        await writeJsonAtomic(paths.translatedJson, { segments: after });
      }
      // The lines the dub uses: the translated ones once they exist.
      const before = translated ?? source;
      const changedSpeaker = after.filter((s, i) => s.speakerId !== before[i]?.speakerId).length;
      await recordEdit({
        projectId,
        target: translated ? 'translation' : 'source',
        summary: `Detected speakers again: ${found.speakers.length} speaker(s), ${changedSpeaker} line(s) changed speaker`,
        summaryKey: 'history.summary.speakers-redetected',
        summaryParams: { speakers: found.speakers.length, lines: changedSpeaker },
        before,
        after,
      });
    });
    await this.deps.store.saveProject({ ...(await this.deps.store.getProject(projectId)), settings, updatedAt: new Date().toISOString() });
    await this.refreshWarnings(projectId);
    return { speakers: found.speakers.length, lowConfidence: found.lowConfidence, remapped: Object.keys(found.remap).length };
  }

  /**
   * Speakers again over one range, linked to the project's known speakers
   * (pipeline/diarization.ts redetectSpeakersInRange): only the lines in the
   * range change, known speakers keep their ids and so their voices, a voice
   * heard for the first time gets a new id and a gender for the default
   * voices. The labels are put on the lines as they are when it ends, by id:
   * an edit made meanwhile in the editor is kept.
   */
  private async runRangedSpeakerDetection(
    projectId: string,
    range: TimeRange,
    numSpeakers: number | undefined,
    job: SpeakerJob,
    onProgress: (done: number, total: number) => void,
  ): Promise<Partial<SpeakerJobState>> {
    const service = this.deps.diarization!;
    const paths = this.deps.store.paths(projectId);
    const source = (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const found = await redetectSpeakersInRange({
      service,
      audioPath: paths.original16kMonoWav,
      cachePath: paths.diarizationJson,
      checkpointDir: paths.diarizationChunksDir,
      segments: source,
      fromMs: range.fromMs,
      toMs: range.toMs,
      ...(numSpeakers ? { numSpeakers } : {}),
      onProgress,
      signal: job.abort.signal,
    });
    if (!found) throw new AppErrorException('ENGINE_PACK_MISSING', 'Speaker detection is not installed.');
    const inRange = (s: { startMs: number; endMs: number }): boolean => s.startMs < range.toMs && s.endMs > range.fromMs;
    const labels = found.segments.filter(inRange);
    const project = await this.deps.store.getProject(projectId);
    const genders: Record<string, 'female' | 'male'> = { ...(project.settings.speakerGenders ?? {}) };
    for (const sp of found.added) if ((sp.gender === 'male' || sp.gender === 'female') && !genders[sp.speakerId]) genders[sp.speakerId] = sp.gender;
    const settings: ProjectSettings = {
      ...project.settings,
      diarize: true,
      ...(Object.keys(genders).length > 0 ? { speakerGenders: genders } : {}),
    };
    await this.artifactLock.run(projectId, async () => {
      const current = (await this.tryReadSegments(paths.sourceJson)) ?? [];
      const relabelledSource = copySpeakerLabels(current, labels);
      await writeJsonAtomic(paths.sourceJson, { segments: relabelledSource });
      await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(relabelledSource, { songSubtitles: await songSubtitlesOn(paths.projectJson) })));
      const translated = await this.tryReadSegments(paths.translatedJson);
      let after: TranscriptSegment[] = relabelledSource;
      if (translated) {
        const voiced = (await this.deps.store.getPipeline(projectId)).steps.find((s) => s.id === 'tts')?.status === 'completed';
        after = copySpeakerLabels(translated, labels).map((s, i) =>
          voiced && voiceForLine(s, settings) !== voiceForLine(translated[i]!, project.settings) ? { ...s, ttsStale: true } : s,
        );
        await writeJsonAtomic(paths.translatedJson, { segments: after });
      }
      await recordEdit({
        projectId,
        target: translated ? 'translation' : 'source',
        summary:
          `Detected speakers at ${formatClock(range.fromMs)}–${formatClock(range.toMs)}: ${found.relabelled} of ${found.lines} line(s) changed speaker` +
          (found.added.length ? `, ${found.added.length} new speaker(s)` : ''),
        summaryKey: found.added.length ? 'history.summary.speakers-range-added' : 'history.summary.speakers-range',
        summaryParams: {
          from: formatClock(range.fromMs),
          to: formatClock(range.toMs),
          relabelled: found.relabelled,
          lines: found.lines,
          added: found.added.length,
        },
        before: translated ?? current,
        after,
      });
    });
    await this.deps.store.saveProject({ ...(await this.deps.store.getProject(projectId)), settings, updatedAt: new Date().toISOString() });
    await this.refreshWarnings(projectId);
    return {
      speakers: found.speakers.length,
      lowConfidence: found.lowConfidence,
      relabelled: found.relabelled,
      added: found.added.length,
      detectedParts: found.detectedParts,
    };
  }

  /** Bring the project's transcript warnings up to date with its lines (pipeline/transcriptWarnings.ts). */
  private async refreshWarnings(
    projectId: string,
    opts: { rewritten?: { fromMs: number; toMs: number } | readonly { fromMs: number; toMs: number }[] } = {},
  ): Promise<void> {
    await refreshTranscriptWarnings(
      {
        store: this.deps.store,
        isRunning: (id) => this.running.has(id),
        emit: (id, pipeline) => this.deps.bus.get(id).emit({ type: 'state', pipeline }),
      },
      projectId,
      opts,
    );
  }

  /**
   * Set warnings aside (POST /projects/:id/warnings/dismiss): those with these
   * codes, or all of them. Kept in `dismissedWarnings` with when; a step that
   * runs again and finds the same raises it again. Not while the dub runs (its
   * run writes the warnings).
   */
  async dismissWarnings(projectId: string, codes?: readonly string[]): Promise<{ dismissed: ProjectWarning[]; pipeline: PipelineState }> {
    this.assertNotRunning(projectId, 'dismiss its warnings');
    const pipeline = await this.deps.store.getPipeline(projectId);
    const all = pipeline.warnings ?? [];
    const pick = (w: ProjectWarning): boolean => !codes || codes.length === 0 || codes.includes(w.code);
    const dismissed = all.filter(pick);
    if (dismissed.length === 0) return { dismissed, pipeline };
    const now = new Date().toISOString();
    const kept = all.filter((w) => !pick(w));
    const { warnings: _w, ...rest } = pipeline;
    const saved: PipelineState = {
      ...rest,
      ...(kept.length > 0 ? { warnings: kept } : {}),
      dismissedWarnings: [...(pipeline.dismissedWarnings ?? []), ...dismissed.map((w) => ({ ...w, dismissedAt: now }))].slice(-100),
    };
    await this.deps.store.savePipeline(saved);
    this.deps.bus.get(projectId).emit({ type: 'state', pipeline: saved });
    return { dismissed, pipeline: saved };
  }

  /**
   * Detect the speakers again and wait for it (the editor's old flow, kept
   * for callers that need the relabelled timeline back).
   */
  async redetectSpeakers(projectId: string, opts: { numSpeakers?: number; fromMs?: number; toMs?: number } = {}): Promise<TimelineDocument> {
    const started = await this.startSpeakerDetection(projectId, opts);
    const job = this.speakerJobs.get(projectId);
    if (!started.started && !job) throw new AppErrorException('UNKNOWN', 'Speaker detection did not start.');
    while (this.speakerJobs.get(projectId)?.state === 'running') await new Promise((r) => setTimeout(r, 200));
    const done = this.speakerJobs.get(projectId);
    if (done?.state === 'failed') throw new AppErrorException('UNKNOWN', `Speaker detection failed: ${done.error ?? 'unknown error'}`);
    return this.getTimeline(projectId);
  }

  /**
   * Mark the lines a settings change gives another voice as needing
   * re-voicing. Only once the dub has voices: before that every line is
   * spoken fresh anyway. Marked BEFORE the settings are saved: a failed save
   * then leaves extra lines to re-voice (in the same voice, harmless), never a
   * changed voice with nothing marked.
   */
  private async markLinesWhoseVoiceMoved(projectId: string, before: ProjectSettings, after: ProjectSettings): Promise<void> {
    const pipeline = await this.deps.store.getPipeline(projectId);
    if (pipeline.steps.find((s) => s.id === 'tts')?.status !== 'completed') return;
    await this.artifactLock.run(projectId, async () => {
      const paths = this.deps.store.paths(projectId);
      const translated = await this.tryReadSegments(paths.translatedJson);
      if (!translated) return;
      let moved = 0;
      const segments = translated.map((s) => {
        if (s.ttsStale || voiceForLine(s, before) === voiceForLine(s, after)) return s;
        moved++;
        return { ...s, ttsStale: true };
      });
      if (moved > 0) await writeJsonAtomic(paths.translatedJson, { segments });
    });
  }

  // ----- Extra API methods -------------------------------------------------

  /**
   * Load a project together with its pipeline state and, while it dubs, the
   * time left as the run's own pace says (activity/dubRuns.ts, the estimate
   * GET /queue shows). WHY the server's estimate: get_project worked it out
   * from the first step's start, which a render redo keeps from the dub days
   * earlier: "running, 89%, at render, about 2 h 25 min left" for a render of
   * minutes (claude-dubber, 2026-11-25).
   */
  async getProjectWithPipeline(projectId: string): Promise<{ project: Project; pipeline: PipelineState; etaSec?: number }> {
    const project = await this.deps.store.getProject(projectId);
    const pipeline = await this.deps.store.getPipeline(projectId);
    const etaSec = pipeline.status === 'running' ? dubRuns.etaOf(projectId) : undefined;
    return { project, pipeline, ...(etaSec !== undefined ? { etaSec } : {}) };
  }

  /** List all projects (most recently updated first). */
  async listProjects(): Promise<Project[]> {
    return this.deps.store.listProjects();
  }

  /**
   * Probe the project's input media, persist the resulting {@link MediaInfo}
   * on the project, and return it. Surfaces NO_AUDIO_STREAM.
   */
  async probe(projectId: string): Promise<MediaInfo> {
    const project = await this.deps.store.getProject(projectId);
    const probed = await this.deps.media.probe(project.inputVideoPath);
    if (!probed.hasAudio || probed.audioStreams.length === 0) {
      throw new AppErrorException('NO_AUDIO_STREAM', 'The input video has no audio stream to dub.');
    }
    const info = rangedMediaInfo(probed, project.sourceRange);
    await this.deps.store.saveProject({ ...project, mediaInfo: info });
    return info;
  }

  /**
   * Replace the source lines of several ranges at once (POST
   * /projects/:id/lines/replace-many, replace_lines with `ranges` or a file):
   * one write and ONE history entry over the stretch from the first range's
   * start to the last one's end, undone as one. claude-dubber's repair of
   * 《反相之地》 was 119 ranges and ~1,100 line edits through a script, one
   * call and one history entry per range (2026-11-25). Same rules as
   * {@link replaceSourceLines}: before translation, each range's lines inside
   * it, no overlaps; the ranges themselves may not overlap.
   */
  async replaceSourceRanges(
    projectId: string,
    ranges: readonly {
      fromMs: number;
      toMs: number;
      lines: readonly { startMs: number; endMs: number; text: string; speakerId?: string }[];
    }[],
  ): Promise<{
    replaced: number;
    made: number;
    ranges: { fromMs: number; toMs: number; replaced: number; lines: { id: string; startMs: number; endMs: number; text: string; speakerId?: string }[] }[];
  }> {
    this.assertNotRunning(projectId, 'replace lines');
    if (this.speakerJobs.get(projectId)?.state === 'running') {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Speakers are being detected in this project: change its lines when that is done.');
    }
    if (ranges.length === 0) throw new AppErrorException('INVALID_EDIT', 'Give at least one range.');
    const sorted = [...ranges].map((r) => ({ ...r, fromMs: Math.round(r.fromMs), toMs: Math.round(r.toMs) })).sort((a, b) => a.fromMs - b.fromMs);
    for (const [i, r] of sorted.entries()) {
      if (!(r.toMs > r.fromMs)) throw new AppErrorException('INVALID_EDIT', `Range ${i + 1} must end after it starts.`);
      if (i > 0 && r.fromMs < sorted[i - 1]!.toMs) {
        throw new AppErrorException('INVALID_EDIT', `Ranges at ${formatClock(sorted[i - 1]!.fromMs)} and ${formatClock(r.fromMs)} overlap: give each stretch once.`);
      }
    }
    await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    if (await fileExistsNonEmpty(paths.translatedJson)) {
      throw new AppErrorException('INVALID_EDIT', 'This project is already translated: its lines can no longer be restructured.', {
        remediation: 'Replace lines before translation. In a series, fix the series (parent) transcript, then rebuild the parts not translated yet (rebuild_parts).',
      });
    }
    const fresh = sorted.map((r) => {
      const lines = r.lines
        .map((l) => ({ startMs: Math.round(l.startMs), endMs: Math.round(l.endMs), text: String(l.text ?? '').trim(), speakerId: l.speakerId }))
        .filter((l) => l.text && l.endMs > l.startMs && l.startMs >= r.fromMs - 1 && l.endMs <= r.toMs + 1)
        .sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]!.startMs < lines[i - 1]!.endMs) {
          throw new AppErrorException('INVALID_EDIT', `In the range at ${formatClock(r.fromMs)}, lines ${i} and ${i + 1} overlap; each line must end before the next starts.`);
        }
      }
      return { ...r, lines };
    });
    return this.artifactLock.run(projectId, async () => {
      const current = (await this.tryReadSegments(paths.sourceJson)) ?? [];
      const inside = (s: TranscriptSegment, r: { fromMs: number; toMs: number }): boolean => s.startMs < r.toMs && s.endMs > r.fromMs;
      const made = fresh.map((r) =>
        r.lines.map(
          (l): TranscriptSegment => ({
            id: '',
            index: 0,
            startMs: l.startMs,
            endMs: l.endMs,
            sourceText: l.text,
            ...(l.speakerId && /^SPEAKER_\d+$/.test(l.speakerId) ? { speakerId: l.speakerId } : {}),
          }),
        ),
      );
      const kept = current.filter((s) => !fresh.some((r) => inside(s, r)));
      // Renumbered; each new line remembered by the range it was given for.
      const rangeOf = new Map<TranscriptSegment, number>();
      made.forEach((lines, k) => lines.forEach((l) => rangeOf.set(l, k)));
      const placed: { line: TranscriptSegment; range: number | undefined }[] = [];
      const all = [...kept, ...made.flat()]
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
        .map((s, i) => {
          const line = { ...s, index: i, id: `seg_${String(i + 1).padStart(4, '0')}` };
          placed.push({ line, range: rangeOf.get(s) });
          return line;
        });
      await writeJsonAtomic(paths.sourceJson, { segments: all });
      await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(all, { songSubtitles: await songSubtitlesOn(paths.projectJson) })));
      const span = { fromMs: fresh[0]!.fromMs, toMs: fresh[fresh.length - 1]!.toMs };
      const replaced = current.length - kept.length;
      const count = made.reduce((n, m) => n + m.length, 0);
      await recordEdit({
        projectId,
        target: 'source',
        range: span,
        summary: `Replaced ${replaced} line(s) with ${count} in ${fresh.length} range(s), ${formatClock(span.fromMs)}–${formatClock(span.toMs)}`,
        summaryKey: 'history.summary.replaced-many',
        summaryParams: { replaced, made: count, ranges: fresh.length, from: formatClock(span.fromMs), to: formatClock(span.toMs) },
        before: current.filter((s) => inside(s, span)),
        after: all.filter((s) => inside(s, span)),
      });
      await this.refreshWarnings(projectId, { rewritten: fresh.map((r) => ({ fromMs: r.fromMs, toMs: r.toMs })) });
      return {
        replaced,
        made: count,
        ranges: fresh.map((r, k) => ({
          fromMs: r.fromMs,
          toMs: r.toMs,
          replaced: current.filter((s) => inside(s, r)).length,
          lines: placed
            .filter((p) => p.range === k)
            .map(({ line: s }) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.sourceText, ...(s.speakerId ? { speakerId: s.speakerId } : {}) })),
        })),
      };
    });
  }

  /**
   * Read the project's transcript segments, merged with alignment status if
   * alignment has run. Prefers `translated.json`, falling back to `source.json`.
   */
  /**
   * Replace the source lines in [fromMs, toMs) with `lines` (a loop the app
   * could not repair, a range transcribed again): the line structure itself,
   * which no other edit changes. Only before translation: the translated
   * lines, their voices and their timing are keyed by these lines. Lines are
   * renumbered; returns the new lines of the range with their ids.
   */
  async replaceSourceLines(
    projectId: string,
    fromMs: number,
    toMs: number,
    lines: readonly { startMs: number; endMs: number; text: string; speakerId?: string; speakerLowConfidence?: boolean; loopSuspect?: boolean }[],
    /**
     * What the project's edit history says about it (activity/history.ts); a
     * default otherwise. An undo (activity/undo.ts) names the entry it undoes
     * and checks, inside the lock, that the lines are still as it expects.
     */
    opts: { summary?: string; summaryKey?: string; summaryParams?: Record<string, string | number>; undoOf?: string; precondition?: (current: readonly TranscriptSegment[]) => void } = {},
  ): Promise<{ replaced: number; lines: { id: string; startMs: number; endMs: number; text: string; speakerId?: string }[] }> {
    this.assertNotRunning(projectId, 'replace lines');
    // The detection writes every line's speaker when it ends: lines changed under it would be lost.
    if (this.speakerJobs.get(projectId)?.state === 'running') {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Speakers are being detected in this project: change its lines when that is done.');
    }
    if (!(toMs > fromMs)) throw new AppErrorException('INVALID_EDIT', 'The range must end after it starts.');
    // A project that exists, before anything is written: a mistyped id made
    // a stray <projects>/<id>/subtitles/source.json (found booting 0.17.0's
    // own build before release).
    await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    if (await fileExistsNonEmpty(paths.translatedJson)) {
      throw new AppErrorException('INVALID_EDIT', 'This project is already translated: its lines can no longer be restructured.', {
        remediation:
          'Replace lines before translation. In a series, fix the series (parent) transcript, then rebuild the parts not translated yet (rebuild_parts).',
      });
    }
    const fresh = lines
      .map((l) => ({
        startMs: Math.round(l.startMs),
        endMs: Math.round(l.endMs),
        text: String(l.text ?? '').trim(),
        speakerId: l.speakerId,
        // A re-transcription's marks: a carried best-guess speaker, a loop it could not check.
        guess: l.speakerLowConfidence === true,
        loop: l.loopSuspect === true,
      }))
      .filter((l) => l.text && l.endMs > l.startMs && l.startMs >= fromMs - 1 && l.endMs <= toMs + 1)
      .sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < fresh.length; i++) {
      if (fresh[i]!.startMs < fresh[i - 1]!.endMs) {
        throw new AppErrorException('INVALID_EDIT', `Lines ${i} and ${i + 1} overlap; each line must end before the next starts.`);
      }
    }
    return this.artifactLock.run(projectId, async () => {
      const current = (await this.tryReadSegments(paths.sourceJson)) ?? [];
      opts.precondition?.(current);
      const inside = (s: TranscriptSegment): boolean => s.startMs < toMs && s.endMs > fromMs;
      const before = current.filter((s) => !inside(s) && s.endMs <= fromMs);
      const after = current.filter((s) => !inside(s) && s.startMs >= toMs);
      const replaced = current.length - before.length - after.length;
      const made: TranscriptSegment[] = fresh.map((l) => ({
        id: '',
        index: 0,
        startMs: l.startMs,
        endMs: l.endMs,
        sourceText: l.text,
        ...(l.speakerId && /^SPEAKER_\d+$/.test(l.speakerId) ? { speakerId: l.speakerId, ...(l.guess ? { speakerLowConfidence: true as const } : {}) } : {}),
        ...(l.loop ? { loopSuspect: true as const } : {}),
      }));
      const all = [...before, ...made, ...after].map((s, i) => ({ ...s, index: i, id: `seg_${String(i + 1).padStart(4, '0')}` }));
      await writeJsonAtomic(paths.sourceJson, { segments: all });
      await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(all, { songSubtitles: await songSubtitlesOn(paths.projectJson) })));
      const first = before.length;
      // A structural change: every later line was renumbered, so the history
      // keeps the range's lines as they were and are (undo replaces the range).
      await recordEdit({
        projectId,
        target: 'source',
        range: { fromMs, toMs },
        summary: opts.summary ?? `Replaced ${replaced} line(s) with ${made.length} at ${formatClock(fromMs)}–${formatClock(toMs)}`,
        ...(opts.summary
          ? opts.summaryKey
            ? { summaryKey: opts.summaryKey, ...(opts.summaryParams ? { summaryParams: opts.summaryParams } : {}) }
            : {}
          : {
              summaryKey: 'history.summary.replaced',
              summaryParams: { replaced, made: made.length, from: formatClock(fromMs), to: formatClock(toMs) },
            }),
        before: current.filter(inside),
        after: all.slice(first, first + made.length),
        ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
      });
      // A loop left LOOP? may be gone now, or lines may have lost their
      // speaker; and the stretch's own warnings (lines over silence, a failed
      // spot check) are settled by its new lines.
      await this.refreshWarnings(projectId, { rewritten: { fromMs, toMs } });
      return {
        replaced,
        lines: all.slice(first, first + made.length).map((s) => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.sourceText,
          ...(s.speakerId ? { speakerId: s.speakerId } : {}),
        })),
      };
    });
  }

  /**
   * Transcribe [fromMs, toMs) of the project's audio again, by default
   * without the previous text (what repairs a loop), with the project's own
   * speech-to-text engine and model, through the STT step's loop pass
   * (pipeline/retranscribe.ts); `apply` replaces the range with it, a line
   * keeping a speaker only where its text still matches the old line under
   * it. The range grows to the whole lines across its edges. Up to 15
   * minutes it answers with the result, as it always did; a longer range is
   * one job in windows of up to 15 minutes, each applied as it is heard,
   * followed with {@link retranscribeJob} and the activity list
   * (`lines.retranscribe`). A translated project is refused before anything
   * is decoded.
   */
  async retranscribeRange(
    projectId: string,
    fromMs: number,
    toMs: number,
    opts: { noContext?: boolean; model?: string; apply?: boolean } = {},
  ): Promise<RetranscribeOutcome> {
    this.assertNotRunning(projectId, 'transcribe a range');
    if (!(fromMs >= 0) || !(toMs > fromMs)) {
      throw new AppErrorException('INVALID_EDIT', 'Give a range that starts at 0 or later and ends after it starts.');
    }
    if (this.lineJobs.has(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'A range of this project is already being transcribed again: wait for it to finish.');
    }
    if (this.speakerJobs.get(projectId)?.state === 'running') {
      throw new AppErrorException('RUN_IN_PROGRESS', 'Speakers are being detected in this project: transcribe a range when that is done.');
    }
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const clip = this.deps.media.clip16kMono?.bind(this.deps.media);
    if (!clip || !(await fileExistsNonEmpty(paths.original16kMonoWav))) {
      throw new AppErrorException('INVALID_EDIT', 'This project has no extracted audio yet: start_dubbing transcribes it first.');
    }
    const apply = opts.apply === true;
    // Before anything is decoded: the request used to decode for minutes and
    // only then be refused by replaceSourceLines.
    if (apply && (await fileExistsNonEmpty(paths.translatedJson))) {
      throw new AppErrorException('INVALID_EDIT', 'This project is already translated: its lines can no longer be restructured.', {
        remediation:
          'Transcribe a range again before translation (without apply it only shows what it hears). In a series, fix the series (parent) transcript, then rebuild the parts not translated yet (rebuild_parts).',
      });
    }
    const audioMs = project.mediaInfo?.durationMs;
    const end = audioMs && audioMs > 0 ? Math.min(toMs, audioMs) : toMs;
    if (!(end > fromMs)) throw new AppErrorException('INVALID_EDIT', 'The range starts after the end of the audio.');
    const asJob = end - fromMs > RETRANSCRIBE_WINDOW_MS;
    if (asJob && this.queued.has(projectId)) {
      throw new AppErrorException('RUN_IN_PROGRESS', 'This project is waiting in the dubbing queue: take it out of the queue first.');
    }
    const old = (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const range = widenToLines({ fromMs, toMs: end }, old);
    const windows = asJob ? planRetranscribeWindows(range, old) : [range];

    const stt = this.deps.registry.getStt(project.settings.sttProviderId);
    const language = project.settings.sourceLanguage ? toWhisperLanguage(project.settings.sourceLanguage) : undefined;
    const model = opts.model ?? project.settings.sttModel ?? 'small';
    const regions = await readSavedSpeechRegions(paths.original16kMonoWav, paths.speechRegionsJson);
    const hear: HearDeps = {
      decode: async (from, to, noContext, signal, decodeOpts = {}) => {
        await fsp.mkdir(paths.sttChunksDir, { recursive: true });
        const clipPath = path.join(paths.sttChunksDir, `range_${Math.round(from)}_${Math.round(to)}.wav`);
        try {
          await clip(paths.original16kMonoWav, clipPath, from, to, signal);
          const heard = await stt.transcribe(
            { audioPath: clipPath, language, model, wordTimestamps: true, noContext, ...(decodeOpts.listenToAll ? { vadFilter: false } : {}) },
            signal,
          );
          return heard.segments.map((s) => ({ ...s, startMs: s.startMs + from, endMs: s.endMs + from }));
        } finally {
          await fsp.rm(clipPath, { force: true }).catch(() => undefined);
        }
      },
      ...(regions ? { inSilence: silenceTest(regions) } : {}),
    };

    const startedAt = new Date().toISOString();
    const handle = activity.start({
      kind: 'lines.retranscribe',
      title: said(`Re-transcribing ${formatClock(range.fromMs)}–${formatClock(range.toMs)}`, 'activity.text.retranscribe', {
        from: formatClock(range.fromMs),
        to: formatClock(range.toMs),
      }),
      projectId,
      ...(asJob ? { message: said(`${windows.length} windows of up to 15 minutes`, 'activity.text.windows-planned', { n: windows.length }) } : {}),
    });
    const lineJob: LineJob = { kind: 'retranscribe', abort: new AbortController(), activityId: handle.id };
    this.lineJobs.set(projectId, lineJob);
    const view: RetranscribeJobView = {
      id: handle.id,
      projectId,
      state: 'running',
      fromMs: range.fromMs,
      toMs: range.toMs,
      apply,
      windows: windows.length,
      done: 0,
      startedAt,
      results: [],
    };
    const work = this.withEditorLane(projectId, () =>
      this.hearRange(projectId, windows, hear, { apply, noContext: opts.noContext !== false }, lineJob.abort.signal, (result) => {
        view.done += 1;
        view.results.push(result);
        const percent = (view.done / windows.length) * 100;
        handle.progress(
          percent,
          said(`${view.done}/${windows.length}: ${result.summary}`, 'activity.text.window-of', { done: view.done, total: windows.length }, [
            windowPhrase(result, result.lines, result.loops, result.speakers.unassigned),
          ]),
          etaSeconds(startedAt, percent),
        );
      }),
    ).finally(() => {
      if (this.lineJobs.get(projectId) === lineJob) this.lineJobs.delete(projectId);
    });

    if (!asJob) {
      try {
        const result = await work;
        const counts = loopCounts(result.loops);
        handle.done({
          text: windowSummary(range, result.lines.length, counts, result.speakers.unassigned),
          phrase: windowPhrase(range, result.lines.length, counts, result.speakers.unassigned),
        });
        return result;
      } catch (err) {
        handle.fail(err);
        throw err;
      }
    }
    this.keepRetranscribeJob(view);
    void work.then(
      (result) => {
        const loops = loopCounts(result.loops);
        Object.assign(view, {
          state: 'done',
          finishedAt: new Date().toISOString(),
          result: { lines: result.lines.length, replaced: result.applied?.replaced ?? 0, loops, speakers: result.speakers },
          ...(apply ? {} : { lines: result.lines }),
        });
        handle.done({
          text: windowSummary(range, result.lines.length, loops, result.speakers.unassigned),
          phrase: windowPhrase(range, result.lines.length, loops, result.speakers.unassigned),
        });
      },
      (err: unknown) => {
        Object.assign(view, { state: 'failed', finishedAt: new Date().toISOString(), error: toAppError(err).message });
        handle.fail(err);
        this.deps.bus.get(projectId).emit({
          type: 'log',
          level: 'warn',
          message: `Re-transcription stopped after ${view.done} of ${windows.length} window(s): ${toAppError(err).message}`,
          ts: new Date().toISOString(),
        });
      },
    );
    return { job: { ...view, results: [...view.results] } };
  }

  /**
   * Hear the windows in order, carrying speakers from the lines each one
   * replaces (pipeline/retranscribe.ts). With `apply` each window replaces
   * its range as soon as it is heard (its own entry in the edit history) and
   * refreshes the loop report: a job stopped halfway leaves whole windows.
   */
  private async hearRange(
    projectId: string,
    windows: readonly TimeRange[],
    hear: HearDeps,
    opts: { apply: boolean; noContext: boolean },
    signal: AbortSignal,
    onWindow: (result: RetranscribeWindowResult) => void,
  ): Promise<RetranscribeResult> {
    const paths = this.deps.store.paths(projectId);
    const out: RetranscribeResult = { fromMs: windows[0]!.fromMs, toMs: windows[windows.length - 1]!.toMs, lines: [], loops: [], speakers: { carried: 0, unassigned: 0 }, windows: [] };
    const applied: NonNullable<RetranscribeResult['applied']> = { replaced: 0, lines: [] };
    for (const w of windows) {
      const heard = await hearWindow(hear, w, opts.noContext, signal);
      if (signal.aborted) throw new AppErrorException('CANCELLED', 'The re-transcription was stopped.');
      const current = (await this.tryReadSegments(paths.sourceJson)) ?? [];
      const under = current.filter((s) => s.startMs < w.toMs && s.endMs > w.fromMs);
      const speakers = carrySpeakers(heard.lines.map(heardLine), under, current.some((s) => s.speakerId));
      const counts = loopCounts(heard.loops);
      const summary = windowSummary(w, speakers.lines.length, counts, speakers.unassigned);
      let result: RetranscribeWindowResult = {
        fromMs: w.fromMs,
        toMs: w.toMs,
        lines: speakers.lines.length,
        loops: counts,
        speakers: { carried: speakers.carried, unassigned: speakers.unassigned },
        summary,
      };
      if (opts.apply) {
        await saveLoopReport(paths.loopRangesJson, w, heard.loops);
        const done = await this.replaceSourceLines(projectId, w.fromMs, w.toMs, speakers.lines, {
          summary,
          summaryKey: 'history.summary.retranscribed',
          summaryParams: windowSummaryParams(w, speakers.lines.length, counts, speakers.unassigned),
        });
        applied.replaced += done.replaced;
        applied.lines.push(...done.lines);
        result = { ...result, replaced: done.replaced };
      }
      out.lines.push(...speakers.lines);
      out.loops.push(...heard.loops);
      out.speakers.carried += speakers.carried;
      out.speakers.unassigned += speakers.unassigned;
      out.windows.push(result);
      onWindow(result);
    }
    return opts.apply ? { ...out, applied } : out;
  }

  /** Keep a re-transcription job for its result; the oldest finished ones go first. */
  private keepRetranscribeJob(view: RetranscribeJobView): void {
    this.retranscribeJobs.set(view.id, view);
    const ended = [...this.retranscribeJobs.values()].filter((j) => j.state !== 'running');
    for (const j of ended.slice(0, Math.max(0, this.retranscribeJobs.size - RETRANSCRIBE_JOBS_KEPT))) this.retranscribeJobs.delete(j.id);
  }

  /** A re-transcription job of this project (a range over 15 minutes), as it is now. */
  retranscribeJob(projectId: string, jobId: string): RetranscribeJobView | undefined {
    const job = this.retranscribeJobs.get(jobId);
    return job && job.projectId === projectId ? { ...job, results: [...job.results] } : undefined;
  }

  /** The activity entries of the jobs this process runs on projects' lines and speakers (anything else of those kinds died with an earlier one). */
  liveLineJobIds(): Set<string> {
    return new Set([
      ...[...this.lineJobs.values()].map((j) => j.activityId),
      ...[...this.speakerJobs.values()].filter((j) => j.state === 'running' && j.activityId).map((j) => j.activityId!),
    ]);
  }

  async getSegments(projectId: string): Promise<SegmentWithAlignment[]> {
    const paths = this.deps.store.paths(projectId);
    const segments =
      (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];

    const aligned = await this.tryReadAligned(paths.translatedAlignedJson);
    if (!aligned) return segments;

    const byId = new Map(aligned.map((a) => [a.segmentId, a]));
    return segments.map((s) => {
      const a = byId.get(s.id);
      return a ? { ...s, alignment: a } : s;
    });
  }

  /**
   * Save edited translations. Merges `translatedText` into `translated.json`
   * (creating it from `source.json` if needed) and regenerates the SRT/VTT.
   *
   * A line whose text REALLY changed is also locked (auto-fit and refine leave
   * it alone from now on) and its clip marked stale — the bulk save sends every
   * line, so an unchanged one must not be locked just for being in the batch.
   */
  async saveTranslatedSegments(
    projectId: string,
    edits: { id: string; translatedText: string }[],
  ): Promise<void> {
    this.assertNotRunning(projectId, 'edit segments');
    // Read-modify-write of translated.json + both sidecars: serialized per
    // project so two concurrent edits can't lose one of them.
    await this.artifactLock.run(projectId, async () => {
      const paths = this.deps.store.paths(projectId);
      const base =
        (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];

      const editMap = new Map(edits.map((e) => [e.id, e.translatedText]));
      const merged: TranscriptSegment[] = base.map((s) => {
        const next = editMap.get(s.id);
        if (next === undefined || next === (s.translatedText ?? '')) return s;
        // Hand-written text replaces the machine's, and with it the checks' flags.
        const { qualityFlags: _flags, ...rest } = s;
        return { ...rest, translatedText: next, locked: true, ttsStale: true };
      });

      await writeJsonAtomic(paths.translatedJson, { segments: merged });
      await this.writeSidecars(paths, merged);
      await recordEdit({
        projectId,
        target: 'translation',
        summary: `Edited the translation of ${merged.filter((s, i) => s !== base[i]).length} line(s)`,
        summaryKey: 'history.summary.translation-edited',
        summaryParams: { n: merged.filter((s, i) => s !== base[i]).length },
        before: base,
        after: merged,
      });
      // A line fixed by hand is no longer one the run flagged (lines-flagged).
      await this.refreshWarnings(projectId);
    });
  }

  /**
   * The editor's timeline document: cues, synthesis units with their fit, the
   * voice-synced subtitle timing and the preview media — one consistent read.
   */
  async getTimeline(projectId: string): Promise<TimelineDocument> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const translated = await this.tryReadSegments(paths.translatedJson);
    const segments = translated ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const aligned = await this.tryReadAligned(paths.translatedAlignedJson);
    const groups = await this.tryReadGroups(paths.synthesisGroupsJson);
    const alignedById = new Map((aligned ?? []).map((a) => [a.segmentId, a]));

    // Units exist once TTS has planned/synthesized them; a project synthesized
    // before group plans existed is one unit per line.
    const units: TimelineUnit[] =
      aligned || groups
        ? reconcileGroups(groups ?? singletonUnits(segments), segments).map((u) => {
            const alignment = alignedById.get(u.id);
            return {
              id: u.id,
              segmentIds: u.segmentIds,
              startMs: u.startMs,
              endMs: u.endMs,
              ...(alignment ? { alignment } : {}),
            };
          })
        : [];

    const overrides = await readCueOverrides(paths.cueTimingJson);
    const video = project.mediaInfo?.videoStreams[0];
    const exists = async (p: string): Promise<boolean> =>
      fsp.stat(p).then((s) => s.isFile() && s.size > 0, () => false);
    // The pace the pipeline budgets this project's lines at (speechFit.ts).
    const rate = await resolveVoiceRate(
      voiceRateBookFor(this.deps.config.configDir),
      project.settings.ttsProviderId,
      project.settings.ttsVoiceId,
      project.settings.targetLanguage,
    ).catch(() => undefined);

    return {
      projectId,
      segments: segments.map((s) => {
        const alignment = alignedById.get(s.id);
        return alignment ? { ...s, alignment } : s;
      }),
      units,
      translated: translated !== undefined,
      aligned: aligned !== undefined,
      cueOverrides: Object.fromEntries(overrides),
      media: {
        videoPath: project.inputVideoPath,
        ...(project.mediaInfo?.durationMs !== undefined ? { durationMs: project.mediaInfo.durationMs } : {}),
        ...(video ? { width: video.width, height: video.height, fps: video.fps } : {}),
        ...((await exists(paths.originalWav)) ? { originalAudioPath: paths.originalWav } : {}),
        ...((await exists(projectOutputVideoPath(project))) ? { outputPath: projectOutputVideoPath(project) } : {}),
      },
      ...(rate?.perSecond !== undefined && rate.source !== 'language-default'
        ? { speechRate: { perSecond: rate.perSecond, source: rate.source } }
        : {}),
    };
  }

  /**
   * Waveform peaks of the ORIGINAL audio for the editor (cached on disk).
   *
   * Reads `audio/original.wav` when extract-audio has produced it (a plain
   * PCM decode — fast) and the input video otherwise. The cache records the
   * source's size + mtime, so re-extracting the audio rebuilds it.
   */
  async getWaveform(projectId: string): Promise<TimelineWaveform> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const media = this.deps.media;
    if (typeof media.computeWaveformPeaks !== 'function') {
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'This build cannot draw waveforms.');
    }
    const source = (await fileStamp(paths.originalWav)) ? paths.originalWav : project.inputVideoPath;
    const stamp = await fileStamp(source);
    const cached = await readJsonIfExists<TimelineWaveform & { source: string; stamp: string }>(paths.waveformOriginalJson);
    if (cached && cached.source === source && cached.stamp === stamp) {
      const { source: _s, stamp: _t, ...doc } = cached;
      return doc;
    }
    return this.onceInFlight(`waveform:${projectId}`, async () => {
      const { peaksPerSecond, durationMs, peaks } = await media.computeWaveformPeaks!(source, { peaksPerSecond: 100 });
      const doc: TimelineWaveform = {
        track: 'original',
        peaksPerSecond,
        durationMs,
        peaks: Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength).toString('base64'),
      };
      await writeJsonAtomic(paths.waveformOriginalJson, { ...doc, source, stamp });
      return doc;
    });
  }

  /**
   * The editor's filmstrip sprite (cached on disk next to its layout). The
   * sprite is written atomically by the media worker; the layout JSON is
   * written after it, so a layout on disk always describes a complete sprite.
   */
  async getFilmstrip(projectId: string): Promise<TimelineFilmstrip> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const media = this.deps.media;
    if (typeof media.renderFilmstrip !== 'function') {
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'This build cannot draw a filmstrip.');
    }
    const durationMs = project.mediaInfo?.durationMs;
    if (!durationMs || !project.mediaInfo?.videoStreams.length) {
      throw new AppErrorException('UNSUPPORTED_MEDIA', 'The project has no probed video stream to draw a filmstrip from.');
    }
    const stamp = await fileStamp(project.inputVideoPath);
    const cached = await readJsonIfExists<TimelineFilmstrip & { stamp: string }>(paths.filmstripJson);
    if (cached && cached.stamp === stamp && (await fileStamp(paths.filmstripJpg))) {
      const { stamp: _t, ...layout } = cached;
      return layout;
    }
    return this.onceInFlight(`filmstrip:${projectId}`, async () => {
      await fsp.mkdir(paths.cacheDir, { recursive: true });
      // A series part: only its window of the video (durationMs is the window's).
      const result = await media.renderFilmstrip!(project.inputVideoPath, paths.filmstripJpg, durationMs, undefined, project.sourceRange);
      const layout: TimelineFilmstrip = {
        path: result.path,
        count: result.count,
        columns: result.columns,
        rows: result.rows,
        tileWidth: result.tileWidth,
        tileHeight: result.tileHeight,
        intervalMs: result.intervalMs,
      };
      await writeJsonAtomic(paths.filmstripJson, { ...layout, stamp });
      return layout;
    });
  }

  /**
   * The path of a dub clip trimmed and tempo-fitted like the final mix
   * (cached), for the editor's preview. `trim` is the unit's alignment trim
   * (the part of the clip the mix plays); without it and at 1x the clip itself
   * is the preview. Validates the unit id (it becomes part of a file name),
   * clamps the ratio to what the aligner can produce and ignores a malformed
   * trim; the cache key includes the clip's own size+mtime, so regenerating the
   * line invalidates it, and older fits of the same unit are deleted when a new
   * one is written.
   */
  async getFittedClip(projectId: string, unitId: string, ratio: number, trim?: ClipTrim): Promise<string> {
    const paths = this.deps.store.paths(projectId);
    const media = this.deps.media;
    if (!/^seg_\d{1,6}$/.test(unitId)) throw new AppErrorException('INVALID_EDIT', `Unknown clip ${unitId}.`);
    if (typeof media.renderFittedClip !== 'function') {
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'This build cannot preview fitted clips.');
    }
    const r = Math.round(Math.max(1, Math.min(4, Number.isFinite(ratio) ? ratio : 1)) * 1000) / 1000;
    const window = validClipTrim(trim);
    const source = paths.ttsSegment(segmentIdToIndex(unitId) || 1);
    const stamp = await fileStamp(source);
    if (!stamp) throw new AppErrorException('TTS_VOICE_MISSING', `Clip ${unitId} has not been synthesized yet.`);
    if (r === 1 && !window) return source;
    const cut = window ? `-t${window.startMs}-${window.endMs}` : '';
    const name = `${unitId}-r${r.toFixed(3)}${cut}-${stamp.replace(':', '-')}.wav`;
    const out = path.join(paths.fittedClipsDir, name);
    if (await fileStamp(out)) return out;
    return this.onceInFlight(`fitted:${projectId}:${name}`, async () => {
      await fsp.mkdir(paths.fittedClipsDir, { recursive: true });
      await media.renderFittedClip!(source, out, r, window);
      // Drop stale fits of this unit (other ratios / an older synthesis).
      const entries = await fsp.readdir(paths.fittedClipsDir).catch(() => [] as string[]);
      await Promise.all(
        entries
          .filter((e) => e.startsWith(`${unitId}-r`) && e !== name)
          .map((e) => fsp.rm(path.join(paths.fittedClipsDir, e), { force: true })),
      );
      return out;
    });
  }

  /** Run `fn` once per key at a time; concurrent callers share the result. */
  private onceInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.editorMediaInFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => this.editorMediaInFlight.delete(key));
    this.editorMediaInFlight.set(key, p);
    return p;
  }

  /**
   * Apply editor patches (text, timing, voice, rate, lock) and keep every
   * artifact that encodes the same timing consistent — see timelineEdit.ts.
   *
   * A timing edit re-places the EXISTING clips (their durations are already
   * known) and recomputes every fit status, so the editor shows the consequence
   * of a drag immediately and the next mix uses it, without re-synthesizing a
   * single line. Text/voice/rate edits only mark the clip stale; the editor
   * regenerates it on demand.
   */
  async patchSegments(
    projectId: string,
    patches: SegmentPatch[],
    /** As replaceSourceLines': what the history says, the entry an undo undoes, its check inside the lock. */
    opts: {
      summary?: string;
      summaryKey?: string;
      summaryParams?: Record<string, string | number>;
      undoOf?: string;
      precondition?: (base: readonly TranscriptSegment[]) => void;
    } = {},
  ): Promise<TimelineDocument> {
    this.assertNotRunning(projectId, 'edit the timeline');
    if (!Array.isArray(patches) || patches.length === 0) {
      throw new AppErrorException('INVALID_EDIT', 'No changes were sent.');
    }
    await this.artifactLock.run(projectId, async () => {
      const project = await this.deps.store.getProject(projectId);
      const paths = this.deps.store.paths(projectId);
      const translated = await this.tryReadSegments(paths.translatedJson);
      const source = await this.tryReadSegments(paths.sourceJson);
      const base = translated ?? source;
      if (!base) throw new AppErrorException('INVALID_EDIT', 'This project has no transcript to edit yet.');
      opts.precondition?.(base);

      const outcome = applySegmentPatches(base, patches, {
        durationMs: project.mediaInfo?.durationMs,
        voiceOf: (line) => voiceForLine(line, project.settings),
      });
      if (
        !translated &&
        (outcome.textChanged.size > 0 || outcome.voiceChanged.size > 0 || outcome.rateChanged.size > 0)
      ) {
        throw new AppErrorException(
          'INVALID_EDIT',
          'Translate the transcript before editing translations or voices — only timing and speakers can be changed now.',
        );
      }
      const changed =
        outcome.textChanged.size +
        outcome.timingChanged.size +
        outcome.voiceChanged.size +
        outcome.rateChanged.size +
        outcome.lockChanged.size +
        outcome.speakerChanged.size;
      if (changed === 0) return;

      if (translated) await writeJsonAtomic(paths.translatedJson, { segments: outcome.segments });

      if ((outcome.timingChanged.size > 0 || outcome.speakerChanged.size > 0) && source) {
        // Timing and speakers also land in source.json: re-translating rebuilds
        // translated.json FROM source.json, and must not snap the lines back to
        // the recogniser's timing, or to the speakers, the user just corrected.
        const byId = new Map(outcome.segments.map((s) => [s.id, s]));
        await writeJsonAtomic(paths.sourceJson, {
          segments: source.map((s) => {
            const n = byId.get(s.id);
            if (!n) return s;
            let next: TranscriptSegment = { ...s, startMs: n.startMs, endMs: n.endMs };
            if (outcome.timingChanged.has(s.id)) {
              // Same rule as applySegmentPatches: words move with the line, or go.
              const { words: _stale, ...rest } = next;
              next = { ...rest, ...(n.words ? { words: n.words } : {}) };
            }
            if (outcome.speakerChanged.has(s.id)) {
              const { speakerId: _old, speakerLowConfidence: _guess, ...rest } = next;
              next = { ...rest, ...(n.speakerId ? { speakerId: n.speakerId } : {}) };
            }
            return next;
          }),
        });
      }

      if (outcome.timingChanged.size > 0) {
        await this.realign(project, paths, outcome.segments, new Map());
        // A cue the user placed by hand is shown where they put it, not where the
        // voice-sync pass would put it.
        await clearCueOverridesFor(paths.cueTimingJson, [...outcome.timingChanged]);
      }
      if (outcome.timingChanged.size > 0 || outcome.textChanged.size > 0) {
        await this.writeSidecars(paths, outcome.segments);
      }
      const what = [
        outcome.textChanged.size ? `text of ${outcome.textChanged.size}` : '',
        outcome.timingChanged.size ? `timing of ${outcome.timingChanged.size}` : '',
        outcome.speakerChanged.size ? `speaker of ${outcome.speakerChanged.size}` : '',
        outcome.voiceChanged.size ? `voice of ${outcome.voiceChanged.size}` : '',
        outcome.rateChanged.size ? `pace of ${outcome.rateChanged.size}` : '',
        outcome.lockChanged.size ? `lock of ${outcome.lockChanged.size}` : '',
      ].filter(Boolean);
      await recordEdit({
        projectId,
        target: translated ? 'translation' : 'source',
        summary: opts.summary ?? `Changed the ${what.join(', ')} line(s)`,
        ...(opts.summary
          ? opts.summaryKey
            ? { summaryKey: opts.summaryKey, ...(opts.summaryParams ? { summaryParams: opts.summaryParams } : {}) }
            : {}
          : {
              summaryKey: 'history.summary.changed',
              summaryParams: {
                text: outcome.textChanged.size,
                timing: outcome.timingChanged.size,
                speaker: outcome.speakerChanged.size,
                voice: outcome.voiceChanged.size,
                pace: outcome.rateChanged.size,
                lock: outcome.lockChanged.size,
              },
            }),
        before: base,
        after: outcome.segments,
        ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
      });
      // A speaker set by hand may be one a re-transcription left out
      // (speakers-unassigned); a line rewritten by hand, one the run flagged.
      if (outcome.speakerChanged.size > 0 || outcome.textChanged.size > 0) await this.refreshWarnings(projectId);
    });
    return this.getTimeline(projectId);
  }

  /**
   * Re-synthesize a single segment (after an edit) and recompute its alignment.
   * Returns the new {@link TtsSegment} and its {@link AlignedSegment}.
   */
  async synthesizeSingleSegment(
    projectId: string,
    segmentId: string,
    opts: { text?: string; voiceId?: string; speed?: number },
  ): Promise<{ segment: TtsSegment; alignment: AlignedSegment }> {
    this.assertNotRunning(projectId, 're-synthesize a segment');
    return this.withEditorLane(projectId, () =>
      this.synthesizeSingleSegmentImpl(projectId, segmentId, opts),
    );
  }

  /**
   * A one-off job for a project's editor outside this class (separating the
   * voices of lines a voice is made from), under the editor's heavy-engine
   * owner: it may use a free lane, never one a running dub holds, and a dub
   * queued behind it is dispatched when it ends.
   */
  runEditorJob<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.withEditorLane(projectId, fn);
  }

  /**
   * Run an editor action under its own heavy-engine owner.
   *
   * Editor actions touch the SAME heavy engines a run uses, so they get their
   * own owner id: they may claim a FREE lane, but get a clear ENGINE_BUSY
   * instead of unloading the engine a running dub is mid-request against.
   * Claims are reference-counted — the editor allows concurrent actions on
   * different segments, and the first to finish must not free a lane the
   * others are still using.
   */
  private async withEditorLane<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.runLaneJob(`editor:${projectId}`, fn);
  }

  /**
   * Run work outside any dub (an editor action, a voice preview) under an
   * owner of its own: `editor:<project>`, `preview:<voice>`. It may take a
   * free heavy lane, is refused (ENGINE_BUSY) rather than unloading a running
   * dub's engine, and releases the lane when the last job of that owner ends.
   * Before this, a preview ran as "anonymous" and its claim never ended.
   */
  async runLaneJob<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    this.laneRefs.set(owner, (this.laneRefs.get(owner) ?? 0) + 1);
    try {
      return await withEngineOwner(owner, fn);
    } finally {
      const remaining = (this.laneRefs.get(owner) ?? 1) - 1;
      if (remaining > 0) {
        this.laneRefs.set(owner, remaining);
      } else {
        this.laneRefs.delete(owner);
        this.deps.engines?.releaseHeavyLane(owner);
        // The lane may now be free for a queued heavy dub.
        void this.pump();
      }
    }
  }

  /** Whether a heavy-lane owner still exists: a live run, or a lane job in progress. */
  private laneOwnerAlive(owner: string): boolean {
    return this.running.has(owner) || this.laneRefs.has(owner);
  }

  private async synthesizeSingleSegmentImpl(
    projectId: string,
    segmentId: string,
    opts: { text?: string; voiceId?: string; speed?: number },
  ): Promise<{ segment: TtsSegment; alignment: AlignedSegment }> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);

    const segments =
      (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const segment = segments.find((s) => s.id === segmentId);
    if (!segment) {
      throw new AppErrorException('UNKNOWN', `Segment not found: ${segmentId}`);
    }
    // A song line plays the original and never gets a voice (mix.ts): a clip
    // made for it would only take time and lie unused on disk.
    if (segment.song === true) {
      throw new AppErrorException('INVALID_EDIT', 'This line is kept as the original song, so it has no dub voice.', {
        remediation: 'Dub it again first (“Dub this line again” in the editor, or mark_song with song=false), then make its voice.',
      });
    }

    const text = (opts.text ?? segment.translatedText ?? segment.sourceText ?? '').trim();
    const provider = this.deps.registry.getTts(project.settings.ttsProviderId);

    // DEGROUP when this segment was synthesized as part of a multi-cue group:
    // grouped cues share one WAV (on the first member's path), so regenerating
    // one line must give EVERY member its own WAV + alignment entry again —
    // otherwise the edit would either overwrite the shared clip (first member)
    // or never be heard at all (later members).
    const groups = await this.tryReadGroups(paths.synthesisGroupsJson);
    const group = groups?.find((g) => g.segmentIds.length > 1 && g.segmentIds.includes(segmentId));

    // Voice + rate per member. An explicit override on THIS request applies to
    // the edited line only (and is persisted below, so a later full run keeps
    // it); every other member keeps its own per-line override or falls back to
    // its speaker's / the project's voice. This used to give every former
    // member the edited line's voice.
    const voiceFor = (s: TranscriptSegment): string | undefined =>
      s.id === segmentId && opts.voiceId !== undefined ? opts.voiceId || undefined : s.voiceId;
    const rateFor = (s: TranscriptSegment): number | undefined =>
      s.id === segmentId && opts.speed !== undefined ? opts.speed : s.speakingRate;
    const units: SynthesisGroup[] = (group ? group.segmentIds : [segmentId]).map((id) => {
      const s = (id === segmentId ? segment : segments.find((x) => x.id === id)) ?? segment;
      const voiceId = voiceFor(s);
      const speakingRate = rateFor(s);
      return {
        id,
        segmentIds: [id],
        text: id === segmentId ? text : (s.translatedText ?? s.sourceText ?? '').trim(),
        startMs: s.startMs,
        endMs: s.endMs,
        ...(s.speakerId ? { speakerId: s.speakerId } : {}),
        ...(voiceId ? { voiceId } : {}),
        ...(speakingRate !== undefined ? { speakingRate } : {}),
      };
    });

    // `voiceId` and `speed` are batch-level TTS parameters: one call per pair.
    const buckets = new Map<string, { voiceId: string | undefined; speed: number; units: SynthesisGroup[] }>();
    for (const u of units) {
      const voiceId = voiceForGroup(u, project.settings);
      const speed = rateForGroup(u);
      const key = `${voiceId ?? ''}\u0000${speed}`;
      const bucket = buckets.get(key) ?? { voiceId, speed, units: [] };
      bucket.units.push(u);
      buckets.set(key, bucket);
    }
    const synthesized: TtsSegment[] = [];
    for (const b of buckets.values()) {
      // A line with nothing to say ("…", "♪") is silence, never an engine call (speakable.ts).
      const silent = b.units.filter((u) => !hasSpeakableText(u.text) && segmentIdToIndex(u.id) > 0);
      for (const u of silent) {
        const audioPath = paths.ttsSegment(segmentIdToIndex(u.id));
        const durationMs = await writeSilentClip(audioPath);
        synthesized.push({ segmentId: u.id, audioPath, durationMs, text: u.text, startMs: u.startMs, endMs: u.endMs });
      }
      b.units = b.units.filter((u) => !silent.includes(u));
      if (b.units.length === 0) continue;
      const result = await provider.synthesizeSegments({
        language: project.settings.targetLanguage,
        voiceId: b.voiceId,
        segments: b.units.map((u) => ({ id: u.id, text: u.text, startMs: u.startMs, endMs: u.endMs })),
        outputDir: paths.ttsSegmentsDir,
        speed: b.speed,
      });
      synthesized.push(...result.segments);
    }

    const ttsSegment = synthesized.find((s) => s.segmentId === segmentId);
    if (!ttsSegment) {
      throw new AppErrorException('UNKNOWN', `TTS produced no output for segment ${segmentId}.`);
    }

    // Measure each new clip as the alignment step does (clipSpeech.ts): the
    // speech is what gets fitted and played, not the file around it.
    const clips = new Map<string, ClipTiming>();
    for (const s of synthesized) {
      const unitText = units.find((u) => u.id === s.segmentId)?.text ?? s.text;
      try {
        clips.set(s.segmentId, await measureClip(this.deps.media, s.audioPath, unitText));
      } catch {
        // Unreadable right after synthesis: fit the length the engine reported.
        clips.set(s.segmentId, { generatedDurationMs: s.durationMs });
      }
    }

    const alignment = await this.artifactLock.run(projectId, async () => {
      // Re-read: another line may have been regenerated while this one synthesized.
      const latest =
        (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? segments;
      const synthesizedIds = new Set(synthesized.map((s) => s.segmentId));
      const target = latest.find((s) => s.id === segmentId) ?? segment;
      const textChanged = opts.text !== undefined && text !== (target.translatedText ?? '');
      const merged = latest.map((s) => {
        if (!synthesizedIds.has(s.id)) return s;
        const { ttsStale: _wasStale, ...next } = s;
        if (s.id === segmentId) {
          if (textChanged) {
            next.translatedText = text;
            next.locked = true;
            delete next.qualityFlags; // the user's text, not the machine's
          }
          if (opts.voiceId !== undefined) {
            if (opts.voiceId) next.voiceId = opts.voiceId;
            else delete next.voiceId;
          }
          if (opts.speed !== undefined) {
            if (Math.abs(opts.speed - 1) < 1e-3) delete next.speakingRate;
            else next.speakingRate = opts.speed;
          }
        }
        return next;
      });
      await writeJsonAtomic(paths.translatedJson, { segments: merged });

      // Persist the degrouped plan: each former member is its own unit now,
      // carrying its own voice/rate, and its voice-sync cue override no longer
      // applies (it speaks from its own cue).
      let plan = (await this.tryReadGroups(paths.synthesisGroupsJson)) ?? groups;
      if (group && plan) {
        const replacement = new Map(units.map((u) => [u.id, u]));
        plan = plan.flatMap((g) =>
          g.segmentIds.length > 1 && g.segmentIds.includes(segmentId)
            ? g.segmentIds.map((id) => replacement.get(id)!).filter(Boolean)
            : [g],
        );
        await writeJsonAtomic(paths.synthesisGroupsJson, { groups: plan });
        await clearCueOverridesFor(paths.cueTimingJson, group.segmentIds);
      }
      if (textChanged || group) await this.writeSidecars(paths, merged);

      // Re-fit the WHOLE timeline gap-aware, exactly as the alignment step does.
      // This used to align just the edited line against its own cue window, so
      // a line the pipeline accepted (it may use the pause before the next
      // line) was reported as a timing conflict the moment it was regenerated.
      const placed = await this.realign(project, paths, merged, clips);
      return (
        placed?.find((a) => a.segmentId === segmentId) ??
        // No alignment artifact yet (e.g. a preview at the review checkpoint,
        // before TTS ever ran): fit this line in memory and do NOT create a
        // one-entry aligned file — "an artifact that exists is complete".
        alignSegments(
          alignmentInputsForUnits(
            [units.find((u) => u.id === segmentId)!],
            new Map(),
            (id) => paths.ttsSegment(segmentIdToIndex(id) || segment.index + 1),
            clips,
          ),
          this.alignSettings(project),
          project.mediaInfo?.durationMs,
        )[0]!
      );
    });
    // New text from the editor clears the line's flags (lines-flagged).
    if (opts.text !== undefined) await this.refreshWarnings(projectId);

    return { segment: ttsSegment, alignment };
  }

  /**
   * "Tighten to fit" one segment: SHORTEN its current translation with the
   * project's context engine (review model, else the Gemma chat model, else an
   * instruction-following translator — never TranslateGemma), then
   * re-synthesize + re-align via {@link synthesizeSingleSegment}. The editor
   * uses this on a flagged line.
   *
   * It used to re-translate the line FROM THE SOURCE with the translation
   * provider, with no neighbours and a shrunk fake window, and accept any text
   * that differed — the same path that turned reviewed lines into "Tránh làm
   * vỡ." (母符必碎) during auto-fit. Now the model sees the current line, its
   * neighbours, the character sheet and a length budget at the voice's
   * measured pace, and the proposal is kept only when it is shorter AND passes
   * the line checks (dubPasses.tightenOneLine). `shortened: false` + `reason`
   * tell the editor when the line was kept as it was.
   */
  async refitSegment(
    projectId: string,
    segmentId: string,
  ): Promise<{
    segment: TtsSegment;
    alignment: AlignedSegment;
    translatedText: string;
    shortened: boolean;
    reason?: string;
  }> {
    this.assertNotRunning(projectId, 'tighten a segment');
    // Same engine-ownership rule as synthesizeSingleSegment: this runs a model
    // (possibly a heavy local LLM) before re-synthesizing.
    return this.withEditorLane(projectId, () => this.refitSegmentImpl(projectId, segmentId));
  }

  private async refitSegmentImpl(
    projectId: string,
    segmentId: string,
  ): Promise<{
    segment: TtsSegment;
    alignment: AlignedSegment;
    translatedText: string;
    shortened: boolean;
    reason?: string;
  }> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const segments =
      (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const idx = segments.findIndex((s) => s.id === segmentId);
    const seg = idx >= 0 ? segments[idx] : undefined;
    if (!seg) {
      throw new AppErrorException('UNKNOWN', `Segment not found: ${segmentId}`);
    }
    const current = (seg.translatedText ?? seg.sourceText ?? '').trim();

    // The window the line may fill: its cue plus a capped share of the pause
    // after it (or of the media's end), the same window every prompt budgets.
    const next = segments[idx + 1];
    const windowMs = fitWindowMs(seg, next ? next.startMs : (project.mediaInfo?.durationMs ?? seg.endMs));
    const rate = await resolveVoiceRate(
      voiceRateBookFor(this.deps.config.configDir),
      project.settings.ttsProviderId,
      seg.voiceId ?? project.settings.ttsVoiceId,
      project.settings.targetLanguage,
    );

    let finalText = current;
    let shortened = false;
    let reason: string | undefined;
    const engine = new FallbackContextChat(contextEngineCandidates(this.deps.registry, project.settings));
    if (!engine.available) {
      reason = 'No instruction-following model is available to shorten the line (set a review model or install the Gemma chat model).';
    } else if (seg.translatedText !== undefined) {
      const documentContext = (await this.getTranslationContext(projectId)) ?? undefined;
      const outcome = await tightenOneLine(
        {
          sourceLanguage: project.settings.sourceLanguage,
          targetLanguage: project.settings.targetLanguage,
          segments,
          segmentId,
          windowMs,
          ...(documentContext ? { documentContext } : {}),
          ...(rate.perSecond !== undefined ? { perSecond: rate.perSecond } : {}),
        },
        engine,
      );
      shortened = outcome.shortened;
      reason = outcome.reason;
      if (outcome.shortened) finalText = outcome.text;
    } else {
      reason = 'The line has no translation yet.';
    }

    // Persist the shortened text + re-synthesize + re-align (handled inside).
    // Nothing shortened: re-voice the line as it is. Passing its text as an
    // edit wrote the SOURCE of an untranslated line as its locked translation.
    const { segment, alignment } = await this.synthesizeSingleSegmentImpl(
      projectId,
      segmentId,
      shortened ? { text: finalText } : {},
    );
    return { segment, alignment, translatedText: finalText, shortened, ...(reason ? { reason } : {}) };
  }

  /**
   * What the app's text passes did to a project's translation: the character
   * sheet (built, or failed and why), the per-line checks (repaired, still
   * flagged), auto-fit (shortened, refused) — translation_report.json — and the
   * review pass (changes, refusals) — refine_report.json. Empty / null before
   * those steps ran. The editor warns from it, and Claude reads it over MCP to
   * find the lines worth a look.
   */
  async getTranslationReport(
    projectId: string,
  ): Promise<{ translation: TranslationReport; review: Record<string, unknown> | null }> {
    await this.deps.store.getProject(projectId); // an unknown project is an error, not an empty report
    const paths = this.deps.store.paths(projectId);
    const [translation, review] = await Promise.all([
      readTranslationReport(translationReportPath(paths.subtitlesDir)),
      readJsonIfExists<Record<string, unknown>>(paths.refineReportJson),
    ]);
    return { translation, review: review ?? null };
  }

  /**
   * Read the project's translation character sheet (cast/glossary/pronoun
   * plan), or null when none has been generated/saved yet.
   */
  async getTranslationContext(projectId: string): Promise<TranslationDocContext | null> {
    const paths = this.deps.store.paths(projectId);
    try {
      const raw = await fsp.readFile(paths.translationContextJson, 'utf8');
      const parsed = JSON.parse(raw) as TranslationDocContext;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Save the (user-edited) translation character sheet. Only the known fields
   * are persisted; context-capable providers use it verbatim on the next
   * translation run (re-dub from the translation step to apply it).
   */
  async saveTranslationContext(projectId: string, ctx: TranslationDocContext): Promise<TranslationDocContext> {
    const paths = this.deps.store.paths(projectId);
    const clean: TranslationDocContext = {
      ...(typeof ctx.synopsis === 'string' && ctx.synopsis.trim() ? { synopsis: ctx.synopsis.trim() } : {}),
      ...(Array.isArray(ctx.cast)
        ? {
            cast: ctx.cast
              .filter((c) => typeof c?.name === 'string' && c.name.trim().length > 0)
              .map((c) => ({
                name: c.name.trim(),
                ...(c.role?.trim() ? { role: c.role.trim() } : {}),
                // Which detected speaker this character is (SPEAKER_03).
                ...(typeof c.speakerId === 'string' && /^SPEAKER_\d+$/.test(c.speakerId.trim()) ? { speakerId: c.speakerId.trim() } : {}),
              })),
          }
        : {}),
      // "Heard as → is": what speech-to-text mishears, fixed before translating.
      ...(Array.isArray(ctx.corrections)
        ? {
            corrections: ctx.corrections
              .filter((c) => typeof c?.heard === 'string' && c.heard.trim().length > 0 && typeof c?.is === 'string' && c.heard.trim() !== c.is)
              .slice(0, 200)
              .map((c) => ({ heard: c.heard.trim(), is: c.is.trim() })),
          }
        : {}),
      ...(Array.isArray(ctx.glossary)
        ? {
            glossary: ctx.glossary
              .filter((g) => typeof g?.source === 'string' && g.source.trim().length > 0 && typeof g?.target === 'string')
              .map((g) => ({ source: g.source.trim(), target: g.target.trim() })),
          }
        : {}),
      ...(typeof ctx.pronounGuide === 'string' && ctx.pronounGuide.trim()
        ? { pronounGuide: ctx.pronounGuide.trim() }
        : {}),
    };
    await writeJsonAtomic(paths.translationContextJson, clean);
    return clean;
  }

  /**
   * Export's "Render again": keep the chosen subtitle mode / burn style, then
   * re-run from the mix when it is out of date (an edit since it was made, a
   * mix setting changed; pipeline/mixFingerprint.ts), else from the render.
   *
   * A run like any other, so the queue, pausing, the render-quality setting
   * and the subtitle files all apply. It used to call the media service
   * directly: after editor edits it rendered the OLD mix under the new
   * subtitles, always with bare x264, and could not be paused or queued.
   */
  async rerender(
    projectId: string,
    opts: { subtitleExportMode?: Project['settings']['subtitleExportMode']; burnSubtitleStyle?: Project['settings']['burnSubtitleStyle'] },
  ): Promise<RunScheduleResult & { fromStep: PipelineStepId }> {
    this.assertNotMoving(projectId);
    if (opts.subtitleExportMode !== undefined || opts.burnSubtitleStyle !== undefined) {
      await this.updateProjectSettings(projectId, {
        ...(opts.subtitleExportMode !== undefined ? { subtitleExportMode: opts.subtitleExportMode } : {}),
        ...(opts.burnSubtitleStyle !== undefined ? { burnSubtitleStyle: opts.burnSubtitleStyle } : {}),
      });
    }
    const fromStep: PipelineStepId = (await this.mixIsCurrent(projectId)) ? 'render' : 'audio-mix';
    return { ...(await this.retryStep(projectId, fromStep)), fromStep };
  }

  /** Whether final_mix.wav is the mix of what is on disk now (see {@link rerender}). */
  async mixIsCurrent(projectId: string): Promise<boolean> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    if (!(await fileExistsNonEmpty(paths.finalMixWav))) return false;
    const recorded = await readMixFingerprint(paths.finalMixInputsJson);
    if (recorded === undefined) return false;
    let aligned: AlignedSegment[];
    try {
      aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as AlignedSegment[];
    } catch {
      return false;
    }
    const totalDurationMs =
      project.mediaInfo?.durationMs ??
      aligned.reduce((max, a) => Math.max(max, a.endMs, a.startMs + a.placedDurationMs), 0);
    // The greeting's share, as the last mix planned it; a plan made for other
    // greeting settings means the mix is out of date.
    const greetingSettings = project.settings.branding?.greeting;
    let greeting: { file: string; placements: { atMs: number }[]; gainDb: number; key: string } | undefined;
    if (greetingSettings?.assetId) {
      const plan = await readGreetingPlan(paths.greetingPlanJson);
      const key = greetingSettingsKey(greetingSettings);
      if (!plan || plan.settingsKey !== key) return false;
      greeting = {
        file: path.join(project.workspaceDir, 'branding', `${greetingSettings.assetId}.wav`),
        placements: plan.placements,
        gainDb: greetingSettings.gainDb,
        key,
      };
    }
    // What the mix step plays of it: no unit of song lines, the original in their windows (songs/songLines.ts).
    const songs = await songMixPlan(
      aligned,
      await this.tryReadGroups(paths.synthesisGroupsJson),
      (await this.tryReadSegments(paths.translatedJson)) ?? [],
      fileExistsNonEmpty,
    );
    const now = await mixFingerprint({
      workspaceDir: project.workspaceDir,
      aligned: songs.aligned,
      keepOriginal: songs.keepOriginal,
      totalDurationMs,
      settings: project.settings,
      originalWav: paths.originalWav,
      ...(greeting ? { greeting } : {}),
    });
    return now === recorded;
  }

  /** Languages helper: proxy the translation worker, tolerating unavailability. */
  async listTranslationLanguages(): Promise<TranslationLanguages> {
    const provider: unknown = this.deps.registry.getTranslation();
    // Only the Argos provider exposes listLanguages; guard structurally.
    if (hasListLanguages(provider)) {
      try {
        return await provider.listLanguages();
      } catch {
        return { installed: [] };
      }
    }
    return { installed: [] };
  }

  // ----- Internals ---------------------------------------------------------

  // ----- Run scheduling (capacity limit + queue) ----------------------------

  /** The hardware capacity recommendation (memoized; specs are stable). */
  async capacity(): Promise<CapacityRecommendation> {
    this.capacityPromise ??= getSystemProfile()
      .then(recommendCapacity)
      .catch(() => recommendCapacity(FALLBACK_PROFILE));
    return this.capacityPromise;
  }

  /** The limit actually in force (hardware recommendation or the manual pin). */
  private async effectiveCapacity(): Promise<CapacityRecommendation> {
    const recommended = await this.capacity();
    const prefs = await this.deps.setup?.getPreferences().catch(() => undefined);
    return effectiveCapacity(recommended, prefs?.concurrency);
  }

  /**
   * Schedule a run: start it immediately when the machine has room, otherwise
   * mark the project `queued` and let {@link pump} dispatch it when a slot
   * frees. Registration is synchronous (no `await` between the decision and
   * `running.set`/`queued.add`) so the idempotence guards stay race-free.
   */
  private async scheduleRun(
    project: Project,
    retryFromStep: PipelineStepId | undefined,
  ): Promise<RunScheduleResult> {
    const gpuFamilies = await this.gpuFamilies();
    const contextEngine = await this.contextEngineOf(project.settings);
    const workload = classifyWorkload(project.settings, this.deps.registry, {
      fromStep: retryFromStep,
      ...(await this.optionalEngines()),
      gpuFamilies,
      ...(contextEngine ? { contextEngine } : {}),
    });

    const capacity = await this.effectiveCapacity();
    const prefs = await this.deps.setup?.getPreferences().catch(() => undefined);

    // Re-check AFTER the awaits above: a concurrent /run (double-click, or Home
    // + Processing both firing) may have started or queued this project while
    // we were reading preferences/capacity. Without this the same project could
    // be registered twice.
    if (this.running.has(project.id)) return { started: true, queued: false };
    if (this.queued.has(project.id)) {
      return { started: false, queued: true, position: this.queuePosition(project.id) };
    }

    // A non-empty queue always wins: starting a fresh request ahead of projects
    // that are already waiting would jump the FIFO order and defeat the
    // head-reservation that keeps the queue starvation-free.
    // Quitting (pauseAll): a dub asked for now waits in the queue, which the
    // next start resumes, instead of starting a run nothing would pause.
    const decision =
      (this.queue.length > 0 && !workload.lightOnly) || this.closing
        ? { start: [] as string[] }
        : decideAdmissions(
            [{ projectId: project.id, points: workload.points, needsHeavyEngine: workload.needsHeavyEngine, lightOnly: workload.lightOnly }],
            this.runningRuns(),
            {
              budgetPoints: capacity.budgetPoints,
              paused: prefs?.concurrency?.paused === true,
              pressure: this.deps.pressure?.() === true,
              ...(this.externalHeavyOwner() ? { externalHeavyOwner: this.externalHeavyOwner() } : {}),
            },
          );

    if (decision.start.includes(project.id)) {
      this.workloads.set(project.id, workload);
      dubRuns.scheduled(project, { queued: false, ...(retryFromStep ? { fromStep: retryFromStep } : {}) });
      this.startRun(project, retryFromStep);
      return { started: true, queued: false };
    }

    // No room: persist the queue entry FIRST (project.json is written
    // atomically, so the queue survives a restart with no second source of
    // truth), then register in memory — a failed write must not leave a
    // phantom queue entry the user cannot see or cancel.
    // A series part waits ahead of its own series' later parts: retried after
    // a failure, part 16 went behind parts 20-48, and the agent paused 29
    // parts to bring it forward (claude-dubber, 2026-11-24).
    const successor = await this.laterPartInQueue(project);
    const entry: ProjectQueueEntry = {
      queuedAt: successor ? new Date(Date.parse(successor.queuedAt) - 1).toISOString() : new Date().toISOString(),
      previousStatus: project.status,
      ...(retryFromStep ? { fromStep: retryFromStep } : {}),
    };
    await this.deps.store.saveProject({ ...project, status: 'queued', queue: entry });
    if (this.running.has(project.id) || this.queued.has(project.id)) {
      return { started: false, queued: true, position: this.queuePosition(project.id) };
    }
    this.workloads.set(project.id, workload);
    const at = successor ? this.queue.indexOf(successor.projectId) : -1;
    if (at >= 0) this.queue.splice(at, 0, project.id);
    else this.queue.push(project.id);
    this.queued.add(project.id);
    dubRuns.scheduled(project, { queued: true, ...(retryFromStep ? { fromStep: retryFromStep } : {}) });
    return { started: false, queued: true, position: this.queuePosition(project.id) };
  }

  /**
   * The first queued part of the same series with a later number than this
   * part, with when it was queued: a part is queued ahead of it, keeping the
   * series' order. Undefined for anything but a series part, or when none waits.
   */
  private async laterPartInQueue(project: Project): Promise<{ projectId: string; queuedAt: string } | undefined> {
    const own = project.series;
    if (own?.role !== 'part') return undefined;
    for (const id of this.queue) {
      const other = await this.deps.store.getProject(id).catch(() => undefined);
      const s = other?.series;
      if (s?.role === 'part' && s.parentId === own.parentId && s.index > own.index && other?.queue?.queuedAt) {
        return { projectId: id, queuedAt: other.queue.queuedAt };
      }
    }
    return undefined;
  }

  /** 1-based queue position (0 when not queued). */
  private queuePosition(projectId: string): number {
    return this.queue.indexOf(projectId) + 1;
  }

  /**
   * The heavy-engine lane holder when it is NOT one of our runs — i.e. an
   * editor action (`editor:<projectId>`). The scheduler must see it, or it
   * would dispatch a heavy run straight into an ENGINE_BUSY failure.
   */
  private externalHeavyOwner(): string | undefined {
    const owner = this.deps.engines?.heavyLaneOwner();
    return owner !== undefined && !this.running.has(owner) ? owner : undefined;
  }

  /** Running jobs in the shape the admission rule reads. */
  private runningRuns(): RunningRun[] {
    return [...this.running.keys()].map((projectId) => {
      const w = this.workloads.get(projectId);
      return {
        projectId,
        points: w?.points ?? POINTS_PER_LOCAL_RUN,
        needsHeavyEngine: w?.needsHeavyEngine ?? false,
        lightOnly: w?.lightOnly ?? false,
      };
    });
  }

  /**
   * Dispatch every queued run the machine now has room for. The ONLY place
   * queued runs start. Serialized via {@link pumping}; requests arriving during
   * a pass set {@link pumpAgain} so a slot freed mid-pass is never missed.
   *
   * Termination is driven by PROGRESS, not by `queue.length`: a pass that
   * dispatches nothing ends the loop. (Keying it on the queue emptying could
   * spin forever if an admitted candidate is skipped — e.g. it started via
   * another path — while remaining in the queue.)
   */
  private async pump(): Promise<void> {
    // Quitting: a slot freed by a pause must not start the next queued dub.
    if (this.closing) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        this.pumpAgain = false;
        const dispatched = await this.pumpOnce();
        // Re-run only when this pass achieved something, or a wakeup arrived
        // while it was running (a freed slot / raised limit / un-pause).
        if (!dispatched && !this.pumpAgain) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** One admission pass. Returns true when at least one run was dispatched. */
  private async pumpOnce(): Promise<boolean> {
    // Held (whileQueueHeld): its release pumps again.
    if (this.queue.length === 0 || this.queueHolds > 0) return false;

    const capacity = await this.effectiveCapacity();
    const prefs = await this.deps.setup?.getPreferences().catch(() => undefined);
    const candidates = this.queue.map((projectId) => {
      const w = this.workloads.get(projectId);
      return {
        projectId,
        points: w?.points ?? POINTS_PER_LOCAL_RUN,
        needsHeavyEngine: w?.needsHeavyEngine ?? false,
        lightOnly: w?.lightOnly ?? false,
      };
    });
    const externalHeavyOwner = this.externalHeavyOwner();
    const decision = decideAdmissions(candidates, this.runningRuns(), {
      budgetPoints: capacity.budgetPoints,
      paused: prefs?.concurrency?.paused === true,
      pressure: this.deps.pressure?.() === true,
      ...(externalHeavyOwner ? { externalHeavyOwner } : {}),
    });
    if (decision.start.length === 0) return false;

    let dispatched = false;
    for (const projectId of decision.start) {
      // Re-load: settings/status may have changed while queued.
      let project: Project;
      try {
        project = await this.deps.store.getProject(projectId);
      } catch {
        this.forget(projectId);
        continue;
      }
      // A queue must never stall on one bad entry: re-check readiness at
      // dispatch. A TRANSIENT problem (a bundled worker still booting — the
      // normal state moments after launch, when reconcileQueue runs) keeps the
      // project queued and retries shortly; anything else fails that project
      // and the queue moves on.
      if (this.deps.checkReadiness) {
        let problems: ProviderReadiness[];
        try {
          problems = (await this.deps.checkReadiness(project, project.queue?.fromStep)).filter((r) => !r.ready);
        } catch {
          // The checker itself failed — don't punish the project for that; let
          // the run start and surface any real problem in its own step.
          problems = [];
        }
        if (problems.length > 0) {
          if (problems.every((p) => p.status === 'worker-loading')) {
            this.scheduleQueueRetry();
            continue;
          }
          this.forget(projectId);
          this.workloads.delete(projectId);
          await this.deps.store
            .saveProject({ ...project, status: 'failed', queue: undefined })
            .catch(() => undefined);
          const first = problems[0]!;
          this.deps.bus.get(projectId).emit({
            type: 'error',
            error: toAppError(
              new AppErrorException('ENGINE_UNAVAILABLE', first.message, {
                ...(first.remediation ? { remediation: first.remediation } : {}),
              }),
            ),
          });
          continue;
        }
      }
      // Someone may have started/cancelled it while we awaited. Drop it from
      // the queue either way — leaving it would make this pass repeat forever.
      if (!this.queued.has(projectId) || this.running.has(projectId)) {
        this.forget(projectId);
        continue;
      }
      // Held since this pass began: it stays queued, and the release pumps again.
      if (this.queueHolds > 0) return dispatched;
      // Read again: a part changed where it waited (whileQueueHeld) starts as it is now.
      project = await this.deps.store.getProject(projectId).catch(() => project);
      if (this.queueHolds > 0 || !this.queued.has(projectId) || this.running.has(projectId)) return dispatched;
      const fromStep = project.queue?.fromStep;
      this.forget(projectId);
      this.startRun({ ...project, queue: undefined }, fromStep);
      dispatched = true;
    }
    return dispatched;
  }

  /**
   * Re-pump shortly, for TRANSIENT dispatch failures (a bundled worker still
   * booting). One pending timer at a time; cleared on shutdown.
   */
  private scheduleQueueRetry(): void {
    if (this.queueRetryTimer) return;
    this.queueRetryTimer = setTimeout(() => {
      this.queueRetryTimer = undefined;
      void this.pump();
    }, QUEUE_RETRY_MS);
    // Never hold the process open just for a retry tick.
    this.queueRetryTimer.unref?.();
  }

  /** Stop the pending queue-retry timer (call on shutdown). */
  stopScheduler(): void {
    if (this.queueRetryTimer) {
      clearTimeout(this.queueRetryTimer);
      this.queueRetryTimer = undefined;
    }
  }

  /** Drop a project from the queue bookkeeping (in-memory only). */
  private forget(projectId: string): void {
    this.queued.delete(projectId);
    this.queue = this.queue.filter((id) => id !== projectId);
  }

  /** Remove a queued project and restore the status it had before queueing. */
  private async dequeue(projectId: string): Promise<void> {
    if (!this.queued.has(projectId)) return;
    this.forget(projectId);
    this.workloads.delete(projectId);
    dubRuns.dequeued(projectId);
    try {
      const project = await this.deps.store.getProject(projectId);
      await this.deps.store.saveProject({
        ...project,
        status: project.queue?.previousStatus ?? 'created',
        queue: undefined,
      });
    } catch {
      /* project vanished; nothing to restore */
    }
    void this.pump();
  }

  /**
   * Re-establish the queue from disk at startup: `queued` projects re-enter in
   * `queuedAt` order, and any project left `running` by a crash is demoted to
   * `paused` (conservative — the runner's artifact writes are not atomic, so
   * auto-resuming could treat a truncated artifact as complete). Best-effort.
   */
  /** GPU-backed engine families on this machine; never throws (classification must not fail). */
  private async gpuFamilies(): Promise<ReadonlySet<string>> {
    return (await this.deps.gpuEngineFamilies?.().catch(() => undefined)) ?? new Set<string>();
  }

  /**
   * Which optional engines can actually run here, for admission. Being wired is
   * not enough: the server always wires separation and alignment, and with
   * their packs disabled every "replace the voices" project took the heavy
   * lane (and held it to the end of the mix) for an engine that never ran.
   * A service without `available` is taken at its word. Never throws.
   */
  private async optionalEngines(): Promise<{ separationAvailable: boolean; alignmentAvailable: boolean }> {
    const can = async (service: { available?(): Promise<boolean> } | undefined): Promise<boolean> =>
      service ? ((await service.available?.().catch(() => false)) ?? true) : false;
    const [separationAvailable, alignmentAvailable] = await Promise.all([can(this.deps.separation), can(this.deps.alignment)]);
    this.lastOptionalEngines = { separationAvailable, alignmentAvailable };
    return this.lastOptionalEngines;
  }

  /** The last answer of {@link optionalEngines}, for startRun (which must not await). */
  private lastOptionalEngines: { separationAvailable: boolean; alignmentAvailable: boolean } | undefined;

  /**
   * The engine a run's context work will use (the first candidate that can
   * answer: a configured cloud or review model is taken to, the built-in chat
   * only when it is installed), for admission. Never throws.
   */
  private async contextEngineOf(settings: ProjectSettings): Promise<ContextCapableProvider | undefined> {
    for (const candidate of contextEngineCandidates(this.deps.registry, settings)) {
      if (candidate.id !== BUILT_IN_CHAT_PROVIDER_ID) return candidate;
      if (await this.deps.localChatAvailable?.().catch(() => false)) return candidate;
    }
    return undefined;
  }

  /** The steps of a queued or running dub that use a heavy engine (the download gate). */
  heavyStepsOf(projectId: string): readonly PipelineStepId[] {
    return this.workloads.get(projectId)?.heavySteps ?? [];
  }

  async reconcileQueue(opts: { resumeInterrupted?: boolean } = {}): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.deps.store.listProjects();
    } catch {
      return;
    }
    const queued = projects
      .filter((p) => p.status === 'queued' && p.queue)
      .sort((a, b) => (a.queue!.queuedAt < b.queue!.queuedAt ? -1 : 1));
    const gpuFamilies = await this.gpuFamilies();
    const engines = await this.optionalEngines();
    for (const p of queued) {
      if (this.queued.has(p.id) || this.running.has(p.id)) continue;
      const contextEngine = await this.contextEngineOf(p.settings);
      this.workloads.set(
        p.id,
        classifyWorkload(p.settings, this.deps.registry, {
          ...(p.queue?.fromStep ? { fromStep: p.queue.fromStep } : {}),
          ...engines,
          gpuFamilies,
          ...(contextEngine ? { contextEngine } : {}),
        }),
      );
      this.queue.push(p.id);
      this.queued.add(p.id);
      dubRuns.scheduled(p, { queued: true, restored: true, ...(p.queue?.fromStep ? { fromStep: p.queue.fromStep } : {}) });
    }
    // A dub the app died on (closed, the computer turned off) is paused, not
    // silently resumed. After a backend crash the shell restarted us for, the
    // dubs it interrupted continue by themselves, in the order they started
    // (the user's call, 2026-11-21): nobody asked them to stop.
    const interrupted: Project[] = [];
    for (const p of projects) {
      if (this.running.has(p.id) || this.queued.has(p.id)) continue;
      if (await this.settleStaleRun(p)) interrupted.push(p);
    }
    if (opts.resumeInterrupted) {
      interrupted.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
      for (const p of interrupted) {
        void runAsScheduler(() => this.runPipeline(p.id)).catch((err: unknown) =>
          this.deps.bus.get(p.id).emit({ type: 'error', error: toAppError(err) }),
        );
      }
    }
    if (this.queue.length > 0) void this.pump();
  }

  /**
   * A project saved as running that nothing runs (the app died mid-run): saved
   * as paused, and its pipeline too. The pipeline used to stay "running", which
   * the processing screen showed as a dub in progress with no way to continue
   * it. Best-effort; never throws.
   */
  private async settleStaleRun(project: Project): Promise<boolean> {
    const pipeline = await this.deps.store.getPipeline(project.id).catch(() => undefined);
    const stale = pipeline !== undefined && (pipeline.status === 'running' || pipeline.steps.some((s) => s.status === 'running'));
    if (stale) {
      const paused = pausePipelineState(pipeline);
      await this.deps.store.savePipeline(paused).catch(() => undefined);
      // A screen already open on it shows the live state over the saved one.
      this.deps.bus.get(project.id).emit({ type: 'state', pipeline: paused });
    }
    const wasRunning = project.status === 'running' || (stale && project.status !== 'paused');
    if (wasRunning) {
      await this.deps.store.saveProject({ ...project, status: 'paused' }).catch(() => undefined);
    }
    return wasRunning;
  }

  /** Live scheduler state for the UI (GET /queue). */
  async queueState(): Promise<QueueState> {
    const capacity = await this.effectiveCapacity();
    const prefs = await this.deps.setup?.getPreferences().catch(() => undefined);
    const paused = prefs?.concurrency?.paused === true;
    const names = new Map<string, string>();
    for (const id of [...this.running.keys(), ...this.queue]) {
      try {
        names.set(id, (await this.deps.store.getProject(id)).name);
      } catch {
        /* skip */
      }
    }
    const candidates = this.queue.map((projectId) => {
      const w = this.workloads.get(projectId);
      return {
        projectId,
        points: w?.points ?? POINTS_PER_LOCAL_RUN,
        needsHeavyEngine: w?.needsHeavyEngine ?? false,
        lightOnly: w?.lightOnly ?? false,
      };
    });
    const externalHeavyOwner = this.externalHeavyOwner();
    const { held } = decideAdmissions(candidates, this.runningRuns(), {
      budgetPoints: capacity.budgetPoints,
      paused,
      nameOf: (id) => names.get(id),
      pressure: this.deps.pressure?.() === true,
      ...(externalHeavyOwner ? { externalHeavyOwner } : {}),
    });
    return {
      maxProjects: capacity.maxProjects,
      budgetPoints: capacity.budgetPoints,
      usedPoints: this.runningRuns().reduce((sum, r) => sum + r.points, 0),
      paused,
      capacity,
      running: await Promise.all(
        [...this.running.keys()].map(async (projectId) => {
          const pipeline = await this.deps.store.getPipeline(projectId).catch(() => undefined);
          // From this run's own pace (activity/dubRuns.ts): the first step's
          // start belongs to the first run, and a 7-minute re-mix of a part
          // dubbed days ago showed ~8 h left (claude-dubber, 2026-11-24).
          const eta = dubRuns.etaOf(projectId);
          return {
            projectId,
            name: names.get(projectId) ?? projectId,
            heavy: this.workloads.get(projectId)?.needsHeavyEngine === true,
            ...(pipeline?.currentStep ? { step: pipeline.currentStep } : {}),
            ...(pipeline ? { progressPercent: Math.round(pipeline.progressPercent) } : {}),
            ...(eta !== undefined ? { etaSec: eta } : {}),
          };
        }),
      ),
      ...(this.deps.engines?.heavyLaneOwner() ? { laneOwner: this.deps.engines.heavyLaneOwner()! } : {}),
      entries: this.queue.map((projectId, i) => ({
        projectId,
        name: names.get(projectId) ?? projectId,
        position: i + 1,
        reason: held.get(projectId)?.reason ?? 'no-slot',
        message: held.get(projectId)?.message ?? 'Waiting for a free slot.',
      })),
    };
  }

  /** Re-evaluate the queue (e.g. after the user changed the limit or resumed). */
  async pumpQueue(): Promise<void> {
    await this.pump();
  }

  /**
   * Move a queued project to the head (rewrites its ordering key). Refused,
   * saying why, for a project that is not waiting: an agent asking to run a
   * part next learned nothing from a silent no-op.
   */
  async runNext(projectId: string): Promise<{ position: number }> {
    if (!this.queued.has(projectId)) {
      const project = await this.deps.store.getProject(projectId);
      throw new AppErrorException(
        'INVALID_EDIT',
        this.running.has(projectId) ? `"${project.name}" is dubbing already.` : `"${project.name}" is not waiting in the queue.`,
        { remediation: 'start_dubbing queues it; then run_next moves it to the front.' },
      );
    }
    const head = this.queue[0];
    if (head === projectId) return { position: 1 };
    const project = await this.deps.store.getProject(projectId);
    const headProject = head ? await this.deps.store.getProject(head).catch(() => undefined) : undefined;
    const headAt = headProject?.queue?.queuedAt ?? project.queue?.queuedAt ?? new Date().toISOString();
    const queuedAt = new Date(Date.parse(headAt) - 1).toISOString();
    await this.deps.store.saveProject({
      ...project,
      queue: { ...(project.queue ?? { previousStatus: 'created' }), queuedAt },
    });
    this.queue = [projectId, ...this.queue.filter((id) => id !== projectId)];
    void this.pump();
    return { position: this.queuePosition(projectId) };
  }

  /** Schedule and track a pipeline run. */
  /**
   * Start a run and register it in {@link running} SYNCHRONOUSLY (no `await`
   * before `this.running.set`) so the guards in runPipeline/retryStep are race
   * free. The actual work (mark-running + runner.run) executes in the stored
   * promise; errors are recorded by the runner (pipeline state + SSE), so we
   * swallow the promise rejection here to avoid an unhandled rejection.
   *
   * The run executes inside {@link withEngineOwner} so every heavy engine it
   * starts is attributed to this project — a concurrent run or an editor action
   * then gets ENGINE_BUSY instead of unloading this run's engine mid-request.
   */
  private startRun(project: Project, retryFromStep: PipelineStepId | undefined): void {
    const controller = new AbortController();
    const { runner, bus } = this.runnerDeps(project.id);

    // Past its last heavy step the run only mixes and renders: hand the heavy
    // lane to the next queued dub instead of holding it to the end (see
    // lastHeavyStep). Its engines stay warm until someone else needs the GPU.
    const handOver = lastHeavyStep(project.settings, {
      separationAvailable: this.lastOptionalEngines?.separationAvailable ?? this.deps.separation !== undefined,
    });
    const stopWatching = bus.subscribe((event) => {
      if (event.type !== 'step' || event.step.id !== handOver) return;
      if (event.step.status !== 'completed' && event.step.status !== 'skipped') return;
      const w = this.workloads.get(project.id);
      if (w?.needsHeavyEngine) this.workloads.set(project.id, { ...w, needsHeavyEngine: false });
      this.deps.engines?.releaseHeavyLane(project.id);
      void this.pump();
    });

    const promise = withEngineOwner(project.id, async () => {
      // Mark the project running immediately for snappy UI feedback.
      await this.deps.store.saveProject({ ...project, status: 'running', queue: undefined });
      await runner.run(
        project,
        retryFromStep ? { retryFromStep, signal: controller.signal } : { signal: controller.signal },
      );
      // A series parent that has analysed its video: plan the parts.
      if (project.series?.role === 'parent' && this.deps.seriesAnalysed) {
        const after = await this.deps.store.getProject(project.id).catch(() => undefined);
        if (after?.status === 'completed') void this.deps.seriesAnalysed(project.id);
      }
    })
      .finally(() => {
        stopWatching();
        dubRuns.ended(project.id);
        this.running.delete(project.id);
        this.workloads.delete(project.id);
        this.deps.engines?.releaseHeavyLane(project.id);
        // A slot just freed — dispatch whatever was waiting on it.
        void this.pump();
      })
      .catch(() => {
        /* runner records its own failure; nothing to do here */
      });

    this.running.set(project.id, { projectId: project.id, controller, promise });
  }

  /** Read transcript segments from a JSON artifact (or undefined if missing). */
  private async tryReadSegments(path: string): Promise<TranscriptSegment[] | undefined> {
    try {
      const raw = await fsp.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
      return Array.isArray(parsed) ? parsed : parsed.segments;
    } catch {
      return undefined;
    }
  }

  /** Read the synthesis-group plan (or undefined if missing/corrupt). */
  private async tryReadGroups(path: string): Promise<SynthesisGroup[] | undefined> {
    try {
      const raw = await fsp.readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as SynthesisGroupsArtifact;
      return Array.isArray(parsed.groups) ? parsed.groups : undefined;
    } catch {
      return undefined;
    }
  }

  /** Read aligned segments (or undefined if missing). */
  private async tryReadAligned(path: string): Promise<AlignedSegment[] | undefined> {
    try {
      const raw = await fsp.readFile(path, 'utf8');
      return JSON.parse(raw) as AlignedSegment[];
    } catch {
      return undefined;
    }
  }

  /** The aligner settings a project uses (one place, so every re-fit agrees). */
  private alignSettings(project: Project): AlignSettings {
    return {
      maxSpeedRatio: project.settings.maxSpeedRatio,
      allowedOverflowMs: project.settings.allowedOverflowMs,
    };
  }

  /**
   * Re-fit every synthesis unit, gap-aware, from the clip timings of the last
   * fit (overridden by `clips` for units just re-synthesized), and persist.
   *
   * Callers MUST hold the project's artifact lock. Returns undefined — and
   * writes nothing — when no alignment artifact exists yet: creating one with a
   * partial set of entries would make the alignment step look complete.
   */
  private async realign(
    project: Project,
    paths: WorkspacePaths,
    segments: readonly TranscriptSegment[],
    clips: ReadonlyMap<string, ClipTiming>,
  ): Promise<AlignedSegment[] | undefined> {
    const previous = await this.tryReadAligned(paths.translatedAlignedJson);
    const groups = await this.tryReadGroups(paths.synthesisGroupsJson);
    const units = reconcileGroups(groups ?? singletonUnits(segments), segments);
    if (groups) await writeJsonAtomic(paths.synthesisGroupsJson, { groups: units });
    if (!previous) return undefined;
    const prior = new Map(previous.map((a) => [a.segmentId, a]));
    const inputs = alignmentInputsForUnits(
      units,
      prior,
      (id) => paths.ttsSegment(segmentIdToIndex(id) || 1),
      clips,
    );
    const aligned = alignSegments(inputs, this.alignSettings(project), project.mediaInfo?.durationMs);
    await writeJsonAtomic(paths.translatedAlignedJson, aligned);
    return aligned;
  }

  /**
   * Regenerate the SRT/VTT sidecars from `segments`, REAPPLYING the persisted
   * voice-sync cue overrides so an edit doesn't revert the whole track to
   * source-speech timing. Atomic, like every other editor write.
   */
  private async writeSidecars(paths: WorkspacePaths, segments: readonly TranscriptSegment[]): Promise<void> {
    const [overrides, groups, units, songSubtitles] = await Promise.all([
      readCueOverrides(paths.cueTimingJson),
      this.tryReadGroups(paths.synthesisGroupsJson),
      this.tryReadAligned(paths.translatedAlignedJson),
      songSubtitlesOn(paths.projectJson),
    ]);
    const cues = displayCuesFor(segments, {
      overrides,
      ...(groups ? { groups } : {}),
      ...(units ? { units } : {}),
      songSubtitles,
    });
    await writeTextAtomic(paths.translatedSrt, segmentsToSrt(cues));
    await writeTextAtomic(paths.translatedVtt, segmentsToVtt(cues));
  }

  /** Write a project's subtitle files again from its lines as they are (a setting they follow changed). */
  async rewriteSubtitleFiles(projectId: string): Promise<void> {
    await this.artifactLock.run(projectId, async () => {
      const paths = this.deps.store.paths(projectId);
      const translated = await this.tryReadSegments(paths.translatedJson);
      if (translated) await this.writeSidecars(paths, translated);
      const source = await this.tryReadSegments(paths.sourceJson);
      if (source) {
        const songSubtitles = await songSubtitlesOn(paths.projectJson);
        await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(source, { songSubtitles })));
      }
    });
  }

  /**
   * Keep lines as the original song, or dub them again (MCP mark_song, the
   * editor; songs/songLines.ts). The flag lands in source.json (so a new
   * translation keeps it) and translated.json; a synthesis unit holding a
   * song line is cut around it and its other lines marked for re-voicing (its
   * clip said the song line too); the dub's fit is redone from the clips on
   * disk; the subtitle files follow; the edit history records it. Nothing is
   * synthesized here: the re-voicing is the editor's Regenerate, or the next
   * run from alignment.
   */
  async markSongs(
    projectId: string,
    request: SongMarkRequest,
    /** An undo from the history names itself (activity/undo.ts); else the default summary. */
    opts: { summary?: string; summaryKey?: string; summaryParams?: Record<string, string | number>; undoOf?: string } = {},
  ): Promise<SongMarkResult> {
    this.assertNotRunning(projectId, 'mark songs');
    return this.artifactLock.run(projectId, async () => {
      const project = await this.deps.store.getProject(projectId);
      const paths = this.deps.store.paths(projectId);
      const translated = await this.tryReadSegments(paths.translatedJson);
      const source = await this.tryReadSegments(paths.sourceJson);
      const base = translated ?? source;
      if (!base) throw new AppErrorException('INVALID_EDIT', 'This project has no transcript yet: songs are marked on its lines.');
      const targets = songTargets(base, request);
      const groups = await this.tryReadGroups(paths.synthesisGroupsJson);
      const marked = setSongFlags(base, new Set(targets.map((t) => t.id)), request.song, groups !== undefined);
      let lines = marked.lines;
      let revoice: string[] = [];
      if (marked.changed.length > 0) {
        if (groups) {
          const units = songUnits(groups, lines);
          if (units.changed) {
            revoice = units.revoice;
            const stale = new Set(revoice);
            lines = lines.map((l) => (stale.has(l.id) ? { ...l, ttsStale: true as const } : l));
            await writeJsonAtomic(paths.synthesisGroupsJson, { groups: units.groups });
            await clearCueOverridesFor(paths.cueTimingJson, units.touched);
          }
        }
        if (translated) await writeJsonAtomic(paths.translatedJson, { segments: lines });
        if (source) {
          const flagged = new Map(lines.map((l) => [l.id, isSong(l)]));
          const nextSource = source.map((s) => {
            const song = flagged.get(s.id);
            if (song === undefined || song === isSong(s)) return s;
            const { song: _song, ...rest } = s;
            return song ? { ...rest, song: true } : rest;
          });
          await writeJsonAtomic(paths.sourceJson, { segments: nextSource });
          const songSubtitles = await songSubtitlesOn(paths.projectJson);
          await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(nextSource, { songSubtitles })));
        }
        if (translated) {
          if (groups) await this.realign(project, paths, lines, new Map());
          await this.writeSidecars(paths, lines);
        }
        const first = targets[0];
        await recordEdit({
          projectId,
          target: translated ? 'translation' : 'source',
          summary:
            opts.summary ??
            (request.song
              ? `Kept ${marked.changed.length} line(s) as the original song${first ? ` at ${formatClock(first.startMs)}` : ''}`
              : `Dubbed ${marked.changed.length} song line(s) again${first ? ` at ${formatClock(first.startMs)}` : ''}`),
          ...(opts.summary
            ? opts.summaryKey
              ? { summaryKey: opts.summaryKey, ...(opts.summaryParams ? { summaryParams: opts.summaryParams } : {}) }
              : {}
            : {
                summaryKey: request.song ? 'history.summary.songs-kept' : 'history.summary.songs-dubbed',
                summaryParams: { n: marked.changed.length, at: first ? formatClock(first.startMs) : '' },
              }),
          ...(opts.undoOf ? { undoOf: opts.undoOf } : {}),
          before: base,
          after: lines,
        });
      }
      const span = (l: TranscriptSegment): { id: string; startMs: number; endMs: number } => ({ id: l.id, startMs: l.startMs, endMs: l.endMs });
      const changed = new Set(marked.changed);
      return {
        song: request.song,
        targets: targets.map(span),
        changed: targets.filter((t) => changed.has(t.id)).map(span),
        revoice,
        songs: lines.filter(isSong).length,
      };
    });
  }

  /**
   * Choose where a project saves its finished video and subtitles: a folder
   * (absolute path), or null for its own render/ folder in the app's data.
   * Files already rendered move with it, so the project stays complete; in a
   * chosen folder they are named after the project, uniquely there. Refused
   * while the project runs (the render may be writing them).
   */
  async setProjectOutputDir(projectId: string, dir: string | null): Promise<Project> {
    this.assertOutputIdle(projectId);
    const paths = this.deps.store.paths(projectId);
    const target = dir?.trim() ? await acceptOutputDir(dir) : paths.renderDir;
    const current = await this.deps.store.getProject(projectId);
    if (samePath(target, current.outputDir)) return current;
    if (!dir?.trim()) await fsp.mkdir(target, { recursive: true });
    // Again after the awaits, then held: no run or render may start (and
    // write to the old folder) while the files move.
    this.assertOutputIdle(projectId);
    this.movingOutput.add(projectId);
    try {
      const relocate = async (outputFileName: string | undefined): Promise<Project> => {
        const before = await this.deps.store.getProject(projectId);
        const where = { outputDir: target, ...(outputFileName ? { outputFileName } : {}) };
        const to = projectOutputFiles(where);
        await moveOutputFiles(projectOutputFiles(before).map((from, i) => [from, to[i]!] as const));
        // Only where it saves changes here: read again, so nothing saved
        // during a long cross-drive copy is overwritten.
        const { outputFileName: _old, ...latest } = await this.deps.store.getProject(projectId);
        return this.deps.store.saveProject({ ...latest, ...where });
      };
      if (samePath(target, paths.renderDir)) return await relocate(undefined);
      return await this.deps.store.withOutputName(target, current.name, current.settings.targetLanguage, projectId, relocate);
    } finally {
      this.movingOutput.delete(projectId);
    }
  }

  /**
   * A new name for a project that may have run already (a series part renamed
   * after it was made: series/seriesService.ts editPart). Nothing it has done
   * is reset. In a chosen folder its files follow the name, uniquely there,
   * and files already rendered are renamed along, as when the folder changes;
   * in its own folder they are output.* and stay. Refused while it runs; a
   * queued caller holds the queue (whileQueueHeld).
   */
  async renameProject(projectId: string, name: string): Promise<Project> {
    this.assertNotRunning(projectId, 'rename the project');
    this.assertNotMoving(projectId);
    const current = await this.deps.store.getProject(projectId);
    if (current.name === name) return current;
    const lang = current.settings.targetLanguage;
    // Only the name changes when its files keep theirs: its own folder, or a
    // new name that makes the same file name ("Phần 1" → "phần 1" on Windows).
    const sameFiles = !current.outputFileName || chosenOutputBaseName(name, lang, () => false).toLowerCase() === current.outputFileName.toLowerCase();
    if (sameFiles) return this.deps.store.saveProject({ ...current, name });
    this.movingOutput.add(projectId);
    try {
      return await this.deps.store.withOutputName(current.outputDir, name, lang, projectId, async (outputFileName) => {
        const before = await this.deps.store.getProject(projectId);
        const to = projectOutputFiles({ outputDir: before.outputDir, outputFileName });
        await moveOutputFiles(projectOutputFiles(before).map((from, i) => [from, to[i]!] as const));
        return this.deps.store.saveProject({ ...(await this.deps.store.getProject(projectId)), name, outputFileName });
      });
    } finally {
      this.movingOutput.delete(projectId);
    }
  }

  /** Changing where a project saves needs it idle: not running, waiting, rendering or already moving. */
  private assertOutputIdle(projectId: string): void {
    this.assertNotRunning(projectId, 'change where the project is saved');
    if (this.queued.has(projectId)) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        'This project is waiting in the dubbing queue. Remove it from the queue to change where it is saved.',
      );
    }
    if (this.movingOutput.has(projectId)) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        'This project is moving its files right now. Try again when that has finished.',
      );
    }
  }

  /** A run or render would write to the folder the project is leaving. */
  private assertNotMoving(projectId: string): void {
    if (this.movingOutput.has(projectId)) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        "VideoDubber is moving this project's finished files to another folder. Try again in a moment.",
      );
    }
  }

  /** True if a project currently has an active run. */
  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  /**
   * Refuse an editor mutation while the pipeline owns the same artifacts.
   *
   * `updateProjectSettings` has always guarded this way, but the editor's write
   * paths did not — they rewrite translated.json / synthesis_groups.json /
   * translated.aligned.json, the very files a running `stepTts`/`stepAlignment`
   * is writing, which produces audio that does not match the persisted text with
   * no error anywhere. A paused (awaiting-review) project is NOT running — the
   * run promise has settled — so review edits are unaffected.
   */
  private assertNotRunning(projectId: string, action: string): void {
    if (this.running.has(projectId)) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        `Cannot ${action} while the pipeline is running. Cancel the run first.`,
      );
    }
  }
}

/**
 * A project whose dub never started: created, and every step untouched. A run
 * the gate refused at Start changes neither (assertRunReady throws first).
 */
export function neverRun(project: Pick<Project, 'status'>, pipeline: Pick<PipelineState, 'steps' | 'pausedAt'>): boolean {
  return (
    project.status === 'created' &&
    !pipeline.pausedAt &&
    pipeline.steps.every((s) => s.status === 'pending' && s.progressPercent === 0 && !s.startedAt)
  );
}

/** "size:mtimeMs" of a file, or undefined when it does not exist. */
async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const s = await fsp.stat(file);
    return s.isFile() && s.size > 0 ? `${s.size}:${Math.round(s.mtimeMs)}` : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a JSON file, or undefined when it is missing or corrupt. */
async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

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
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  toAppError,
  segmentsToSrt,
  segmentsToVtt,
  transcriptSegmentsToCues,
  type AlignedSegment,
  type CreateProjectInput,
  type JobOrchestrator,
  type MediaInfo,
  type PipelineState,
  type PipelineStepId,
  type CapacityRecommendation,
  type Project,
  type ProjectQueueEntry,
  type ProjectSettings,
  type QueueState,
  type RunScheduleResult,
  type RenderFinalVideoResult,
  type SegmentPatch,
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
import { classifyWorkload, type RunWorkload } from './scheduler/workload.js';
import { effectiveCapacity, POINTS_PER_LOCAL_RUN, recommendCapacity } from './system/capacity.js';
import { getSystemProfile } from './system/systemProfile.js';
import type { SetupStore } from './setup/setupStore.js';
import type { EventBusRegistry} from './events.js';
import { type ProjectEventBus } from './events.js';
import { KeyedMutex } from './keyedMutex.js';
import { ProjectLogger } from './logging.js';
import type { PipelineMediaService, SeparationService } from './media.js';
import type { AlignmentService } from './providers/alignment/whisperxProvider.js';
import type { ProviderRegistry } from './providers/registry.js';
import { assertRunReady, type ProviderReadiness } from './providers/readiness.js';
import { PipelineRunner, type RunnerDeps } from './pipeline/runner.js';
import type { ProjectStore } from './workspace/projectStore.js';
import { segmentIdToIndex, type WorkspacePaths } from './workspace/paths.js';
import { applyCueOverrides, clearCueOverridesFor, readCueOverrides } from './workspace/subtitleTiming.js';
import { writeJsonAtomic, writeTextAtomic } from './workspace/projectStore.js';
import {
  alignmentInputsForUnits,
  applySegmentPatches,
  reconcileGroups,
  singletonUnits,
} from './workspace/timelineEdit.js';

/** Injected dependencies for the orchestrator (all mockable in tests). */
export interface OrchestratorDeps {
  config: OrchestratorConfig;
  store: ProjectStore;
  media: PipelineMediaService;
  registry: ProviderRegistry;
  bus: EventBusRegistry;
  /** Optional vocal-separation engine for the "replace-vocals" mix mode. */
  separation?: SeparationService;
  /** Optional forced-alignment/diarization engine for tighter timing. */
  alignment?: AlignmentService;
  /** Engine lifecycle manager, so a finished run releases its heavy-engine lane. */
  engines?: EngineManager;
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
  'roomTone',
  'renderQuality',
  'subtitleExportMode',
  'forcedAlignment',
  'diarize',
] as const satisfies readonly (keyof ProjectSettings)[];

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
  private pumpAgain = false;
  /** Memoized hardware capacity (specs don't change while the app runs). */
  private capacityPromise: Promise<CapacityRecommendation> | undefined;
  /** Pending re-pump for a transient dispatch failure (worker still booting). */
  private queueRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-flight editor actions per owner id, so the LAST one frees the lane. */
  private readonly editorLaneRefs = new Map<string, number>();
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

  constructor(private readonly deps: OrchestratorDeps) {}

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
    };
    return { runner: new PipelineRunner(deps), bus, logger };
  }

  // ----- JobOrchestrator contract ------------------------------------------

  /** Create a project workspace and persist its initial state. */
  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.deps.store.createProject(input);
  }

  /**
   * Start the pipeline for a project asynchronously (resumable). Returns once
   * the run is scheduled; progress is observed via SSE. Idempotent guard: a
   * second call while a run is active is a no-op.
   */
  async runPipeline(projectId: string): Promise<RunScheduleResult> {
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

  /** Pause == cancel for the MVP (the run can be re-started/resumed). */
  async pauseJob(jobId: string): Promise<void> {
    await this.cancelJob(jobId);
  }

  /**
   * Cancel a run. A RUNNING job is aborted between steps; a QUEUED one is
   * simply removed from the queue (nothing to abort) and its previous status
   * restored.
   */
  async cancelJob(jobId: string): Promise<void> {
    if (this.queued.has(jobId)) {
      await this.dequeue(jobId);
      return;
    }
    const job = this.running.get(jobId);
    if (!job) return;
    job.controller.abort(new AppErrorException('CANCELLED', 'Cancelled by user.'));
    try {
      await job.promise;
    } catch {
      /* the run handles its own errors */
    }
  }

  /** Reset a step + downstream and re-run from there (resumable retry). */
  async retryStep(projectId: string, stepId: PipelineStepId): Promise<RunScheduleResult> {
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
  ): Promise<{ project: Project; pipeline: PipelineState }> {
    if (this.running.has(projectId)) {
      throw new AppErrorException(
        'RUN_IN_PROGRESS',
        'Cannot change settings while the pipeline is running. Cancel the run first.',
      );
    }
    // Queued runs are frozen too: the scheduler classified this project's cost
    // (heavy engine? cloud-only?) at enqueue time, and letting the settings
    // change underneath would make that classification — and therefore the
    // queue's ordering decisions — silently wrong.
    if (this.queued.has(projectId)) {
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
    const saved = await this.deps.store.saveProject({
      ...project,
      settings: next,
      updatedAt: new Date().toISOString(),
    });
    const pipeline = await this.deps.store.getPipeline(projectId);
    return { project: saved, pipeline };
  }

  // ----- Extra API methods -------------------------------------------------

  /** Load a project together with its pipeline state. */
  async getProjectWithPipeline(projectId: string): Promise<{ project: Project; pipeline: PipelineState }> {
    const project = await this.deps.store.getProject(projectId);
    const pipeline = await this.deps.store.getPipeline(projectId);
    return { project, pipeline };
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
    const info = await this.deps.media.probe(project.inputVideoPath);
    if (!info.hasAudio || info.audioStreams.length === 0) {
      throw new AppErrorException('NO_AUDIO_STREAM', 'The input video has no audio stream to dub.');
    }
    await this.deps.store.saveProject({ ...project, mediaInfo: info });
    return info;
  }

  /**
   * Read the project's transcript segments, merged with alignment status if
   * alignment has run. Prefers `translated.json`, falling back to `source.json`.
   */
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
        return { ...s, translatedText: next, locked: true, ttsStale: true };
      });

      await writeJsonAtomic(paths.translatedJson, { segments: merged });
      await this.writeSidecars(paths, merged);
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
        ...((await exists(paths.outputMp4)) ? { outputPath: paths.outputMp4 } : {}),
      },
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
      const result = await media.renderFilmstrip!(project.inputVideoPath, paths.filmstripJpg, durationMs);
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
   * The path of a dub clip tempo-fitted to `ratio` (cached), for the editor's
   * preview. Validates the unit id (it becomes part of a file name) and clamps
   * the ratio to what the aligner can produce; the cache key includes the
   * clip's own size+mtime, so regenerating the line invalidates it, and older
   * fits of the same unit are deleted when a new one is written.
   */
  async getFittedClip(projectId: string, unitId: string, ratio: number): Promise<string> {
    const paths = this.deps.store.paths(projectId);
    const media = this.deps.media;
    if (!/^seg_\d{1,6}$/.test(unitId)) throw new AppErrorException('INVALID_EDIT', `Unknown clip ${unitId}.`);
    if (typeof media.renderFittedClip !== 'function') {
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'This build cannot preview fitted clips.');
    }
    const r = Math.round(Math.max(1, Math.min(4, Number.isFinite(ratio) ? ratio : 1)) * 1000) / 1000;
    const source = paths.ttsSegment(segmentIdToIndex(unitId) || 1);
    const stamp = await fileStamp(source);
    if (!stamp) throw new AppErrorException('TTS_VOICE_MISSING', `Clip ${unitId} has not been synthesized yet.`);
    if (r === 1) return source;
    const name = `${unitId}-r${r.toFixed(3)}-${stamp.replace(':', '-')}.wav`;
    const out = path.join(paths.fittedClipsDir, name);
    if (await fileStamp(out)) return out;
    return this.onceInFlight(`fitted:${projectId}:${name}`, async () => {
      await fsp.mkdir(paths.fittedClipsDir, { recursive: true });
      await media.renderFittedClip!(source, out, r);
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
  async patchSegments(projectId: string, patches: SegmentPatch[]): Promise<TimelineDocument> {
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

      const outcome = applySegmentPatches(base, patches, { durationMs: project.mediaInfo?.durationMs });
      if (
        !translated &&
        (outcome.textChanged.size > 0 || outcome.voiceChanged.size > 0 || outcome.rateChanged.size > 0)
      ) {
        throw new AppErrorException(
          'INVALID_EDIT',
          'Translate the transcript before editing translations or voices — only timing can be changed now.',
        );
      }
      const changed =
        outcome.textChanged.size +
        outcome.timingChanged.size +
        outcome.voiceChanged.size +
        outcome.rateChanged.size +
        outcome.lockChanged.size;
      if (changed === 0) return;

      if (translated) await writeJsonAtomic(paths.translatedJson, { segments: outcome.segments });

      if (outcome.timingChanged.size > 0) {
        // Timing also lands in source.json: re-translating rebuilds translated.json
        // FROM source.json, and must not snap every line back to the recogniser's
        // timing the user just corrected.
        if (source) {
          const byId = new Map(outcome.segments.map((s) => [s.id, s]));
          await writeJsonAtomic(paths.sourceJson, {
            segments: source.map((s) => {
              const n = byId.get(s.id);
              return n ? { ...s, startMs: n.startMs, endMs: n.endMs } : s;
            }),
          });
        }
        await this.realign(project, paths, outcome.segments, new Map());
        // A cue the user placed by hand is shown where they put it, not where the
        // voice-sync pass would put it.
        await clearCueOverridesFor(paths.cueTimingJson, [...outcome.timingChanged]);
      }
      if (outcome.timingChanged.size > 0 || outcome.textChanged.size > 0) {
        await this.writeSidecars(paths, outcome.segments);
      }
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
    const owner = `editor:${projectId}`;
    this.editorLaneRefs.set(owner, (this.editorLaneRefs.get(owner) ?? 0) + 1);
    try {
      return await withEngineOwner(owner, fn);
    } finally {
      const remaining = (this.editorLaneRefs.get(owner) ?? 1) - 1;
      if (remaining > 0) {
        this.editorLaneRefs.set(owner, remaining);
      } else {
        this.editorLaneRefs.delete(owner);
        this.deps.engines?.releaseHeavyLane(owner);
        // The lane may now be free for a queued heavy dub.
        void this.pump();
      }
    }
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
      const durations = new Map(synthesized.map((s) => [s.segmentId, s.durationMs]));
      const placed = await this.realign(project, paths, merged, durations);
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
            durations,
          ),
          this.alignSettings(project),
          project.mediaInfo?.durationMs,
        )[0]!
      );
    });

    return { segment: ttsSegment, alignment };
  }

  /**
   * "Tighten to fit" one segment: re-translate it with a tighter word budget (by
   * handing the LLM a shrunk window, which lowers the prompt's target), then
   * re-synthesize + re-align via {@link synthesizeSingleSegment}. The editor uses
   * this on a flagged line. A provider that can't shorten (Argos) returns the
   * same text, so we keep the existing translation and just re-synthesize.
   */
  async refitSegment(
    projectId: string,
    segmentId: string,
  ): Promise<{ segment: TtsSegment; alignment: AlignedSegment; translatedText: string }> {
    this.assertNotRunning(projectId, 'tighten a segment');
    // Same engine-ownership rule as synthesizeSingleSegment: this re-translates
    // (possibly on a heavy local LLM) before re-synthesizing.
    return this.withEditorLane(projectId, () => this.refitSegmentImpl(projectId, segmentId));
  }

  private async refitSegmentImpl(
    projectId: string,
    segmentId: string,
  ): Promise<{ segment: TtsSegment; alignment: AlignedSegment; translatedText: string }> {
    const project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);
    const segments =
      (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];
    const idx = segments.findIndex((s) => s.id === segmentId);
    const seg = idx >= 0 ? segments[idx] : undefined;
    if (!seg) {
      throw new AppErrorException('UNKNOWN', `Segment not found: ${segmentId}`);
    }

    // Gap-aware window: this line may use the silence until the next line starts
    // (or the end of the media for the last line). Target the max-speed window so
    // the new line fits with the same atempo headroom the aligner allows.
    const next = segments[idx + 1];
    const endSlot = next ? next.startMs : ((await this.deps.store.getProject(projectId)).mediaInfo?.durationMs ?? seg.endMs);
    const availableMs = Math.max(1, endSlot - seg.startMs);
    const tightMs = Math.max(500, Math.round(availableMs * Math.max(1, project.settings.maxSpeedRatio)));

    const translation = this.deps.registry.getTranslation(project.settings.translationProviderId);
    const documentContext = (await this.getTranslationContext(projectId)) ?? undefined;
    const result = await translation.translateSegments({
      sourceLanguage: project.settings.sourceLanguage,
      targetLanguage: project.settings.targetLanguage,
      segments: [{ id: segmentId, sourceText: seg.sourceText, startMs: 0, endMs: tightMs }],
      ...(documentContext ? { documentContext } : {}),
    });
    const proposed = (result.segments[0]?.translatedText ?? '').trim();
    const finalText =
      proposed && proposed !== (seg.translatedText ?? '') ? proposed : (seg.translatedText ?? seg.sourceText ?? '');

    // Persist the shortened text + re-synthesize + re-align (handled inside).
    const { segment, alignment } = await this.synthesizeSingleSegmentImpl(projectId, segmentId, { text: finalText });
    return { segment, alignment, translatedText: finalText };
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
              .map((c) => ({ name: c.name.trim(), ...(c.role?.trim() ? { role: c.role.trim() } : {}) })),
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
    await fsp.writeFile(paths.translationContextJson, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    return clean;
  }

  /**
   * Render the final video. Optional overrides update the project settings
   * (subtitle export mode / burn style) before delegating to the runner's
   * render step semantics.
   */
  async renderFinalVideo(
    projectId: string,
    opts: { subtitleExportMode?: Project['settings']['subtitleExportMode']; burnSubtitleStyle?: Project['settings']['burnSubtitleStyle'] },
  ): Promise<RenderFinalVideoResult> {
    let project = await this.deps.store.getProject(projectId);
    const paths = this.deps.store.paths(projectId);

    // Apply overrides to settings (persisted so subsequent runs are consistent).
    if (opts.subtitleExportMode !== undefined || opts.burnSubtitleStyle !== undefined) {
      project = await this.deps.store.saveProject({
        ...project,
        settings: {
          ...project.settings,
          ...(opts.subtitleExportMode !== undefined ? { subtitleExportMode: opts.subtitleExportMode } : {}),
          ...(opts.burnSubtitleStyle !== undefined ? { burnSubtitleStyle: opts.burnSubtitleStyle } : {}),
        },
      });
    }

    const mode = project.settings.subtitleExportMode;
    const subtitlePath =
      mode === 'vtt-file'
        ? paths.translatedVtt
        : mode === 'srt-file' || mode === 'embedded-soft' || mode === 'burned-in'
          ? paths.translatedSrt
          : undefined;

    return this.deps.media.renderFinalVideo({
      inputVideoPath: project.inputVideoPath,
      audioPath: paths.finalMixWav,
      outputPath: paths.outputMp4,
      subtitleExportMode: mode,
      subtitlePath,
      burnSubtitleStyle: project.settings.burnSubtitleStyle,
      copyVideoStream: mode !== 'burned-in',
    });
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
    const workload = classifyWorkload(project.settings, this.deps.registry, {
      fromStep: retryFromStep,
      separationAvailable: this.deps.separation !== undefined,
      alignmentAvailable: this.deps.alignment !== undefined,
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
    const decision =
      this.queue.length > 0
        ? { start: [] as string[] }
        : decideAdmissions(
            [{ projectId: project.id, points: workload.points, needsHeavyEngine: workload.needsHeavyEngine }],
            this.runningRuns(),
            {
              budgetPoints: capacity.budgetPoints,
              paused: prefs?.concurrency?.paused === true,
              ...(this.externalHeavyOwner() ? { externalHeavyOwner: this.externalHeavyOwner() } : {}),
            },
          );

    if (decision.start.includes(project.id)) {
      this.workloads.set(project.id, workload);
      this.startRun(project, retryFromStep);
      return { started: true, queued: false };
    }

    // No room: persist the queue entry FIRST (project.json is written
    // atomically, so the queue survives a restart with no second source of
    // truth), then register in memory — a failed write must not leave a
    // phantom queue entry the user cannot see or cancel.
    const entry: ProjectQueueEntry = {
      queuedAt: new Date().toISOString(),
      previousStatus: project.status,
      ...(retryFromStep ? { fromStep: retryFromStep } : {}),
    };
    await this.deps.store.saveProject({ ...project, status: 'queued', queue: entry });
    if (this.running.has(project.id) || this.queued.has(project.id)) {
      return { started: false, queued: true, position: this.queuePosition(project.id) };
    }
    this.workloads.set(project.id, workload);
    this.queue.push(project.id);
    this.queued.add(project.id);
    return { started: false, queued: true, position: this.queuePosition(project.id) };
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
    if (this.queue.length === 0) return false;

    const capacity = await this.effectiveCapacity();
    const prefs = await this.deps.setup?.getPreferences().catch(() => undefined);
    const candidates = this.queue.map((projectId) => {
      const w = this.workloads.get(projectId);
      return {
        projectId,
        points: w?.points ?? POINTS_PER_LOCAL_RUN,
        needsHeavyEngine: w?.needsHeavyEngine ?? false,
      };
    });
    const externalHeavyOwner = this.externalHeavyOwner();
    const decision = decideAdmissions(candidates, this.runningRuns(), {
      budgetPoints: capacity.budgetPoints,
      paused: prefs?.concurrency?.paused === true,
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
  async reconcileQueue(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.deps.store.listProjects();
    } catch {
      return;
    }
    const queued = projects
      .filter((p) => p.status === 'queued' && p.queue)
      .sort((a, b) => (a.queue!.queuedAt < b.queue!.queuedAt ? -1 : 1));
    for (const p of queued) {
      if (this.queued.has(p.id) || this.running.has(p.id)) continue;
      this.workloads.set(
        p.id,
        classifyWorkload(p.settings, this.deps.registry, {
          ...(p.queue?.fromStep ? { fromStep: p.queue.fromStep } : {}),
          separationAvailable: this.deps.separation !== undefined,
          alignmentAvailable: this.deps.alignment !== undefined,
        }),
      );
      this.queue.push(p.id);
      this.queued.add(p.id);
    }
    for (const p of projects) {
      if (p.status === 'running' && !this.running.has(p.id)) {
        await this.deps.store.saveProject({ ...p, status: 'paused' }).catch(() => undefined);
      }
    }
    if (this.queue.length > 0) void this.pump();
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
      };
    });
    const externalHeavyOwner = this.externalHeavyOwner();
    const { held } = decideAdmissions(candidates, this.runningRuns(), {
      budgetPoints: capacity.budgetPoints,
      paused,
      nameOf: (id) => names.get(id),
      ...(externalHeavyOwner ? { externalHeavyOwner } : {}),
    });
    return {
      maxProjects: capacity.maxProjects,
      budgetPoints: capacity.budgetPoints,
      usedPoints: this.runningRuns().reduce((sum, r) => sum + r.points, 0),
      paused,
      capacity,
      running: [...this.running.keys()].map((projectId) => ({
        projectId,
        name: names.get(projectId) ?? projectId,
        heavy: this.workloads.get(projectId)?.needsHeavyEngine === true,
      })),
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

  /** Move a queued project to the head (rewrites its ordering key). */
  async runNext(projectId: string): Promise<void> {
    if (!this.queued.has(projectId)) return;
    const head = this.queue[0];
    if (head === projectId) return;
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
    const { runner } = this.runnerDeps(project.id);

    const promise = withEngineOwner(project.id, async () => {
      // Mark the project running immediately for snappy UI feedback.
      await this.deps.store.saveProject({ ...project, status: 'running', queue: undefined });
      await runner.run(
        project,
        retryFromStep ? { retryFromStep, signal: controller.signal } : { signal: controller.signal },
      );
    })
      .finally(() => {
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

  /** Persist the synthesis-group plan. */
  private async writeGroups(path: string, groups: SynthesisGroup[]): Promise<void> {
    const artifact: SynthesisGroupsArtifact = { groups };
    await fsp.writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
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
   * Re-fit every synthesis unit, gap-aware, from the clip durations already on
   * disk (overridden by `durations` for units just re-synthesized), and persist.
   *
   * Callers MUST hold the project's artifact lock. Returns undefined — and
   * writes nothing — when no alignment artifact exists yet: creating one with a
   * partial set of entries would make the alignment step look complete.
   */
  private async realign(
    project: Project,
    paths: WorkspacePaths,
    segments: readonly TranscriptSegment[],
    durations: ReadonlyMap<string, number>,
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
      durations,
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
    const overrides = await readCueOverrides(paths.cueTimingJson);
    const cues = transcriptSegmentsToCues(applyCueOverrides([...segments], overrides));
    await writeTextAtomic(paths.translatedSrt, segmentsToSrt(cues));
    await writeTextAtomic(paths.translatedVtt, segmentsToVtt(cues));
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

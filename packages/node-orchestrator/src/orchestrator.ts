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
  type SystemProfile,
  type TranscriptSegment,
  type TranslationDocContext,
  type TtsSegment,
} from '@videodubber/shared';
import { alignSegment, type AlignInputSegment } from './alignment/align.js';
import type { SynthesisGroup, SynthesisGroupsArtifact } from './pipeline/grouping.js';
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
import { ProjectLogger } from './logging.js';
import type { PipelineMediaService, SeparationService } from './media.js';
import type { AlignmentService } from './providers/alignment/whisperxProvider.js';
import type { ProviderRegistry } from './providers/registry.js';
import { assertRunReady, type ProviderReadiness } from './providers/readiness.js';
import { PipelineRunner, type RunnerDeps } from './pipeline/runner.js';
import type { ProjectStore } from './workspace/projectStore.js';
import { segmentIdToIndex, type WorkspacePaths } from './workspace/paths.js';
import { applyCueOverrides, clearCueOverridesFor, readCueOverrides } from './workspace/subtitleTiming.js';

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
   */
  async saveTranslatedSegments(
    projectId: string,
    edits: { id: string; translatedText: string }[],
  ): Promise<void> {
    const paths = this.deps.store.paths(projectId);
    const base =
      (await this.tryReadSegments(paths.translatedJson)) ?? (await this.tryReadSegments(paths.sourceJson)) ?? [];

    const editMap = new Map(edits.map((e) => [e.id, e.translatedText]));
    const merged: TranscriptSegment[] = base.map((s) =>
      editMap.has(s.id) ? { ...s, translatedText: editMap.get(s.id)! } : s,
    );

    await fsp.writeFile(paths.translatedJson, `${JSON.stringify({ segments: merged }, null, 2)}\n`, 'utf8');

    // Regenerate subtitle sidecars to keep them in sync with edits — REAPPLYING
    // the persisted voice-sync cue overrides so a text edit doesn't revert the
    // whole track to source-speech timing.
    const overrides = await readCueOverrides(paths.cueTimingJson);
    const cues = transcriptSegmentsToCues(applyCueOverrides(merged, overrides));
    await fsp.writeFile(paths.translatedSrt, segmentsToSrt(cues), 'utf8');
    await fsp.writeFile(paths.translatedVtt, segmentsToVtt(cues), 'utf8');
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
    const memberInputs = (group ? group.segmentIds : [segmentId]).map((id) => {
      const s = id === segmentId ? segment : segments.find((x) => x.id === id);
      return {
        id,
        text: id === segmentId ? text : (s?.translatedText ?? s?.sourceText ?? '').trim(),
        startMs: s?.startMs ?? segment.startMs,
        endMs: s?.endMs ?? segment.endMs,
      };
    });

    // Voice precedence: explicit override > the speaker's assigned voice
    // (diarized projects) > the project voice.
    const assignedVoice = segment.speakerId
      ? project.settings.speakerVoices?.find((v) => v.speakerId === segment.speakerId)?.voiceId
      : undefined;
    const result = await provider.synthesizeSegments({
      language: project.settings.targetLanguage,
      voiceId: opts.voiceId ?? assignedVoice ?? project.settings.ttsVoiceId,
      segments: memberInputs,
      outputDir: paths.ttsSegmentsDir,
      speed: opts.speed ?? 1.0,
    });

    const ttsSegment = result.segments.find((s) => s.segmentId === segmentId);
    if (!ttsSegment) {
      throw new AppErrorException('UNKNOWN', `TTS produced no output for segment ${segmentId}.`);
    }

    // Persist the degrouped plan (each former member is its own singleton now)
    // and give the OTHER members fresh alignment entries; the edited segment's
    // own entry is patched below.
    if (group && groups) {
      const replacement: SynthesisGroup[] = group.segmentIds.map((id) => {
        const input = memberInputs.find((m) => m.id === id)!;
        return { id, segmentIds: [id], text: input.text, startMs: input.startMs, endMs: input.endMs };
      });
      const nextGroups = groups.flatMap((g) => (g === group ? replacement : [g]));
      await this.writeGroups(paths.synthesisGroupsJson, nextGroups);
      // The former group is now singletons: each member speaks from its own
      // cue, so its voice-sync override no longer applies — drop them, and
      // saveTranslatedSegments (below) regenerates sidecars with the rest.
      await clearCueOverridesFor(paths.cueTimingJson, group.segmentIds);

      for (const member of result.segments) {
        if (member.segmentId === segmentId) continue;
        const input = memberInputs.find((m) => m.id === member.segmentId);
        if (!input) continue;
        const idx = segmentIdToIndex(member.segmentId);
        const memberAligned = alignSegment(
          {
            segmentId: member.segmentId,
            startMs: input.startMs,
            endMs: input.endMs,
            audioPath: idx > 0 ? paths.ttsSegment(idx) : member.audioPath,
            generatedDurationMs: member.durationMs,
          },
          {
            maxSpeedRatio: project.settings.maxSpeedRatio,
            allowedOverflowMs: project.settings.allowedOverflowMs,
          },
        );
        await this.patchAlignedSegment(paths, memberAligned);
      }
    }

    // If text was edited, persist it back to translated.json too.
    if (opts.text !== undefined) {
      await this.saveTranslatedSegments(projectId, [{ id: segmentId, translatedText: text }]);
    }

    // Recompute alignment for just this segment and patch the aligned file.
    const index = segmentIdToIndex(segmentId);
    const audioPath = paths.ttsSegment(index > 0 ? index : segment.index + 1);
    const alignInput: AlignInputSegment = {
      segmentId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      audioPath,
      generatedDurationMs: ttsSegment.durationMs,
    };
    const alignment = alignSegment(alignInput, {
      maxSpeedRatio: project.settings.maxSpeedRatio,
      allowedOverflowMs: project.settings.allowedOverflowMs,
    });

    await this.patchAlignedSegment(paths, alignment);

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

  /** Update a single aligned segment within translated.aligned.json. */
  private async patchAlignedSegment(paths: WorkspacePaths, alignment: AlignedSegment): Promise<void> {
    const existing = (await this.tryReadAligned(paths.translatedAlignedJson)) ?? [];
    const idx = existing.findIndex((a) => a.segmentId === alignment.segmentId);
    if (idx >= 0) existing[idx] = alignment;
    else existing.push(alignment);
    await fsp.writeFile(paths.translatedAlignedJson, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  }

  /** True if a project currently has an active run. */
  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }
}

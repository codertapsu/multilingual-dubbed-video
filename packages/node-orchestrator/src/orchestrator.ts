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
  segmentsToSrt,
  segmentsToVtt,
  transcriptSegmentsToCues,
  type AlignedSegment,
  type CreateProjectInput,
  type JobOrchestrator,
  type MediaInfo,
  type PipelineState,
  type PipelineStepId,
  type Project,
  type RenderFinalVideoResult,
  type TranscriptSegment,
  type TtsSegment,
} from '@videodubber/shared';
import { alignSegment, type AlignInputSegment } from './alignment/align.js';
import type { OrchestratorConfig } from './config.js';
import type { EventBusRegistry} from './events.js';
import { type ProjectEventBus } from './events.js';
import { ProjectLogger } from './logging.js';
import type { PipelineMediaService } from './media.js';
import type { ProviderRegistry } from './providers/registry.js';
import { PipelineRunner, type RunnerDeps } from './pipeline/runner.js';
import type { ProjectStore } from './workspace/projectStore.js';
import { segmentIdToIndex, type WorkspacePaths } from './workspace/paths.js';

/** Injected dependencies for the orchestrator (all mockable in tests). */
export interface OrchestratorDeps {
  config: OrchestratorConfig;
  store: ProjectStore;
  media: PipelineMediaService;
  registry: ProviderRegistry;
  bus: EventBusRegistry;
}

/** A tracked, in-flight pipeline run. */
interface RunningJob {
  projectId: string;
  controller: AbortController;
  promise: Promise<void>;
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
  async runPipeline(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return;
    const project = await this.deps.store.getProject(projectId);
    // Re-check after the await: a concurrent run() request may have started one
    // while we were loading the project. startRun() then registers the job
    // synchronously (no await before this.running.set), so this guard is safe.
    if (this.running.has(projectId)) return;
    this.startRun(project, undefined);
  }

  /** Pause == cancel for the MVP (the run can be re-started/resumed). */
  async pauseJob(jobId: string): Promise<void> {
    await this.cancelJob(jobId);
  }

  /** Cancel an in-flight run (the AbortController stops it between steps). */
  async cancelJob(jobId: string): Promise<void> {
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
  async retryStep(projectId: string, stepId: PipelineStepId): Promise<void> {
    if (this.running.has(projectId)) {
      // Cancel the current run before retrying to avoid overlap.
      await this.cancelJob(projectId);
    }
    const project = await this.deps.store.getProject(projectId);
    this.startRun(project, stepId);
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

    // Regenerate subtitle sidecars to keep them in sync with edits.
    const cues = transcriptSegmentsToCues(merged);
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

    const result = await provider.synthesizeSegments({
      language: project.settings.targetLanguage,
      voiceId: opts.voiceId ?? project.settings.ttsVoiceId,
      segments: [{ id: segmentId, text, startMs: segment.startMs, endMs: segment.endMs }],
      outputDir: paths.ttsSegmentsDir,
      speed: opts.speed ?? 1.0,
    });

    const ttsSegment = result.segments[0];
    if (!ttsSegment) {
      throw new AppErrorException('UNKNOWN', `TTS produced no output for segment ${segmentId}.`);
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

  /** Schedule and track a pipeline run. */
  /**
   * Start a run and register it in {@link running} SYNCHRONOUSLY (no `await`
   * before `this.running.set`) so the guards in runPipeline/retryStep are race
   * free. The actual work (mark-running + runner.run) executes in the stored
   * promise; errors are recorded by the runner (pipeline state + SSE), so we
   * swallow the promise rejection here to avoid an unhandled rejection.
   */
  private startRun(project: Project, retryFromStep: PipelineStepId | undefined): void {
    const controller = new AbortController();
    const { runner } = this.runnerDeps(project.id);

    const promise = (async () => {
      // Mark the project running immediately for snappy UI feedback.
      await this.deps.store.saveProject({ ...project, status: 'running' });
      await runner.run(
        project,
        retryFromStep ? { retryFromStep, signal: controller.signal } : { signal: controller.signal },
      );
    })()
      .finally(() => {
        this.running.delete(project.id);
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

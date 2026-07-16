/**
 * The PipelineRunner: executes the 8 dubbing steps sequentially with
 * persistence, SSE progress, resumability, and cancellation.
 *
 * Steps (in order):
 *   probe-video     -> media.probe; persist mediaInfo; NO_AUDIO_STREAM check
 *   extract-audio   -> original.wav (full) + original_16k_mono.wav (for STT)
 *   stt             -> transcribe 16k mono -> source.json + source.srt
 *   translation     -> translate segments -> translated.json/.srt/.vtt
 *   tts             -> group cues into utterances (synthesis_groups.json) ->
 *                      synthesize each utterance -> tts_segments/*.wav
 *   alignment       -> align timing (per utterance; native-rate refit when the
 *                      engine supports it) -> translated.aligned.json
 *   audio-mix       -> buildTtsTimeline (rubberband/atempo + micro-fades) ->
 *                      tts_full.wav -> duckAndMix (room tone) -> final_mix.wav
 *   render          -> renderFinalVideo per subtitleExportMode -> render/output.mp4 (+ sidecars)
 *
 * RESUMABILITY: before each step, if its output artifact(s) already exist and
 * the step was previously completed, it is marked `skipped` (unless this run is
 * a retry starting at or before that step). pipeline.json is persisted after
 * every transition.
 *
 * CANCELLATION: a per-run flag + AbortController is checked between (and
 * during) steps. Cancelling throws/propagates CANCELLED and leaves the current
 * step `failed` with a CANCELLED error, so it can be retried.
 *
 * Everything is dependency-injected (store, media, registry, event bus) so the
 * runner is fully testable without ffmpeg or live workers.
 */
import fsp from 'node:fs/promises';
import {
  AppErrorException,
  setStepStatus,
  toAppError,
  toWhisperLanguage,
  transcriptSegmentsToCues,
  segmentsToSrt,
  segmentsToVtt,
  PIPELINE_STEP_IDS,
  pipelineStepIndex,
  pipelineStepLabel,
  type AlignedSegment,
  type PipelineState,
  type PipelineStepId,
  type Project,
  type TranscriptSegment,
  type TranslationDocContext,
} from '@videodubber/shared';
import { alignSegments, summarizeAlignment, type AlignInputSegment } from '../alignment/align.js';
import {
  planSynthesisGroups,
  singletonGroups,
  voiceForGroup,
  type SynthesisGroup,
  type SynthesisGroupsArtifact,
} from './grouping.js';
import type { ProjectEventBus } from '../events.js';
import type { ProjectLogger } from '../logging.js';
import type { PipelineMediaService, SeparationService, TimelineSegmentInput } from '../media.js';
import type { AlignmentService } from '../providers/alignment/whisperxProvider.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProjectStore } from '../workspace/projectStore.js';
import { fileExistsNonEmpty, padSegmentIndex, segmentIdToIndex, type WorkspacePaths } from '../workspace/paths.js';

/** Dependencies injected into the runner (mockable in tests). */
export interface RunnerDeps {
  store: ProjectStore;
  media: PipelineMediaService;
  registry: ProviderRegistry;
  bus: ProjectEventBus;
  logger: ProjectLogger;
  /**
   * Optional source-separation engine (vocal/M&E split) for the
   * "replace-vocals" mix mode. Absent => that mode falls back to ducking.
   */
  separation?: SeparationService;
  /**
   * Optional forced-alignment/diarization engine. Absent => forcedAlignment /
   * diarize settings are skipped with a warning.
   */
  alignment?: AlignmentService;
  /**
   * Long-video STT chunking knobs. Audio longer than `sttChunkThresholdMs` is
   * transcribed in `sttChunkWindowMs` windows (bounded requests + per-chunk
   * checkpoints + progress). Defaults: 10-min windows above a 15-min threshold
   * (also overridable via STT_CHUNK_WINDOW_MS / STT_CHUNK_THRESHOLD_MS).
   */
  sttChunkWindowMs?: number;
  sttChunkThresholdMs?: number;
}

/** Options controlling a single run. */
export interface RunOptions {
  /**
   * When set, the run is a retry starting from this step: this step and all
   * downstream steps are forced to re-execute (no skipping), regardless of
   * existing artifacts.
   */
  retryFromStep?: PipelineStepId;
  /** External cancellation signal. */
  signal: AbortSignal;
}

/** Persist + emit a state transition for a single step. */
async function transition(
  deps: RunnerDeps,
  state: PipelineState,
  stepId: PipelineStepId,
  status: Parameters<typeof setStepStatus>[2],
  patch?: Parameters<typeof setStepStatus>[3],
): Promise<PipelineState> {
  const next = setStepStatus(state, stepId, status, patch);
  await deps.store.savePipeline(next);
  deps.bus.emit({ type: 'state', pipeline: next });
  const step = next.steps.find((s) => s.id === stepId);
  if (step) deps.bus.emit({ type: 'step', step });
  return next;
}

/** Throw CANCELLED if the run has been aborted. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AppErrorException('CANCELLED', 'Pipeline run was cancelled.');
  }
}

/** Read transcript segments from a JSON artifact (source/translated). */
async function readSegments(path: string): Promise<TranscriptSegment[]> {
  const raw = await fsp.readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
  if (Array.isArray(parsed)) return parsed;
  return parsed.segments ?? [];
}

/** Write transcript segments to a JSON artifact. */
async function writeSegments(path: string, segments: TranscriptSegment[]): Promise<void> {
  await fsp.writeFile(path, `${JSON.stringify({ segments }, null, 2)}\n`, 'utf8');
}

/** Read the persisted translation character sheet (undefined when absent/corrupt). */
async function readDocContext(path: string): Promise<TranslationDocContext | undefined> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as TranslationDocContext;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the translation character sheet. */
async function writeDocContext(path: string, ctx: TranslationDocContext): Promise<void> {
  await fsp.writeFile(path, `${JSON.stringify(ctx, null, 2)}\n`, 'utf8');
}

/** Read the synthesis-group plan artifact (undefined when absent/corrupt). */
async function readGroups(path: string): Promise<SynthesisGroup[] | undefined> {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SynthesisGroupsArtifact;
    return Array.isArray(parsed.groups) ? parsed.groups : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the synthesis-group plan artifact. */
async function writeGroups(path: string, groups: SynthesisGroup[]): Promise<void> {
  const artifact: SynthesisGroupsArtifact = { groups };
  await fsp.writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

/** Map segments to the planner's input shape (text = what TTS will speak). */
function toGroupInputs(segments: readonly TranscriptSegment[]): {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
}[] {
  return segments.map((s) => ({
    id: s.id,
    startMs: s.startMs,
    endMs: s.endMs,
    text: (s.translatedText ?? s.sourceText ?? '').trim(),
    ...(s.speakerId ? { speakerId: s.speakerId } : {}),
  }));
}

/** Progress callback for a long-running step (fraction in 0..1). */
export type StepProgress = (fraction: number) => Promise<void>;

/** Parse a positive-int env var with a fallback (local, to avoid a config import). */
function envIntMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Default STT chunk window / threshold (overridable via env or RunnerDeps). */
const DEFAULT_STT_CHUNK_WINDOW_MS = envIntMs('STT_CHUNK_WINDOW_MS', 10 * 60_000);
const DEFAULT_STT_CHUNK_THRESHOLD_MS = envIntMs('STT_CHUNK_THRESHOLD_MS', 15 * 60_000);

/** A single STT time-window to transcribe independently. */
export interface SttChunk {
  index: number;
  startMs: number;
  endMs: number;
}

/**
 * Split a total audio duration into bounded transcription windows. Audio at or
 * below `thresholdMs` returns a single whole-file chunk (no extra clip pass);
 * longer audio is cut into fixed `windowMs` windows with no overlap. With ≤14
 * boundaries for a 2-hour video the boundary-word risk is negligible, while the
 * win is large: each request is bounded (so the worker timeout always suffices),
 * each chunk is checkpointed (crash-resumable), progress is reported per chunk,
 * and peak memory stays at one window rather than the whole file.
 */
export function planSttChunks(totalDurationMs: number, windowMs: number, thresholdMs: number): SttChunk[] {
  if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0 || windowMs <= 0 || totalDurationMs <= thresholdMs) {
    return [{ index: 0, startMs: 0, endMs: Math.max(0, totalDurationMs) }];
  }
  const chunks: SttChunk[] = [];
  for (let i = 0, start = 0; start < totalDurationMs; i++) {
    const end = Math.min(start + windowMs, totalDurationMs);
    chunks.push({ index: i, startMs: start, endMs: end });
    start = end;
  }
  return chunks;
}

/** Shift a segment's timings (and any per-word timings) by `offsetMs`. */
function offsetSegment(seg: TranscriptSegment, offsetMs: number): TranscriptSegment {
  if (offsetMs === 0) return seg;
  return {
    ...seg,
    startMs: seg.startMs + offsetMs,
    endMs: seg.endMs + offsetMs,
    ...(seg.words
      ? { words: seg.words.map((w) => ({ ...w, startMs: w.startMs + offsetMs, endMs: w.endMs + offsetMs })) }
      : {}),
  };
}

/**
 * The runner. One instance per orchestrator; runs are tracked by the
 * orchestrator (only one run per project at a time).
 */
export class PipelineRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Run the pipeline for a project. Resumes by skipping already-completed steps
   * whose artifacts exist, unless `retryFromStep` forces re-execution.
   */
  async run(project: Project, options: RunOptions): Promise<void> {
    const { store, bus, logger } = this.deps;
    const paths = store.paths(project.id);

    let state = await store.getPipeline(project.id);

    // If retrying from a step, reset that step + all downstream to pending.
    if (options.retryFromStep) {
      state = this.resetFromStep(state, options.retryFromStep);
      await store.savePipeline(state);
      bus.emit({ type: 'state', pipeline: state });
      logger.info(`Retrying pipeline from step "${pipelineStepLabel(options.retryFromStep)}".`);
    }

    const retryIndex = options.retryFromStep ? pipelineStepIndex(options.retryFromStep) : Infinity;

    logger.info(`Pipeline started for project "${project.name}" (${project.id}).`);

    try {
      for (const stepId of PIPELINE_STEP_IDS) {
        throwIfCancelled(options.signal);

        const stepState = state.steps.find((s) => s.id === stepId);
        const forceRun = pipelineStepIndex(stepId) >= retryIndex;

        // Resumability: skip a previously-completed step whose outputs exist.
        if (!forceRun && stepState?.status === 'completed' && (await this.outputsExist(stepId, paths))) {
          logger.info(`Skipping "${pipelineStepLabel(stepId)}" — already completed.`);
          state = await transition(this.deps, state, stepId, 'skipped');
          continue;
        }

        // Also skip if outputs exist but status wasn't recorded as completed
        // (e.g. older project) — treat as resumable when not a forced retry.
        if (!forceRun && stepState?.status !== 'completed' && (await this.outputsExist(stepId, paths))) {
          logger.info(`Skipping "${pipelineStepLabel(stepId)}" — outputs already present.`);
          state = await transition(this.deps, state, stepId, 'skipped');
          continue;
        }

        state = await transition(this.deps, state, stepId, 'running', { progressPercent: 0 });
        logger.info(`Step "${pipelineStepLabel(stepId)}" started.`);

        // Mid-step progress: re-emit the step as "running" with an updated
        // percent. Called sparingly (per chunk/batch), so it never floods SSE.
        const onProgress: StepProgress = async (fraction) => {
          const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
          state = await transition(this.deps, state, stepId, 'running', { progressPercent: pct });
        };

        try {
          await this.executeStep(stepId, project, paths, options.signal, onProgress);
        } catch (err) {
          const appError = toAppError(err);
          logger.error(`Step "${pipelineStepLabel(stepId)}" failed: ${appError.code} — ${appError.message}`);
          state = await transition(this.deps, state, stepId, 'failed', { error: appError.message });
          bus.emit({ type: 'error', error: appError });
          // Reflect failure on the project record.
          await this.markProjectStatus(project, 'failed');
          return;
        }

        state = await transition(this.deps, state, stepId, 'completed', { progressPercent: 100 });
        logger.info(`Step "${pipelineStepLabel(stepId)}" completed.`);
      }

      logger.info('Pipeline completed successfully.');
      await this.markProjectStatus(project, 'completed');
      bus.emit({ type: 'done' });
    } catch (err) {
      // Top-level catch handles cancellation between steps.
      const appError = toAppError(err);
      if (appError.code === 'CANCELLED') {
        logger.warn('Pipeline cancelled.');
        // Mark the current running step as failed/cancelled so it can be retried.
        const current = state.steps.find((s) => s.status === 'running');
        if (current) {
          state = await transition(this.deps, state, current.id, 'failed', { error: 'Cancelled' });
        }
        await this.markProjectStatus(project, 'paused');
        bus.emit({ type: 'error', error: appError });
        return;
      }
      logger.error(`Pipeline failed: ${appError.message}`);
      bus.emit({ type: 'error', error: appError });
      await this.markProjectStatus(project, 'failed');
    }
  }

  /** Persist a project status change (best-effort; never throws). */
  private async markProjectStatus(project: Project, status: Project['status']): Promise<void> {
    try {
      const fresh = await this.deps.store.getProject(project.id);
      await this.deps.store.saveProject({ ...fresh, status });
    } catch {
      /* ignore */
    }
  }

  /** Reset a step and everything downstream to `pending`. Pure-ish. */
  private resetFromStep(state: PipelineState, fromStep: PipelineStepId): PipelineState {
    const fromIndex = pipelineStepIndex(fromStep);
    let next = state;
    for (const stepId of PIPELINE_STEP_IDS) {
      if (pipelineStepIndex(stepId) >= fromIndex) {
        next = setStepStatus(next, stepId, 'pending');
      }
    }
    return next;
  }

  /**
   * Whether the expected output artifact(s) for a step already exist on disk
   * (used for resumability skip decisions).
   */
  private async outputsExist(stepId: PipelineStepId, paths: WorkspacePaths): Promise<boolean> {
    switch (stepId) {
      case 'probe-video': {
        // probe-video's "artifact" is persisted mediaInfo on project.json.
        try {
          const raw = await fsp.readFile(paths.projectJson, 'utf8');
          const p = JSON.parse(raw) as Project;
          return p.mediaInfo !== undefined;
        } catch {
          return false;
        }
      }
      case 'extract-audio':
        return (
          (await fileExistsNonEmpty(paths.originalWav)) &&
          (await fileExistsNonEmpty(paths.original16kMonoWav))
        );
      case 'stt':
        return fileExistsNonEmpty(paths.sourceJson);
      case 'translation':
        return fileExistsNonEmpty(paths.translatedJson);
      case 'tts': {
        // TTS is complete only when EVERY synthesis unit has a non-empty WAV.
        // Checking just the first file would wrongly skip a run that was
        // interrupted mid-synthesis, leaving later units missing (which
        // alignment would then flag as 0ms timing-conflicts). With grouping,
        // the units are the persisted synthesis groups (one WAV per group, on
        // the first member's path); without the artifact (older project) fall
        // back to the legacy one-WAV-per-segment check.
        try {
          const segments = await readSegments(paths.translatedJson);
          if (segments.length === 0) return false;
          const groups = await readGroups(paths.synthesisGroupsJson);
          const ids = groups ? groups.map((g) => g.id) : segments.map((s) => s.id);
          for (const id of ids) {
            const idx = segmentIdToIndex(id);
            if (!(await fileExistsNonEmpty(paths.ttsSegment(idx)))) return false;
          }
          return true;
        } catch {
          return false;
        }
      }
      case 'alignment':
        return fileExistsNonEmpty(paths.translatedAlignedJson);
      case 'audio-mix':
        return fileExistsNonEmpty(paths.finalMixWav);
      case 'render':
        return fileExistsNonEmpty(paths.outputMp4);
      default:
        return false;
    }
  }

  /** Dispatch to the per-step implementation. */
  private async executeStep(
    stepId: PipelineStepId,
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    switch (stepId) {
      case 'probe-video':
        return this.stepProbe(project, paths, signal);
      case 'extract-audio':
        return this.stepExtractAudio(project, paths, signal);
      case 'stt':
        return this.stepStt(project, paths, signal, onProgress);
      case 'translation':
        return this.stepTranslation(project, paths, signal);
      case 'tts':
        return this.stepTts(project, paths, signal);
      case 'alignment':
        return this.stepAlignment(project, paths, signal, onProgress);
      case 'audio-mix':
        return this.stepAudioMix(project, paths, signal);
      case 'render':
        return this.stepRender(project, paths, signal);
      default:
        throw new AppErrorException('UNKNOWN', `Unknown pipeline step: ${stepId}`);
    }
  }

  // ----- Step implementations ----------------------------------------------

  private async stepProbe(project: Project, _paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const info = await this.deps.media.probe(project.inputVideoPath);
    if (!info.hasAudio || info.audioStreams.length === 0) {
      throw new AppErrorException('NO_AUDIO_STREAM', 'The input video has no audio stream to dub.');
    }
    const fresh = await this.deps.store.getProject(project.id);
    await this.deps.store.saveProject({ ...fresh, mediaInfo: info });
    this.deps.logger.info(
      `Probed media: ${info.container}, ${Math.round(info.durationMs / 1000)}s, ${info.videoStreams.length} video / ${info.audioStreams.length} audio streams.`,
    );
  }

  private async stepExtractAudio(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    this.deps.logger.info('Extracting full-rate audio (original.wav)...');
    await this.deps.media.extractAudio(project.inputVideoPath, paths.originalWav);
    throwIfCancelled(signal);
    this.deps.logger.info('Extracting 16 kHz mono audio for STT (original_16k_mono.wav)...');
    await this.deps.media.extract16kMono(project.inputVideoPath, paths.original16kMonoWav);
  }

  private async stepStt(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getStt(project.settings.sttProviderId);
    const model = project.settings.sttModel ?? 'small';
    const explicitLanguage = project.settings.sourceLanguage
      ? toWhisperLanguage(project.settings.sourceLanguage)
      : undefined;

    // Decide whether to chunk: long audio is transcribed in bounded windows so
    // the request can't outrun the worker timeout, each window is checkpointed
    // (crash-resumable), progress is visible, and memory stays bounded.
    const totalDurationMs = (await this.deps.store.getProject(project.id)).mediaInfo?.durationMs ?? 0;
    const windowMs = this.deps.sttChunkWindowMs ?? DEFAULT_STT_CHUNK_WINDOW_MS;
    const thresholdMs = this.deps.sttChunkThresholdMs ?? DEFAULT_STT_CHUNK_THRESHOLD_MS;
    const plan = planSttChunks(totalDurationMs, windowMs, thresholdMs);
    // Chunking needs the optional clip16kMono capability; without it (an older
    // media-worker) fall back to a single request even for long audio.
    const canChunk = plan.length > 1 && typeof this.deps.media.clip16kMono === 'function';

    let segments: TranscriptSegment[];
    let detectedLanguage: string | undefined;

    if (!canChunk) {
      this.deps.logger.info(`Transcribing with provider "${provider.id}" (model ${model})...`);
      const result = await provider.transcribe(
        { audioPath: paths.original16kMonoWav, language: explicitLanguage, model, wordTimestamps: true },
        signal,
      );
      segments = result.segments;
      detectedLanguage = result.detectedLanguage;
    } else {
      ({ segments, detectedLanguage } = await this.transcribeChunked(
        paths,
        provider,
        model,
        explicitLanguage,
        plan,
        signal,
        onProgress,
      ));
    }

    // Optional forced-alignment / diarization refinement (WhisperX engine pack).
    // Tightens word timestamps (±50 ms) and, when diarization is on, tags each
    // segment with a speakerId for per-speaker voices. Skipped (with a warning)
    // when requested but the engine pack isn't installed.
    if ((project.settings.forcedAlignment || project.settings.diarize) && this.deps.alignment) {
      throwIfCancelled(signal);
      this.deps.logger.info(
        `Refining timing${project.settings.diarize ? ' + diarizing speakers' : ''} via forced alignment...`,
      );
      const refined = await this.deps.alignment
        .align(
          paths.original16kMonoWav,
          segments,
          detectedLanguage || project.settings.sourceLanguage,
          { diarize: project.settings.diarize === true },
          signal,
        )
        .catch((err: unknown) => {
          this.deps.logger.warn(`Alignment failed (${String(err)}); keeping the original timestamps.`);
          return null;
        });
      if (refined && refined.length > 0) {
        segments = refined;
        this.deps.logger.info('Forced alignment complete (word-accurate timing).');
      }
    } else if (project.settings.forcedAlignment || project.settings.diarize) {
      this.deps.logger.warn(
        'Forced alignment/diarization was requested but the "Forced alignment + diarization" engine pack is not installed — using the default timestamps.',
      );
    }

    await writeSegments(paths.sourceJson, segments);
    const srt = segmentsToSrt(
      segments.map((s) => ({ index: s.index + 1, startMs: s.startMs, endMs: s.endMs, text: s.sourceText })),
    );
    await fsp.writeFile(paths.sourceSrt, srt, 'utf8');
    this.deps.logger.info(`Transcribed ${segments.length} segments (detected language: ${detectedLanguage}).`);

    // The STT chunk clips/checkpoints were scratch space; reclaim the disk now
    // that source.json is the durable artifact (a retry re-chunks from scratch).
    if (canChunk) {
      await fsp.rm(paths.sttChunksDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Transcribe long audio in bounded windows: clip each window to a 16k-mono
   * WAV, transcribe it, offset its timings to absolute, checkpoint it to disk,
   * and report progress. Re-runs resume from the first window whose checkpoint
   * is missing. Language is auto-detected once (on the first window) and reused
   * for the rest so the whole transcript shares one language.
   */
  private async transcribeChunked(
    paths: WorkspacePaths,
    provider: ReturnType<ProviderRegistry['getStt']>,
    model: string,
    explicitLanguage: string | undefined,
    plan: SttChunk[],
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string | undefined }> {
    await fsp.mkdir(paths.sttChunksDir, { recursive: true });
    const totalSec = Math.round((plan[plan.length - 1]?.endMs ?? 0) / 1000);
    this.deps.logger.info(
      `Transcribing ${totalSec}s in ${plan.length} chunks (provider "${provider.id}", model ${model})...`,
    );

    const all: TranscriptSegment[] = [];
    let detectedLanguage = explicitLanguage;

    for (const chunk of plan) {
      throwIfCancelled(signal);
      const checkpoint = paths.sttChunkJson(chunk.index);
      let chunkSegments: TranscriptSegment[];

      if (await fileExistsNonEmpty(checkpoint)) {
        const saved = JSON.parse(await fsp.readFile(checkpoint, 'utf8')) as {
          detectedLanguage?: string;
          segments?: TranscriptSegment[];
        };
        chunkSegments = saved.segments ?? [];
        if (!detectedLanguage && saved.detectedLanguage) detectedLanguage = saved.detectedLanguage;
        this.deps.logger.info(
          `STT chunk ${chunk.index + 1}/${plan.length}: reused checkpoint (${chunkSegments.length} segments).`,
        );
      } else {
        const clipPath = paths.sttChunkWav(chunk.index);
        await this.deps.media.clip16kMono!(paths.original16kMonoWav, clipPath, chunk.startMs, chunk.endMs);
        const res = await provider.transcribe(
          { audioPath: clipPath, language: detectedLanguage, model, wordTimestamps: true },
          signal,
        );
        if (!detectedLanguage && res.detectedLanguage) detectedLanguage = res.detectedLanguage;
        chunkSegments = res.segments.map((s) => offsetSegment(s, chunk.startMs));
        await fsp.writeFile(
          checkpoint,
          `${JSON.stringify({ detectedLanguage: res.detectedLanguage, segments: chunkSegments }, null, 2)}\n`,
          'utf8',
        );
        // The clip WAV is large; drop it once its checkpoint is written.
        await fsp.rm(clipPath, { force: true }).catch(() => {});
        this.deps.logger.info(
          `STT chunk ${chunk.index + 1}/${plan.length}: ${chunkSegments.length} segments ` +
            `(${Math.round(chunk.startMs / 1000)}-${Math.round(chunk.endMs / 1000)}s).`,
        );
      }

      all.push(...chunkSegments);
      await onProgress((chunk.index + 1) / plan.length);
    }

    // Re-number ids/index so the merged transcript is contiguous and unique
    // (each chunk's worker numbering restarts at seg_0001).
    const segments = all.map((s, i) => ({ ...s, index: i, id: `seg_${padSegmentIndex(i + 1)}` }));
    return { segments, detectedLanguage };
  }

  private async stepTranslation(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getTranslation(project.settings.translationProviderId);
    const sourceSegments = await readSegments(paths.sourceJson);
    this.deps.logger.info(
      `Translating ${sourceSegments.length} segments ${project.settings.sourceLanguage} -> ${project.settings.targetLanguage} with "${provider.id}"...`,
    );

    // The project's character sheet (cast/glossary/pronoun plan): a persisted
    // (possibly user-edited) one is authoritative and re-used verbatim; when
    // absent, a context-capable provider generates one and we persist it so the
    // editor can surface it and later re-translates stay consistent.
    const documentContext = await readDocContext(paths.translationContextJson);

    const result = await provider.translateSegments(
      {
        sourceLanguage: project.settings.sourceLanguage,
        targetLanguage: project.settings.targetLanguage,
        segments: sourceSegments.map((s) => ({
          id: s.id,
          sourceText: s.sourceText,
          startMs: s.startMs,
          endMs: s.endMs,
        })),
        ...(documentContext ? { documentContext } : {}),
      },
      signal,
    );

    if (!documentContext && result.analysis) {
      await writeDocContext(paths.translationContextJson, result.analysis);
      this.deps.logger.info(
        'Generated the translation character sheet (cast, glossary, pronoun plan) — review it in the editor to fine-tune pronouns/terminology, then re-run translation.',
      );
    }

    const byId = new Map(result.segments.map((s) => [s.id, s.translatedText]));

    // Surface incompleteness: a worker that drops segment ids would otherwise
    // silently leave those segments untranslated (empty), only showing up much
    // later as empty subtitles / 0ms TTS. Warn loudly (logs + SSE) instead.
    const missing = sourceSegments.filter((s) => !byId.has(s.id));
    if (missing.length > 0) {
      this.deps.logger.warn(
        `Translation worker returned ${result.segments.length}/${sourceSegments.length} segments. ` +
          `${missing.length} segment(s) were not translated (e.g. ${missing
            .slice(0, 3)
            .map((s) => s.id)
            .join(', ')}). They will keep their source text.`,
      );
    }

    const merged: TranscriptSegment[] = sourceSegments.map((s) => ({
      ...s,
      translatedText: byId.get(s.id) ?? s.translatedText ?? '',
    }));

    await writeSegments(paths.translatedJson, merged);

    const cues = transcriptSegmentsToCues(merged);
    await fsp.writeFile(paths.translatedSrt, segmentsToSrt(cues), 'utf8');
    await fsp.writeFile(paths.translatedVtt, segmentsToVtt(cues), 'utf8');
    this.deps.logger.info(`Translated ${merged.length} segments.`);
  }

  private async stepTts(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getTts(project.settings.ttsProviderId);
    const segments = await readSegments(paths.translatedJson);

    // Group consecutive same-speaker cues into whole utterances so the engine
    // speaks them with ONE coherent intonation contour instead of resetting its
    // prosody at every subtitle cue (see grouping.ts). The plan is persisted so
    // alignment/mix/editor know which cues share a WAV.
    const groups = planSynthesisGroups(toGroupInputs(segments), {
      enabled: project.settings.synthesisGrouping !== false,
    });
    await writeGroups(paths.synthesisGroupsJson, groups);

    // Per-speaker voices: partition units by their resolved voice (a diarized
    // speaker with an assignment in settings.speakerVoices gets it; everything
    // else uses the project voice) and synthesize one batch per voice.
    const byVoice = new Map<string | undefined, SynthesisGroup[]>();
    for (const g of groups) {
      const voice = voiceForGroup(g, project.settings);
      byVoice.set(voice, [...(byVoice.get(voice) ?? []), g]);
    }

    this.deps.logger.info(
      `Synthesizing ${groups.length} utterance(s) covering ${segments.length} segment(s) with provider "${provider.id}"` +
        (byVoice.size > 1 ? ` across ${byVoice.size} voices` : '') +
        '...',
    );

    const synthesized = new Set<string>();
    let engine: string | undefined;
    let sawFallbackEngine = false;
    let fallbackSegments = 0;
    for (const [voiceId, voiceGroups] of byVoice) {
      throwIfCancelled(signal);
      const result = await provider.synthesizeSegments(
        {
          language: project.settings.targetLanguage,
          voiceId,
          segments: voiceGroups.map((g) => ({ id: g.id, text: g.text, startMs: g.startMs, endMs: g.endMs })),
          outputDir: paths.ttsSegmentsDir,
          speed: 1.0,
        },
        signal,
      );
      for (const s of result.segments) synthesized.add(s.segmentId);
      if (result.engine === 'fallback') sawFallbackEngine = true;
      else engine ??= result.engine;
      fallbackSegments += result.fallbackSegments ?? 0;
    }

    // Surface incompleteness: if the worker returned fewer segments than asked,
    // the missing WAVs would otherwise only surface as 0ms timing-conflicts at
    // alignment, masking the real failure. Warn with the offending ids.
    const missing = groups.filter((g) => !synthesized.has(g.id));
    if (missing.length > 0) {
      this.deps.logger.warn(
        `TTS worker returned ${synthesized.size}/${groups.length} segments. ` +
          `${missing.length} segment(s) were not synthesized (e.g. ${missing
            .slice(0, 3)
            .map((s) => s.id)
            .join(', ')}). They will be flagged at alignment.`,
      );
    }

    // Surface silent placeholders loudly: "fallback" means no installed voice
    // can speak the target language, so the dub would have no speech at all.
    if (sawFallbackEngine && engine === undefined) {
      this.deps.logger.warn(
        `TTS produced SILENT placeholder audio: no installed voice can speak ` +
          `"${project.settings.targetLanguage}". Install a Piper voice for this ` +
          `language (Settings → Setup) and re-run from the TTS step.`,
      );
    } else if (fallbackSegments > 0) {
      this.deps.logger.warn(
        `TTS engine "${engine}" failed on ${fallbackSegments} segment(s); ` +
          `those segments contain silent placeholder audio.`,
      );
    }
    this.deps.logger.info(`Speech synthesis complete (engine: ${engine ?? (sawFallbackEngine ? 'fallback' : 'unknown')}).`);
  }

  private async stepAlignment(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    const segments = await readSegments(paths.translatedJson);

    // Alignment operates on SYNTHESIS UNITS: the groups persisted by the TTS
    // step (one WAV per group, on the first member's canonical path). Older
    // projects without the artifact fall back to one-group-per-segment, which
    // reproduces the legacy behavior exactly.
    const groups = (await readGroups(paths.synthesisGroupsJson)) ?? singletonGroups(toGroupInputs(segments));

    // Determine each synthesized unit's real duration by probing its WAV.
    // The TTS worker names files by the numeric part of the segment/group id
    // (seg_0001 -> segment_0001.wav), so we resolve the index from the id first
    // and only fall back to the positional index if the id has no number.
    // Probes are independent ffprobe runs — do them with bounded concurrency
    // (sequential probing dominated this step's wall-clock on long videos).
    const PROBE_CONCURRENCY = 8;
    const PROBE_TIMEOUT_MS = 15_000;
    const alignInputs = new Array<AlignInputSegment>(groups.length);
    const progressEvery = Math.max(1, Math.floor(groups.length / 20));
    let nextGroup = 0;
    let probedCount = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, groups.length) }, async () => {
        while (nextGroup < groups.length) {
          const i = nextGroup++;
          const group = groups[i];
          if (!group) continue;
          const fromId = segmentIdToIndex(group.id);
          const index = fromId > 0 ? fromId : i + 1;
          const audioPath = paths.ttsSegment(index);
          // Assigned on both the success and failure paths below.
          let generatedDurationMs: number;
          try {
            // Bound each probe so one hung/locked ffprobe can't stall the whole
            // step on a long video; an unprobeable WAV is treated as 0ms below.
            const info = await Promise.race([
              this.deps.media.probe(audioPath),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS),
              ),
            ]);
            generatedDurationMs = info.durationMs;
          } catch {
            // If the WAV is missing/unprobeable/slow, treat as zero-length so
            // alignment flags it rather than crashing or hanging the pipeline.
            generatedDurationMs = 0;
          }
          alignInputs[i] = {
            segmentId: group.id,
            startMs: group.startMs,
            endMs: group.endMs,
            audioPath,
            generatedDurationMs,
          };
          // Throttled progress (<=~20 emits) so long-video probing isn't a
          // silent multi-minute wait. Concurrent emits only race on the percent.
          probedCount++;
          if (probedCount === groups.length || probedCount % progressEvery === 0) {
            await onProgress(probedCount / groups.length);
          }
        }
      }),
    );

    // Pass the total media duration so alignment is gap-aware (a long
    // translation can use the silence until the next line — or until the end of
    // the video for the last segment — instead of being flagged as a conflict).
    const totalDurationMs = (await this.deps.store.getProject(project.id)).mediaInfo?.durationMs;
    const settings = {
      maxSpeedRatio: project.settings.maxSpeedRatio,
      allowedOverflowMs: project.settings.allowedOverflowMs,
    };
    let aligned = alignSegments(alignInputs, settings, totalDurationMs);

    // Auto-fit: re-translate (tighter), re-synthesize, and re-align any unit
    // that can't fit even at max speed, so timing-conflicts self-heal instead of
    // needing a manual edit. No-op when the setting is off, there are no
    // conflicts, or the translation provider can't shorten on request (Argos).
    if (project.settings.autoFitOverflow !== false && aligned.some((a) => a.status === 'timing-conflict')) {
      this.deps.logger.info('Auto-fitting overflowing translations to their timing windows...');
      aligned = await this.refitOverflowingSegments(
        project,
        paths,
        segments,
        groups,
        alignInputs,
        aligned,
        settings,
        totalDurationMs,
        signal,
      );
    }

    // Native-rate fit: when the engine honors a speed parameter (Piper, OpenAI),
    // re-synthesize still-too-long units AT the required rate instead of leaving
    // them to the post-hoc time-stretcher — a natively faster reading keeps
    // formants and rhythm intact, which any stretcher only approximates.
    aligned = await this.nativeRateResynthesis(
      project,
      paths,
      groups,
      alignInputs,
      aligned,
      settings,
      totalDurationMs,
      signal,
    );

    await fsp.writeFile(paths.translatedAlignedJson, `${JSON.stringify(aligned, null, 2)}\n`, 'utf8');

    const summary = summarizeAlignment(aligned);
    this.deps.logger.info(
      `Alignment: ${summary.ok} ok, ${summary.needsReview} needs-review, ${summary.timingConflicts} timing-conflict, ${summary.needsAtempo} need speed-up.`,
    );
    if (summary.timingConflicts > 0) {
      this.deps.logger.warn(
        `${summary.timingConflicts} segment(s) cannot fit even at max speed — consider editing the translation.`,
      );
    }
  }

  /**
   * Re-fit synthesis units that can't fit even at max speed: re-translate each
   * MEMBER segment with a tighter budget (achieved by handing the LLM a SHRUNK
   * window, which lowers the prompt's budget — distributed across a group's
   * members proportionally to their own cue windows), rebuild the group text,
   * re-synthesize the unit, re-probe, and re-align — up to a couple of passes.
   * Persists the shortened translations + subtitle sidecars + group plan when
   * they change. A provider that can't shorten on request (Argos) returns
   * identical text, which we detect as "no change" and stop without any wasted
   * TTS. Inputs are mutated in place (segments + groups + alignInputs).
   */
  private async refitOverflowingSegments(
    project: Project,
    paths: WorkspacePaths,
    segments: TranscriptSegment[],
    groups: SynthesisGroup[],
    alignInputs: AlignInputSegment[],
    aligned: AlignedSegment[],
    settings: { maxSpeedRatio: number; allowedOverflowMs: number },
    totalDurationMs: number | undefined,
    signal: AbortSignal,
  ): Promise<AlignedSegment[]> {
    const MAX_ATTEMPTS = 2;
    const translation = this.deps.registry.getTranslation(project.settings.translationProviderId);
    const tts = this.deps.registry.getTts(project.settings.ttsProviderId);
    const segById = new Map(segments.map((s) => [s.id, s]));
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const groupOfMember = new Map<string, SynthesisGroup>();
    for (const g of groups) for (const id of g.segmentIds) groupOfMember.set(id, g);
    const inputById = new Map(alignInputs.map((a) => [a.segmentId, a]));
    let current = aligned;
    let changedAny = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      throwIfCancelled(signal);
      const conflicts = current.filter((a) => a.status === 'timing-conflict');
      if (conflicts.length === 0) break;

      // Attempt 1 targets the max-speed window (relies on time-stretch headroom);
      // attempt 2 targets the natural window (must fit without any speed-up).
      const tightFactor = attempt === 1 ? Math.max(1, settings.maxSpeedRatio) : 1;
      const reqSegs: { id: string; sourceText: string; startMs: number; endMs: number }[] = [];
      for (const c of conflicts) {
        const group = groupById.get(c.segmentId);
        if (!group) continue;
        const availableMs = Math.max(1, c.placedDurationMs - c.overflowMs);
        const tightTotalMs = Math.max(500, Math.round(availableMs * tightFactor));
        // Distribute the unit's budget over its members by their cue windows.
        const windows = group.segmentIds.map((id) => {
          const s = segById.get(id);
          return s ? Math.max(1, s.endMs - s.startMs) : 1;
        });
        const windowSum = windows.reduce((a, b) => a + b, 0) || 1;
        group.segmentIds.forEach((id, j) => {
          const s = segById.get(id);
          if (!s) return;
          const memberTight = Math.max(300, Math.round((tightTotalMs * windows[j]!) / windowSum));
          reqSegs.push({ id, sourceText: s.sourceText ?? '', startMs: 0, endMs: memberTight });
        });
      }
      if (reqSegs.length === 0) break;

      // Carry the character sheet into the refit re-translation too, so the
      // shortened lines keep the same pronouns/terminology as the rest.
      const documentContext = await readDocContext(paths.translationContextJson);
      const result = await translation.translateSegments(
        {
          sourceLanguage: project.settings.sourceLanguage,
          targetLanguage: project.settings.targetLanguage,
          segments: reqSegs,
          ...(documentContext ? { documentContext } : {}),
        },
        signal,
      );
      const newTextById = new Map(result.segments.map((s) => [s.id, (s.translatedText ?? '').trim()]));

      const changedGroups = new Set<SynthesisGroup>();
      for (const req of reqSegs) {
        const seg = segById.get(req.id);
        const newText = newTextById.get(req.id);
        if (seg && newText && newText.length > 0 && newText !== (seg.translatedText ?? '')) {
          seg.translatedText = newText;
          const g = groupOfMember.get(req.id);
          if (g) changedGroups.add(g);
        }
      }
      if (changedGroups.size === 0) break; // provider can't shorten (e.g. Argos) or converged

      changedAny = true;

      // Rebuild each changed unit's text from its (updated) members, then
      // re-synthesize only those units (overwrites their WAVs in place).
      for (const g of changedGroups) {
        g.text = g.segmentIds
          .map((id) => (segById.get(id)?.translatedText ?? segById.get(id)?.sourceText ?? '').trim())
          .filter((t) => t.length > 0)
          .join(' ');
      }
      // Re-synthesize per group so speaker-assigned voices are preserved.
      for (const g of changedGroups) {
        await tts.synthesizeSegments(
          {
            language: project.settings.targetLanguage,
            voiceId: voiceForGroup(g, project.settings),
            segments: [{ id: g.id, text: g.text, startMs: g.startMs, endMs: g.endMs }],
            outputDir: paths.ttsSegmentsDir,
            speed: 1.0,
          },
          signal,
        );
      }

      // Re-probe the changed units' new durations, then re-align everything
      // (gap-aware alignment depends on neighbours, so re-run the whole list).
      for (const g of changedGroups) {
        const input = inputById.get(g.id);
        if (!input) continue;
        try {
          input.generatedDurationMs = (await this.deps.media.probe(input.audioPath)).durationMs;
        } catch {
          input.generatedDurationMs = 0;
        }
      }
      current = alignSegments(alignInputs, settings, totalDurationMs);
      this.deps.logger.info(
        `Auto-fit pass ${attempt}: shortened ${changedGroups.size} overflowing line(s); ` +
          `${current.filter((a) => a.status === 'timing-conflict').length} conflict(s) remain.`,
      );
    }

    if (changedAny) {
      // Persist the shortened translations + regenerate subtitle sidecars + the
      // group plan so the editor + burned/sidecar subtitles match the audio.
      await writeSegments(paths.translatedJson, segments);
      const cues = transcriptSegmentsToCues(segments);
      await fsp.writeFile(paths.translatedSrt, segmentsToSrt(cues), 'utf8');
      await fsp.writeFile(paths.translatedVtt, segmentsToVtt(cues), 'utf8');
      await writeGroups(paths.synthesisGroupsJson, groups);
    }
    return current;
  }

  /**
   * Fit still-too-long units by SPEAKING FASTER instead of time-stretching:
   * when the TTS engine honors a native speed parameter, re-synthesize each
   * unit with `speedRatio > 1.05` at that rate, re-probe, and re-align. A
   * natively faster reading preserves formants and articulation; the stretcher
   * then only has to correct the small residual. Engines without native rate
   * control (VieNeu) skip this entirely. Mutates alignInputs in place.
   */
  private async nativeRateResynthesis(
    project: Project,
    paths: WorkspacePaths,
    groups: SynthesisGroup[],
    alignInputs: AlignInputSegment[],
    aligned: AlignedSegment[],
    settings: { maxSpeedRatio: number; allowedOverflowMs: number },
    totalDurationMs: number | undefined,
    signal: AbortSignal,
  ): Promise<AlignedSegment[]> {
    const MIN_NATIVE_RATE = 1.05;
    const tts = this.deps.registry.getTts(project.settings.ttsProviderId);
    if (tts.supportsSpeedControl !== true) return aligned;
    const targets = aligned.filter((a) => a.speedRatio > MIN_NATIVE_RATE);
    if (targets.length === 0) return aligned;

    const groupById = new Map(groups.map((g) => [g.id, g]));
    const inputById = new Map(alignInputs.map((a) => [a.segmentId, a]));
    this.deps.logger.info(
      `Re-synthesizing ${targets.length} over-long line(s) at native speaking rate (instead of time-stretching)...`,
    );

    const requestedSpeed = new Map<string, number>();
    for (const a of targets) {
      throwIfCancelled(signal);
      const group = groupById.get(a.segmentId);
      const input = inputById.get(a.segmentId);
      if (!group || !input) continue;
      // `speed` is a batch-level TTS parameter, so units go one call at a time
      // (there are few of them). A failed call keeps the stretched fallback.
      const speed = Math.min(a.speedRatio, 2);
      try {
        await tts.synthesizeSegments(
          {
            language: project.settings.targetLanguage,
            voiceId: voiceForGroup(group, project.settings),
            segments: [{ id: group.id, text: group.text, startMs: group.startMs, endMs: group.endMs }],
            outputDir: paths.ttsSegmentsDir,
            speed,
          },
          signal,
        );
        input.generatedDurationMs = (await this.deps.media.probe(input.audioPath)).durationMs;
        requestedSpeed.set(a.segmentId, speed);
      } catch (err) {
        if (signal.aborted) throw err;
        this.deps.logger.warn(
          `Native-rate re-synthesis failed for ${a.segmentId} (${String(err)}); keeping the time-stretched version.`,
        );
      }
    }
    if (requestedSpeed.size === 0) return aligned;

    // Re-align everything (gap-aware windows depend on neighbours) and note the
    // native rate on units that now fit, so the editor can still surface it.
    const realigned = alignSegments(alignInputs, settings, totalDurationMs);
    return realigned.map((a) => {
      const speed = requestedSpeed.get(a.segmentId);
      if (speed === undefined || a.status !== 'ok') return a;
      return { ...a, note: `Spoken at ~${speed.toFixed(2)}x native rate to fit the window.` };
    });
  }

  private async stepAudioMix(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const aligned = await this.readAligned(paths.translatedAlignedJson);
    const mediaInfo = (await this.deps.store.getProject(project.id)).mediaInfo;
    const totalDurationMs = mediaInfo?.durationMs ?? this.estimateTotalDuration(aligned);

    // Build the full-length TTS timeline, applying per-clip time-stretch (the
    // engine choice is policy: rubberband when available/warranted, else atempo)
    // and micro-fades at every join. Clip durations let the worker place the
    // fade-outs without probing.
    const timelineSegments: TimelineSegmentInput[] = aligned.map((a) => ({
      audioPath: a.audioPath,
      startMs: a.startMs,
      speedRatio: a.speedRatio,
      durationMs: a.generatedDurationMs,
    }));

    this.deps.logger.info(`Building TTS timeline (${timelineSegments.length} clips, ${totalDurationMs}ms)...`);
    await this.deps.media.buildTtsTimeline({
      segments: timelineSegments,
      totalDurationMs,
      outputPath: paths.ttsFullWav,
      timeStretchEngine: project.settings.timeStretchEngine ?? 'auto',
    });

    throwIfCancelled(signal);

    // Resolve how the original soundtrack is treated. The new originalAudioMode
    // takes precedence; legacy include/duck booleans are the fallback.
    const mode =
      project.settings.originalAudioMode ??
      (project.settings.includeOriginalBackgroundAudio ? 'keep' : 'remove');

    let originalAudio = paths.originalWav;
    let includeBackground = true;
    let duck = project.settings.duckOriginalAudio;
    let duckingLevelDb = project.settings.duckingLevelDb;

    if (mode === 'remove') {
      includeBackground = false;
    } else if (mode === 'replace-vocals') {
      // Separate the original into vocals + music/effects, then mix the dub over
      // the M&E bed at full volume (professional dubbing). Falls back to ducking
      // when no separation engine pack is installed.
      const separated = this.deps.separation
        ? await this.deps.separation.separate(paths.originalWav, paths.audioDir, signal).catch((err: unknown) => {
            this.deps.logger.warn(`Separation failed (${String(err)}); falling back to ducking the original.`);
            return null;
          })
        : null;
      if (separated) {
        this.deps.logger.info('Separated original into vocals + music/effects; mixing dub over the M&E bed.');
        originalAudio = separated.accompanimentPath;
        duck = false;
        duckingLevelDb = 0;
      } else {
        this.deps.logger.warn(
          'No vocal-separation engine installed — install the "Vocal separation" engine pack to keep the original music & effects. Falling back to ducking.',
        );
        duck = true;
      }
    }

    this.deps.logger.info(`Mixing TTS track (original audio: ${mode})...`);
    await this.deps.media.duckAndMix({
      originalAudio,
      ttsTimeline: paths.ttsFullWav,
      output: paths.finalMixWav,
      duckingLevelDb,
      ttsGainDb: project.settings.ttsGainDb,
      includeBackground,
      duck,
      // With the original removed there is no bed at all — pure digital silence
      // between lines reads as "broken audio". Lay a very quiet room tone under
      // the dub (default on; settings.roomTone=false disables).
      roomTone: !includeBackground && project.settings.roomTone !== false,
      // Two-pass loudnorm gives a transparent, dialogue-anchored final mix.
      twoPassLoudnorm: true,
    });
    this.deps.logger.info('Audio mix complete (final_mix.wav).');
  }

  private async stepRender(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const mode = project.settings.subtitleExportMode;
    // Choose the subtitle sidecar that matches the requested mode.
    const subtitlePath =
      mode === 'vtt-file'
        ? paths.translatedVtt
        : mode === 'srt-file' || mode === 'embedded-soft' || mode === 'burned-in'
          ? paths.translatedSrt
          : undefined;

    this.deps.logger.info(`Rendering final video (subtitle mode: ${mode})...`);
    const result = await this.deps.media.renderFinalVideo({
      inputVideoPath: project.inputVideoPath,
      audioPath: paths.finalMixWav,
      outputPath: paths.outputMp4,
      subtitleExportMode: mode,
      subtitlePath,
      burnSubtitleStyle: project.settings.burnSubtitleStyle,
      copyVideoStream: mode !== 'burned-in',
      ...(project.settings.renderQuality ? { renderQuality: project.settings.renderQuality } : {}),
    });
    this.deps.logger.info(
      `Render complete: ${result.outputPath} (${Math.round(result.durationMs / 1000)}s, ${result.sidecarSubtitlePaths.length} sidecar subtitle file(s)).`,
    );
  }

  // ----- Helpers ------------------------------------------------------------

  private async readAligned(path: string): Promise<AlignedSegment[]> {
    const raw = await fsp.readFile(path, 'utf8');
    return JSON.parse(raw) as AlignedSegment[];
  }

  /** Fallback total duration from the last aligned segment's end. */
  private estimateTotalDuration(aligned: AlignedSegment[]): number {
    return aligned.reduce((max, a) => Math.max(max, a.endMs, a.startMs + a.placedDurationMs), 0);
  }
}

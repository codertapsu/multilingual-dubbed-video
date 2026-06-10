/**
 * The PipelineRunner: executes the 8 dubbing steps sequentially with
 * persistence, SSE progress, resumability, and cancellation.
 *
 * Steps (in order):
 *   probe-video     -> media.probe; persist mediaInfo; NO_AUDIO_STREAM check
 *   extract-audio   -> original.wav (full) + original_16k_mono.wav (for STT)
 *   stt             -> transcribe 16k mono -> source.json + source.srt
 *   translation     -> translate segments -> translated.json/.srt/.vtt
 *   tts             -> synthesize each segment -> tts_segments/*.wav
 *   alignment       -> align timing -> translated.aligned.json
 *   audio-mix       -> buildTtsTimeline (atempo) -> tts_full.wav -> duckAndMix -> final_mix.wav
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
  type TtsSegmentInput,
} from '@videodubber/shared';
import { alignSegments, summarizeAlignment, type AlignInputSegment } from '../alignment/align.js';
import type { ProjectEventBus } from '../events.js';
import type { ProjectLogger } from '../logging.js';
import type { PipelineMediaService, TimelineSegmentInput } from '../media.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProjectStore } from '../workspace/projectStore.js';
import { fileExistsNonEmpty, segmentIdToIndex, type WorkspacePaths } from '../workspace/paths.js';

/** Dependencies injected into the runner (mockable in tests). */
export interface RunnerDeps {
  store: ProjectStore;
  media: PipelineMediaService;
  registry: ProviderRegistry;
  bus: ProjectEventBus;
  logger: ProjectLogger;
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

        try {
          await this.executeStep(stepId, project, paths, options.signal);
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
        // TTS is complete only when EVERY translated segment has a non-empty
        // WAV. Checking just the first file would wrongly skip a run that was
        // interrupted mid-synthesis, leaving later segments missing (which
        // alignment would then flag as 0ms timing-conflicts).
        try {
          const segments = await readSegments(paths.translatedJson);
          if (segments.length === 0) return false;
          for (const seg of segments) {
            const idx = segmentIdToIndex(seg.id);
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
  ): Promise<void> {
    switch (stepId) {
      case 'probe-video':
        return this.stepProbe(project, paths, signal);
      case 'extract-audio':
        return this.stepExtractAudio(project, paths, signal);
      case 'stt':
        return this.stepStt(project, paths, signal);
      case 'translation':
        return this.stepTranslation(project, paths, signal);
      case 'tts':
        return this.stepTts(project, paths, signal);
      case 'alignment':
        return this.stepAlignment(project, paths, signal);
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

  private async stepStt(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getStt(project.settings.sttProviderId);
    const model = project.settings.sttModel ?? 'small';
    this.deps.logger.info(`Transcribing with provider "${provider.id}" (model ${model})...`);

    const result = await provider.transcribe(
      {
        audioPath: paths.original16kMonoWav,
        language: project.settings.sourceLanguage
          ? toWhisperLanguage(project.settings.sourceLanguage)
          : undefined,
        model,
        wordTimestamps: true,
      },
      signal,
    );

    await writeSegments(paths.sourceJson, result.segments);
    const srt = segmentsToSrt(
      result.segments.map((s) => ({ index: s.index + 1, startMs: s.startMs, endMs: s.endMs, text: s.sourceText })),
    );
    await fsp.writeFile(paths.sourceSrt, srt, 'utf8');
    this.deps.logger.info(`Transcribed ${result.segments.length} segments (detected language: ${result.detectedLanguage}).`);
  }

  private async stepTranslation(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getTranslation(project.settings.translationProviderId);
    const sourceSegments = await readSegments(paths.sourceJson);
    this.deps.logger.info(
      `Translating ${sourceSegments.length} segments ${project.settings.sourceLanguage} -> ${project.settings.targetLanguage} with "${provider.id}"...`,
    );

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
      },
      signal,
    );

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
    const ttsInputs: TtsSegmentInput[] = segments.map((s) => ({
      id: s.id,
      text: (s.translatedText ?? s.sourceText ?? '').trim(),
      startMs: s.startMs,
      endMs: s.endMs,
    }));

    this.deps.logger.info(`Synthesizing ${ttsInputs.length} segments with provider "${provider.id}"...`);
    const result = await provider.synthesizeSegments(
      {
        language: project.settings.targetLanguage,
        voiceId: project.settings.ttsVoiceId,
        segments: ttsInputs,
        outputDir: paths.ttsSegmentsDir,
        speed: 1.0,
      },
      signal,
    );

    // Surface incompleteness: if the worker returned fewer segments than asked,
    // the missing WAVs would otherwise only surface as 0ms timing-conflicts at
    // alignment, masking the real failure. Warn with the offending ids.
    const synthesized = new Set(result.segments.map((s) => s.segmentId));
    const missing = ttsInputs.filter((s) => !synthesized.has(s.id));
    if (missing.length > 0) {
      this.deps.logger.warn(
        `TTS worker returned ${result.segments.length}/${ttsInputs.length} segments. ` +
          `${missing.length} segment(s) were not synthesized (e.g. ${missing
            .slice(0, 3)
            .map((s) => s.id)
            .join(', ')}). They will be flagged at alignment.`,
      );
    }

    // Surface silent placeholders loudly: "fallback" means no installed voice
    // can speak the target language, so the dub would have no speech at all.
    if (result.engine === 'fallback') {
      this.deps.logger.warn(
        `TTS produced SILENT placeholder audio: no installed voice can speak ` +
          `"${project.settings.targetLanguage}". Install a Piper voice for this ` +
          `language (Settings → Setup) and re-run from the TTS step.`,
      );
    } else if ((result.fallbackSegments ?? 0) > 0) {
      this.deps.logger.warn(
        `TTS engine "${result.engine}" failed on ${result.fallbackSegments} segment(s); ` +
          `those segments contain silent placeholder audio.`,
      );
    }
    this.deps.logger.info(`Speech synthesis complete (engine: ${result.engine ?? 'unknown'}).`);
  }

  private async stepAlignment(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const segments = await readSegments(paths.translatedJson);

    // Determine each synthesized segment's real duration by probing its WAV.
    // The TTS worker names files by the numeric part of the segment id
    // (seg_0001 -> segment_0001.wav), so we resolve the index from the id first
    // and only fall back to the 1-based segment index if the id has no number.
    // Probes are independent ffprobe runs — do them with bounded concurrency
    // (sequential probing dominated this step's wall-clock on long videos).
    const PROBE_CONCURRENCY = 8;
    const alignInputs = new Array<AlignInputSegment>(segments.length);
    let nextSegment = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, segments.length) }, async () => {
        while (nextSegment < segments.length) {
          const i = nextSegment++;
          const seg = segments[i];
          if (!seg) continue;
          const fromId = segmentIdToIndex(seg.id);
          const index = fromId > 0 ? fromId : Number.isFinite(seg.index) ? seg.index + 1 : i + 1;
          const audioPath = paths.ttsSegment(index);
          let generatedDurationMs = 0;
          try {
            const probed = await this.deps.media.probe(audioPath);
            generatedDurationMs = probed.durationMs;
          } catch {
            // If the WAV is missing/unprobeable, treat as zero-length so
            // alignment flags it rather than crashing the whole pipeline.
            generatedDurationMs = 0;
          }
          alignInputs[i] = {
            segmentId: seg.id,
            startMs: seg.startMs,
            endMs: seg.endMs,
            audioPath,
            generatedDurationMs,
          };
        }
      }),
    );

    // Pass the total media duration so alignment is gap-aware (a long
    // translation can use the silence until the next line — or until the end of
    // the video for the last segment — instead of being flagged as a conflict).
    const totalDurationMs = (await this.deps.store.getProject(project.id)).mediaInfo?.durationMs;
    const aligned = alignSegments(
      alignInputs,
      {
        maxSpeedRatio: project.settings.maxSpeedRatio,
        allowedOverflowMs: project.settings.allowedOverflowMs,
      },
      totalDurationMs,
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

  private async stepAudioMix(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const aligned = await this.readAligned(paths.translatedAlignedJson);
    const mediaInfo = (await this.deps.store.getProject(project.id)).mediaInfo;
    const totalDurationMs = mediaInfo?.durationMs ?? this.estimateTotalDuration(aligned);

    // Build the full-length TTS timeline, applying per-segment atempo.
    const timelineSegments: TimelineSegmentInput[] = aligned.map((a) => ({
      audioPath: a.audioPath,
      startMs: a.startMs,
      speedRatio: a.speedRatio,
    }));

    this.deps.logger.info(`Building TTS timeline (${timelineSegments.length} segments, ${totalDurationMs}ms)...`);
    await this.deps.media.buildTtsTimeline({
      segments: timelineSegments,
      totalDurationMs,
      outputPath: paths.ttsFullWav,
    });

    throwIfCancelled(signal);
    this.deps.logger.info('Ducking original audio and mixing TTS track...');
    await this.deps.media.duckAndMix({
      originalAudio: paths.originalWav,
      ttsTimeline: paths.ttsFullWav,
      output: paths.finalMixWav,
      duckingLevelDb: project.settings.duckingLevelDb,
      ttsGainDb: project.settings.ttsGainDb,
      includeBackground: project.settings.includeOriginalBackgroundAudio,
      duck: project.settings.duckOriginalAudio,
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

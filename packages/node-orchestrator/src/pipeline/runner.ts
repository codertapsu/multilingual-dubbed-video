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
 * PAUSING: the run's AbortSignal is checked between (and during) steps. When it
 * is aborted — the user paused, or the app is closing — the run stops where it
 * is and the pipeline is saved as `paused` at that step (pausePipelineState),
 * never as a failure. The next run continues there: finished steps are skipped,
 * and the paused step reuses what it saved of its own work (speech-to-text
 * chunks, translated batches, voice clips).
 *
 * Everything is dependency-injected (store, media, registry, event bus) so the
 * runner is fully testable without ffmpeg or live workers.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  pausePipelineState,
  resumePipelineState,
  setStepStatus,
  toAppError,
  toWhisperLanguage,
  segmentsToSrt,
  segmentsToVtt,
  PIPELINE_STEP_IDS,
  pipelineStepIndex,
  pipelineStepLabel,
  projectOutputVideoPath,
  projectOutputThumbnailPath,
  subtitleCheckOn,
  type AlignedSegment,
  type PictureDetection,
  type ProjectWarning,
  type StepDetail,
  type PipelineState,
  type PipelineStepId,
  type Project,
  type TranscriptSegment,
  type TranslationDocContext,
} from '@videodubber/shared';
import { alignSegments, summarizeAlignment, type AlignInputSegment } from '../alignment/align.js';
import { flaggedLinesWarning, MAX_HELD_LINES, timingConflictWarning } from './beforeVoicing.js';
import {
  coverageWarnings,
  readPresenceReport,
  sameRead,
  speechWithSubtitles,
  subtitleBandFor,
  subtitleCoverage,
  type SubtitlePresenceReport,
} from './subtitleCoverage.js';
import { applyClipTiming, measureClip, type MeasuredClip } from '../alignment/clipSpeech.js';
import type { DubbingTranslationInput, PromptSegment } from '../providers/translation/llmTranslationProvider.js';
import { reviewBatchKey, reviewTranslations, type ReviewedBatch } from '../providers/translation/refinement.js';
import { contextEngineCandidates, FallbackContextChat } from '../providers/translation/contextEngine.js';
import {
  applyReviewOutcome,
  checkAndRepairLines,
  linesFailingChecks,
  readTranslationReport,
  retryFailingLines,
  shortenOverflowingLines,
  TRANSLATION_DRAFT_FILE,
  translationDraftPath,
  translationReportPath,
  updateTranslationReport,
  type CharacterSheetStatus,
  type OverflowUnit,
  type RepairPassResult,
  type RetryPassResult,
  type ShortenOutcome,
} from '../providers/translation/dubPasses.js';
import {
  applySourceCorrections,
  generateCharacterSheet,
  MIN_SEGMENTS_FOR_ANALYSIS,
  translationContextEnabled,
  type AnalysisChat,
} from '../providers/translation/translationContext.js';
import {
  clipRates,
  resolveVoiceRate,
  robustMedian,
  voiceRateKey,
  type ResolvedVoiceRate,
  type VoiceRateBook,
} from '../providers/translation/speechFit.js';
import { isTranslationRefiner } from '../providers/types.js';
import { writeJsonAtomic, writeTextAtomic } from '../workspace/projectStore.js';
import {
  checkpointKey,
  CheckpointWriter,
  readCheckpoint,
  readTranslationCheckpoint,
  translationCheckpointKey,
  TranslationCheckpointWriter,
} from './translationCheckpoint.js';
import { displayCuesFor, songSubtitlesOn, writeCueOverrides } from '../workspace/subtitleTiming.js';
import { isSong, songMixPlan, songUnits } from '../songs/songLines.js';
import { recordSongSuggestions } from '../songs/songSuggestions.js';
import {
  estimateGroupDriftMs,
  maxGroupDriftMs,
  planSynthesisGroups,
  retimeCuesToVoice,
  singletonGroups,
  rateForGroup,
  voiceForGroup,
  type SynthesisGroup,
  type SynthesisGroupsArtifact,
} from './grouping.js';
import { anchorSegmentsToSpeech, needsSpeechMap, type SpeechRegion } from './segmentTiming.js';
import { tidyTranscript } from './transcriptTidy.js';
import { cachedSpeechRegions, type SpeechMapService } from './speechMap.js';
import { mixFingerprint, writeMixFingerprint } from './mixFingerprint.js';
import { projectBrandFiles, type BrandKit } from '../branding/brandKit.js';
import { planGreetings } from '../branding/greetingPlanner.js';
import { dubWindows, greetingSettingsKey, originalSpeech, readGreetingPlan, type SavedGreetingPlan } from '../branding/greetingMix.js';
import { logoPeriods } from '@videodubber/shared';
import { partEffects } from '../series/seriesPlanner.js';
import { sourceNameHints } from '../series/sourceHints.js';
import { rangedMediaInfo } from '../series/seriesRange.js';
import { reuseRecapTranslations } from '../series/recap.js';
import { siteTranscript } from '../providers/download/siteSubtitles.js';
import { thumbnailMomentMs } from './thumbnailMoment.js';
import { autoBlurRegions, describeMarks, faintMarks } from '../picture/watermarkAuto.js';
import { savedDetection } from '../picture/pictureDetection.js';
import type { WarningInbox } from '../diagnostics/warningInbox.js';
import type { ProjectEventBus } from '../events.js';
import type { ProjectLogger } from '../logging.js';
import { describeStretch } from '../media.js';
import type { PipelineMediaService, SeparationService, TimelineSegmentInput } from '../media.js';
import type { AlignmentService } from '../providers/alignment/whisperxProvider.js';
import type { DiarizationService } from '../providers/diarization/sherpaDiarizationProvider.js';
import type { SubtitleOcrService, SubtitleRead } from '../providers/ocr/rapidOcrProvider.js';
import { enoughRead, linesFromSubtitles, MIN_SUBTITLES, readingTimeOf } from './burnedInTranscript.js';
import { detectLineSpeakers, readSpeakerProfiles, speakerDetectionProgress } from './diarization.js';
import { hasSpeakableText, writeSilentClip } from './speakable.js';
import { findLoopRanges, repairLoops, type LoopRange, type RepairedRange } from './loopRepair.js';
import { mergeLoopRanges } from './sttChecks.js';
import { onDecoderWindow } from './decodeMerge.js';
import { recordLoopEdits, type LoopOutcome } from './loopEdits.js';
import { checkDigitalSilence, linesOverSilence, recordAudioDrift, silenceCheckWarning, speechMapForChecks, spotCheckTranscript } from './sourceChecksStep.js';
import { expectedSpeechMs } from '../alignment/clipSpeech.js';
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
   * Optional forced-alignment engine. Absent => the forcedAlignment setting is
   * skipped with a warning.
   */
  alignment?: AlignmentService;
  /**
   * Optional speaker detection (who says each line) for the diarize setting.
   * Absent or not installed => the lines keep no speaker, with a warning.
   */
  diarization?: DiarizationService;
  /**
   * Optional reader of the video's burned-in subtitles (the ocr-rapid pack),
   * for settings.useBurnedInSubtitles. Absent or not installed => the speech
   * is transcribed, with a warning.
   */
  ocr?: SubtitleOcrService;
  /**
   * Where speech is in the audio (the STT worker's VAD). Anchors transcript
   * lines to when they are spoken; absent => lines without word timings keep
   * the engine's timing.
   */
  speechMap?: SpeechMapService;
  /**
   * Long-video STT chunking knobs. Audio longer than `sttChunkThresholdMs` is
   * transcribed in `sttChunkWindowMs` windows (bounded requests + per-chunk
   * checkpoints + progress). Defaults: 10-min windows above a 15-min threshold
   * (also overridable via STT_CHUNK_WINDOW_MS / STT_CHUNK_THRESHOLD_MS).
   */
  sttChunkWindowMs?: number;
  sttChunkThresholdMs?: number;
  /**
   * Measured speaking rates per voice (speechFit.ts). Alignment records each
   * run's clips here and translation budgets read them back; absent => every
   * run budgets with its TTS engine's default rate.
   */
  voiceRates?: VoiceRateBook;
  /**
   * The brand kit a project's logo and greeting come from (copied into the
   * project the first time; branding/brandKit.ts). Absent: a project that has
   * no copy of its branding yet fails at the mix/render with how to fix it.
   */
  brandKit?: Pick<BrandKit, 'get'>;
  /** Warnings raised outside the run (engine fallbacks), picked up when a step ends. */
  warningInbox?: WarningInbox;
  /**
   * Find a project's watermark, the whole detection run to its end (a result
   * saved earlier is used as it is): for `settings.watermarkAuto` when the
   * project has no boxes yet (picture/watermarkAuto.ts). Absent: such a render
   * hides only the boxes it was given, with a note in the log.
   */
  watermark?: { detect(projectId: string): Promise<PictureDetection> };
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

/**
 * `work`, or CANCELLED as soon as the run is aborted (the work itself goes on:
 * a picture detection finishes in the background and keeps its result).
 */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AppErrorException('CANCELLED', 'Pipeline run was cancelled.');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AppErrorException('CANCELLED', 'Pipeline run was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
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

/**
 * Write transcript segments to a JSON artifact — atomically: source.json is the
 * speech-to-text step's resume marker, and a file torn by a crash mid-write
 * would be skipped over as a finished transcript.
 */
async function writeSegments(path: string, segments: TranscriptSegment[]): Promise<void> {
  await writeJsonAtomic(path, { segments });
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

/** Persist the translation character sheet (atomically: the editor reads it). */
async function writeDocContext(path: string, ctx: TranslationDocContext): Promise<void> {
  await writeJsonAtomic(path, ctx);
}

/**
 * Persist a transcript and its subtitle sidecars atomically. The text passes
 * (translation, review, auto-fit) write while the editor may be reading the
 * same files; a torn translated.json is read back as a complete artifact.
 */
async function writeTranscriptAtomic(paths: WorkspacePaths, segments: TranscriptSegment[]): Promise<void> {
  await writeJsonAtomic(paths.translatedJson, { segments });
  // Planned for reading (displayCuesFor); the alignment step rewrites them
  // once the dub is placed, holding each line until its voice has finished.
  const cues = displayCuesFor(segments, { songSubtitles: await songSubtitlesOn(paths.projectJson) });
  await writeTextAtomic(paths.translatedSrt, segmentsToSrt(cues));
  await writeTextAtomic(paths.translatedVtt, segmentsToVtt(cues));
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

/** Persist the synthesis-group plan artifact (atomically: alignment and the editor read it). */
async function writeGroups(path: string, groups: SynthesisGroup[]): Promise<void> {
  const artifact: SynthesisGroupsArtifact = { groups };
  await writeJsonAtomic(path, artifact);
}

/**
 * A translation provider's `onProgress(done, total)` as the step's progress:
 * up to 90% (the character sheet and the line repairs follow), only on a whole
 * percent that moved, and in order (a line-by-line provider reports from
 * several requests at once). `log` gets every tenth of the lines.
 */
export function translationProgress(
  step: StepProgress,
  log: (done: number, total: number) => void,
  now: () => number = Date.now,
): (done: number, total: number) => void {
  let lastPct = -1;
  let lastTenth = 0;
  let chain: Promise<unknown> = Promise.resolve();
  // The measured pace, from the first report on (batches a checkpoint gave
  // back arrive at once and would make it look fast): on an 8 GB card the 27B
  // model translated about 0.36 lines/s, and nothing said so (field report B7).
  let first: { at: number; done: number } | undefined;
  return (done, total) => {
    if (!(total > 0)) return;
    const fraction = Math.min(1, done / total);
    const pct = Math.floor(fraction * 90);
    first ??= { at: now(), done };
    if (pct > lastPct) {
      lastPct = pct;
      const minutes = (now() - first.at) / 60_000;
      const perMin = minutes > 0.25 && done > first.done ? Math.round((done - first.done) / minutes) : undefined;
      const detail = {
        key: perMin !== undefined ? 'step-detail.translating-rate' : 'step-detail.translating',
        params: { done, total, ...(perMin !== undefined ? { rate: perMin } : {}) },
        text: `Translating ${done}/${total} lines${perMin !== undefined ? ` · ${perMin} lines/min` : ''}`,
      };
      chain = chain.then(() => step(pct / 100, detail)).catch(() => undefined);
    }
    const tenth = Math.floor(fraction * 10);
    if (tenth > lastTenth && done < total) {
      lastTenth = tenth;
      log(done, total);
    }
  };
}

/** What a unit's clip says: its members' current texts, in order. */
function unitText(group: SynthesisGroup, segById: ReadonlyMap<string, TranscriptSegment>): string {
  return group.segmentIds
    .map((id) => (segById.get(id)?.translatedText ?? segById.get(id)?.sourceText ?? '').trim())
    .filter((t) => t.length > 0)
    .join(' ');
}

/** Map segments to the planner's input shape (text = what TTS will speak). */
function toGroupInputs(segments: readonly TranscriptSegment[]): {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerId?: string;
  voiceId?: string;
  speakingRate?: number;
}[] {
  return segments.map((s) => {
    const text = (s.translatedText ?? s.sourceText ?? '').trim();
    return {
    id: s.id,
    startMs: s.startMs,
    endMs: s.endMs,
    // A line with nothing to say ("…", "♪", zero-width) is an empty unit:
    // grouping never joins it to a neighbour, and synthesis writes silence
    // for it (pipeline/speakable.ts) instead of letting the engine read it.
    text: hasSpeakableText(text) ? text : '',
    ...(s.speakerId ? { speakerId: s.speakerId } : {}),
    // Per-line editor overrides: grouping splits on them and synthesis honours them.
    ...(s.voiceId ? { voiceId: s.voiceId } : {}),
    ...(s.speakingRate !== undefined ? { speakingRate: s.speakingRate } : {}),
    };
  });
}

/** Progress callback for a long-running step (fraction in 0..1). */
export type StepProgress = ((fraction: number, detail?: StepDetail) => Promise<void>) & {
  /**
   * Record something that went worse than asked (models/diagnostics.ts): kept
   * with this step in the pipeline, shown in the app and get_project.
   */
  warn?: (warning: Omit<ProjectWarning, 'at' | 'step'>) => void;
};

/**
 * Above this time-stretch ratio a fitted line audibly changes delivery (rushed
 * pace ≈ "a different speaker"), so auto-fit prefers shortening its text. (The
 * stretch it shortens TO is speechFit.FIT_COMFORT_RATIO, shared with every
 * prompt's length ceiling.)
 */
const STRETCH_SOFT_CAP = 1.25;

/** True when a unit should go through auto-fit shortening. */
function needsDurationFit(a: AlignedSegment): boolean {
  return a.status === 'timing-conflict' || a.speedRatio > STRETCH_SOFT_CAP;
}

/** Aggregate result of synthesizing a set of groups (see synthesizeGroups). */
interface GroupSynthesisOutcome {
  synthesizedIds: Set<string>;
  /** Measured WAV duration per group id (drives the drift check). */
  durations: Map<string, number>;
  engine?: string;
  sawFallbackEngine: boolean;
  fallbackSegments: number;
  /** Units the engine served from its clip cache instead of re-synthesizing. */
  reusedSegments: number;
}

/**
 * Units per TTS request when the provider states no limit of its own.
 *
 * Synthesis used to go out as ONE request per voice: every utterance of the
 * dub in a single call, under the single 30-minute worker timeout. A 21-minute
 * video (120 utterances) on the CPU neural engine needed ~48 minutes, so it
 * could never finish: two attempts, both cut off at exactly 30 minutes while
 * the engine was still working, with no progress shown for any of it. Batches
 * bound every request, show progress between them, and let a retry resume
 * (the engines reuse finished clips). Piper does ~8 lines/s, so 48 per call
 * still costs it nothing.
 */
const DEFAULT_TTS_UNITS_PER_REQUEST = 48;
/**
 * Share of the TTS step's progress bar given to the first synthesis pass; the
 * drift pass (re-speaking drifting groups cue by cue) gets the rest. It was
 * 0.95, until the same dub re-spoke 99 cues after its 120 utterances: three
 * minutes of a bar crawling from 95 to 100. When there is no drift pass the bar
 * jumps forward at the end, which reads better than one that seems stuck.
 */
const TTS_FIRST_PASS_SHARE = 0.8;

/**
 * Alignment's progress bar, by phase: measuring the clips, then auto-fit
 * (shortening lines with the context model, then re-voicing them), then
 * re-voicing the still-too-long units at their natural pace. Measuring used to
 * fill the whole bar, so a 31-minute dub sat at "alignment 100%" for the 4.5
 * minutes of the other two, which reads as stuck.
 */
const ALIGN_MEASURED = 0.5;
const ALIGN_SHORTENED = 0.7;
const ALIGN_REFITTED = 0.85;

/**
 * A synthesizeGroups progress callback: maps (done, total) onto [from, to] of
 * the step's bar and logs "<verb> done/total <noun>..." at most once per tenth
 * of the run, so a long synthesis reads as progress in the log, not a hang.
 */
function ttsProgress(
  onProgress: StepProgress,
  from: number,
  to: number,
  log: (message: string) => void,
  verb: string,
  noun: string,
): (done: number, total: number) => Promise<void> {
  let loggedTenths = 0;
  return async (done, total) => {
    await onProgress(from + ((to - from) * done) / total, {
      key: 'step-detail.voicing',
      params: { done, total },
      text: `Voicing ${done}/${total}`,
    });
    const tenths = Math.floor((done / total) * 10);
    if (done < total && tenths > loggedTenths) {
      loggedTenths = tenths;
      log(`${verb} ${done}/${total} ${noun}...`);
    }
  };
}

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

/** A speech-to-text provider as the registry hands it out. */
type SttProviderRef = ReturnType<ProviderRegistry['getStt']>;
/** A translation provider as the registry hands it out. */
type TranslationProviderRef = ReturnType<ProviderRegistry['getTranslation']>;
/**
 * The bundled engine an app-picked engine falls back to, per phase. Not the
 * voice: voices belong to their engine (a VieNeu voice id means nothing to
 * Piper), and a dub that silently changed its whole sound is worse than one
 * that stops and says why.
 */
const BUILT_IN_PROVIDER = { stt: 'faster-whisper', translation: 'argos' } as const;
const BUILT_IN_STT_PROVIDER = BUILT_IN_PROVIDER.stt;
/**
 * Failures of the ENGINE (would not start, crashed, missing native runtime or
 * pack), which the built-in engine can stand in for.
 */
const STT_FALLBACK_CODES: ReadonlySet<string> = new Set(['ENGINE_UNAVAILABLE', 'ENGINE_PACK_MISSING', 'ENGINE_PACK_FAILED']);

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
   * The clips alignment measures were synthesized by THIS run's TTS step. Only
   * then are their paces recorded: a retry from alignment measures the same
   * clips again, and recording them twice weighted one dub double in every
   * later translation's length budgets.
   */
  private freshClips = false;

  /**
   * Run the pipeline for a project. Resumes by skipping already-completed steps
   * whose artifacts exist, unless `retryFromStep` forces re-execution.
   */
  async run(project: Project, options: RunOptions): Promise<void> {
    const { store, bus, logger } = this.deps;
    const paths = store.paths(project.id);
    this.freshClips = false;

    let state = await store.getPipeline(project.id);

    // Continuing a paused dub. The step it stopped in was cut off part-way, so
    // whatever it left on disk is not taken as "already done" (`interrupted`
    // below); it runs again and reuses what it saved of its own work.
    const resumedStep = state.pausedStep;
    const resumeIndex = resumedStep ? pipelineStepIndex(resumedStep) : Infinity;
    if (state.pausedAt !== undefined || state.status === 'paused') {
      state = resumePipelineState(state);
      await store.savePipeline(state);
      bus.emit({ type: 'state', pipeline: state });
      if (resumedStep) {
        logger.info(
          `Continuing the paused dub at "${pipelineStepLabel(resumedStep)}"; everything finished before the pause is kept.`,
        );
      }
    }

    // If retrying from a step, reset that step + all downstream to pending.
    if (options.retryFromStep) {
      state = this.resetFromStep(state, options.retryFromStep);
      await store.savePipeline(state);
      bus.emit({ type: 'state', pipeline: state });
      logger.info(`Retrying pipeline from step "${pipelineStepLabel(options.retryFromStep)}".`);
    }

    const retryIndex = options.retryFromStep ? pipelineStepIndex(options.retryFromStep) : Infinity;

    logger.info(`Pipeline started for project "${project.name}" (${project.id}).`);

    // Any (re)start leaves the transcript-review checkpoint: a plain "Run" on
    // a paused-for-review project means "I'm done reviewing — continue" (the
    // completed early steps skip straight through to TTS).
    if (state.awaitingReview || state.heldLines) {
      const { heldLines: _held, ...rest } = state;
      state = { ...rest, awaitingReview: false };
      await store.savePipeline(state);
      bus.emit({ type: 'state', pipeline: state });
    }

    try {
      for (const stepId of PIPELINE_STEP_IDS) {
        throwIfCancelled(options.signal);

        // A series parent only analyses the video (speech-to-text once, for the
        // whole of it); its parts dub the rest, each as a project of its own.
        if (project.series?.role === 'parent' && pipelineStepIndex(stepId) > pipelineStepIndex('stt')) {
          state = await transition(this.deps, state, stepId, 'skipped');
          continue;
        }

        const stepState = state.steps.find((s) => s.id === stepId);
        const forceRun = pipelineStepIndex(stepId) >= retryIndex;

        // Resumability: skip a previously-completed step whose outputs exist.
        if (!forceRun && stepState?.status === 'completed' && (await this.outputsExist(stepId, paths, project))) {
          logger.info(`Skipping "${pipelineStepLabel(stepId)}" — already completed.`);
          state = await transition(this.deps, state, stepId, 'skipped');
          continue;
        }

        // Also skip if outputs exist but status wasn't recorded as completed
        // (e.g. an older project, written before the pipeline recorded status).
        //
        // NEVER for a step recorded `failed`/`running`: those are exactly the
        // states a cancel or a crash leaves behind, and an artifact from an
        // interrupted ffmpeg used to be enough to "skip" the step and report
        // success — shipping a half-length dub. The media worker now writes
        // artifacts atomically (media-worker/src/atomic.ts), so a present
        // artifact really is a complete one; this is the second lock on the same
        // door, for artifacts written by an older version of the app.
        //
        // Nor at or after the step a paused dub continues at: the steps after
        // it are pending because this dub has not reached them, and the files
        // on disk are an earlier run's. A voice re-dub paused mid-synthesis
        // skipped alignment, mix and render on Continue and kept the old dub.
        const interrupted =
          stepState?.status === 'failed' || stepState?.status === 'running' || pipelineStepIndex(stepId) >= resumeIndex;
        if (!forceRun && !interrupted && stepState?.status !== 'completed' && (await this.outputsExist(stepId, paths, project))) {
          logger.info(`Skipping "${pipelineStepLabel(stepId)}" — outputs already present.`);
          state = await transition(this.deps, state, stepId, 'skipped');
          continue;
        }

        state = await transition(this.deps, state, stepId, 'running', { progressPercent: 0 });
        logger.info(`Step "${pipelineStepLabel(stepId)}" started.`);

        // Mid-step progress: re-emit the step as "running" with an updated
        // percent. Called sparingly (per chunk/batch), so it never floods SSE.
        // Writes go one at a time, and none is made once the run is stopping or
        // the step has returned: translation reports without waiting, so a
        // "running 84%" queued behind a burst of resumed batches landed after
        // the step was saved completed, and put a finished dub back to
        // "running" — or after a pause was saved, with nothing running.
        let progressWrite: Promise<unknown> = Promise.resolve();
        let stepReturned = false;
        const stepWarnings: ProjectWarning[] = [];
        const onProgress: StepProgress = Object.assign(
          (fraction: number, detail?: StepDetail) => {
            if (options.signal.aborted || stepReturned) return Promise.resolve();
            const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
            const write = progressWrite.then(async () => {
              if (stepReturned) return;
              state = await transition(this.deps, state, stepId, 'running', {
                progressPercent: pct,
                ...(detail !== undefined ? { detail } : {}),
              });
            });
            progressWrite = write.catch(() => undefined);
            return write;
          },
          {
            warn: (w: Omit<ProjectWarning, 'at' | 'step'>) => {
              stepWarnings.push({ ...w, step: stepId, at: new Date().toISOString() });
              this.deps.logger.warn(w.message);
            },
          },
        );
        // This step's warnings replace the ones an earlier run of it left.
        const settleWarnings = (): void => {
          const fromInbox = (this.deps.warningInbox?.drain(project.id) ?? []).map((w) => ({
            ...w,
            step: stepId,
            at: w.at ?? new Date().toISOString(),
          }));
          const mine = [...stepWarnings, ...fromInbox];
          const others = (state.warnings ?? []).filter((w) => w.step !== stepId);
          const warnings = [...others, ...mine];
          state = warnings.length > 0 ? { ...state, warnings } : (({ warnings: _w, ...rest }) => rest)(state);
        };

        try {
          await this.executeStep(stepId, project, paths, options.signal, onProgress);
        } catch (err) {
          // Pausing (or the app closing) aborts the run's signal: that stops the
          // dub where it is, it does not fail it. Before, the step was marked
          // failed and the project "failed", with a CANCELLED error on screen.
          // The reports made before the stop still land, so the paused step
          // keeps its latest percent.
          if (options.signal.aborted) {
            await progressWrite;
            stepReturned = true;
            state = await this.pauseRun(state, project);
            return;
          }
          stepReturned = true;
          await progressWrite;
          const appError = toAppError(err);
          logger.errorWithCause(`Step "${pipelineStepLabel(stepId)}" failed`, appError);
          settleWarnings();
          state = await transition(this.deps, state, stepId, 'failed', { error: appError.message });
          bus.emit({ type: 'error', error: appError });
          // Reflect failure on the project record.
          await this.markProjectStatus(project, 'failed');
          return;
        }

        stepReturned = true;
        await progressWrite;
        settleWarnings();
        state = await transition(this.deps, state, stepId, 'completed', { progressPercent: 100 });
        logger.info(`Step "${pipelineStepLabel(stepId)}" completed.`);

        // Transcript-review checkpoint: after the last text-shaping step
        // EXECUTES (refine — a no-op pass-through when unconfigured), pause so
        // the user can review/edit the segments before any voice is
        // synthesized. Only an EXECUTED step pauses — on the continue run the
        // earlier steps are 'skipped', so the pipeline flows straight to TTS;
        // a retry from translation re-runs refine and pauses again (the text
        // changed, so it deserves another look).
        // Lines still failing the translation checks hold the run here too
        // with settings.holdFlaggedLines (H7): fixed before any voice says them.
        const held = stepId === 'refine' && project.settings.holdFlaggedLines === true ? await this.heldLineIds(paths) : [];
        if (stepId === 'refine' && (project.settings.reviewBeforeSynthesis === true || held.length > 0)) {
          state = { ...state, awaitingReview: true, ...(held.length > 0 ? { heldLines: held.slice(0, MAX_HELD_LINES) } : {}) };
          await store.savePipeline(state);
          bus.emit({ type: 'state', pipeline: state });
          await this.markProjectStatus(project, 'paused');
          logger.info(
            held.length > 0
              ? `Stopped before voicing: ${held.length} line(s) still fail the translation checks (${held.slice(0, 5).join(', ')}${held.length > 5 ? ', …' : ''}). ` +
                  'Fix them in the editor (Problems), then continue dubbing (resumes at speech synthesis and voices the lines as they are then).'
              : 'Paused for transcript review: check the segments in the editor, then continue dubbing (resumes at speech synthesis).',
          );
          return;
        }
      }

      logger.info('Pipeline completed successfully.');
      await this.markProjectStatus(project, 'completed');
      bus.emit({ type: 'done' });
    } catch (err) {
      // Paused between steps (the check at the top of the loop).
      if (options.signal.aborted) {
        state = await this.pauseRun(state, project);
        return;
      }
      const appError = toAppError(err);
      logger.errorWithCause('Pipeline failed', appError);
      bus.emit({ type: 'error', error: appError });
      await this.markProjectStatus(project, 'failed');
    }
  }

  /**
   * The run stopped part-way and continues later: a pause, or the app closing.
   * Saved as `paused` at its step (pausePipelineState), never as a failure: the
   * step keeps its progress, the project shows "Paused" with a Continue
   * button, and no error is raised.
   */
  private async pauseRun(state: PipelineState, project: Project): Promise<PipelineState> {
    const { store, bus, logger } = this.deps;
    const paused = pausePipelineState(state);
    await store.savePipeline(paused);
    bus.emit({ type: 'state', pipeline: paused });
    const step = paused.steps.find((s) => s.id === paused.pausedStep);
    if (step) bus.emit({ type: 'step', step });
    await this.markProjectStatus(project, 'paused');
    logger.info(
      `Paused${paused.pausedStep ? ` at "${pipelineStepLabel(paused.pausedStep)}"` : ''}. ` +
        'Everything done so far is saved: continue any time, also after closing VideoDubber or restarting the computer.',
    );
    return paused;
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
  private async outputsExist(stepId: PipelineStepId, paths: WorkspacePaths, project: Project): Promise<boolean> {
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
      case 'refine':
        // The report doubles as the resume marker (written even when the pass
        // is skipped because no refine provider is configured).
        return fileExistsNonEmpty(paths.refineReportJson);
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
          // A line kept as the original song has no clip (songs/songLines.ts).
          const ids = groups ? groups.map((g) => g.id) : segments.filter((s) => !isSong(s)).map((s) => s.id);
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
        // The finished video is in the project's output folder (pipeline/output.ts).
        return fileExistsNonEmpty(projectOutputVideoPath(project));
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
        return this.stepExtractAudio(project, paths, signal, onProgress);
      case 'stt':
        return this.stepStt(project, paths, signal, onProgress);
      case 'translation':
        await this.stepTranslation(project, paths, signal, onProgress);
        // A series part's recap says what the previous part said: in the same words.
        await reuseRecapTranslations(project, this.deps.store).then(
          (n) => n > 0 && this.deps.logger.info(`Recap: ${n} line(s) take the previous part's translation.`),
          (err: unknown) => this.deps.logger.warn(`Recap lines keep their own translation (${String(err)}).`),
        );
        return;
      case 'refine':
        return this.stepRefine(project, paths, signal, onProgress);
      case 'tts':
        await this.stepTts(project, paths, signal, onProgress);
        this.freshClips = true;
        return;
      case 'alignment':
        return this.stepAlignment(project, paths, signal, onProgress);
      // The mix and the render read the project as it is NOW: what changes
      // only them may change while the dub runs, until it starts mixing
      // (Orchestrator.updateProjectSettings), and a rename moves the output.
      case 'audio-mix':
        return this.stepAudioMix(await this.current(project), paths, signal);
      case 'render':
        return this.stepRender(await this.autoWatermark(await this.current(project), signal), paths, signal);
      default:
        throw new AppErrorException('UNKNOWN', `Unknown pipeline step: ${stepId}`);
    }
  }

  /** The project as saved now (the run's copy when it cannot be read). */
  private async current(project: Project): Promise<Project> {
    return this.deps.store.getProject(project.id).catch(() => project);
  }

  /**
   * "Find the watermark and blur it" for a render whose project has no boxes
   * yet (a single video, or a part whose series found none): look now, save
   * the clear marks as the project's boxes, render with them. A series finds
   * its mark once during its analysis instead (series/seriesService.ts), so
   * its parts arrive here with boxes and skip this. Never fails the render: a
   * detection that fails or finds nothing is said in the log.
   */
  private async autoWatermark(project: Project, signal: AbortSignal): Promise<Project> {
    const auto = project.settings.watermarkAuto;
    if (!auto || (project.settings.blurRegions?.length ?? 0) > 0) return project;
    const { logger } = this.deps;
    if (!this.deps.watermark) {
      logger.warn('The settings ask for the watermark to be found and blurred, but the picture cannot be looked at here: rendering without.');
      return project;
    }
    logger.info('Looking for a watermark to blur (settings: find the watermark and blur it)...');
    let detection: PictureDetection;
    try {
      detection = await untilAborted(this.deps.watermark.detect(project.id), signal);
    } catch (err) {
      throwIfCancelled(signal);
      logger.warn(`Could not look for the watermark (${toAppError(err).message}): rendering without blurring it.`);
      return project;
    }
    throwIfCancelled(signal);
    const regions = autoBlurRegions(detection, auto);
    const faint = faintMarks(detection);
    if (regions.length === 0) {
      logger.info(
        `No watermark stood out clearly enough to blur by itself${faint > 0 ? ` (${faint} faint mark(s): check them with detect_watermark or the editor's Picture tab)` : ''}.`,
      );
      return project;
    }
    const fresh = await this.current(project);
    const saved = await this.deps.store.saveProject({ ...fresh, settings: { ...fresh.settings, blurRegions: regions } });
    logger.info(
      `Blurring ${describeMarks(detection)}. The box(es) are saved in the project (Picture in the editor; blurRegions) and used as they are from now on.`,
    );
    return saved;
  }

  // ----- Step implementations ----------------------------------------------

  private async stepProbe(project: Project, _paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const probed = await this.deps.media.probe(project.inputVideoPath, signal);
    if (!probed.hasAudio || probed.audioStreams.length === 0) {
      throw new AppErrorException('NO_AUDIO_STREAM', 'The input video has no audio stream to dub.');
    }
    // A series part dubs a window of the video: everything inside it is timed from the window's start.
    const info = rangedMediaInfo(probed, project.sourceRange);
    const fresh = await this.deps.store.getProject(project.id);
    await this.deps.store.saveProject({ ...fresh, mediaInfo: info });
    this.deps.logger.info(
      `Probed media: ${info.container}, ${Math.round(info.durationMs / 1000)}s, ${info.videoStreams.length} video / ${info.audioStreams.length} audio streams.`,
    );
  }

  private async stepExtractAudio(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress?: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    const range = project.sourceRange;
    this.deps.logger.info(`Extracting full-rate audio (original.wav)${range ? ' of this part' : ''}...`);
    await this.deps.media.extractAudio(project.inputVideoPath, paths.originalWav, signal, range);
    throwIfCancelled(signal);
    this.deps.logger.info('Extracting 16 kHz mono audio for STT (original_16k_mono.wav)...');
    await this.deps.media.extract16kMono(project.inputVideoPath, paths.original16kMonoWav, signal, range);
    // How far the source's audio was off its picture (sourceChecksStep.ts).
    await recordAudioDrift(this.deps, project, signal, onProgress);
  }

  private async stepStt(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    let provider = this.deps.registry.getStt(project.settings.sttProviderId);
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

    const transcribeWith = async (
      p: SttProviderRef,
    ): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string | undefined }> => {
      if (canChunk) return this.transcribeChunked(paths, p, model, explicitLanguage, plan, signal, onProgress);
      this.deps.logger.info(`Transcribing with provider "${p.id}" (model ${model})...`);
      const result = await p.transcribe(
        { audioPath: paths.original16kMonoWav, language: explicitLanguage, model, wordTimestamps: true },
        signal,
      );
      return { segments: result.segments, detectedLanguage: result.detectedLanguage };
    };

    let transcript: { segments: TranscriptSegment[]; detectedLanguage: string | undefined };
    // The site's own subtitles (Bilibili CC/AI) instead of the engine, when the
    // project asks for them and the download has some in its spoken language.
    const fromSite = project.settings.useSourceSubtitles ? await siteTranscript(project) : undefined;
    if (project.settings.useSourceSubtitles && !fromSite) {
      this.deps.logger.info(
        'The site published no subtitles for this video in its spoken language (Bilibili gives them only to a signed-in account): transcribing it.',
      );
    }
    // The video's own burned-in subtitles read as text, when the project asks
    // for them (pipeline/burnedInTranscript.ts); undefined: they could not be,
    // and a warning says why.
    const fromPicture = !fromSite && project.settings.useBurnedInSubtitles ? await this.burnedInTranscript(project, paths, signal, onProgress) : undefined;
    if (fromSite) {
      this.deps.logger.info(
        `Using the "${fromSite.label}" subtitles the site published (${fromSite.segments.length} lines) instead of speech-to-text.`,
      );
      transcript = { segments: fromSite.segments, detectedLanguage: fromSite.language };
    } else if (fromPicture) {
      this.deps.logger.info(`Using the video's own subtitles (${fromPicture.length} lines read from the picture) instead of speech-to-text.`);
      transcript = { segments: fromPicture, detectedLanguage: explicitLanguage };
    } else try {
      transcript = await transcribeWith(provider);
    } catch (err) {
      const fallback = this.sttFallbackFor(project, provider.id, err);
      if (!fallback) throw err;
      this.deps.logger.warn(
        `Speech-to-text engine "${provider.id}" could not run (${toAppError(err).message}). ` +
          `The app picked it for this project, so the built-in "${fallback.id}" transcribes instead.`,
      );
      await this.recordSttFallback(project.id, fallback.id);
      provider = fallback;
      transcript = await transcribeWith(provider);
    }
    let { segments } = transcript;
    const { detectedLanguage } = transcript;

    // Optional forced alignment (WhisperX engine pack, not shipped yet):
    // tighter word timestamps (±50 ms). Said, not silent, when it cannot run.
    if (project.settings.forcedAlignment) {
      throwIfCancelled(signal);
      const refined = this.deps.alignment
        ? await this.deps.alignment
            .align(paths.original16kMonoWav, segments, detectedLanguage || project.settings.sourceLanguage, { diarize: false }, signal)
            .catch((err: unknown) => {
              throwIfCancelled(signal);
              this.deps.logger.warn(`Alignment failed (${String(err)}); keeping the original timestamps.`);
              return null;
            })
        : null;
      if (refined && refined.length > 0) {
        segments = refined;
        this.deps.logger.info('Forced alignment complete (word-accurate timing).');
      } else if (refined === null) {
        this.deps.logger.warn('Forced alignment is on, but no alignment engine is installed: using the default timestamps.');
      }
    }

    // Transcription loops (pipeline/loopRepair.ts): found, decoded again
    // without context, repaired; what is left is flagged and said. Before
    // speaker detection, so the repaired lines get their speakers.
    // The STT self-checks (sttChecks.ts, spotCheck.ts) around it: lines
    // written over silence go through the same pass, a minute of every half
    // hour is decoded again, and the audio is searched for digital silence.
    let speech: { regions?: SpeechRegion[] } | undefined;
    let loopOutcome: LoopOutcome | undefined;
    let subtitles: SubtitlePresenceReport | undefined;
    if (!fromSite && !fromPicture) {
      speech = await speechMapForChecks(this.deps, paths, segments, totalDurationMs, signal);
      // The video's own subtitles, where it burns them in: a line under one
      // is never taken for silence (pipeline/subtitleCoverage.ts).
      subtitles = await this.subtitlePresence(project, paths, signal, onProgress);
      const checkRegions = speech?.regions && subtitles ? speechWithSubtitles(speech.regions, subtitles.events) : speech?.regions;
      const lastEnd = segments.reduce((m, s) => Math.max(m, s.endMs), totalDurationMs);
      const chunks = canChunk ? plan : [{ startMs: 0, endMs: lastEnd }];
      const silent = checkRegions ? linesOverSilence(segments, checkRegions, chunks) : undefined;
      loopOutcome = await this.repairTranscriptLoops(paths, provider, model, detectedLanguage || explicitLanguage, segments, signal, onProgress, silent, chunks);
      segments = loopOutcome.lines;
      // Said once the loop pass has decided them: how many, and what became of them.
      const silenceWarning = silent ? silenceCheckWarning(silent.findings, loopOutcome.ranges) : undefined;
      if (silenceWarning) onProgress.warn?.(silenceWarning);
      const language = detectedLanguage || explicitLanguage;
      const check = { project, paths, provider, model, language, segments, totalMs: totalDurationMs, regions: speech?.regions };
      await spotCheckTranscript(this.deps, check, signal, onProgress);
    }
    await checkDigitalSilence(this.deps, paths, segments, totalDurationMs, speech?.regions, signal, onProgress);

    // Speaker detection: who says each line, before anchoring so a line it
    // splits keeps its speaker (pipeline/diarization.ts).
    if (project.settings.diarize) {
      segments = await this.detectSpeakers(paths, segments, project.settings.diarizeSpeakers, signal, onProgress);
      await this.recordSpeakerGenders(project.id, paths);
    }

    segments = await this.anchorToSpeech(
      paths,
      segments,
      detectedLanguage || project.settings.sourceLanguage || '',
      signal,
      speech,
    );
    // The last word on timing: no empty fragment, duplicate or overlap reaches
    // the editor, whose timeline refuses overlaps (pipeline/transcriptTidy.ts).
    const tidy = tidyTranscript(segments);
    segments = tidy.lines;
    if (tidy.report.dropped + tidy.report.merged + tidy.report.separated > 0) {
      this.deps.logger.info(
        `Tidied the transcript: ${tidy.report.dropped} empty fragment(s) dropped, ${tidy.report.merged} duplicate(s) made one, ${tidy.report.separated} overlap(s) separated.`,
      );
    }
    // The lines as they are now against the video's own subtitles: speech the
    // subtitles show with no line, lines no subtitle shows.
    if (subtitles) {
      const coverage = subtitleCoverage(subtitles.events, segments);
      this.deps.logger.info(
        `The video's own subtitles against the lines: ${coverage.missing.length} subtitle(s) without a line (${Math.round(coverage.missingMs / 1000)} s), ` +
          `${Math.round(coverage.linesCovered * 100)} % of the lines' time under a subtitle${coverage.unseen.length > 0 ? `, ${coverage.unseen.length} line(s) under none` : ''}.`,
      );
      for (const w of coverageWarnings(coverage)) onProgress.warn?.(w);
    }

    await writeSegments(paths.sourceJson, segments);
    await writeTextAtomic(paths.sourceSrt, segmentsToSrt(displayCuesFor(segments, { songSubtitles: await songSubtitlesOn(paths.projectJson) })));
    this.deps.logger.info(`Transcribed ${segments.length} segments (detected language: ${detectedLanguage}).`);
    // Every range the loop pass changed is an entry of the edit history, so a
    // wrong decision can be undone range by range (claude-dubber, 2026-11-25).
    if (loopOutcome) await recordLoopEdits(project.id, loopOutcome, segments);

    // The STT chunk clips/checkpoints were scratch space; reclaim the disk now
    // that source.json is the durable artifact (a retry re-chunks from scratch).
    if (canChunk) {
      await fsp.rm(paths.sttChunksDir, { recursive: true, force: true }).catch(() => {});
    }
    // Lines that look sung, offered to keep as the original song: never applied here (songs/songSuggestions.ts).
    await recordSongSuggestions(paths, segments, { language: detectedLanguage || project.settings.sourceLanguage || '', warn: onProgress.warn, log: (m) => this.deps.logger.info(m) });
  }

  /**
   * The engine to fall back to when the speech-to-text engine failed to run.
   * Only when the APP picked that engine (an installed GPU engine, see
   * recommendProjectSettings): a project that used to work on the built-in
   * engine must not start failing because a better one was installed. An
   * engine the user chose fails loudly, as before; so does anything that is
   * not the engine's fault (bad audio, cancellation, a missing speech model
   * the run gate would have caught).
   */
  private sttFallbackFor(project: Project, providerId: string, err: unknown): SttProviderRef | undefined {
    if (providerId === BUILT_IN_STT_PROVIDER) return undefined;
    if (!project.settings.autoSelectedPhases?.includes('stt')) return undefined;
    if (!STT_FALLBACK_CODES.has(toAppError(err).code)) return undefined;
    try {
      return this.deps.registry.getStt(BUILT_IN_STT_PROVIDER);
    } catch {
      return undefined;
    }
  }

  /** Make the project say which engine actually transcribed it (and stop retrying the broken one). */
  private async recordSttFallback(projectId: string, providerId: string): Promise<void> {
    await this.recordFallback(projectId, 'stt', providerId);
  }

  /**
   * The built-in translator to fall back to when the translation engine failed
   * to run — under the same rule as {@link sttFallbackFor}: only an engine the
   * APP picked (TranslateGemma, once installed), only for a failure of the
   * engine itself. A project that translated with Argos before the GPU engine
   * was installed must not start failing because of it.
   */
  private translationFallbackFor(project: Project, providerId: string, err: unknown): TranslationProviderRef | undefined {
    if (providerId === BUILT_IN_PROVIDER.translation) return undefined;
    if (!project.settings.autoSelectedPhases?.includes('translation')) return undefined;
    if (!STT_FALLBACK_CODES.has(toAppError(err).code)) return undefined;
    try {
      const fallback = this.deps.registry.getTranslation(BUILT_IN_PROVIDER.translation);
      return fallback.id === BUILT_IN_PROVIDER.translation ? fallback : undefined;
    } catch {
      return undefined;
    }
  }

  /** Make the project say which engine actually ran a phase (and stop retrying the broken one). */
  private async recordFallback(projectId: string, phase: 'stt' | 'translation', providerId: string): Promise<void> {
    const fresh = await this.deps.store.getProject(projectId);
    const { autoSelectedPhases, ...settings } = fresh.settings;
    const auto = (autoSelectedPhases ?? []).filter((p) => p !== phase);
    const field = phase === 'stt' ? 'sttProviderId' : 'translationProviderId';
    await this.deps.store.saveProject({
      ...fresh,
      settings: { ...settings, [field]: providerId, ...(auto.length > 0 ? { autoSelectedPhases: auto } : {}) },
    });
  }

  /**
   * Find transcription loops and repair them (pipeline/loopRepair.ts). A
   * range is decoded again without the previous text, from a clip of the
   * audio; without the clip capability nothing can be decoded again, and the
   * loops are only flagged. The report goes to audio/loop_ranges.json, the
   * outcome to the project's warnings, and lines left in a loop carry
   * `loopSuspect` for the editor and get_transcript.
   */
  private async repairTranscriptLoops(
    paths: WorkspacePaths,
    provider: SttProviderRef,
    model: string,
    language: string | undefined,
    segments: TranscriptSegment[],
    signal: AbortSignal,
    onProgress: StepProgress,
    /** The speech map's verdict (linesOverSilence): its `inSilence`, and the lines written over silence. */
    silence?: { inSilence: (fromMs: number, toMs: number) => boolean; ranges: readonly LoopRange[] },
    /** The windows speech-to-text decoded (its STT chunks): where its 30-s decoder windows started. */
    chunks: readonly { startMs: number }[] = [{ startMs: 0 }],
  ): Promise<LoopOutcome> {
    const ranges = mergeLoopRanges(findLoopRanges(segments, silence?.inSilence), silence?.ranges ?? []);
    if (ranges.length === 0) {
      await fsp.rm(paths.loopRangesJson, { force: true }).catch(() => undefined);
      return { lines: segments, ranges: [], originals: [] };
    }
    this.deps.logger.info(`Found ${ranges.length} range(s) that look like transcription loops or credit lines; checking them...`);
    const clip = this.deps.media.clip16kMono?.bind(this.deps.media);
    let done = 0;
    const redecode = async (fromMs: number, toMs: number, s: AbortSignal): Promise<TranscriptSegment[]> => {
      if (!clip) throw new Error('this build cannot cut the audio to decode a range again');
      await fsp.mkdir(paths.sttChunksDir, { recursive: true });
      const clipPath = path.join(paths.sttChunksDir, `loop_${fromMs}_${toMs}.wav`);
      try {
        await clip(paths.original16kMonoWav, clipPath, fromMs, toMs, s);
        // Listening to every second: the speech map's detector is what
        // called these ranges silent, so it must not filter the second opinion.
        const res = await provider.transcribe({ audioPath: clipPath, language, model, wordTimestamps: true, noContext: true, vadFilter: false }, s);
        return res.segments.map((x) => offsetSegment(x, fromMs));
      } finally {
        await fsp.rm(clipPath, { force: true }).catch(() => undefined);
        done += 1;
        await onProgress(0.97, { key: 'step-detail.loops', params: { done, total: ranges.length }, text: `Checking transcription loops ${done}/${ranges.length}` });
      }
    };
    // Where speech-to-text's own 30-s windows started: a line that starts on
    // one, far longer than its words, has its timing from the decoder.
    const starts = chunks.map((c) => c.startMs).sort((a, b) => a - b);
    const originalOnWindow = (ms: number): boolean => {
      const chunkStart = starts.filter((s) => s <= ms).pop() ?? 0;
      return onDecoderWindow(ms, chunkStart);
    };
    const outcome = await repairLoops(
      segments,
      ranges,
      { redecode, expectedSpeechMs, originalOnWindow, ...(silence ? { inSilence: silence.inSilence } : {}) },
      signal,
    );
    // Lines still inside a range left as it was: a person must look at them.
    const left = outcome.ranges.filter((r) => r.status === 'left');
    const lines = outcome.lines.map((l) =>
      left.some((r) => l.startMs < r.toMs && l.endMs > r.fromMs) ? { ...l, loopSuspect: true as const } : l,
    );
    await writeJsonAtomic(paths.loopRangesJson, { checkedAt: new Date().toISOString(), ranges: outcome.ranges });
    this.reportLoops(outcome.ranges, onProgress);
    return { lines, ranges: outcome.ranges, originals: outcome.originals };
  }

  /** The loop check's outcome in the log and the project's warnings. */
  private reportLoops(ranges: readonly RepairedRange[], onProgress: StepProgress): void {
    const count = (s: RepairedRange['status']): number => ranges.filter((r) => r.status === s).length;
    const repaired = count('replaced') + count('removed');
    const left = count('left');
    const kept = count('kept');
    const clock = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
    for (const r of ranges) {
      this.deps.logger.info(
        `Loop check ${clock(r.fromMs)}-${clock(r.toMs)} (${r.kind}${r.phrase ? `: "${r.phrase}"` : ''}): ${r.status}, ${r.before} -> ${r.after} line(s)${r.reason ? `; ${r.reason}` : ''}.`,
      );
    }
    if (repaired > 0) {
      onProgress.warn?.({
        code: 'loops-repaired',
        key: 'warning.loops-repaired',
        params: { count: repaired },
        message: `${repaired} transcription loop(s) or credit line(s) were repaired (decoded again, or removed where nothing was said).${kept > 0 ? ` ${kept} repetition(s) were real and kept.` : ''}`,
      });
    }
    if (left > 0) {
      onProgress.warn?.({
        code: 'loops-left',
        key: 'warning.loops-left',
        params: { count: left },
        message: `${left} range(s) that look like transcription loops could not be repaired: their lines are marked in the editor (Problems) and in get_transcript. Check them before dubbing.`,
      });
    }
  }

  /**
   * Who says each line (speaker detection, pipeline/diarization.ts). Best
   * effort, and said: without the engine, or when it fails, the lines keep no
   * speaker and the dub goes on in the project voice. A failure is a project
   * warning, not only a log line: the field report's 10-hour drama lost its
   * speakers to an HTTP 500 that only the log mentioned, and a whole series
   * was dubbed in one voice. A pause still stops.
   */
  private async detectSpeakers(
    paths: WorkspacePaths,
    segments: TranscriptSegment[],
    knownCount: number | undefined,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<TranscriptSegment[]> {
    const service = this.deps.diarization;
    if (!service || !(await service.available().catch(() => false))) {
      this.deps.logger.warn(
        'Speaker detection is on, but its engine is not installed (Settings → Engines → Speaker detection): the lines keep no speaker.',
      );
      return segments;
    }
    throwIfCancelled(signal);
    this.deps.logger.info('Detecting who says each line...');
    const warn = (w: Omit<ProjectWarning, 'at' | 'step'>): void =>
      onProgress.warn ? onProgress.warn(w) : this.deps.logger.warn(w.message);
    try {
      const numSpeakers = knownCount && knownCount >= 2 ? knownCount : undefined;
      const found = await detectLineSpeakers({
        service,
        audioPath: paths.original16kMonoWav,
        cachePath: paths.diarizationJson,
        checkpointDir: paths.diarizationChunksDir,
        segments,
        ...(numSpeakers ? { numSpeakers } : {}),
        onProgress: speakerDetectionProgress(onProgress, (m) => this.deps.logger.info(m)),
        signal,
      });
      if (!found) return segments;
      const out = found.segments;
      const speakers = new Set(out.map((s) => s.speakerId).filter(Boolean)).size;
      const nobody = out.filter((s) => !s.speakerId).length;
      this.deps.logger.info(
        `Found ${speakers} speaker(s)${nobody > 0 ? `; ${nobody} line(s) could not be given one (set them in the editor)` : ''}.`,
      );
      if (found.lowConfidence > 0) {
        warn({
          code: 'speakers-low-confidence',
          key: 'warning.speakers-low-confidence',
          params: { count: found.lowConfidence },
          message: `${found.lowConfidence} line(s) got only a best-guess speaker (music, voices at once, or no clear turn): check them in the editor's Issues.`,
        });
      }
      return out;
    } catch (err) {
      throwIfCancelled(signal);
      const cause = toAppError(err).message;
      warn({
        code: 'speakers-failed',
        key: 'warning.speakers-failed',
        params: { cause },
        message: `Speaker detection failed (${cause}): the dub uses one voice. Re-detect speakers in the editor, or with detect_speakers.`,
      });
      return segments;
    }
  }

  /**
   * Save each detected speaker's gender in the project (settings.speakerGenders),
   * so the default voice of their gender speaks a speaker with no voice of
   * their own, in the dub and in the editor alike (voiceForLine). Best effort.
   */
  private async recordSpeakerGenders(projectId: string, paths: WorkspacePaths): Promise<void> {
    try {
      const profiles = await readSpeakerProfiles(paths.diarizationJson);
      const genders: Record<string, 'female' | 'male'> = {};
      for (const p of profiles) if (p.gender === 'male' || p.gender === 'female') genders[p.speakerId] = p.gender;
      const fresh = await this.deps.store.getProject(projectId);
      const { speakerGenders: _old, ...rest } = fresh.settings;
      await this.deps.store.saveProject({
        ...fresh,
        settings: Object.keys(genders).length > 0 ? { ...rest, speakerGenders: genders } : rest,
      });
    } catch (err) {
      this.deps.logger.warn(`Could not record the speakers' genders (${toAppError(err).message}).`);
    }
  }

  /**
   * Anchor every line to when it is spoken (pipeline/segmentTiming.ts). The
   * speech map is best-effort: without it, lines without word timings keep the
   * engine's timing, as before.
   */
  private async anchorToSpeech(
    paths: WorkspacePaths,
    segments: TranscriptSegment[],
    language: string,
    signal: AbortSignal,
    /** The map the STT checks already measured (or failed to: then not asked again). */
    measured?: { regions?: SpeechRegion[] },
  ): Promise<TranscriptSegment[]> {
    let regions: SpeechRegion[] | undefined;
    if (this.deps.speechMap && needsSpeechMap(segments)) {
      throwIfCancelled(signal);
      try {
        regions = measured
          ? measured.regions
          : await cachedSpeechRegions(this.deps.speechMap, paths.original16kMonoWav, paths.speechRegionsJson, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        this.deps.logger.warn(
          `Could not map where speech is (${toAppError(err).message}); lines without word timings keep the engine's timing.`,
        );
      }
    }
    const { segments: anchored, report } = anchorSegmentsToSpeech(segments, {
      sourceLanguage: language,
      ...(regions ? { regions } : {}),
    });
    if (report.moved > 0) {
      this.deps.logger.info(
        `Re-timed ${report.moved} of ${segments.length} lines to when they are spoken ` +
          `(${report.byWords} by word timings, ${report.bySpeechMap} by the speech map; ` +
          `${report.split} split at a long pause; largest shift ${(report.maxShiftMs / 1000).toFixed(1)} s).`,
      );
    }
    return anchored;
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
        await this.deps.media.clip16kMono!(paths.original16kMonoWav, clipPath, chunk.startMs, chunk.endMs, signal);
        const res = await provider.transcribe(
          { audioPath: clipPath, language: detectedLanguage, model, wordTimestamps: true },
          signal,
        );
        if (!detectedLanguage && res.detectedLanguage) detectedLanguage = res.detectedLanguage;
        chunkSegments = res.segments.map((s) => offsetSegment(s, chunk.startMs));
        // Atomic: a resumed run trusts a checkpoint that exists.
        await writeJsonAtomic(checkpoint, { detectedLanguage: res.detectedLanguage, segments: chunkSegments });
        // The clip WAV is large; drop it once its checkpoint is written.
        await fsp.rm(clipPath, { force: true }).catch(() => {});
        this.deps.logger.info(
          `STT chunk ${chunk.index + 1}/${plan.length}: ${chunkSegments.length} segments ` +
            `(${Math.round(chunk.startMs / 1000)}-${Math.round(chunk.endMs / 1000)}s).`,
        );
      }

      all.push(...chunkSegments);
      await onProgress((chunk.index + 1) / plan.length, {
        key: 'step-detail.transcribing',
        params: { done: chunk.index + 1, total: plan.length },
        text: `Transcribing part ${chunk.index + 1}/${plan.length}`,
      });
    }

    // Re-number ids/index so the merged transcript is contiguous and unique
    // (each chunk's worker numbering restarts at seg_0001).
    const segments = all.map((s, i) => ({ ...s, index: i, id: `seg_${padSegmentIndex(i + 1)}` }));
    return { segments, detectedLanguage };
  }

  /**
   * The speaking rate translation budgets use: the project voice's measured
   * rate once it has enough history (RunnerDeps.voiceRates), else its TTS
   * engine's default, else the language default (evidence in speechFit.ts).
   */
  private async speechRateFor(project: Project): Promise<ResolvedVoiceRate> {
    return resolveVoiceRate(
      this.deps.voiceRates,
      project.settings.ttsProviderId,
      project.settings.ttsVoiceId,
      project.settings.targetLanguage,
    );
  }

  /**
   * When the video's own burned-in subtitles are on screen
   * (settings.subtitleCoverageCheck; pipeline/subtitleCoverage.ts): read once
   * over the project's window and kept in audio/subtitle_presence.json, in the
   * transcript's time. Undefined when the check is off, no subtitle band is
   * known, or the picture cannot be read: said in the log, and speech-to-text
   * goes on without it.
   */
  private async subtitlePresence(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
    /** The transcript itself needs it (useBurnedInSubtitles): read whatever the check's setting says. */
    opts: { required?: boolean } = {},
  ): Promise<SubtitlePresenceReport | undefined> {
    if (!opts.required && !subtitleCheckOn(project.settings.subtitleCoverageCheck, project.settings.sourceLanguage)) return undefined;
    const { logger } = this.deps;
    const scan = this.deps.media.scanSubtitlePresence?.bind(this.deps.media);
    if (!scan) {
      logger.info('This build cannot read the picture for subtitles: speech-to-text is not checked against the video\'s own subtitles.');
      return undefined;
    }
    let detection: PictureDetection | undefined;
    if (!project.settings.burnSubtitleStyle?.coverBand && this.deps.watermark) {
      try {
        detection = await untilAborted(this.deps.watermark.detect(project.id), signal);
      } catch (err) {
        throwIfCancelled(signal);
        logger.info(`Could not look for the video's own subtitles (${toAppError(err).message}): speech-to-text is not checked against them.`);
        return undefined;
      }
    }
    const found = subtitleBandFor(project, detection);
    if (!found) {
      logger.info('No band of burned-in subtitles was found in this video: speech-to-text is not checked against its own subtitles.');
      return undefined;
    }
    const window = {
      startMs: project.sourceRange?.startMs ?? 0,
      ...(project.sourceRange?.endMs !== undefined ? { endMs: project.sourceRange.endMs } : {}),
    };
    const saved = await readPresenceReport(paths.subtitlePresenceJson);
    if (saved && sameRead(saved, found.band, window)) return saved;
    const pct = (v: number): number => Math.round(v * 1000) / 10;
    logger.info(
      `Reading the video's own subtitles (the band at ${pct(found.band.y)}–${pct(found.band.y + found.band.h)} % of the height, ` +
        `${found.from === 'settings' ? 'as set in the project' : 'as picture detection found it'}), five frames a second...`,
    );
    let read: Awaited<ReturnType<typeof scan>>;
    try {
      read = await scan(
        project.inputVideoPath,
        { band: found.band, ...window },
        (fraction) => {
          const percent = Math.round(fraction * 100);
          void onProgress(0.95, { key: 'step-detail.subtitle-check', params: { percent }, text: `Reading the video's own subtitles ${percent}%` });
        },
        signal,
      );
    } catch (err) {
      throwIfCancelled(signal);
      logger.warn(`Could not read the video's own subtitles (${toAppError(err).message}): speech-to-text is not checked against them.`);
      return undefined;
    }
    const report: SubtitlePresenceReport = {
      at: new Date().toISOString(),
      band: found.band,
      bandFrom: found.from,
      window,
      frames: read.frames,
      framesWithText: read.framesWithText,
      events: read.events.map((e) => ({ startMs: e.startMs - window.startMs, endMs: e.endMs - window.startMs })),
    };
    await writeJsonAtomic(paths.subtitlePresenceJson, report);
    const onScreen = report.events.reduce((ms, e) => ms + (e.endMs - e.startMs), 0);
    logger.info(`The video's own subtitles: ${report.events.length} on screen, for ${Math.round(onScreen / 1000)} s in all.`);
    return report;
  }

  /**
   * The transcript from the video's own burned-in subtitles
   * (settings.useBurnedInSubtitles; pipeline/burnedInTranscript.ts): when each
   * is on screen (the subtitle check's scan), one frame inside each cut from
   * the band, and read by the subtitle reader. What was read is kept in
   * audio/subtitle_ocr.json, so a retry reads nothing again. Undefined, with a
   * warning, when it cannot be the transcript: speech-to-text runs instead.
   */
  private async burnedInTranscript(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<TranscriptSegment[] | undefined> {
    const { logger } = this.deps;
    const fallback = (key: string, message: string, params: Record<string, string | number> = {}): undefined => {
      onProgress.warn?.({
        code: 'burned-in-fallback',
        key,
        params,
        message: `The video's own subtitles could not be its transcript: ${message} Speech-to-text transcribed it instead.`,
      });
      return undefined;
    };
    const ocr = this.deps.ocr;
    const cut = this.deps.media.readBandFrames?.bind(this.deps.media);
    if (!ocr || !cut || !(await ocr.available())) {
      return fallback(
        'warning.burned-in-not-installed',
        'the subtitle reader is not installed (Settings → Engines & models → Reading burned-in subtitles; MCP install_engine ocr-rapid).',
      );
    }
    const presence = await this.subtitlePresence(project, paths, signal, onProgress, { required: true });
    if (!presence) return fallback('warning.burned-in-no-band', 'no band of subtitles was found in the picture.');
    if (presence.events.length < MIN_SUBTITLES) {
      return fallback('warning.burned-in-few', `only ${presence.events.length} subtitle(s) showed in the picture.`, { count: presence.events.length });
    }
    const key = { band: presence.band, window: presence.window, events: presence.events.length, first: presence.events[0], last: presence.events[presence.events.length - 1] };
    const saved = await fsp
      .readFile(paths.subtitleOcrJson, 'utf8')
      .then((raw) => JSON.parse(raw) as { key?: unknown; reads?: (SubtitleRead | null)[] })
      .catch(() => undefined);
    let reads: (SubtitleRead | undefined)[];
    if (saved && JSON.stringify(saved.key) === JSON.stringify(key) && Array.isArray(saved.reads) && saved.reads.length === presence.events.length) {
      reads = saved.reads.map((r) => r ?? undefined);
      logger.info(`Using the ${reads.length} subtitle(s) read from the picture before.`);
    } else {
      const framesPath = path.join(paths.audioDir, 'subtitle_frames.u8');
      try {
        logger.info(`Reading the text of ${presence.events.length} subtitle(s) in the picture...`);
        const times = presence.events.map((e) => readingTimeOf(e) + presence.window.startMs);
        const frames = await cut(
          project.inputVideoPath,
          { band: presence.band, timesMs: times, outputPath: framesPath },
          (fraction) => {
            const percent = Math.round(fraction * 100);
            void onProgress(0.3 * fraction, { key: 'step-detail.subtitle-frames', params: { percent }, text: `Cutting the subtitles from the picture ${percent}%` });
          },
          signal,
        );
        const found = await ocr.read(
          { path: framesPath, width: frames.width, height: frames.height, count: frames.count },
          {
            onProgress: (done, total) =>
              void onProgress(0.3 + (0.6 * done) / Math.max(1, total), {
                key: 'step-detail.subtitle-reading',
                params: { done, total },
                text: `Reading the subtitles ${done}/${total}`,
              }),
          },
          signal,
        );
        if (!found) {
          return fallback('warning.burned-in-not-installed', 'the subtitle reader is not installed (Settings → Engines & models → Reading burned-in subtitles).');
        }
        const byIndex = new Map(found.map((r) => [r.index, r]));
        reads = frames.indexOf.map((k) => byIndex.get(k));
        await writeJsonAtomic(paths.subtitleOcrJson, { at: new Date().toISOString(), key, reads: reads.map((r) => r ?? null) });
      } catch (err) {
        throwIfCancelled(signal);
        const reason = toAppError(err).message;
        return fallback('warning.burned-in-failed', `reading them failed (${reason}).`, { reason });
      } finally {
        await fsp.rm(framesPath, { force: true }).catch(() => undefined);
      }
    }
    const built = linesFromSubtitles(presence.events, reads);
    if (!enoughRead(built, presence.events.length)) {
      return fallback(
        'warning.burned-in-unreadable',
        `only ${built.lines.length} of the ${presence.events.length} subtitles could be read.`,
        { count: built.lines.length, total: presence.events.length },
      );
    }
    logger.info(
      `Read ${built.lines.length} line(s) from the video's own subtitles (${presence.events.length} on screen` +
        `${built.unreadable > 0 ? `, ${built.unreadable} unreadable` : ''}${built.merged > 0 ? `, ${built.merged} repeat(s) joined` : ''}).`,
    );
    return built.lines;
  }

  /** The project's context engine (contextEngine.ts), logging every candidate it has to skip. */
  private contextEngineFor(project: Project): FallbackContextChat {
    return new FallbackContextChat(contextEngineCandidates(this.deps.registry, project.settings), (provider, err) =>
      this.deps.logger.info(`"${provider.displayName}" cannot run here (${toAppError(err).message}); trying the next model.`),
    );
  }

  /**
   * Build and persist the character sheet with `chat`, or fail LOUDLY: a
   * pipeline warning plus a `failed` status in translation_report.json (the
   * editor/MCP surface). The old code swallowed every analysis error, and not
   * one of six audited projects (2026-11) had a sheet.
   */
  private async generateSheet(
    project: Project,
    paths: WorkspacePaths,
    chat: AnalysisChat,
    engineLabel: () => string | undefined,
    segments: PromptSegment[],
    signal: AbortSignal,
  ): Promise<{ sheet?: TranslationDocContext; status: CharacterSheetStatus }> {
    const at = (): string => new Date().toISOString();
    const outcome = await generateCharacterSheet(
      chat,
      // How the source spells its names (title, file names), over what was heard (F1).
      { sourceLanguage: project.settings.sourceLanguage, targetLanguage: project.settings.targetLanguage, segments, hints: sourceNameHints(project) },
      signal,
    );
    const engine = engineLabel();
    if (outcome.analysis) {
      await writeDocContext(paths.translationContextJson, outcome.analysis);
      this.deps.logger.info(
        `Generated the translation character sheet (cast, glossary, pronoun plan) with "${engine ?? 'the context model'}" — review it in the editor to fine-tune pronouns/terminology, then re-run translation.`,
      );
      return {
        sheet: outcome.analysis,
        status: { status: 'generated', ...(engine ? { engine } : {}), attempts: outcome.attempts, at: at() },
      };
    }
    const why = outcome.attempts.map((a) => `${a.mode}: ${a.error ?? 'failed'}`).join('; ');
    this.deps.logger.warn(
      `Could not build the translation character sheet${engine ? ` with "${engine}"` : ''} (${why}). ` +
        'Names, terms and terms of address will not be kept consistent across the video. Write or fix the sheet in the editor (or pick a stronger review model), then re-run translation.',
    );
    return { status: { status: 'failed', ...(engine ? { engine } : {}), attempts: outcome.attempts, at: at() } };
  }

  private async stepTranslation(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress = async () => {},
  ): Promise<void> {
    throwIfCancelled(signal);
    const { settings } = project;
    let provider = this.deps.registry.getTranslation(settings.translationProviderId);
    const sourceSegments = await readSegments(paths.sourceJson);
    const languages = { sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage };
    const rate = await this.speechRateFor(project);
    this.deps.logger.info(
      `Translating ${sourceSegments.length} segments ${settings.sourceLanguage} -> ${settings.targetLanguage} with "${provider.id}"` +
        (rate.perSecond !== undefined ? ` (line lengths budgeted at ${rate.perSecond.toFixed(2)} units/s, ${rate.source})` : '') +
        '...',
    );
    const reportPath = translationReportPath(paths.subtitlesDir);
    // A new translation starts a new report: the previous run's review and
    // auto-fit records described other lines, and its "failed" character
    // sheet made the refine step skip building one.
    await writeJsonAtomic(reportPath, {});
    // "Heard as → is" fixes from the character sheet, before anything reads the text.
    const corrections = (await readDocContext(paths.translationContextJson))?.corrections;
    const promptSegments: PromptSegment[] = sourceSegments.map((s) => ({
      id: s.id,
      sourceText: applySourceCorrections(s.sourceText, corrections),
      startMs: s.startMs,
      endMs: s.endMs,
      // Carry diarized speaker ids into the prompt: who is speaking is what
      // decides Vietnamese xưng hô, and it was computed and then dropped.
      ...(s.speakerId ? { speakerId: s.speakerId } : {}),
    }));

    // The project's character sheet (cast/glossary/pronoun plan): a persisted
    // (possibly user-edited) one is authoritative and re-used verbatim. When
    // absent, the PIPELINE generates it (providers are told to skip their own
    // analysis) so a failure is reported instead of swallowed: with the
    // translator itself when it reads context, else with the context engine
    // AFTER translating — a local translator's model and the chat model then
    // swap once instead of twice.
    let documentContext = await readDocContext(paths.translationContextJson);
    let sheetStatus: CharacterSheetStatus | undefined = documentContext
      ? { status: 'provided', at: new Date().toISOString() }
      : undefined;
    const wantSheet =
      !documentContext && translationContextEnabled() && sourceSegments.length >= MIN_SEGMENTS_FOR_ANALYSIS;
    const contextEngine = this.contextEngineFor(project);
    if (wantSheet && isTranslationRefiner(provider)) {
      ({ sheet: documentContext, status: sheetStatus } = await this.generateSheet(
        project,
        paths,
        provider,
        () => provider.displayName,
        promptSegments,
        signal,
      ));
    }

    const input: DubbingTranslationInput = {
      ...languages,
      segments: sourceSegments.map((s) => ({
        id: s.id,
        sourceText: s.sourceText,
        startMs: s.startMs,
        endMs: s.endMs,
        ...(s.speakerId ? { speakerId: s.speakerId } : {}),
      })),
      ...(documentContext ? { documentContext } : {}),
      ...(rate.perSecond !== undefined ? { speechRate: rate.perSecond } : {}),
      skipAnalysis: true,
      onProgress: translationProgress(onProgress, (done, total) =>
        this.deps.logger.info(`Translated ${done}/${total} lines...`),
      ),
    };
    // Where an unfinished run of this same translation stopped (a pause, a
    // closed app, a crash): its finished batches are reused and every new one
    // is saved as it lands (translationCheckpoint.ts). Per engine: a fallback
    // engine's lines are its own.
    const checkpointFor = async (p: TranslationProviderRef) => {
      const key = translationCheckpointKey({
        providerId: p.id,
        model: (await p.modelIdentity?.().catch(() => undefined)) ?? p.displayName,
        ...languages,
        segments: input.segments,
        // Only a translator that reads the sheet is changed by it. A line-by-
        // line one (TranslateGemma) gets its sheet AFTER translating, so a
        // pause during the repair pass would otherwise find a new key and
        // translate everything again.
        ...(documentContext && isTranslationRefiner(p) ? { documentContext } : {}),
        ...(rate.perSecond !== undefined ? { speechRate: rate.perSecond } : {}),
      });
      const saved = await readTranslationCheckpoint(paths.translationCheckpointJson, key);
      if (saved.size > 0) {
        this.deps.logger.info(
          `Continuing the translation: ${saved.size} of ${sourceSegments.length} lines were done before it stopped.`,
        );
      }
      return { saved, writer: new TranslationCheckpointWriter(paths.translationCheckpointJson, key, saved) };
    };
    let checkpoint = await checkpointFor(provider);
    const translateWith = async (p: TranslationProviderRef) => {
      const resumable: DubbingTranslationInput = {
        ...input,
        resume: checkpoint.saved,
        onBatch: (lines) => checkpoint.writer.add(lines),
      };
      try {
        return await p.translateSegments(resumable, signal);
      } finally {
        // Stopped or not, what was translated is on disk before the step ends.
        await checkpoint.writer.flush();
      }
    };
    let result: Awaited<ReturnType<TranslationProviderRef['translateSegments']>>;
    try {
      result = await translateWith(provider);
    } catch (err) {
      const fallback = this.translationFallbackFor(project, provider.id, err);
      if (!fallback || signal.aborted) throw err;
      this.deps.logger.warn(
        `Translation engine "${provider.id}" could not run (${toAppError(err).message}). ` +
          `The app picked it for this project, so the built-in "${fallback.id}" translates instead.`,
      );
      await this.recordFallback(project.id, 'translation', fallback.id);
      provider = fallback;
      checkpoint = await checkpointFor(provider);
      result = await translateWith(provider);
    }

    // A provider that ignores skipAnalysis may still return a sheet: keep it.
    if (!documentContext && result.analysis) {
      documentContext = result.analysis;
      await writeDocContext(paths.translationContextJson, result.analysis);
      sheetStatus = { status: 'generated', engine: provider.displayName, at: new Date().toISOString() };
    }
    if (wantSheet && !documentContext && sheetStatus === undefined) {
      if (contextEngine.available) {
        ({ sheet: documentContext, status: sheetStatus } = await this.generateSheet(
          project,
          paths,
          contextEngine,
          () => contextEngine.engine?.displayName,
          promptSegments,
          signal,
        ));
        // Every candidate turned out not to be installed: that is "no model",
        // not a failed analysis.
        if (!contextEngine.available) {
          sheetStatus = {
            status: 'skipped',
            reason: 'no instruction-following model is installed or configured',
            at: new Date().toISOString(),
          };
        }
      } else {
        sheetStatus = {
          status: 'skipped',
          reason: `"${provider.displayName}" translates line by line and no review or chat model is configured`,
          at: new Date().toISOString(),
        };
        this.deps.logger.info(
          'No character sheet: the translator works line by line and no instruction-following model (a review model, the Gemma chat model or a cloud LLM) is available to build one.',
        );
      }
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
            .join(', ')}). They will be repaired or flagged.`,
      );
    }

    const merged: TranscriptSegment[] = sourceSegments.map((s) => ({
      ...s,
      translatedText: byId.get(s.id) ?? s.translatedText ?? '',
    }));

    // Check every line (lineQuality.ts): Chinese left in a Vietnamese line,
    // pinyin names, "/" hedges, untranslated lines. Failures get ONE repair by
    // the context engine with their neighbours and the sheet; whatever is
    // still bad keeps its best candidate and is FLAGGED on the segment — it
    // used to ship silently ("Nữ Th娲", "Kunlun Xu", "thầy/cô").
    let pass: RepairPassResult;
    const repairInput = {
      ...languages,
      segments: merged,
      ...(documentContext ? { documentContext } : {}),
      ...(rate.perSecond !== undefined ? { perSecond: rate.perSecond } : {}),
    };
    try {
      pass = await checkAndRepairLines(repairInput, contextEngine.available ? contextEngine : undefined, signal);
    } catch (err) {
      // Only the run's signal is a cancel; a timed-out model just repairs nothing.
      if (signal.aborted) throw err;
      this.deps.logger.warn(
        `Could not repair lines that failed the checks (${toAppError(err).message}); they are flagged instead.`,
      );
      pass = await checkAndRepairLines(repairInput, undefined, signal);
    }
    if (pass.errors.length > 0) {
      this.deps.logger.warn(
        `The model failed on ${pass.errors.length} repair request(s) (${pass.errors[0]}); those lines keep their best version.`,
      );
    }
    if (pass.repaired.length > 0) {
      this.deps.logger.info(
        `Repaired ${pass.repaired.length} line(s) that failed the checks with "${contextEngine.engine?.displayName ?? 'the context model'}" ` +
          `(e.g. ${pass.repaired
            .slice(0, 2)
            .map((r) => `${r.id}: "${r.before}" -> "${r.after}"`)
            .join('; ')}).`,
      );
    }
    if (pass.flagged.length > 0) {
      // "UNTRANSLATED" keeps the wording of the warning this replaces (a zh→vi
      // run once shipped 169 Chinese lines without one): the editor badge and
      // support threads search for it.
      const untranslated = pass.flagged.filter((f) => f.flags.includes('untranslated'));
      this.deps.logger.warn(
        `${pass.flagged.length} line(s) still fail the translation checks and are flagged for review ` +
          `(${pass.flagged
            .slice(0, 3)
            .map((f) => `${f.id}: ${f.flags.join('+')}`)
            .join(', ')}).` +
          (untranslated.length > 0
            ? ` ${untranslated.length} of them look UNTRANSLATED and keep their source text — re-run translation, try a stronger model, or edit them in the editor.`
            : ''),
      );
    }

    await writeTranscriptAtomic(paths, pass.segments);
    // translated.json holds the translation now; a later re-translation of
    // this project must start fresh, not from these lines.
    await checkpoint.writer.discard();
    await updateTranslationReport(reportPath, {
      ...(sheetStatus ? { characterSheet: sheetStatus } : {}),
      speechRate: { ...(rate.perSecond !== undefined ? { perSecond: rate.perSecond } : {}), source: rate.source },
      quality: {
        checked: pass.segments.length,
        repaired: pass.repaired,
        flagged: pass.flagged,
        ...(pass.errors.length > 0 ? { errors: pass.errors } : {}),
        ...(contextEngine.engine ? { engine: contextEngine.engine.displayName } : {}),
        at: new Date().toISOString(),
      },
    });
    this.deps.logger.info(`Translated ${pass.segments.length} segments.`);
  }

  /**
   * Optional review-and-refine pass: a context-capable LLM re-reads the whole
   * translated transcript (with the character sheet + scene context) and
   * polishes each line — returning it unchanged when it's already good. Runs
   * only when settings.refineProviderId names a refinement-capable provider;
   * otherwise completes instantly. The refine report doubles as the step's
   * resume marker and feeds the editor's summary; it records EVERY change
   * with its before/after text and every proposal the checks refused, and the
   * pre-review transcript is kept as translated.draft.json — before, the
   * draft was overwritten and the report kept at most 200 bare ids.
   */
  private async stepRefine(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress = async () => {},
  ): Promise<void> {
    await this.reviewPass(project, paths, signal, onProgress);
    throwIfCancelled(signal);
    await this.retryBeforeVoicing(project, paths, signal, onProgress);
  }

  /** The ids of the lines a voice would say with a failed check (for the hold). */
  private async heldLineIds(paths: WorkspacePaths): Promise<string[]> {
    const lines = await readSegments(paths.translatedJson).catch(() => [] as TranscriptSegment[]);
    return lines.filter((s) => s.locked !== true && !isSong(s) && (s.qualityFlags?.length ?? 0) > 0).map((s) => s.id);
  }

  /**
   * Before any voice is made: the lines that still fail the translation checks
   * get a second, pointed repair (dubPasses.retryFailingLines), and those still
   * failing are named in a warning; with settings.holdFlaggedLines the run then
   * stops here (the run loop, once this step completes). claude-dubber's parts
   * of 《反相之地》 were voiced with pinyin names and a line without diacritics
   * (2026-11-25, H7).
   */
  private async retryBeforeVoicing(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    const languages = { sourceLanguage: project.settings.sourceLanguage, targetLanguage: project.settings.targetLanguage };
    const segments = await readSegments(paths.translatedJson);
    if (linesFailingChecks(segments, languages).length === 0) return;
    const documentContext = await readDocContext(paths.translationContextJson);
    const rate = await this.speechRateFor(project);
    const chat = this.contextEngineFor(project);
    const input = {
      ...languages,
      segments,
      ...(documentContext ? { documentContext } : {}),
      ...(rate.perSecond !== undefined ? { perSecond: rate.perSecond } : {}),
    };
    let pass: RetryPassResult;
    try {
      pass = await retryFailingLines(input, chat.available ? chat : undefined, signal);
    } catch (err) {
      // Only the run's signal is a cancel; a model that failed just fixes nothing.
      if (signal.aborted) throw err;
      this.deps.logger.warn(`Could not try the failing lines again (${toAppError(err).message}).`);
      pass = await retryFailingLines(input, undefined, signal);
    }
    const engine = chat.available ? chat.engine?.displayName : undefined;
    if (pass.segments.some((s, i) => s !== segments[i])) await writeTranscriptAtomic(paths, pass.segments);
    if (pass.repaired.length > 0) {
      this.deps.logger.info(
        `Fixed ${pass.repaired.length} of ${pass.checked} line(s) that still failed the checks before voicing, with "${engine ?? 'the context model'}" ` +
          `(e.g. ${pass.repaired
            .slice(0, 2)
            .map((r) => `${r.id}: "${r.before}" -> "${r.after}"`)
            .join('; ')}).`,
      );
    }
    if (pass.errors.length > 0) {
      this.deps.logger.warn(`The model failed on ${pass.errors.length} request(s) of the second try (${pass.errors[0]}).`);
    }
    await updateTranslationReport(translationReportPath(paths.subtitlesDir), {
      beforeVoicing: {
        checked: pass.checked,
        repaired: pass.repaired,
        flagged: pass.flagged,
        ...(pass.errors.length > 0 ? { errors: pass.errors } : {}),
        ...(engine ? { engine } : {}),
        at: new Date().toISOString(),
      },
    });
    if (pass.flagged.length > 0) onProgress.warn?.(flaggedLinesWarning(pass.flagged, project.settings.holdFlaggedLines === true));
  }

  /**
   * The review-and-refine pass itself (see {@link stepRefine}): a no-op that
   * writes a "skipped" report when no review model is set.
   */
  private async reviewPass(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    const providerId = project.settings.refineProviderId;
    const writeReport = (report: object): Promise<void> => writeJsonAtomic(paths.refineReportJson, report);

    if (!providerId || providerId === 'none') {
      await writeReport({ skipped: true, reason: 'no refine provider configured' });
      return;
    }
    const provider = this.deps.registry.getTranslation(providerId);
    if (!isTranslationRefiner(provider)) {
      this.deps.logger.warn(
        `Refine provider "${providerId}" cannot run the review pass (needs an instruction-following LLM — a cloud provider or the Gemma 3 chat model). Skipping refinement.`,
      );
      await writeReport({ skipped: true, reason: `provider ${providerId} is not refinement-capable` });
      return;
    }

    const segments = await readSegments(paths.translatedJson);
    const languages = {
      sourceLanguage: project.settings.sourceLanguage,
      targetLanguage: project.settings.targetLanguage,
    };
    await writeJsonAtomic(translationDraftPath(paths.subtitlesDir), { segments });
    let documentContext = await readDocContext(paths.translationContextJson);
    const rate = await this.speechRateFor(project);
    this.deps.logger.info(
      `Reviewing ${segments.length} translated line(s) with "${provider.displayName}" (context-aware refinement)...`,
    );
    const promptSegments: PromptSegment[] = segments.map((s) => ({
      id: s.id,
      sourceText: applySourceCorrections(s.sourceText, documentContext?.corrections),
      startMs: s.startMs,
      endMs: s.endMs,
      ...(s.speakerId ? { speakerId: s.speakerId } : {}),
    }));

    // No sheet yet (the translator could not build one): this engine reads
    // context, so try — unless the translation step already failed with this
    // very engine, which would just pay for the same failure twice.
    let sheetStatus: CharacterSheetStatus | undefined;
    if (!documentContext && translationContextEnabled() && segments.length >= MIN_SEGMENTS_FOR_ANALYSIS) {
      const reportPath = translationReportPath(paths.subtitlesDir);
      const prior = (await readTranslationReport(reportPath)).characterSheet;
      if (prior?.status === 'failed' && prior.engine === provider.displayName) {
        sheetStatus = prior;
      } else {
        ({ sheet: documentContext, status: sheetStatus } = await this.generateSheet(
          project,
          paths,
          provider,
          () => provider.displayName,
          promptSegments,
          signal,
        ));
        await updateTranslationReport(reportPath, { characterSheet: sheetStatus });
      }
    }

    // Where an unfinished run of this same review stopped (a pause, a closed
    // app, a crash): its finished batches are kept, and each new one is saved
    // as it lands (translationCheckpoint.ts). The drafts are in the key: a line
    // edited during the pause gets the whole transcript reviewed again.
    const batchSegments = provider.isLocal ? 8 : undefined;
    const reviewKey = checkpointKey([
      'refine',
      1,
      provider.id,
      (await provider.modelIdentity?.().catch(() => undefined)) ?? provider.displayName,
      languages.sourceLanguage,
      languages.targetLanguage,
      promptSegments.map((s) => [s.id, s.sourceText, s.startMs ?? null, s.endMs ?? null, s.speakerId ?? null]),
      segments.map((s) => [s.id, (s.translatedText ?? '').trim(), s.locked === true]),
      documentContext ?? null,
      rate.perSecond ?? null,
      batchSegments ?? null,
    ]);
    const finished = (await readCheckpoint<ReviewedBatch[]>(paths.refineCheckpointJson, reviewKey)) ?? [];
    if (finished.length > 0) {
      this.deps.logger.info(
        `Continuing the review: ${finished.reduce((n, b) => n + b.ids.length, 0)} of ${segments.length} lines were reviewed before it stopped.`,
      );
    }
    const checkpoint = new CheckpointWriter<ReviewedBatch[]>(paths.refineCheckpointJson, reviewKey);
    let outcome: Awaited<ReturnType<typeof reviewTranslations>>;
    try {
      outcome = await reviewTranslations(
        {
          ...languages,
          segments: promptSegments,
          draftById: new Map(segments.map((s) => [s.id, (s.translatedText ?? '').trim()])),
          ...(documentContext ? { documentContext } : {}),
          mode: 'refine',
          ...(rate.perSecond !== undefined ? { perSecond: rate.perSecond } : {}),
          skipAnalysis: true,
          // A small local model mixes lines up in big batches (refinement.ts).
          ...(batchSegments !== undefined ? { batchSegments } : {}),
          onProgress: translationProgress(onProgress, (done, total) =>
            this.deps.logger.info(`Reviewed ${done}/${total} lines...`),
          ),
          resume: new Map(finished.map((b) => [reviewBatchKey(b.ids), b])),
          onBatch: (batch) => {
            finished.push(batch);
            checkpoint.save(finished);
          },
        },
        provider,
        signal,
      );
    } finally {
      // Stopped or not, what was reviewed is on disk before the step ends.
      await checkpoint.flush();
    }

    // Locked lines were read as context but are never replaced; every line's
    // quality flags are refreshed from its final text.
    const merged = applyReviewOutcome(segments, outcome, languages);
    const flagsChanged = merged.segments.some(
      (s, i) => JSON.stringify(s.qualityFlags ?? []) !== JSON.stringify(segments[i]!.qualityFlags ?? []),
    );
    if (merged.applied.length > 0 || flagsChanged) await writeTranscriptAtomic(paths, merged.segments);
    const lockedCount = segments.filter((s) => s.locked === true).length;
    const appliedIds = merged.applied.map((c) => c.id);
    await writeReport({
      provider: providerId,
      reviewed: segments.length,
      changed: appliedIds.length,
      changedIds: appliedIds,
      changes: merged.applied,
      rejected: outcome.rejected,
      ...(outcome.failedBatches.length > 0 ? { failedBatches: outcome.failedBatches } : {}),
      ...(lockedCount > 0 ? { lockedKept: lockedCount } : {}),
      ...(sheetStatus ? { characterSheet: sheetStatus } : {}),
      draft: TRANSLATION_DRAFT_FILE,
      finishedAt: new Date().toISOString(),
    });
    // The review is in translated.json and its report: a later review starts fresh.
    await checkpoint.discard();
    if (outcome.failedBatches.length > 0) {
      this.deps.logger.warn(
        `The review model returned no usable reply for ${outcome.failedBatches.length} batch(es) even after a retry ` +
          `(${outcome.failedBatches.reduce((a, b) => a + b.length, 0)} line(s) kept their draft, e.g. ${outcome.failedBatches[0]![0]}).`,
      );
    }
    if (outcome.rejected.length > 0) {
      this.deps.logger.info(
        `Kept the draft for ${outcome.rejected.length} line(s) whose review failed the checks ` +
          `(e.g. ${outcome.rejected
            .slice(0, 2)
            .map((r) => `${r.id}: ${r.reason}`)
            .join('; ')}).`,
      );
    }
    this.deps.logger.info(
      `Refinement complete: ${appliedIds.length}/${segments.length} line(s) improved` +
        (appliedIds.length > 0
          ? ` (e.g. ${appliedIds.slice(0, 3).join(', ')}).`
          : ' — the translation was already consistent.') +
        (lockedCount > 0 ? ` ${lockedCount} locked line(s) kept as written.` : '') +
        ` The pre-review draft is in ${TRANSLATION_DRAFT_FILE}.`,
    );
  }

  private async stepTts(
    project: Project,
    paths: WorkspacePaths,
    signal: AbortSignal,
    onProgress: StepProgress,
  ): Promise<void> {
    throwIfCancelled(signal);
    const provider = this.deps.registry.getTts(project.settings.ttsProviderId);
    const lines = await readSegments(paths.translatedJson);
    // Lines kept as the original song get no voice (songs/songLines.ts): the
    // original plays in their windows at the mix.
    const segments = lines.filter((s) => !isSong(s));
    if (segments.length < lines.length) {
      this.deps.logger.info(`${lines.length - segments.length} line(s) are kept as the original song: no voice is made for them.`);
    }

    // Group consecutive same-speaker cues into whole utterances so the engine
    // speaks them with ONE coherent intonation contour instead of resetting its
    // prosody at every subtitle cue (see grouping.ts). The plan is persisted so
    // alignment/mix/editor know which cues share a WAV.
    const groups = planSynthesisGroups(toGroupInputs(segments), {
      enabled: project.settings.synthesisGrouping !== false,
    });
    await writeGroups(paths.synthesisGroupsJson, groups);
    const unspoken = segments.filter((s) => !hasSpeakableText(s.translatedText ?? s.sourceText));
    if (unspoken.length > 0) {
      const examples = [...new Set(unspoken.map((s) => (s.translatedText ?? s.sourceText ?? '').trim() || '(empty)'))].slice(0, 3);
      onProgress.warn?.({
        code: 'no-speech-lines',
        key: 'warning.no-speech-lines',
        params: { count: unspoken.length, examples: examples.join(' ') },
        message: `${unspoken.length} line(s) have no words to say (${examples.join(' ')}): they stay silent in the dub, and keep their subtitle.`,
      });
    }

    this.deps.logger.info(
      `Synthesizing ${groups.length} utterance(s) covering ${segments.length} segment(s) with provider "${provider.id}"...`,
    );
    if (provider.prepare) {
      await provider.prepare(signal);
      const where = provider.activeDevice;
      if (where?.device === 'cuda') {
        this.deps.logger.info(`Voice engine running on the GPU (${where.name ?? 'NVIDIA'}).`);
      } else if (where?.note) {
        // A GPU pack that had to fall back: say so, or a slow run looks like a bug.
        this.deps.logger.warn(`Voice engine is running on the CPU: ${where.note}`);
      }
    }
    const log = (message: string): void => this.deps.logger.info(message);
    const first = await this.synthesizeGroups(
      project,
      paths,
      groups,
      signal,
      ttsProgress(onProgress, 0, TTS_FIRST_PASS_SHARE, log, 'Synthesized', 'utterance(s)'),
    );

    // Drift-bounded grouping: a group is read as ONE continuous utterance from
    // its start, so when the translated pace deviates from the original cue
    // spacing, mid-group words play seconds before/after their subtitles. Now
    // that real durations are known, estimate each multi-cue group's worst
    // member drift and DEGROUP the offenders — re-synthesizing their cues
    // individually so every cue's audio starts exactly at its subtitle.
    const driftCap = maxGroupDriftMs();
    const memberInfo = segments.map((s) => ({
      id: s.id,
      startMs: s.startMs,
      text: (s.translatedText ?? s.sourceText ?? '').trim(),
    }));
    const segById = new Map(segments.map((s) => [s.id, s]));
    const finalGroups: SynthesisGroup[] = [];
    const degrouped: SynthesisGroup[] = [];
    let degroupedGroupCount = 0;
    for (const [i, g] of groups.entries()) {
      const generated = first.durations.get(g.id);
      if (g.segmentIds.length < 2 || generated === undefined) {
        finalGroups.push(g);
        continue;
      }
      // The clip's on-timeline duration: alignment compresses it into the
      // gap-aware slot when it overruns (cap at the slot; stretch limits make
      // this approximate, which a ~700ms threshold comfortably absorbs).
      const nextStart = groups[i + 1]?.startMs;
      const slot = Math.max(g.endMs - g.startMs, (nextStart ?? g.endMs) - g.startMs);
      const placed = Math.min(generated, slot);
      const drift = estimateGroupDriftMs(g, memberInfo, placed);
      if (drift <= driftCap) {
        finalGroups.push(g);
        continue;
      }
      const singles: SynthesisGroup[] = g.segmentIds.map((id) => {
        const seg = segById.get(id)!;
        return {
          id,
          segmentIds: [id],
          text: (seg.translatedText ?? seg.sourceText ?? '').trim(),
          startMs: seg.startMs,
          endMs: seg.endMs,
          ...(g.speakerId ? { speakerId: g.speakerId } : {}),
          ...(g.voiceId ? { voiceId: g.voiceId } : {}),
          ...(g.speakingRate !== undefined ? { speakingRate: g.speakingRate } : {}),
        };
      });
      degrouped.push(...singles);
      finalGroups.push(...singles);
      degroupedGroupCount += 1;
    }

    let second: GroupSynthesisOutcome | undefined;
    if (degrouped.length > 0) {
      this.deps.logger.info(
        `Re-synthesizing ${degrouped.length} cue(s) individually to keep the voice in sync with the subtitles ` +
          `(estimated drift exceeded ${driftCap}ms in ${degroupedGroupCount} merged group(s)).`,
      );
      await writeGroups(paths.synthesisGroupsJson, finalGroups);
      second = await this.synthesizeGroups(
        project,
        paths,
        degrouped,
        signal,
        ttsProgress(onProgress, TTS_FIRST_PASS_SHARE, 1, log, 'Re-synthesized', 'cue(s)'),
      );
    }
    const reused = first.reusedSegments + (second?.reusedSegments ?? 0);
    if (reused > 0) {
      this.deps.logger.info(
        `Reused ${reused} clip(s) finished by an earlier run (same text and voice); only the rest were synthesized.`,
      );
    }

    // Surface incompleteness: if the worker returned fewer segments than asked,
    // the missing WAVs would otherwise only surface as 0ms timing-conflicts at
    // alignment, masking the real failure. Warn with the offending ids.
    const synthesized = new Set([...first.synthesizedIds, ...(second?.synthesizedIds ?? [])]);
    const missing = finalGroups.filter((g) => !synthesized.has(g.id));
    if (missing.length > 0) {
      this.deps.logger.warn(
        `TTS worker returned ${synthesized.size}/${finalGroups.length} segments. ` +
          `${missing.length} segment(s) were not synthesized (e.g. ${missing
            .slice(0, 3)
            .map((s) => s.id)
            .join(', ')}). They will be flagged at alignment.`,
      );
    }

    // Surface silent placeholders loudly: "fallback" means no installed voice
    // can speak the target language, so the dub would have no speech at all.
    const engine = first.engine ?? second?.engine;
    const sawFallbackEngine = first.sawFallbackEngine || second?.sawFallbackEngine === true;
    const fallbackSegments = first.fallbackSegments + (second?.fallbackSegments ?? 0);
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
    // Every line was just synthesized from its current text/voice/rate, so no
    // clip is stale any more. Rewritten only when a flag is actually set (and
    // whole: the song lines, never voiced, are part of the transcript).
    if (lines.some((s) => s.ttsStale === true)) {
      await writeSegments(
        paths.translatedJson,
        lines.map(({ ttsStale: _stale, ...rest }) => rest),
      );
    }
    this.deps.logger.info(`Speech synthesis complete (engine: ${engine ?? (sawFallbackEngine ? 'fallback' : 'unknown')}).`);
  }

  /**
   * Synthesize a set of groups, partitioned per resolved voice (a diarized
   * speaker with an assignment in settings.speakerVoices gets it; everything
   * else the project voice). Returns ids, measured durations, and engine info.
   */
  private async synthesizeGroups(
    project: Project,
    paths: WorkspacePaths,
    groups: readonly SynthesisGroup[],
    signal: AbortSignal,
    onBatch?: (done: number, total: number) => Promise<void>,
  ): Promise<GroupSynthesisOutcome> {
    const provider = this.deps.registry.getTts(project.settings.ttsProviderId);
    // Read per batch, not once: a provider can only size its requests after its
    // engine reports the device (24 lines a request on a GPU, 6 on a CPU).
    const perRequestNow = (): number =>
      Math.max(1, Math.floor(provider.maxSegmentsPerRequest ?? DEFAULT_TTS_UNITS_PER_REQUEST));
    // `voiceId` and `speed` are BATCH-level TTS parameters, so units are
    // partitioned by the (voice, rate) pair they resolve to: a per-line rate or
    // voice from the editor gets its own call instead of being flattened into
    // its neighbours' batch.
    const byVoice = new Map<string, { voiceId: string | undefined; speed: number; groups: SynthesisGroup[] }>();
    for (const g of groups) {
      const voiceId = voiceForGroup(g, project.settings);
      const speed = rateForGroup(g);
      const key = `${voiceId ?? ''}\u0000${speed}`;
      const bucket = byVoice.get(key) ?? { voiceId, speed, groups: [] };
      bucket.groups.push(g);
      byVoice.set(key, bucket);
    }

    const outcome: GroupSynthesisOutcome = {
      synthesizedIds: new Set<string>(),
      durations: new Map<string, number>(),
      sawFallbackEngine: false,
      fallbackSegments: 0,
      reusedSegments: 0,
    };
    let done = 0;
    // Units with nothing to say get a short silence, never an engine call.
    for (const bucket of byVoice.values()) {
      const silent = bucket.groups.filter((g) => !hasSpeakableText(g.text) && segmentIdToIndex(g.id) > 0);
      if (silent.length === 0) continue;
      for (const g of silent) {
        throwIfCancelled(signal);
        outcome.durations.set(g.id, await writeSilentClip(paths.ttsSegment(segmentIdToIndex(g.id))));
        outcome.synthesizedIds.add(g.id);
      }
      bucket.groups = bucket.groups.filter((g) => !silent.includes(g));
      done += silent.length;
    }
    for (const { voiceId, speed, groups: voiceGroups } of byVoice.values()) {
      for (let at = 0; at < voiceGroups.length; ) {
        throwIfCancelled(signal);
        const batch = voiceGroups.slice(at, at + perRequestNow());
        at += batch.length;
        const result = await provider.synthesizeSegments(
          {
            language: project.settings.targetLanguage,
            voiceId,
            segments: batch.map((g) => ({ id: g.id, text: g.text, startMs: g.startMs, endMs: g.endMs })),
            outputDir: paths.ttsSegmentsDir,
            speed,
          },
          signal,
        );
        for (const s of result.segments) {
          outcome.synthesizedIds.add(s.segmentId);
          outcome.durations.set(s.segmentId, s.durationMs);
        }
        if (result.engine === 'fallback') outcome.sawFallbackEngine = true;
        else outcome.engine ??= result.engine;
        outcome.fallbackSegments += result.fallbackSegments ?? 0;
        outcome.reusedSegments += result.reusedSegments ?? 0;
        done += batch.length;
        await onBatch?.(done, groups.length);
      }
    }
    return outcome;
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
    let groups = (await readGroups(paths.synthesisGroupsJson)) ?? singletonGroups(toGroupInputs(segments.filter((s) => !isSong(s))));
    // Song lines have no unit (songs/songLines.ts): one planned before they
    // were marked goes, one shared with spoken lines is cut and re-voiced
    // below, a line that sings no more gets its own.
    const songFix = songUnits(groups, segments);
    if (songFix.changed) {
      groups = songFix.groups;
      const revoice = new Set(songFix.revoice);
      for (const s of segments) if (revoice.has(s.id)) s.ttsStale = true;
      await writeGroups(paths.synthesisGroupsJson, groups);
      this.deps.logger.info(`Song lines: ${songFix.touched.length} line(s) moved out of or into a voice clip; ${revoice.size} re-voiced.`);
    }
    await this.revoiceStaleUnits(project, paths, segments, groups, signal);

    // Measure each synthesized unit's WAV: its length, and where the speech is
    // in it (clipSpeech.ts — edge silence trimmed, a botched clip's trailing
    // noise cut), so alignment fits the speech rather than the file.
    // The TTS worker names files by the numeric part of the segment/group id
    // (seg_0001 -> segment_0001.wav), so we resolve the index from the id first
    // and only fall back to the positional index if the id has no number.
    // Measurements are independent ffmpeg runs — do them with bounded
    // concurrency (sequential probing dominated this step on long videos).
    const PROBE_CONCURRENCY = 8;
    const alignInputs = new Array<AlignInputSegment>(groups.length);
    const outcomes = new Map<MeasuredClip['outcome'] | 'failed' | 'no-speech', string[]>();
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
          const input: AlignInputSegment = {
            segmentId: group.id,
            startMs: group.startMs,
            endMs: group.endMs,
            audioPath,
            generatedDurationMs: 0,
          };
          const measured = await this.measureInto(input, group.text, signal);
          // Silence is what a line with nothing to say should be (speakable.ts).
          const outcome = measured === 'silent' && !hasSpeakableText(group.text) ? 'no-speech' : measured;
          outcomes.set(outcome, [...(outcomes.get(outcome) ?? []), group.id]);
          alignInputs[i] = input;
          // Throttled progress (<=~20 emits) so long-video probing isn't a
          // silent multi-minute wait. Concurrent emits only race on the percent.
          probedCount++;
          if (probedCount === groups.length || probedCount % progressEvery === 0) {
            await onProgress((probedCount / groups.length) * ALIGN_MEASURED);
          }
        }
      }),
    );
    this.logClipMeasurements(outcomes);

    // Pass the total media duration so alignment is gap-aware (a long
    // translation can use the silence until the next line — or until the end of
    // the video for the last segment — instead of being flagged as a conflict).
    const totalDurationMs = (await this.deps.store.getProject(project.id)).mediaInfo?.durationMs;
    const settings = {
      maxSpeedRatio: project.settings.maxSpeedRatio,
      allowedOverflowMs: project.settings.allowedOverflowMs,
    };
    let aligned = alignSegments(alignInputs, settings, totalDurationMs);

    // Learn the voice's real pace from the clips just measured (speechFit.ts):
    // the next translation of this voice budgets with it, and auto-fit below
    // uses it to spot clips the engine botched. A clip that is silent (the TTS
    // worker's placeholder for a line it failed to voice), unreadable, or had
    // noise cut off says nothing about the voice's pace.
    const unreliable = new Set([
      ...(outcomes.get('silent') ?? []),
      ...(outcomes.get('no-speech') ?? []),
      ...(outcomes.get('failed') ?? []),
      ...(outcomes.get('cut') ?? []),
    ]);
    const voiceRate = await this.learnVoiceRates(project, groups, alignInputs, unreliable);

    // Auto-fit: SHORTEN the current text of any unit that can't fit even at
    // max speed OR that only fits with a heavy time-stretch (> STRETCH_SOFT_CAP):
    // pace whiplash between a 1.5x line and its natural-rate neighbours reads as
    // a different speaker, so shortening the text beats stretching the audio.
    // No-op when the setting is off, nothing needs fitting, or no
    // instruction-following model is available (contextEngine.ts).
    if (project.settings.autoFitOverflow !== false && aligned.some(needsDurationFit)) {
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
        voiceRate,
        onProgress,
      );
    }
    await onProgress(ALIGN_REFITTED);

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
      onProgress,
    );

    // The step's resume artifact: written atomically, like every artifact that
    // "exists = complete" (a torn file would be skipped over as done).
    await writeJsonAtomic(paths.translatedAlignedJson, aligned);

    // Sync subtitles to the dub voice: re-time cues inside merged groups to
    // when their words are actually spoken (the canonical segment timings in
    // translated.json stay untouched, so re-runs and the editor are
    // unaffected). Uses the FINAL placed clips — after auto-fit and native-rate
    // re-synthesis. The overrides are PERSISTED (cue_timing.json) so an editor
    // edit / refit reapplies them instead of reverting the whole track to
    // source-speech timing.
    // As saved now: a change to the subtitles may come while the dub runs, until this step (series/partWork.ts).
    const subtitleSettings = (await this.current(project)).settings;
    const sync = subtitleSettings.syncSubtitlesToVoice !== false;
    const finalGroups = (await readGroups(paths.synthesisGroupsJson)) ?? [];
    let retimed = new Map<string, { startMs: number; endMs: number }>();
    if (sync) {
      const placedById = new Map(
        aligned.map((a) => [a.segmentId, { startMs: a.startMs, placedDurationMs: a.placedDurationMs }]),
      );
      retimed = retimeCuesToVoice(
        finalGroups,
        placedById,
        segments.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          text: (s.translatedText ?? s.sourceText ?? '').trim(),
        })),
      );
      // Persist the fresh set (possibly empty — clears stale overrides from a prior run).
      await writeCueOverrides(paths.cueTimingJson, retimed);
      if (retimed.size > 0) {
        this.deps.logger.info(
          `Re-timed ${retimed.size} subtitle cue(s) to match the dub voice (grouped lines are spoken continuously).`,
        );
      }
    }
    // The subtitle files, now that the dub is placed: planned for reading, and
    // (with voice sync) each line held until its voice has finished. Song
    // lines only with the project's songSubtitles.
    const songSubtitles = subtitleSettings.songSubtitles === true;
    const cues = displayCuesFor(segments, sync ? { overrides: retimed, groups: finalGroups, units: aligned, songSubtitles } : { songSubtitles });
    await writeTextAtomic(paths.translatedSrt, segmentsToSrt(cues));
    await writeTextAtomic(paths.translatedVtt, segmentsToVtt(cues));

    const summary = summarizeAlignment(aligned);
    this.deps.logger.info(
      `Alignment: ${summary.ok} ok, ${summary.needsReview} needs-review, ${summary.timingConflicts} timing-conflict, ${summary.needsAtempo} need speed-up.`,
    );
    if (summary.timingConflicts > 0) {
      // A warning, not only a log line: claude-dubber found 1-6 of these per
      // part only by reading the alignment (2026-11-25, H7).
      onProgress.warn?.(timingConflictWarning(aligned, project.settings.maxSpeedRatio));
    }
  }

  /**
   * Voice the units whose text changed after their clip was made (an auto-fit
   * a cancel cut short, an editor edit) before alignment measures them: their
   * clips say the old line, and fitting those would place the old line under
   * the new subtitle. Clears the stale marks. Mutates `segments` and `groups`.
   */
  private async revoiceStaleUnits(
    project: Project,
    paths: WorkspacePaths,
    segments: TranscriptSegment[],
    groups: SynthesisGroup[],
    signal: AbortSignal,
  ): Promise<void> {
    const stale = new Set(segments.filter((s) => s.ttsStale === true).map((s) => s.id));
    if (stale.size === 0) return;
    const segById = new Map(segments.map((s) => [s.id, s]));
    const staleGroups = groups.filter((g) => g.segmentIds.some((id) => stale.has(id)));
    for (const g of staleGroups) g.text = unitText(g, segById);
    this.deps.logger.info(
      `Re-voicing ${staleGroups.length} unit(s) whose text changed after they were synthesized...`,
    );
    await this.synthesizeGroups(project, paths, staleGroups, signal);
    for (const s of segments) delete s.ttsStale;
    await writeTranscriptAtomic(paths, segments);
    await writeJsonAtomic(paths.synthesisGroupsJson, { groups } satisfies SynthesisGroupsArtifact);
  }

  /**
   * Measure a unit's clip into its alignment input: the length that plays and
   * the trim that gives it (clipSpeech.ts). Bounded, so one hung ffmpeg cannot
   * stall the step on a long video; a clip that cannot be read is aligned as
   * empty, which flags it instead of failing the run. A cancel propagates.
   */
  private async measureInto(
    input: AlignInputSegment,
    text: string,
    signal: AbortSignal,
  ): Promise<MeasuredClip['outcome'] | 'failed' | 'no-speech'> {
    const MEASURE_TIMEOUT_MS = 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const measured = await Promise.race([
        measureClip(this.deps.media, input.audioPath, text, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('measurement timeout')), MEASURE_TIMEOUT_MS);
        }),
      ]);
      applyClipTiming(input, measured);
      return measured.outcome;
    } catch (err) {
      if (signal.aborted) throw err;
      applyClipTiming(input, { generatedDurationMs: 0 });
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What the clip measurements found, for pipeline.log: how many clips were
   * trimmed, and by name the ones to listen to — a botched clip whose noise
   * was cut, a silent one, one that could not be read.
   */
  private logClipMeasurements(outcomes: ReadonlyMap<MeasuredClip['outcome'] | 'failed' | 'no-speech', readonly string[]>): void {
    const ids = (k: MeasuredClip['outcome'] | 'failed' | 'no-speech'): readonly string[] => outcomes.get(k) ?? [];
    const named = (list: readonly string[]): string =>
      list.length > 10 ? `${list.slice(0, 10).join(', ')} and ${list.length - 10} more` : list.join(', ');
    const total = [...outcomes.values()].reduce((sum, list) => sum + list.length, 0);
    const trimmed = ids('trimmed').length + ids('cut').length;
    if (trimmed > 0) {
      this.deps.logger.info(`Voice clips: trimmed the silence around the speech in ${trimmed} of ${total} clip(s).`);
    }
    const cut = [...ids('cut')].sort();
    if (cut.length > 0) {
      this.deps.logger.warn(
        `${cut.length} voice clip(s) ran on long after their line (the voice engine kept generating); ` +
          `the noise after the speech was cut: ${named(cut)}. Listen to them in the editor and regenerate any that sound wrong.`,
      );
    }
    const silent = [...ids('silent')].sort();
    if (silent.length > 0) {
      this.deps.logger.warn(`${silent.length} voice clip(s) are silent: ${named(silent)}. Regenerate them in the editor.`);
    }
    const failed = [...ids('failed')].sort();
    if (failed.length > 0) {
      this.deps.logger.warn(`${failed.length} voice clip(s) could not be read and are left out: ${named(failed)}.`);
    }
  }

  /**
   * Measure how fast the voice actually spoke, from the clips the alignment
   * step just measured (syllables ÷ speech length per unit; speechFit.clipRates
   * drops short clips and engine failures), record it per voice for the next
   * translation's budgets — once per synthesis, see {@link freshClips} — and
   * return the pace auto-fit should assume for the project voice: this run's
   * median when it has enough clips, else the stored/engine rate. Units read
   * at a per-line speed, and `unreliable` ones, are skipped.
   */
  private async learnVoiceRates(
    project: Project,
    groups: readonly SynthesisGroup[],
    alignInputs: readonly AlignInputSegment[],
    unreliable: ReadonlySet<string>,
  ): Promise<number | undefined> {
    const { settings } = project;
    const lang = settings.targetLanguage;
    const byKey = new Map<string, { text: string; durationMs: number }[]>();
    groups.forEach((g, i) => {
      const input = alignInputs[i];
      if (!input || input.segmentId !== g.id || Math.abs(rateForGroup(g) - 1) > 1e-3) return;
      if (unreliable.has(g.id)) return;
      const key = voiceRateKey(settings.ttsProviderId, voiceForGroup(g, settings), lang);
      const list = byKey.get(key) ?? [];
      list.push({ text: g.text, durationMs: input.generatedDurationMs });
      byKey.set(key, list);
    });
    for (const [key, samples] of byKey) {
      const rates = clipRates(samples, lang);
      if (rates.length === 0 || !this.deps.voiceRates || !this.freshClips) continue;
      await this.deps.voiceRates.record(key, rates).catch((err: unknown) => {
        this.deps.logger.warn(`Could not save the measured voice pace (${toAppError(err).message}).`);
      });
    }
    const projectKey = voiceRateKey(settings.ttsProviderId, settings.ttsVoiceId, lang);
    const runRates = clipRates(byKey.get(projectKey) ?? [], lang);
    const measured = runRates.length >= 5 ? robustMedian(runRates) : undefined;
    if (measured !== undefined) {
      this.deps.logger.info(
        `Voice pace: ${measured.toFixed(2)} units/s (median of ${runRates.length} clips) — later translations with this voice budget line lengths with it.`,
      );
      return measured;
    }
    return (await this.speechRateFor(project)).perSecond;
  }

  /**
   * Auto-fit: SHORTEN the current translation of every unit that cannot fit,
   * or fits only with a heavy stretch, then re-synthesize those units once and
   * re-align once.
   *
   * It used to RE-TRANSLATE overflowing lines from the source with the
   * project's translator (TranslateGemma: no context, no instructions) after
   * the review pass, accept any text that differed, and alternate LLM and TTS
   * per pass. On three real dubs that rewrote 36-62 reviewed lines each, many
   * broken (母符必碎 → "Tránh làm vỡ."), and reloaded llama.cpp and the GPU voice
   * four times in four minutes. Now the context engine shortens the CURRENT
   * line with its neighbours, the character sheet and a length computed from
   * the clip itself; a proposal is kept only if it is shorter and passes the
   * line checks (contextEngine.judgeShortening). Both shortening passes finish
   * before any re-synthesis. Locked members are never touched (their unit keeps
   * whatever stretch it needs). Persists the new texts, sidecars, group plan,
   * and an auto-fit record (before/after, refusals) in translation_report.json.
   * Mutates segments, groups and alignInputs in place.
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
    voiceRate: number | undefined,
    onProgress: StepProgress = async () => {},
  ): Promise<AlignedSegment[]> {
    throwIfCancelled(signal);
    const conflicts = aligned.filter(needsDurationFit);
    const chat = this.contextEngineFor(project);
    if (!chat.available) {
      this.deps.logger.info(
        `${conflicts.length} unit(s) need a heavy speed-up, but no instruction-following model is available to shorten them ` +
          '(set a review model or install the Gemma chat model); time-stretch fits them instead.',
      );
      return aligned;
    }
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const units: OverflowUnit[] = conflicts.flatMap((c) => {
      const g = groupById.get(c.segmentId);
      return g
        ? [
            {
              id: g.id,
              memberIds: g.segmentIds,
              generatedMs: c.generatedDurationMs,
              availableMs: Math.max(1, c.placedDurationMs - c.overflowMs),
            },
          ]
        : [];
    });
    this.deps.logger.info(`Auto-fit: shortening the lines of ${units.length} overflowing/over-stretched unit(s)...`);
    await onProgress(ALIGN_MEASURED + 0.05);
    const documentContext = await readDocContext(paths.translationContextJson);
    let outcome: ShortenOutcome;
    try {
      outcome = await shortenOverflowingLines(
        {
          sourceLanguage: project.settings.sourceLanguage,
          targetLanguage: project.settings.targetLanguage,
          units,
          segments,
          ...(documentContext ? { documentContext } : {}),
          ...(voiceRate !== undefined ? { perSecond: voiceRate } : {}),
        },
        chat,
        signal,
      );
    } catch (err) {
      if (signal.aborted) throw err;
      this.deps.logger.warn(
        `Auto-fit could not shorten lines (${toAppError(err).message}); time-stretch fits them instead.`,
      );
      return aligned;
    }
    if (outcome.errors.length > 0) {
      this.deps.logger.warn(`Auto-fit: the model failed on part of the request (${outcome.errors[0]}).`);
    }
    await updateTranslationReport(translationReportPath(paths.subtitlesDir), {
      autoFit: {
        ...(chat.engine ? { engine: chat.engine.displayName } : {}),
        units: units.length,
        changes: outcome.changes,
        rejected: outcome.rejected,
        stillLong: outcome.stillLong,
        ...(outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
        at: new Date().toISOString(),
      },
    });
    if (outcome.accepted.size === 0) {
      this.deps.logger.info(
        `Auto-fit: no shorter line passed the checks (${outcome.rejected.length} proposal(s) refused); time-stretch fits them instead.`,
      );
      return aligned;
    }

    const segById = new Map(segments.map((s) => [s.id, s]));
    for (const [id, text] of outcome.accepted) {
      const seg = segById.get(id);
      if (!seg) continue;
      seg.translatedText = text;
      delete seg.qualityFlags; // accepted shortenings passed every line check
    }
    const changedGroups = groups.filter((g) => g.segmentIds.some((id) => outcome.accepted.has(id)));
    for (const g of changedGroups) g.text = unitText(g, segById);

    // The text goes to disk first, marked stale until its clip exists. Written
    // after the synthesis, a cancel in between left the dub saying the long
    // line under the short subtitle with nothing to tell; now the editor shows
    // "voice out of date" on those lines, and the next alignment re-voices them.
    for (const id of outcome.accepted.keys()) {
      const seg = segById.get(id);
      if (seg) seg.ttsStale = true;
    }
    await writeTranscriptAtomic(paths, segments);
    await writeJsonAtomic(paths.synthesisGroupsJson, { groups } satisfies SynthesisGroupsArtifact);

    // ONE synthesis pass for every changed unit, batched per voice and rate
    // like the TTS step (synthesizeGroups) — after all LLM work is done.
    throwIfCancelled(signal);
    await onProgress(ALIGN_SHORTENED);
    await this.synthesizeGroups(
      project,
      paths,
      changedGroups,
      signal,
      ttsProgress(onProgress, ALIGN_SHORTENED, ALIGN_REFITTED, (m) => this.deps.logger.info(m), 'Auto-fit: re-voiced', 'unit(s)'),
    );
    for (const id of outcome.accepted.keys()) {
      const seg = segById.get(id);
      if (seg) delete seg.ttsStale;
    }
    const inputById = new Map(alignInputs.map((a) => [a.segmentId, a]));
    for (const g of changedGroups) {
      const input = inputById.get(g.id);
      if (input) await this.measureInto(input, g.text, signal);
    }
    // Re-align everything (gap-aware windows depend on neighbours).
    const current = alignSegments(alignInputs, settings, totalDurationMs);
    this.deps.logger.info(
      `Auto-fit: shortened ${outcome.changes.length} line(s) in ${changedGroups.length} unit(s) ` +
        `(${outcome.rejected.length} proposal(s) refused by the checks); ` +
        `${current.filter(needsDurationFit).length} unit(s) still need a heavy speed-up.`,
    );

    // The clips now say the shortened lines: clear their stale marks.
    await writeTranscriptAtomic(paths, segments);
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
    onProgress: StepProgress = async () => {},
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
    const report = ttsProgress(onProgress, ALIGN_REFITTED, 1, (m) => this.deps.logger.info(m), 'Re-voiced', 'over-long unit(s)');
    for (const [i, a] of targets.entries()) {
      throwIfCancelled(signal);
      if (i > 0) await report(i, targets.length);
      const group = groupById.get(a.segmentId);
      const input = inputById.get(a.segmentId);
      if (!group || !input) continue;
      // `speed` is a batch-level TTS parameter, so units go one call at a time
      // (there are few of them). A failed call keeps the stretched fallback.
      // The ratio was measured on audio already spoken at the unit's own rate
      // (a per-line editor override), so the two compound.
      const speed = Math.min(rateForGroup(group) * a.speedRatio, 2);
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
        await this.measureInto(input, group.text, signal);
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
    // Song lines (songs/songLines.ts): no clip of theirs plays, the original
    // plays in their windows; a clip not made yet for lines split off a song's
    // unit is silent until re-voiced instead of failing the mix.
    const songs = await songMixPlan(
      await this.readAligned(paths.translatedAlignedJson),
      await readGroups(paths.synthesisGroupsJson),
      await readSegments(paths.translatedJson).catch(() => [] as TranscriptSegment[]),
      fileExistsNonEmpty,
    );
    const aligned = songs.aligned;
    if (songs.keepOriginal.length > 0) {
      this.deps.logger.info(`Keeping the original song in ${songs.keepOriginal.length} window(s) (lines kept as the original song).`);
    }
    if (songs.waiting.length > 0) {
      this.deps.logger.warn(
        `${songs.waiting.length} voice clip(s) are not made yet (lines split off a song's clip, e.g. ${songs.waiting.slice(0, 3).join(', ')}): silent in this mix. Regenerate their voices, or redo from alignment.`,
      );
    }
    const mediaInfo = (await this.deps.store.getProject(project.id)).mediaInfo;
    const totalDurationMs = mediaInfo?.durationMs ?? this.estimateTotalDuration(aligned);
    // The spoken greeting (branding): planned into quiet moments, laid into the
    // dub's track so the original is lowered under it like under a line.
    const greeting = await this.greetingClips(project, paths, aligned, totalDurationMs);
    // What this mix is made of, taken before it is built: recorded once it is
    // written, so a later render can tell whether it is still current.
    const fingerprint = await mixFingerprint({
      workspaceDir: project.workspaceDir,
      aligned,
      keepOriginal: songs.keepOriginal,
      totalDurationMs,
      settings: project.settings,
      originalWav: paths.originalWav,
      ...(greeting ? { greeting: greeting.fingerprint } : {}),
    });

    // Build the full-length TTS timeline, applying per-clip time-stretch (the
    // engine choice is policy: rubberband when available/warranted, else atempo)
    // and micro-fades at every join. Clip durations let the worker place the
    // fade-outs without probing.
    const timelineSegments: TimelineSegmentInput[] = [
      ...aligned.map((a) => ({
        audioPath: a.audioPath,
        startMs: a.startMs,
        speedRatio: a.speedRatio,
        durationMs: a.generatedDurationMs,
        // Only the speech plays (clipSpeech.ts); durationMs is already its length.
        ...(a.trimStartMs !== undefined && a.trimEndMs !== undefined
          ? { trimStartMs: a.trimStartMs, trimEndMs: a.trimEndMs }
          : {}),
      })),
      ...(greeting?.clips ?? []),
    ];

    this.deps.logger.info(`Building TTS timeline (${timelineSegments.length} clips, ${totalDurationMs}ms)...`);
    const timeline = await this.deps.media.buildTtsTimeline(
      {
        segments: timelineSegments,
        totalDurationMs,
        outputPath: paths.ttsFullWav,
        timeStretchEngine: project.settings.timeStretchEngine ?? 'auto',
      },
      signal,
    );

    // Which stretcher actually ran. Rubber Band is picked from runtime
    // capability detection, so the shipped macOS build (whose ffmpeg has no
    // rubberband filter, with no CLI beside it) quietly uses atempo while a dev
    // machine with Homebrew's rubberband on PATH does not — the single largest
    // gap between what the maintainer hears and what users hear. Record it.
    if (timeline.stretch) {
      this.deps.logger.info(describeStretch(timeline.stretch));
    }

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
    // The separated voices, put back where a song plays (replace-vocals).
    let originalVocals: string | undefined;

    if (mode === 'remove') {
      includeBackground = false;
    } else if (mode === 'replace-vocals') {
      // Separate the original into vocals + music/effects, then mix the dub over
      // the M&E bed at full volume (professional dubbing). Falls back to ducking
      // when no separation engine pack is installed.
      const separated = this.deps.separation
        ? await this.deps.separation.separate(paths.originalWav, paths.audioDir, signal).catch((err: unknown) => {
            // A pause is a stop, not a failure: never mix on with ducking.
            throwIfCancelled(signal);
            this.deps.logger.warn(`Separation failed (${String(err)}); falling back to ducking the original.`);
            return null;
          })
        : null;
      if (separated) {
        this.deps.logger.info('Separated original into vocals + music/effects; mixing dub over the M&E bed.');
        originalAudio = separated.accompanimentPath;
        originalVocals = separated.vocalsPath;
        duck = false;
        duckingLevelDb = 0;
      } else {
        this.deps.logger.warn(
          'Music & voice separation is not installed (Settings → Engines → "Music & voice separation"): the original is turned down under the dub instead of keeping its music at full volume.',
        );
        duck = true;
      }
    }

    this.deps.logger.info(`Mixing TTS track (original audio: ${mode})...`);
    await this.deps.media.duckAndMix(
      {
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
        // The original as it is where a song is kept: not lowered (keep), put
        // back with its voices (replace-vocals), there at all (remove).
        ...(songs.keepOriginal.length > 0
          ? { keepOriginal: songs.keepOriginal, ...(originalVocals ? { originalVocals } : {}) }
          : {}),
      },
      signal,
    );
    await writeMixFingerprint(paths.finalMixInputsJson, fingerprint);
    this.deps.logger.info('Audio mix complete (final_mix.wav).');
  }

  /**
   * The greeting's clips and plan. A plan the user edited (the editor) is used
   * as it is while the greeting settings stay the same; otherwise the planner
   * places it afresh around the dub and the original speech.
   */
  private async greetingClips(
    project: Project,
    paths: WorkspacePaths,
    aligned: readonly AlignedSegment[],
    totalDurationMs: number,
  ): Promise<{ clips: TimelineSegmentInput[]; fingerprint: { file: string; placements: { atMs: number }[]; gainDb: number; key: string } } | undefined> {
    const settings = project.settings.branding?.greeting;
    if (!settings?.assetId) return undefined;
    const files = await projectBrandFiles(project.workspaceDir, { greeting: settings }, this.brandKit());
    if (!files.greetingPath || !files.greetingDurationMs) return undefined;
    const key = greetingSettingsKey(settings);
    const previous = await readGreetingPlan(paths.greetingPlanJson);
    let plan: SavedGreetingPlan;
    if (previous?.edited && previous.settingsKey === key) {
      plan = previous;
    } else {
      const busy = [...dubWindows(aligned), ...(await originalSpeech(paths.speechRegionsJson, paths.sourceJson))];
      plan = {
        ...planGreetings({ assetId: settings.assetId, durationMs: totalDurationMs, greetingMs: files.greetingDurationMs, busy, settings }),
        settingsKey: key,
      };
      await writeJsonAtomic(paths.greetingPlanJson, plan);
    }
    this.deps.logger.info(
      `Greeting: ${plan.placements.length} time(s)` +
        (plan.openingSkipped ? '; no quiet moment in the opening, so none at the start' : '') +
        (plan.found < plan.requested ? `; ${plan.found} of ${plan.requested} repeats fitted between lines` : '') +
        '.',
    );
    const greetingPath = files.greetingPath;
    const greetingMs = files.greetingDurationMs;
    return {
      clips: plan.placements.map((p) => ({ audioPath: greetingPath, startMs: p.atMs, speedRatio: 1, durationMs: greetingMs, gainDb: settings.gainDb })),
      fingerprint: { file: greetingPath, placements: plan.placements, gainDb: settings.gainDb, key },
    };
  }

  /** The brand kit, or one that has nothing (projects then use the copies they already have). */
  private brandKit(): Pick<BrandKit, 'get'> {
    return (
      this.deps.brandKit ?? {
        get: async (id: string) => {
          throw new AppErrorException('INVALID_EDIT', `The brand kit item "${id}" is not available here.`);
        },
      }
    );
  }

  /**
   * Where the video's own burned-in subtitles are, for the render to keep the
   * dub's text clear of them: the band set to cover, else a picture detection
   * already made (the project's own; a part's series looked at the whole
   * video). Nothing is detected here: a render never waits for a detection.
   */
  private async sourceSubtitleBand(project: Project): Promise<{ y: number; h: number } | undefined> {
    const own = subtitleBandFor(project, await savedDetection(project));
    if (own) return own.band;
    if (project.series?.role !== 'part') return undefined;
    const parent = await this.deps.store.getProject(project.series.parentId).catch(() => undefined);
    return parent ? subtitleBandFor(project, await savedDetection(parent))?.band : undefined;
  }

  private async stepRender(project: Project, paths: WorkspacePaths, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const mode = project.settings.subtitleExportMode;
    // The logo (branding): drawn over the picture, so the video is re-encoded.
    const logoSettings = project.settings.branding?.logo;
    const logoFile = logoSettings?.assetId
      ? (await projectBrandFiles(project.workspaceDir, { logo: logoSettings }, this.brandKit())).logoPath
      : undefined;
    const videoMs = (await this.deps.store.getProject(project.id)).mediaInfo?.durationMs ?? 0;
    const periods = logoSettings ? logoPeriods(logoSettings, videoMs) : undefined;
    const logo =
      logoSettings && logoFile
        ? {
            imagePath: logoFile,
            corner: logoSettings.corner,
            widthPct: logoSettings.widthPct,
            marginPct: logoSettings.marginPct,
            opacity: logoSettings.opacity,
            ...(periods ? { periods } : {}),
          }
        : undefined;
    // Choose the subtitle sidecar that matches the requested mode.
    const subtitlePath =
      mode === 'vtt-file'
        ? paths.translatedVtt
        : mode === 'srt-file' || mode === 'embedded-soft' || mode === 'burned-in'
          ? paths.translatedSrt
          : undefined;

    // Into the folder chosen for this project (its own render/ folder by
    // default); it may have been removed since it was chosen.
    const outputPath = projectOutputVideoPath(project);
    await fsp.mkdir(project.outputDir, { recursive: true });
    const sourceBand = mode === 'burned-in' ? await this.sourceSubtitleBand(project) : undefined;
    if (sourceBand) {
      this.deps.logger.info(
        `The video's own subtitles are at ${Math.round(sourceBand.y * 100)}–${Math.round((sourceBand.y + sourceBand.h) * 100)} % of the height: ` +
          `the dub's subtitles keep clear of them unless they are covered (position ${project.settings.burnSubtitleStyle?.position ?? 'auto'}).`,
      );
    }
    this.deps.logger.info(`Rendering final video (subtitle mode: ${mode}) to ${outputPath}...`);
    const result = await this.deps.media.renderFinalVideo(
      {
        inputVideoPath: project.inputVideoPath,
        audioPath: paths.finalMixWav,
        outputPath,
        subtitleExportMode: mode,
        subtitlePath,
        burnSubtitleStyle: project.settings.burnSubtitleStyle,
        ...(sourceBand ? { sourceSubtitleBand: sourceBand } : {}),
        copyVideoStream: mode !== 'burned-in',
        ...(project.settings.renderQuality ? { renderQuality: project.settings.renderQuality } : {}),
        ...(logo ? { logo } : {}),
        // Watermarks hidden (picture options), in the input video's time: a
        // part's render moves them to its window.
        ...(project.settings.blurRegions?.length ? { blurRegions: project.settings.blurRegions } : {}),
        // A series part: its window of the video, its recap, title and end cards.
        ...(project.sourceRange ? { range: project.sourceRange } : {}),
        ...(project.series?.role === 'part'
          ? {
              effects: partEffects({
                index: project.series.index,
                count: project.series.count,
                seriesName: project.series.seriesName,
                ...(project.series.title ? { title: project.series.title } : {}),
                recapEndMs: project.series.recapEndMs,
                durationMs: videoMs,
                targetLanguage: project.settings.targetLanguage,
              }),
            }
          : {}),
      },
      signal,
    );
    this.deps.logger.info(
      `Render complete: ${result.outputPath} (${Math.round(result.durationMs / 1000)}s, ${result.sidecarSubtitlePaths.length} sidecar subtitle file(s)).`,
    );
    // Chosen per machine at run time, so the log is the only record of them.
    const enc = result.videoEncoder;
    if (enc) {
      const fellBack = enc.fallbackFrom ? ` after ${enc.fallbackFrom} failed (${enc.fallbackReason ?? 'no reason given'})` : '';
      this.deps.logger.info(`Video encoded with ${enc.codec}${enc.hardware ? ' (hardware)' : ''}${fellBack}.`);
    }
    if (result.burnFont) {
      this.deps.logger.info(
        `Subtitles drawn in ${result.burnFont.family}${result.burnFont.fontsDir ? '' : ' (a system font: the bundled one was not found)'}.`,
      );
    }
    // The post's thumbnail, beside the video (get_outputs): a frame where no
    // line is spoken, so no subtitle is across it. A finished video never
    // fails for want of a picture.
    if (this.deps.media.renderThumbnail) {
      try {
        const aligned = await this.readAligned(paths.translatedAlignedJson).catch(() => [] as AlignedSegment[]);
        const atMs = thumbnailMomentMs(
          result.durationMs || videoMs,
          aligned.map((a) => ({ startMs: a.startMs, endMs: Math.max(a.endMs, a.startMs + (a.placedDurationMs ?? 0)) })),
        );
        await this.deps.media.renderThumbnail(outputPath, atMs, projectOutputThumbnailPath(project), signal);
      } catch (err) {
        this.deps.logger.warn(`No thumbnail for the post (${toAppError(err).message}); the video itself is finished.`);
      }
    }
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

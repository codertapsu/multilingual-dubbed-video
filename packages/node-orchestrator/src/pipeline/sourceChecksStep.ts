/**
 * The source checks as the pipeline runs them (docs/plans/
 * production-requests-2026-11-23.md 1.1 and 1.6): the audio's drift against
 * the picture at extract-audio, and speech-to-text checking itself at the end
 * of its step. The decisions are pure (audioDrift.ts, sttChecks.ts,
 * spotCheck.ts); this is what reads the media, writes the project, logs, and
 * turns findings into the step's warnings. Kept out of runner.ts so the
 * runner only calls it.
 *
 * Every check is best effort: none ever fails its step. A pause still stops
 * one, like the rest of the step (the run's signal is rethrown).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, toAppError, type AudioDrift, type Project, type ProjectWarning, type TranscriptSegment } from '@videodubber/shared';
import { formatClock } from '../activity/history.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { WorkspacePaths } from '../workspace/paths.js';
import { audioDriftWarning, describeAudioDrift } from './audioDrift.js';
import type { LoopRange, RepairedRange } from './loopRepair.js';
import type { RunnerDeps, StepProgress } from './runner.js';
import { needsSpeechMap, type SpeechRegion } from './segmentTiming.js';
import { cachedSpeechRegions } from './speechMap.js';
import { comparableTranscript, runSpotCheck, SPOT_MIN_OVERLAP, spotCheckOn } from './spotCheck.js';
import {
  DIGITAL_SILENCE_DB,
  DIGITAL_SILENCE_MIN_MS,
  digitalSilenceFindings,
  findLinesOverSilence,
  inSilenceOf,
  linesCoverMs,
  normalizeRegions,
  speechMsIn,
  type SilentLinesFinding,
  type SttChunkSpan,
} from './sttChecks.js';

/**
 * Longest audio whose speech map is measured for the STT self-checks alone.
 * The STT worker loads the whole 16 kHz track as float32 to measure it: about
 * 0.7 GB for 3 hours, but ~16 GB at its peak for the 27.8-hour series. Longer
 * audio is measured only when anchoring needs the map anyway.
 */
export const CHECK_MAP_MAX_MS = 3 * 3_600_000;
/** Warnings one check raises at most (one per time range), then one saying how many more. */
export const MAX_RANGE_WARNINGS = 6;

/** A speech-to-text provider as the registry hands it out. */
type SttProviderRef = ReturnType<ProviderRegistry['getStt']>;
/** A warning as a step raises it (StepProgress.warn). */
type StepWarning = Omit<ProjectWarning, 'at' | 'step'>;

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AppErrorException('CANCELLED', 'Pipeline run was cancelled.');
}

/**
 * How far the source's audio was off its picture (audioDrift.ts), after the
 * extract-audio step re-timed both tracks to the picture: in the project's
 * media info and the log every time, a warning from 0.5 s.
 */
export async function recordAudioDrift(
  deps: Pick<RunnerDeps, 'media' | 'store' | 'logger'>,
  project: Project,
  signal: AbortSignal,
  onProgress?: StepProgress,
): Promise<void> {
  const measure = deps.media.measureAudioDrift?.bind(deps.media);
  if (!measure) return;
  let drift: AudioDrift | undefined;
  try {
    const measured = await measure(project.inputVideoPath, signal, project.sourceRange);
    if (measured) drift = { ...measured, measuredAt: new Date().toISOString() };
  } catch (err) {
    if (signal.aborted) throw err;
    deps.logger.warn(
      `Could not measure the audio against the picture (${toAppError(err).message}); both audio tracks follow the picture's clock all the same.`,
    );
  }
  // Replaced every time: a part starts with its parent's whole-video value.
  const fresh = await deps.store.getProject(project.id);
  if (fresh.mediaInfo) {
    const { audioDrift: _previous, ...info } = fresh.mediaInfo;
    await deps.store.saveProject({ ...fresh, mediaInfo: drift ? { ...info, audioDrift: drift } : info });
  }
  if (!drift) return;
  deps.logger.info(describeAudioDrift(drift));
  const warning = audioDriftWarning(drift);
  if (warning) onProgress?.warn?.(warning);
}

/**
 * The speech map for the STT self-checks, measured once (speechMap.ts caches
 * it per audio file; anchoring reuses it). Above {@link CHECK_MAP_MAX_MS} it
 * is measured only when the run needs it anyway: for lines without usable
 * word timings (whisper.cpp, the engine that writes lines over silence;
 * faster-whisper's own VAD skips silence). Undefined: not measured here; `{}`:
 * it failed, said once.
 */
export async function speechMapForChecks(
  deps: Pick<RunnerDeps, 'speechMap' | 'logger'>,
  paths: WorkspacePaths,
  segments: readonly TranscriptSegment[],
  totalMs: number,
  signal: AbortSignal,
): Promise<{ regions?: SpeechRegion[] } | undefined> {
  if (!deps.speechMap) return undefined;
  if (totalMs > CHECK_MAP_MAX_MS && !needsSpeechMap(segments)) {
    deps.logger.info('Lines over silence are not checked on this long video: its lines have word timings, so the speech map is not measured.');
    return undefined;
  }
  throwIfCancelled(signal);
  try {
    return { regions: await cachedSpeechRegions(deps.speechMap, paths.original16kMonoWav, paths.speechRegionsJson, signal) };
  } catch (err) {
    if (signal.aborted) throw err;
    deps.logger.warn(
      `Could not map where speech is (${toAppError(err).message}); the speech-to-text checks that need it are skipped, and lines without word timings keep the engine's timing.`,
    );
    return {};
  }
}

/**
 * Lines speech-to-text wrote where the speech map heard no speech
 * (sttChecks.ts): what the loop pass needs for them (the lines as `silence`
 * ranges, `inSilence` from the same map), and the stretches, which
 * {@link silenceCheckWarning} reports once the loop pass has decided them.
 */
export function linesOverSilence(
  segments: readonly TranscriptSegment[],
  regions: readonly SpeechRegion[],
  chunks: readonly SttChunkSpan[],
): { inSilence: (fromMs: number, toMs: number) => boolean; ranges: LoopRange[]; findings: SilentLinesFinding[] } {
  const { ranges, findings } = findLinesOverSilence(segments, regions, chunks);
  return { inSilence: inSilenceOf(regions), ranges, findings };
}

/**
 * One warning for the lines written where the speech map heard no speech,
 * once the loop pass has decided them: how many, for how long, what a decode
 * without context made of them, and the biggest stretches. It used to say,
 * before anything was decided, "STT chunk 1-25 of 25 heard no speech at
 * 3:47-4:03:30: 1766 line(s) over silence (the speech map heard 3579 s of
 * speech there)", which no one could act on (claude-dubber, 2026-11-25).
 * Undefined when there were none. Pure.
 */
export function silenceCheckWarning(findings: readonly SilentLinesFinding[], repaired: readonly RepairedRange[]): StepWarning | undefined {
  if (findings.length === 0) return undefined;
  const count = findings.reduce((n, f) => n + f.lines, 0);
  const silence = repaired.filter((r) => r.kind === 'silence');
  const sum = (key: 'kept' | 'added' | 'dropped'): number => silence.reduce((n, r) => n + (r.counts?.[key] ?? 0), 0);
  const kept = sum('kept') + silence.filter((r) => !r.counts && r.status === 'kept').reduce((n, r) => n + r.before, 0);
  const added = sum('added');
  const removed = sum('dropped') + silence.filter((r) => !r.counts && r.status === 'removed').reduce((n, r) => n + r.before, 0);
  const spokenMs = silence.reduce((ms, r) => ms + (r.originalLines ?? []).reduce((m, l) => m + Math.max(0, l.endMs - l.startMs), 0), 0);
  const minutes = Math.round(spokenMs / 6000) / 10;
  const biggest = [...silence].sort((a, b) => b.before - a.before).slice(0, 3);
  const where = biggest.map((r) => `${formatClock(r.fromMs)}–${formatClock(r.toMs)} (${r.before} → ${r.after})`).join(', ');
  const first = biggest[0] ?? { fromMs: findings[0]!.fromMs, toMs: findings[0]!.toMs };
  return {
    code: 'stt-no-speech',
    key: 'warning.stt-no-speech-checked',
    params: { count, minutes, kept, added, removed, biggest: where || '—', fromMs: first.fromMs, toMs: first.toMs },
    message:
      `${count} line(s) (${minutes} min) were written where the speech map heard no speech. A second decode without context checked them: ` +
      `${kept} heard again and kept, ${added} heard only by it and added, ${removed} removed.` +
      `${where ? ` Biggest stretches: ${where}.` : ''} Each change is in the History and can be undone.`,
  };
}

/** What {@link spotCheckTranscript} decodes with and compares. */
export interface SpotCheckInput {
  project: Project;
  paths: WorkspacePaths;
  provider: SttProviderRef;
  model: string;
  language: string | undefined;
  segments: readonly TranscriptSegment[];
  totalMs: number;
  regions: readonly SpeechRegion[] | undefined;
}

/**
 * Decode a minute of every half hour again and compare it with the lines
 * (spotCheck.ts): on by default for videos over 2 hours, a warning per
 * stretch that does not match.
 */
export async function spotCheckTranscript(
  deps: Pick<RunnerDeps, 'media' | 'logger'>,
  input: SpotCheckInput,
  signal: AbortSignal,
  onProgress: StepProgress,
): Promise<void> {
  const { project, paths, provider, model, language, segments, totalMs, regions } = input;
  if (!spotCheckOn(project.settings.transcriptSpotCheck, totalMs)) return;
  const clip = deps.media.clip16kMono?.bind(deps.media);
  if (!clip) return;
  if (!comparableTranscript(language || project.settings.sourceLanguage, segments)) {
    deps.logger.info('Spot check skipped: it compares Chinese, Japanese or Korean characters, and this transcript is in another script.');
    return;
  }
  deps.logger.info('Spot-checking the transcript: a minute of every half hour decoded again without context...');
  try {
    const report = await runSpotCheck(
      segments,
      totalMs,
      regions,
      {
        decode: async (fromMs, toMs, s) => {
          await fsp.mkdir(paths.sttChunksDir, { recursive: true });
          const clipPath = path.join(paths.sttChunksDir, `spot_${fromMs}_${toMs}.wav`);
          try {
            await clip(paths.original16kMonoWav, clipPath, fromMs, toMs, s);
            return (await provider.transcribe({ audioPath: clipPath, language, model, wordTimestamps: false, noContext: true }, s)).segments;
          } finally {
            await fsp.rm(clipPath, { force: true }).catch(() => undefined);
          }
        },
        progress: (done, total) =>
          onProgress(0.98, { key: 'step-detail.spot-check', params: { done, total }, text: `Spot-checking the transcript ${done}/${total}` }),
      },
      signal,
    );
    const scored = report.results.filter((r) => r.overlap !== undefined);
    const failed = scored.filter((r) => r.failed);
    deps.logger.info(
      `Spot check: ${report.results.length} minute(s) decoded again; ${report.results.length - scored.length} skipped (music, no speech or no decode), ` +
        `${failed.length} below ${Math.round(SPOT_MIN_OVERLAP * 100)} % agreement.`,
    );
    for (const r of failed) {
      deps.logger.info(`Spot check ${formatClock(r.fromMs)}-${formatClock(r.toMs)}: ${Math.round((r.overlap ?? 0) * 100)} % agreement.`);
    }
    warnRanges(
      report.spans.map((s): StepWarning => {
        const percent = Math.round(s.best * 100);
        if (s.failed === 1) {
          const at = formatClock((s.fromMs + s.toMs) / 2);
          return {
            code: 'transcript-mismatch',
            key: 'warning.transcript-mismatch',
            params: { at, fromMs: s.fromMs, toMs: s.toMs, percent },
            message:
              `The transcript does not match the audio around ${at}: decoded again without context, that minute agrees with only ${percent} % of the lines. ` +
              'Listen to it, and re-transcribe it if it is wrong (the editor, or retranscribe_range).',
          };
        }
        const from = formatClock(s.fromMs);
        const to = formatClock(s.toMs);
        return {
          code: 'transcript-mismatch',
          key: 'warning.transcript-mismatch-span',
          params: { from, to, fromMs: s.fromMs, toMs: s.toMs, failed: s.failed, percent },
          message:
            `The transcript does not match the audio from ${from} to ${to}: ${s.failed} spot checks there failed (a second decode agrees with at most ${percent} % of the lines). ` +
            'Probably a broken source there (a bad join or download): check that part, and re-transcribe it (the editor, or retranscribe_range).',
        };
      }),
      onProgress,
    );
  } catch (err) {
    if (signal.aborted) throw err;
    deps.logger.warn(`The spot check could not run (${toAppError(err).message}); the transcript is kept as it is.`);
  }
}

/**
 * A minute or more of digital silence in a talk-heavy video (sttChecks.ts):
 * a broken source or join, which no transcript check can see.
 */
export async function checkDigitalSilence(
  deps: Pick<RunnerDeps, 'media' | 'logger'>,
  paths: WorkspacePaths,
  segments: readonly TranscriptSegment[],
  totalMs: number,
  regions: readonly SpeechRegion[] | undefined,
  signal: AbortSignal,
  onProgress: StepProgress,
): Promise<void> {
  const detect = deps.media.detectSilences?.bind(deps.media);
  if (!detect || totalMs < DIGITAL_SILENCE_MIN_MS) return;
  throwIfCancelled(signal);
  // The pass reads 16 kHz audio hundreds of times faster than it plays: only
  // a long track (27.8 hours: minutes) is worth saying it is being checked.
  if (totalMs >= 30 * 60_000) {
    await onProgress(0.99, { key: 'step-detail.silence-check', text: 'Checking the audio for digital silence' });
  }
  try {
    const found = await detect(paths.original16kMonoWav, { noiseDb: DIGITAL_SILENCE_DB, minSilenceMs: DIGITAL_SILENCE_MIN_MS }, signal);
    if (found.silences.length === 0) return;
    const total = found.durationMs > 0 ? found.durationMs : totalMs;
    const speechMs = regions ? speechMsIn(normalizeRegions(regions), 0, total) : linesCoverMs(segments);
    const findings = digitalSilenceFindings(found.silences, total, speechMs);
    const list = found.silences.map((s) => `${formatClock(s.startMs)}-${formatClock(s.endMs)}`).join(', ');
    deps.logger.info(
      `Digital silence (below ${DIGITAL_SILENCE_DB} dB for a minute or more): ${list}` +
        `${findings.length === 0 ? '. Not flagged: the rest of the video has little talk.' : '.'}`,
    );
    warnRanges(
      findings.map((f): StepWarning => {
        const from = formatClock(f.fromMs);
        const to = formatClock(f.toMs);
        const minutes = Math.round((f.toMs - f.fromMs) / 60_000);
        return {
          code: 'digital-silence',
          key: 'warning.digital-silence',
          params: { from, to, fromMs: f.fromMs, toMs: f.toMs, minutes },
          message:
            `${minutes} min of digital silence at ${from}-${to} in a video full of talk: probably a problem in the source or its encoding ` +
            '(a bad join or a broken download). Check that part of the video.',
        };
      }),
      onProgress,
    );
  } catch (err) {
    if (signal.aborted) throw err;
    deps.logger.warn(`Could not check the audio for digital silence (${toAppError(err).message}).`);
  }
}

/**
 * One warning per time range, at most {@link MAX_RANGE_WARNINGS} per check,
 * then one saying how many more (all of them are in the log).
 */
export function warnRanges(warnings: readonly StepWarning[], onProgress: StepProgress): void {
  for (const w of warnings.slice(0, MAX_RANGE_WARNINGS)) onProgress.warn?.(w);
  const more = warnings.length - MAX_RANGE_WARNINGS;
  if (more > 0) {
    onProgress.warn?.({
      code: warnings[0]!.code,
      key: 'warning.more-ranges',
      params: { count: more },
      message: `...and ${more} more like it (every one is in the log).`,
    });
  }
}

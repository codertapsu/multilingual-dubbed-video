/**
 * The transcript's warnings, kept true outside a run.
 *
 * The STT step raises the loop check's warnings when it runs (runner.ts
 * reportLoops). Afterwards a re-transcribed range, replace_lines, a speaker
 * detection or the editor change the lines, and the project's warnings
 * (get_project, the processing screen, a series' review) must say what is
 * true now: a loop an agent repaired is no longer "left", and lines a
 * re-transcription could not give a speaker are named, with where they are
 * (plan 1.3: the result points to a ranged speaker detection). They stay on
 * the STT step, as the run's own: transcribing again replaces them.
 */
import fsp from 'node:fs/promises';
import type { PipelineState, ProjectWarning, ProjectWarningCode, TranscriptSegment } from '@videodubber/shared';
import { formatClock } from '../activity/history.js';
import type { ProjectStore } from '../workspace/projectStore.js';
import type { RepairedRange } from './loopRepair.js';

type Warning = Omit<ProjectWarning, 'at' | 'step'>;
type Line = Pick<TranscriptSegment, 'startMs' | 'endMs' | 'speakerId' | 'loopSuspect'>;

/** The codes kept current here. */
export const TRANSCRIPT_WARNING_CODES: readonly ProjectWarningCode[] = ['loops-repaired', 'loops-left', 'speakers-unassigned'];

/** Lines without a speaker closer than this are named as one stretch. */
const SPAN_JOIN_MS = 5 * 60_000;
/** Stretches named in the warning; more are an ellipsis. */
const MAX_SPANS = 3;

/**
 * The loop check's warnings from its report (audio/loop_ranges.json), in the
 * STT step's words. A range left unrepaired counts while its lines still
 * carry the LOOP? mark: replace_lines or a re-transcription took them out. Pure.
 */
export function loopWarnings(ranges: readonly RepairedRange[], lines: readonly Line[]): Warning[] {
  const repaired = ranges.filter((r) => r.status === 'replaced' || r.status === 'removed').length;
  const kept = ranges.filter((r) => r.status === 'kept').length;
  const left = ranges.filter(
    (r) => r.status === 'left' && lines.some((l) => l.loopSuspect && l.startMs < r.toMs && l.endMs > r.fromMs),
  ).length;
  const out: Warning[] = [];
  if (repaired > 0) {
    out.push({
      code: 'loops-repaired',
      key: 'warning.loops-repaired',
      params: { count: repaired },
      message: `${repaired} transcription loop(s) or credit line(s) were repaired (decoded again, or removed where nothing was said).${kept > 0 ? ` ${kept} repetition(s) were real and kept.` : ''}`,
    });
  }
  if (left > 0) {
    out.push({
      code: 'loops-left',
      key: 'warning.loops-left',
      params: { count: left },
      message: `${left} range(s) that look like transcription loops could not be repaired: their lines are marked in the editor (Problems) and in get_transcript. Check them before dubbing.`,
    });
  }
  return out;
}

/**
 * Lines with no speaker in a project that has speakers, with where they are
 * ("24:12:04–24:27:04, 25:01:00–25:03:10"): they would be dubbed in the
 * project voice. Undefined when every line has one, or none has. Pure.
 */
export function unassignedWarning(lines: readonly Line[]): Warning | undefined {
  if (!lines.some((l) => l.speakerId)) return undefined;
  const nobody = lines.filter((l) => !l.speakerId).sort((a, b) => a.startMs - b.startMs);
  if (nobody.length === 0) return undefined;
  const spans: { fromMs: number; toMs: number }[] = [];
  for (const l of nobody) {
    const last = spans[spans.length - 1];
    if (last && l.startMs - last.toMs <= SPAN_JOIN_MS) last.toMs = Math.max(last.toMs, l.endMs);
    else spans.push({ fromMs: l.startMs, toMs: l.endMs });
  }
  const ranges =
    spans
      .slice(0, MAX_SPANS)
      .map((s) => `${formatClock(s.fromMs)}–${formatClock(s.toMs)}`)
      .join(', ') + (spans.length > MAX_SPANS ? ', …' : '');
  return {
    code: 'speakers-unassigned',
    key: 'warning.speakers-unassigned',
    params: { count: nobody.length, ranges },
    message:
      `${nobody.length} line(s) have no speaker (${ranges}), so they would be dubbed in the project voice: ` +
      'detect speakers over that range (detect_speakers with fromMs and toMs) or set them in the editor.',
  };
}

/** The warnings the transcript calls for now (speakers only in a project that detects them). Pure. */
export function transcriptWarnings(lines: readonly Line[], loopReport: readonly RepairedRange[], diarized: boolean): Warning[] {
  const speakers = diarized ? unassignedWarning(lines) : undefined;
  return [...loopWarnings(loopReport, lines), ...(speakers ? [speakers] : [])];
}

/**
 * `current` with this module's warnings replaced by `next` (kept on the STT
 * step); undefined when nothing changes, so nothing is written. A warning
 * that says the same as before keeps its time. Pure.
 */
export function withTranscriptWarnings(current: readonly ProjectWarning[], next: readonly Warning[], now: string): ProjectWarning[] | undefined {
  const ours = new Set<string>(TRANSCRIPT_WARNING_CODES);
  const key = (w: Pick<ProjectWarning, 'code' | 'message'>): string => JSON.stringify([w.code, w.message]);
  const before = current.filter((w) => ours.has(w.code));
  if (JSON.stringify(before.map(key).sort()) === JSON.stringify(next.map(key).sort())) return undefined;
  return [
    ...current.filter((w) => !ours.has(w.code)),
    ...next.map((w) => before.find((b) => key(b) === key(w)) ?? { ...w, step: 'stt' as const, at: now }),
  ];
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export interface TranscriptWarningDeps {
  store: Pick<ProjectStore, 'getProject' | 'getPipeline' | 'savePipeline' | 'paths'>;
  /** A run owns pipeline.json while it runs: nothing is written then (its own STT step says it). */
  isRunning: (projectId: string) => boolean;
  /** The new state, for the screens that show it. */
  emit?: (projectId: string, pipeline: PipelineState) => void;
}

/**
 * Bring the project's transcript warnings up to date with its lines (the
 * translated ones once they exist: those are dubbed) and its loop report.
 * Never throws: a warning that could not be updated must not fail the edit.
 */
export async function refreshTranscriptWarnings(deps: TranscriptWarningDeps, projectId: string): Promise<void> {
  try {
    const paths = deps.store.paths(projectId);
    const [project, translated, source, report] = await Promise.all([
      deps.store.getProject(projectId),
      readJson<{ segments?: Line[] }>(paths.translatedJson),
      readJson<{ segments?: Line[] }>(paths.sourceJson),
      readJson<{ ranges?: RepairedRange[] }>(paths.loopRangesJson),
    ]);
    const lines = translated?.segments ?? source?.segments;
    if (!Array.isArray(lines)) return;
    const next = transcriptWarnings(lines, Array.isArray(report?.ranges) ? report.ranges : [], project.settings.diarize === true);
    if (deps.isRunning(projectId)) return;
    const pipeline = await deps.store.getPipeline(projectId);
    const warnings = withTranscriptWarnings(pipeline.warnings ?? [], next, new Date().toISOString());
    if (!warnings || deps.isRunning(projectId)) return;
    const { warnings: _old, ...rest } = pipeline;
    const saved: PipelineState = warnings.length > 0 ? { ...rest, warnings } : rest;
    await deps.store.savePipeline(saved);
    deps.emit?.(projectId, saved);
  } catch {
    /* best effort */
  }
}

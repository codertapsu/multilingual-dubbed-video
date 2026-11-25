/**
 * Where a long video is cut into parts (models/series.ts). Pure.
 *
 * Cuts only fall in pauses between lines, never inside one: the candidates
 * are the gaps of the transcript (a scene change or a chapter mark nearby
 * ranks a pause higher). The number of parts follows the length the user
 * chose (15–20 minutes by default); each cut is chosen inside a window around
 * its evenly spaced target, by the AI when it answers, else by the best pause.
 * Part n+1 starts a few seconds before its cut (a recap), at the start of the
 * line being said there when that is close.
 */
import {
  isFallbackPartTitle,
  seriesCardWords,
  type RenderCard,
  type RenderEffects,
  type SeriesCandidate,
  type SeriesPlanPart,
  type SeriesSettings,
  type TranscriptSegment,
} from '@videodubber/shared';

/** A pause shorter than this is a breath, not a place to cut. */
export const MIN_PAUSE_MS = 600;
/**
 * What a file boundary of a joined project adds to the pause it lies in:
 * more than a chapter mark, so a cut near its target lands where one source
 * video ends and the next begins rather than a minute into the next one.
 */
export const BOUNDARY_BONUS = 4;
/** A part is never shorter than this (manual cuts included). */
export const MIN_PART_MS = 60_000;
/** How many candidates the AI is shown per cut. */
export const CANDIDATES_PER_CUT = 8;

export interface PlannerLine {
  startMs: number;
  endMs: number;
  sourceText: string;
}

/**
 * The pauses between lines, scored. `scenes`/`chapters`: times that raise a
 * nearby pause. `boundaries`: where the files of a joined project meet
 * (Project.inputFiles): a pause holding one is cut exactly there and ranks
 * above the rest, and a boundary in no pause (between two lines said without
 * one, or past the last line) is a candidate of its own, never inside a line.
 */
export function candidateCuts(
  lines: readonly PlannerLine[],
  marks: { scenes?: readonly number[]; chapters?: readonly number[]; boundaries?: readonly number[] } = {},
): SeriesCandidate[] {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const boundaries = [...(marks.boundaries ?? [])].sort((a, b) => a - b);
  const placed = new Set<number>();
  const out: SeriesCandidate[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gap = sorted[i + 1]!.startMs - sorted[i]!.endMs;
    if (gap < MIN_PAUSE_MS) continue;
    const boundary = boundaries.find((b) => b >= sorted[i]!.endMs && b <= sorted[i + 1]!.startMs);
    const ms = boundary ?? Math.round(sorted[i]!.endMs + gap / 2);
    let score = Math.min(gap, 6000) / 1000;
    if (marks.scenes?.some((s) => Math.abs(s - ms) <= 1000)) score += 2;
    if (marks.chapters?.some((c) => Math.abs(c - ms) <= 3000)) score += 3;
    if (boundary !== undefined) {
      score += BOUNDARY_BONUS;
      placed.add(boundary);
    }
    out.push({ ms, score: Math.round(score * 100) / 100, ...(boundary !== undefined ? { boundary: true as const } : {}) });
  }
  if (boundaries.length === 0) return out;
  for (const b of boundaries) {
    if (placed.has(b) || sorted.some((l) => l.startMs < b && l.endMs > b)) continue;
    out.push({ ms: Math.round(b), score: 6 + BOUNDARY_BONUS, boundary: true });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** A cut this close to where two joined files meet moves onto it. */
export const SNAP_TO_FILE_MS = 30_000;

/**
 * A cut onto the file boundary within {@link SNAP_TO_FILE_MS} of it, when the
 * parts on both sides keep at least `minPartMs` (one part per source video
 * reads better than one that opens with the last seconds of the previous
 * episode: cut 4 of 《反相之地》 fell 9.6 s before episode 7 began,
 * claude-dubber 2026-11-25). Undefined when there is none. Pure.
 */
export function snapToFileBoundary(
  ms: number,
  boundaries: readonly number[],
  limits: { previousMs: number; durationMs: number; minPartMs: number },
): number | undefined {
  let best: number | undefined;
  for (const b of boundaries) {
    if (b === ms || Math.abs(b - ms) > SNAP_TO_FILE_MS) continue;
    if (b - limits.previousMs < limits.minPartMs || limits.durationMs - b < limits.minPartMs) continue;
    if (best === undefined || Math.abs(b - ms) < Math.abs(best - ms)) best = b;
  }
  return best;
}

/** Where the files of a joined project meet, inside the video (Project.inputFiles). Pure. */
export function fileBoundaries(inputFiles: readonly { startMs: number }[] | undefined, durationMs: number): number[] {
  return (inputFiles ?? [])
    .map((f) => Math.round(f.startMs))
    .filter((ms) => ms > 0 && (durationMs <= 0 || ms < durationMs))
    .sort((a, b) => a - b);
}

/** How many parts: the length the user chose, as evenly as the video allows. */
export function partCount(durationMs: number, minMinutes: number, maxMinutes: number): number {
  const lo = Math.max(1, minMinutes) * 60_000;
  const hi = Math.max(lo, maxMinutes * 60_000);
  let n = Math.max(1, Math.round(durationMs / ((lo + hi) / 2)));
  while (n > 1 && durationMs / n < lo) n--;
  while (durationMs / n > hi) n++;
  return n;
}

/** Where the k-th cut is looked for, and its best candidates. */
export interface CutWindow {
  /** 1-based: the cut between part k and part k+1. */
  index: number;
  targetMs: number;
  fromMs: number;
  toMs: number;
  candidates: SeriesCandidate[];
}

export function cutWindows(
  durationMs: number,
  parts: number,
  settings: Pick<SeriesSettings, 'minMinutes' | 'maxMinutes'>,
  candidates: readonly SeriesCandidate[],
): CutWindow[] {
  const spread = Math.max(90_000, ((settings.maxMinutes - settings.minMinutes) * 60_000) / 2 + 60_000);
  const out: CutWindow[] = [];
  for (let k = 1; k < parts; k++) {
    const targetMs = Math.round((durationMs * k) / parts);
    const fromMs = Math.max(MIN_PART_MS, targetMs - spread);
    const toMs = Math.min(durationMs - MIN_PART_MS, targetMs + spread);
    const inside = candidates
      .filter((c) => c.ms >= fromMs && c.ms <= toMs)
      .sort((a, b) => b.score - a.score || Math.abs(a.ms - targetMs) - Math.abs(b.ms - targetMs))
      .slice(0, CANDIDATES_PER_CUT);
    out.push({ index: k, targetMs, fromMs, toMs, candidates: inside });
  }
  return out;
}

/**
 * Where the k-th cut (1-based) may go so every part stays within
 * [minMs, maxMs]: after the previous cut, and leaving the rest of the video
 * splittable into the parts still to come. Undefined when no cut can. The even
 * split alone let a part run 6 minutes over (field report B3). Pure.
 */
export function admissibleWindow(
  prevCutMs: number,
  k: number,
  parts: number,
  durationMs: number,
  minMs: number,
  maxMs: number,
): { fromMs: number; toMs: number } | undefined {
  const after = parts - k;
  const fromMs = Math.max(prevCutMs + minMs, durationMs - after * maxMs);
  const toMs = Math.min(prevCutMs + maxMs, durationMs - after * minMs);
  return fromMs <= toMs ? { fromMs: Math.round(fromMs), toMs: Math.round(toMs) } : undefined;
}

/** A cut window narrowed to `bounds`, with its best pauses there. Pure. */
export function boundedWindow(
  w: CutWindow,
  bounds: { fromMs: number; toMs: number },
  candidates: readonly SeriesCandidate[],
): CutWindow {
  const targetMs = Math.min(bounds.toMs, Math.max(bounds.fromMs, w.targetMs));
  const inside = candidates
    .filter((c) => c.ms >= bounds.fromMs && c.ms <= bounds.toMs)
    .sort((a, b) => b.score - a.score || Math.abs(a.ms - targetMs) - Math.abs(b.ms - targetMs))
    .slice(0, CANDIDATES_PER_CUT);
  return { ...w, targetMs, fromMs: bounds.fromMs, toMs: bounds.toMs, candidates: inside };
}

/** Parts whose own length (recap excluded) is outside [min, max] minutes. Pure. */
export function partsOutsideBounds(
  parts: readonly Pick<SeriesPlanPart, 'index' | 'startMs' | 'endMs'>[],
  minMinutes: number,
  maxMinutes: number,
): { index: number; minutes: number }[] {
  // Half a second of slack: cuts land on pauses, not on the millisecond.
  return parts
    .map((p) => ({ index: p.index, minutes: (p.endMs - p.startMs) / 60_000 }))
    .filter((p) => p.minutes < minMinutes - 0.01 || p.minutes > maxMinutes + 0.01);
}

/** The cut the window would take without the AI: a long pause near the target. */
export function fallbackCut(w: CutWindow): number {
  const spread = Math.max(1, (w.toMs - w.fromMs) / 2);
  let best: SeriesCandidate | undefined;
  let bestValue = -Infinity;
  for (const c of w.candidates) {
    const value = c.score - (1.5 * Math.abs(c.ms - w.targetMs)) / spread;
    if (value > bestValue) {
      bestValue = value;
      best = c;
    }
  }
  return best ? best.ms : w.targetMs;
}

/**
 * Where a part's video begins: `recapSec` before its cut, moved back to the
 * start of the line being said there when that line began less than 4 s
 * earlier (a recap that starts mid-sentence reads as a glitch), never before
 * the previous part's own start.
 */
export function recapStart(cutMs: number, recapSec: number, lines: readonly PlannerLine[], previousStartMs: number): number {
  const ideal = cutMs - Math.max(0, recapSec) * 1000;
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const speaking = sorted.find((l) => l.startMs <= ideal && l.endMs > ideal);
  let start = ideal;
  if (speaking && speaking.startMs >= ideal - 4000) start = speaking.startMs;
  else if (speaking) start = sorted.find((l) => l.startMs > ideal && l.startMs < cutMs)?.startMs ?? ideal;
  return Math.max(previousStartMs, Math.max(0, Math.round(start)));
}

/**
 * The plan's parts from its cuts (source time), numbered from `offset` + 1
 * (a series continuing another: models/series.ts).
 */
export function partsFromCuts(
  durationMs: number,
  cuts: readonly { ms: number; by: SeriesPlanPart['cutBy'] }[],
  recapSec: number,
  lines: readonly PlannerLine[],
  titles: readonly { title?: string; summary?: string }[] = [],
  offset = 0,
): SeriesPlanPart[] {
  const sorted = [...cuts].sort((a, b) => a.ms - b.ms);
  const parts: SeriesPlanPart[] = [];
  for (let k = 0; k <= sorted.length; k++) {
    const startMs = k === 0 ? 0 : sorted[k - 1]!.ms;
    const endMs = k === sorted.length ? durationMs : sorted[k]!.ms;
    const previous = parts[k - 1];
    parts.push({
      index: offset + k + 1,
      startMs,
      endMs,
      recapStartMs: k === 0 ? 0 : recapStart(startMs, recapSec, lines, previous!.startMs),
      title: titles[k]?.title?.trim() || '',
      summary: titles[k]?.summary?.trim() || '',
      cutBy: k === 0 ? 'start' : sorted[k - 1]!.by,
    });
  }
  return parts;
}

/** Cut times the user edited: sorted, inside the video, parts at least a minute long. */
export function validateCuts(cuts: readonly number[], durationMs: number): { ok: true; cuts: number[] } | { ok: false; reason: string } {
  const sorted = [...new Set(cuts.map((c) => Math.round(c)))].sort((a, b) => a - b);
  let previous = 0;
  for (const c of sorted) {
    if (!Number.isFinite(c) || c - previous < MIN_PART_MS || durationMs - c < MIN_PART_MS) {
      return { ok: false, reason: 'Every part has to be at least a minute long, and the cuts inside the video.' };
    }
    previous = c;
  }
  return { ok: true, cuts: sorted };
}

/**
 * Mark what the user changed in review: a title or summary that differs from
 * the plan's for the same part, or was the user's already and still is.
 * Mutates `next`.
 */
export function markEdited(next: SeriesPlanPart[], before: readonly SeriesPlanPart[]): void {
  for (const [k, part] of next.entries()) {
    const old = before[k];
    const title = part.title !== (old?.title ?? '') || (old?.edited?.title === true && part.title === old.title);
    const summary = part.summary !== (old?.summary ?? '') || (old?.edited?.summary === true && part.summary === old.summary);
    if (title || summary) part.edited = { ...(title ? { title: true } : {}), ...(summary ? { summary: true } : {}) };
    else delete part.edited;
  }
}

/**
 * A plan made again keeps what the user wrote in review (`keepTitles`): each
 * title or summary they edited goes to the new part covering most of the same
 * stretch of video, when that is at least half of both parts. A replan that
 * moves the cuts a little keeps every edit; one that makes other parts keeps
 * only what still fits. Mutates `next`; returns how many parts kept an edit.
 */
export function keepEditedTitles(next: SeriesPlanPart[], before: readonly SeriesPlanPart[]): number {
  let kept = 0;
  for (const old of before) {
    if (!old.edited?.title && !old.edited?.summary) continue;
    let best: SeriesPlanPart | undefined;
    let overlap = 0;
    for (const p of next) {
      const o = Math.min(p.endMs, old.endMs) - Math.max(p.startMs, old.startMs);
      if (o > overlap) {
        overlap = o;
        best = p;
      }
    }
    if (!best || overlap * 2 < old.endMs - old.startMs || overlap * 2 < best.endMs - best.startMs) continue;
    if (old.edited.title) best.title = old.title;
    if (old.edited.summary) best.summary = old.summary;
    best.edited = { ...best.edited, ...(old.edited.title ? { title: true } : {}), ...(old.edited.summary ? { summary: true } : {}) };
    kept += 1;
  }
  return kept;
}

/** The lines of one part, in the part's own time (ids renumbered from seg_0001). */
export function partTranscript(lines: readonly TranscriptSegment[], part: Pick<SeriesPlanPart, 'recapStartMs' | 'endMs'>): TranscriptSegment[] {
  return [...lines]
    .filter((l) => l.startMs >= part.recapStartMs && l.startMs < part.endMs)
    .sort((a, b) => a.startMs - b.startMs)
    .map((l, i) => {
      const { id: _id, index: _index, ...rest } = l;
      return {
        ...rest,
        id: `seg_${String(i + 1).padStart(4, '0')}`,
        index: i,
        startMs: l.startMs - part.recapStartMs,
        endMs: Math.min(l.endMs, part.endMs) - part.recapStartMs,
        ...(l.words
          ? {
              words: l.words.map((w) => ({ ...w, startMs: w.startMs - part.recapStartMs, endMs: w.endMs - part.recapStartMs })),
            }
          : {}),
      };
    });
}

/**
 * The card wording in the dub's language (English for the rest). Kept in
 * shared (pipeline/seriesNames.ts): the part names the UI shows use it too.
 */
export function cardWords(targetLanguage: string): { part: string; previously: string; next: string; end: string } {
  return seriesCardWords(targetLanguage);
}

/**
 * A part's opening and closing for the render: fade in and out, the recap a
 * little darker with a "Previously" label, the title card over the first
 * seconds and a "To be continued · Part n+1" (or "The end") card at the end.
 */
export function partEffects(input: {
  index: number;
  count: number;
  seriesName: string;
  title?: string;
  recapEndMs: number;
  durationMs: number;
  targetLanguage: string;
}): RenderEffects {
  const words = cardWords(input.targetLanguage);
  const label = words.part === '第' ? `第 ${input.index}/${input.count} 集` : `${words.part} ${input.index}/${input.count}`;
  const titleEnd = Math.min(input.durationMs, Math.max(3500, input.recapEndMs > 0 ? Math.min(input.recapEndMs, 5000) : 3500));
  // The plain title a part the AI did not name gets ("Phần 42") only repeats the label.
  const title = input.title && !isFallbackPartTitle(input.title, input.index, input.targetLanguage) ? input.title : undefined;
  const cards: RenderCard[] = [
    { kind: 'title', text: `${input.seriesName}\n${label}${title ? `: ${title}` : ''}`, startMs: 300, endMs: titleEnd },
  ];
  if (input.index > 1 && input.recapEndMs > 0) {
    cards.push({ kind: 'label', text: words.previously, startMs: 0, endMs: input.recapEndMs });
  }
  const closing =
    input.index < input.count
      ? `${words.next} · ${words.part === '第' ? `第 ${input.index + 1} 集` : `${words.part} ${input.index + 1}`}`
      : words.end;
  if (input.durationMs > 8000) cards.push({ kind: 'end', text: closing, startMs: input.durationMs - 3500, endMs: input.durationMs - 200 });
  return {
    fadeInMs: 500,
    fadeOutMs: 1000,
    ...(input.index > 1 && input.recapEndMs > 0 ? { darkenUntilMs: input.recapEndMs } : {}),
    cards,
  };
}

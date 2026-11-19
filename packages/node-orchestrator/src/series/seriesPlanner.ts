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
import type {
  RenderCard,
  RenderEffects,
  SeriesCandidate,
  SeriesPlanPart,
  SeriesSettings,
  TranscriptSegment,
} from '@videodubber/shared';

/** A pause shorter than this is a breath, not a place to cut. */
export const MIN_PAUSE_MS = 600;
/** A part is never shorter than this (manual cuts included). */
export const MIN_PART_MS = 60_000;
/** How many candidates the AI is shown per cut. */
export const CANDIDATES_PER_CUT = 8;

export interface PlannerLine {
  startMs: number;
  endMs: number;
  sourceText: string;
}

/** The pauses between lines, scored. `scenes`/`chapters`: times that raise a nearby pause. */
export function candidateCuts(
  lines: readonly PlannerLine[],
  marks: { scenes?: readonly number[]; chapters?: readonly number[] } = {},
): SeriesCandidate[] {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const out: SeriesCandidate[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gap = sorted[i + 1]!.startMs - sorted[i]!.endMs;
    if (gap < MIN_PAUSE_MS) continue;
    const ms = Math.round(sorted[i]!.endMs + gap / 2);
    let score = Math.min(gap, 6000) / 1000;
    if (marks.scenes?.some((s) => Math.abs(s - ms) <= 1000)) score += 2;
    if (marks.chapters?.some((c) => Math.abs(c - ms) <= 3000)) score += 3;
    out.push({ ms, score: Math.round(score * 100) / 100 });
  }
  return out;
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

/** The plan's parts from its cuts (source time). */
export function partsFromCuts(
  durationMs: number,
  cuts: readonly { ms: number; by: SeriesPlanPart['cutBy'] }[],
  recapSec: number,
  lines: readonly PlannerLine[],
  titles: readonly { title?: string; summary?: string }[] = [],
): SeriesPlanPart[] {
  const sorted = [...cuts].sort((a, b) => a.ms - b.ms);
  const parts: SeriesPlanPart[] = [];
  for (let k = 0; k <= sorted.length; k++) {
    const startMs = k === 0 ? 0 : sorted[k - 1]!.ms;
    const endMs = k === sorted.length ? durationMs : sorted[k]!.ms;
    const previous = parts[k - 1];
    parts.push({
      index: k + 1,
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

/** The card wording in the dub's language (English for the rest). */
const CARD_WORDS: Record<string, { part: string; previously: string; next: string; end: string }> = {
  vi: { part: 'Phần', previously: 'Phần trước', next: 'Còn tiếp', end: 'Hết' },
  en: { part: 'Part', previously: 'Previously', next: 'To be continued', end: 'The end' },
  zh: { part: '第', previously: '前情回顾', next: '未完待续', end: '完' },
  ja: { part: 'パート', previously: '前回', next: '続く', end: '終わり' },
  ko: { part: '파트', previously: '지난 이야기', next: '다음 편에 계속', end: '끝' },
  es: { part: 'Parte', previously: 'Anteriormente', next: 'Continuará', end: 'Fin' },
  fr: { part: 'Partie', previously: 'Précédemment', next: 'À suivre', end: 'Fin' },
};

export function cardWords(targetLanguage: string): { part: string; previously: string; next: string; end: string } {
  return CARD_WORDS[targetLanguage.toLowerCase().split('-')[0] ?? 'en'] ?? CARD_WORDS['en']!;
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
  const cards: RenderCard[] = [
    { kind: 'title', text: `${input.seriesName}\n${label}${input.title ? `: ${input.title}` : ''}`, startMs: 300, endMs: titleEnd },
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

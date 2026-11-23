/**
 * Lines that look sung, offered to keep as the original song: NEVER applied
 * here. Speech-to-text writes a sung OST ballad down like dialogue, and the
 * 27.8-hour series would have dubbed it as speech (claude-dubber report F7,
 * 2026-11-23). Three signs, each a reason on the suggestion:
 *  - `traditional`: a line in traditional characters in a simplified-character
 *    transcript (these uploads carry their lyrics on screen in traditional
 *    characters; songs/chineseScript.ts);
 *  - `repeats`: lines the loop pass kept because they come back unchanged in
 *    a fresh decode (a chorus: pipeline/loopRepair.ts, audio/loop_ranges.json);
 *  - `sung`: a very slow syllable rate with long sustained words, in a run of
 *    such lines (singing holds a syllable 0.4-1 s, speech 0.15-0.25 s).
 * The suggestions go to subtitles/song_suggestions.json and the run's
 * `songs-suggested` warning; the editor lists them with "keep the original
 * song", get_transcript marks them, mark_song applies them.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { countSpeechUnits, type ProjectWarning, type TranscriptSegment } from '@videodubber/shared';

import { normalizeLine, type RepairedRange } from '../pipeline/loopRepair.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';
import { formatClock } from '../activity/history.js';
import { scriptCounts } from './chineseScript.js';
import { isSong } from './songLines.js';

export type SongReason = 'traditional' | 'repeats' | 'sung';

export interface SongSuggestion {
  lineId: string;
  startMs: number;
  endMs: number;
  /** The line's original text (what was heard). */
  text: string;
  reasons: SongReason[];
}

/** subtitles/song_suggestions.json. */
export interface SongSuggestionsFile {
  checkedAt: string;
  suggestions: SongSuggestion[];
}

/** Where a project's suggestions are kept (beside its transcript). */
export function songSuggestionsPath(paths: { subtitlesDir: string }): string {
  return path.join(paths.subtitlesDir, 'song_suggestions.json');
}

// ---- traditional characters -------------------------------------------------

/** Enough simplified-only characters to call the transcript simplified, and by how much. */
const MIN_SIMPLIFIED_CHARS = 20;
const SIMPLIFIED_DOMINANCE = 4;
/** A single traditional character counts in a short line next to a sure one. */
const WEAK_TRADITIONAL_MAX_HAN = 8;
const TRADITIONAL_NEIGHBOUR_MS = 10_000;

/** The lines written in traditional characters, when the transcript is simplified. Pure. */
export function traditionalLines(lines: readonly TranscriptSegment[]): Set<string> {
  const counts = lines.map((l) => scriptCounts(l.sourceText ?? ''));
  // Lines already kept as a song are known lyrics: they do not decide the transcript's script.
  const spoken = counts.filter((_, i) => !isSong(lines[i]!));
  const simplified = spoken.reduce((n, c) => n + c.simplified, 0);
  const traditional = spoken.reduce((n, c) => n + c.traditional, 0);
  const out = new Set<string>();
  if (simplified < MIN_SIMPLIFIED_CHARS || simplified < SIMPLIFIED_DOMINANCE * traditional) return out;
  const strong = counts.map((c) => c.traditional >= 2 && c.simplified === 0);
  // Lyrics come in runs: a short line with one traditional character counts
  // when a sure one is sung within ten seconds of it.
  const strongStarts = lines.filter((_, i) => strong[i]).map((l) => l.startMs).sort((a, b) => a - b);
  const nearStrong = (ms: number): boolean => {
    let lo = 0;
    let hi = strongStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strongStarts[mid]! < ms - TRADITIONAL_NEIGHBOUR_MS) lo = mid + 1;
      else hi = mid;
    }
    return lo < strongStarts.length && strongStarts[lo]! <= ms + TRADITIONAL_NEIGHBOUR_MS;
  };
  for (const [i, l] of lines.entries()) {
    const c = counts[i]!;
    if (strong[i]) {
      out.add(l.id);
      continue;
    }
    if (c.traditional === 1 && c.simplified === 0 && c.han <= WEAK_TRADITIONAL_MAX_HAN && nearStrong(l.startMs)) out.add(l.id);
  }
  return out;
}

// ---- repeats the loop pass kept ----------------------------------------------

/**
 * The lines of the ranges the loop pass KEPT that repeat (distinct share under
 * a half): a chorus that came back unchanged in a fresh decode. A range kept
 * because the fresh decode heard nothing has varied lines and is not one. Pure.
 */
export function keptRepeatLines(lines: readonly TranscriptSegment[], ranges: readonly RepairedRange[]): Set<string> {
  const out = new Set<string>();
  for (const r of ranges) {
    if (r.status !== 'kept') continue;
    const inside = lines.filter((l) => l.startMs < r.toMs && l.endMs > r.fromMs);
    if (inside.length < 2) continue;
    const distinct = new Set(inside.map((l) => normalizeLine(l.sourceText ?? ''))).size;
    if (distinct / inside.length >= 0.5) continue;
    for (const l of inside) out.add(l.id);
  }
  return out;
}

// ---- slow, sustained singing --------------------------------------------------

/** Units per second at most, by how the language is counted (characters for zh/ja, else words). */
const SLOW_RATE: Record<'chars' | 'words', number> = { chars: 2.5, words: 1.3 };
/** Without word timings only a much slower line counts. */
const VERY_SLOW_RATE: Record<'chars' | 'words', number> = { chars: 1.6, words: 0.9 };
/** Median time per syllable of a sung line (speech: ~0.15-0.25 s). */
const SUSTAINED_UNIT_MS = 350;
const MIN_SUNG_LINE_MS = 1500;
/** Sung lines this close are one passage; a passage needs this many lines. */
const SUNG_RUN_GAP_MS = 10_000;
const MIN_SUNG_RUN = 3;
/** A sung line this close to a line suggested for another reason joins it. */
const SUNG_NEAR_OTHER_MS = 15_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Whether a line is said slowly enough, with long enough syllables, to be sung. Pure. */
export function soundsSung(line: TranscriptSegment, language: string): boolean {
  const ms = line.endMs - line.startMs;
  if (ms < MIN_SUNG_LINE_MS) return false;
  const lang = language.split('-')[0]!.toLowerCase();
  const kind: 'chars' | 'words' = lang === 'zh' || lang === 'ja' ? 'chars' : 'words';
  const units = countSpeechUnits(line.sourceText ?? '', lang || 'en');
  if (units === 0) return false;
  const rate = units / (ms / 1000);
  const words = (line.words ?? []).filter((w) => w.endMs > w.startMs && w.word.trim());
  if (words.length >= 2) {
    if (rate > SLOW_RATE[kind]) return false;
    const perUnit = words.map((w) => (w.endMs - w.startMs) / Math.max(1, countSpeechUnits(w.word, lang || 'en')));
    return median(perUnit) >= SUSTAINED_UNIT_MS;
  }
  return rate <= VERY_SLOW_RATE[kind] && ms >= 3000;
}

/**
 * The sung-sounding lines in passages: runs of at least three within ten
 * seconds of each other, or next to a line suggested for another reason. Pure.
 */
export function sungLines(lines: readonly TranscriptSegment[], language: string, others: ReadonlySet<string>): Set<string> {
  const sung = lines.filter((l) => soundsSung(l, language));
  const out = new Set<string>();
  let run: TranscriptSegment[] = [];
  const flush = (): void => {
    if (run.length >= MIN_SUNG_RUN) for (const l of run) out.add(l.id);
    run = [];
  };
  for (const l of sung) {
    const last = run[run.length - 1];
    if (last && l.startMs - last.endMs > SUNG_RUN_GAP_MS) flush();
    run.push(l);
  }
  flush();
  const otherLines = lines.filter((l) => others.has(l.id));
  for (const l of sung) {
    if (out.has(l.id)) continue;
    if (otherLines.some((o) => Math.abs(o.startMs - l.startMs) <= SUNG_NEAR_OTHER_MS)) out.add(l.id);
  }
  return out;
}

// ---- together -------------------------------------------------------------------

/**
 * Every line that looks sung, with why, in timeline order. Lines already kept
 * as a song are not suggested again. Pure.
 */
export function suggestSongLines(
  lines: readonly TranscriptSegment[],
  opts: { language: string; loopRanges?: readonly RepairedRange[] },
): SongSuggestion[] {
  const lang = opts.language.split('-')[0]!.toLowerCase();
  const reasons = new Map<string, SongReason[]>();
  const add = (ids: Iterable<string>, reason: SongReason): void => {
    for (const id of ids) reasons.set(id, [...(reasons.get(id) ?? []), reason]);
  };
  // Characters only say something about a Chinese transcript.
  if (lang === 'zh' || lang === '') add(traditionalLines(lines), 'traditional');
  add(keptRepeatLines(lines, opts.loopRanges ?? []), 'repeats');
  add(sungLines(lines, lang, new Set(reasons.keys())), 'sung');
  return lines
    .filter((l) => reasons.has(l.id) && !isSong(l))
    .map((l) => ({ lineId: l.id, startMs: l.startMs, endMs: l.endMs, text: (l.sourceText ?? '').trim().slice(0, 200), reasons: reasons.get(l.id)! }));
}

/** The suggestions as passages ("12:03–12:58"), for a warning: lines 30 s apart or less join. Pure. */
export function suggestionRanges(suggestions: readonly SongSuggestion[]): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  for (const s of [...suggestions].sort((a, b) => a.startMs - b.startMs)) {
    const last = out[out.length - 1];
    if (last && s.startMs - last.endMs <= 30_000) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out;
}

/** The project warning for a run's suggestions. Pure. */
export function songsWarning(suggestions: readonly SongSuggestion[]): Omit<ProjectWarning, 'at' | 'step'> {
  const ranges = suggestionRanges(suggestions);
  const shown = ranges.slice(0, 3).map((r) => `${formatClock(r.startMs)}–${formatClock(r.endMs)}`);
  const where = `${shown.join(', ')}${ranges.length > 3 ? `, +${ranges.length - 3}` : ''}`;
  return {
    code: 'songs-suggested',
    key: 'warning.songs-suggested',
    params: { count: suggestions.length, ranges: where },
    message:
      `${suggestions.length} line(s) look like a song (${where}). Nothing was changed: review them in the editor ` +
      '(Project → Songs) or with get_transcript filter="songs", and keep the original song with mark_song.',
  };
}

/** The suggestions on disk (none when absent or unreadable). */
export async function readSongSuggestions(file: string): Promise<SongSuggestionsFile | undefined> {
  try {
    const doc = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<SongSuggestionsFile>;
    return Array.isArray(doc.suggestions) ? { checkedAt: String(doc.checkedAt ?? ''), suggestions: doc.suggestions } : undefined;
  } catch {
    return undefined;
  }
}

async function readLoopRanges(file: string): Promise<RepairedRange[]> {
  try {
    const doc = JSON.parse(await fsp.readFile(file, 'utf8')) as { ranges?: RepairedRange[] };
    return Array.isArray(doc.ranges) ? doc.ranges : [];
  } catch {
    return [];
  }
}

/**
 * The end of the speech-to-text step: find the lines that look sung, keep
 * them as suggestions (or remove the old file when there are none: a new
 * transcript has new lines) and raise the warning. Never fails the step and
 * never changes a line.
 */
export async function recordSongSuggestions(
  paths: { subtitlesDir: string; loopRangesJson: string },
  lines: readonly TranscriptSegment[],
  deps: {
    language: string;
    warn?: (warning: Omit<ProjectWarning, 'at' | 'step'>) => void;
    log?: (message: string) => void;
  },
): Promise<SongSuggestion[]> {
  const file = songSuggestionsPath(paths);
  try {
    const suggestions = suggestSongLines(lines, { language: deps.language, loopRanges: await readLoopRanges(paths.loopRangesJson) });
    if (suggestions.length === 0) {
      await fsp.rm(file, { force: true });
      return [];
    }
    await writeJsonAtomic(file, { checkedAt: new Date().toISOString(), suggestions } satisfies SongSuggestionsFile);
    const warning = songsWarning(suggestions);
    deps.log?.(warning.message);
    deps.warn?.(warning);
    return suggestions;
  } catch (err) {
    deps.log?.(`Song suggestions skipped (${err instanceof Error ? err.message : String(err)}).`);
    return [];
  }
}

/**
 * The line a suggestion is about now: the one with its id at about the same
 * time, else the one covering at least half of its time (lines are renumbered
 * by edits that restructure a range). Pure.
 */
function lineOf(s: SongSuggestion, lines: readonly TranscriptSegment[], byId: ReadonlyMap<string, TranscriptSegment>): TranscriptSegment | undefined {
  const same = byId.get(s.lineId);
  if (same && Math.abs(same.startMs - s.startMs) <= 1000) return same;
  const half = Math.max(1, s.endMs - s.startMs) / 2;
  return lines.find((l) => Math.min(l.endMs, s.endMs) - Math.max(l.startMs, s.startMs) >= half);
}

/** The suggestions still open against the lines as they are now (lines kept as a song drop out). Pure. */
export function openSuggestions(file: SongSuggestionsFile | undefined, lines: readonly TranscriptSegment[]): SongSuggestion[] {
  if (!file) return [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: SongSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of file.suggestions) {
    const line = lineOf(s, lines, byId);
    if (!line || isSong(line) || seen.has(line.id)) continue;
    seen.add(line.id);
    out.push({ ...s, lineId: line.id, startMs: line.startMs, endMs: line.endMs });
  }
  return out;
}

/**
 * Settle the suggestions of `lineIds` (kept as a song, or said not to be
 * one): they leave the file, as do those whose line is gone or a song now.
 */
export async function settleSuggestions(file: string, lineIds: readonly string[], lines: readonly TranscriptSegment[]): Promise<void> {
  const doc = await readSongSuggestions(file);
  if (!doc || lineIds.length === 0) return;
  const settled = new Set(lineIds);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const remaining = doc.suggestions.filter((s) => {
    const line = lineOf(s, lines, byId);
    return line !== undefined && !isSong(line) && !settled.has(line.id);
  });
  if (remaining.length === doc.suggestions.length) return;
  if (remaining.length === 0) await fsp.rm(file, { force: true });
  else await writeJsonAtomic(file, { ...doc, suggestions: remaining });
}

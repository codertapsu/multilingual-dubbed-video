/**
 * Lines kept as the original song (`TranscriptSegment.song`).
 *
 * WHY PER LINE: in the 27.8-hour series a sung OST ballad was transcribed and
 * would have been dubbed as speech (claude-dubber report F7, 2026-11-23). The
 * only way to keep the original for a line was to delete it, and in the
 * funeral scene the calls and dialogue sat between the lyrics: 37 lyric lines
 * removed, ~20 spoken lines kept, all within the same 9 minutes. So the flag
 * is a line's, never a range's: a song line gets no voice, no clip is placed
 * for it, the original plays in its window (pipeline audio-mix, media-worker
 * mix.ts), and its subtitle shows only with `songSubtitles`
 * (workspace/subtitleTiming.ts displayCuesFor).
 *
 * Everything here is pure: the orchestrator (markSongs) and the pipeline
 * (TTS, alignment, mix) read and write the files.
 */
import { AppErrorException, type AlignedSegment, type TranscriptSegment } from '@videodubber/shared';

import type { SynthesisGroup } from '../pipeline/grouping.js';
import { hasSpeakableText } from '../pipeline/speakable.js';

/** A time window, ms. */
export interface SongWindow {
  startMs: number;
  endMs: number;
}

/** What to mark: lines by id, the lines of a time range, or of several windows. */
export interface SongMarkRequest {
  lineIds?: readonly string[];
  fromMs?: number;
  toMs?: number;
  /** Windows (a series parent's song lines, moved into one part's time). */
  windows?: readonly SongWindow[];
  /** true: keep the original song; false: dub the lines again. */
  song: boolean;
}

/** What marking did. */
export interface SongMarkResult {
  song: boolean;
  /** The lines the request named (their flag may already have been so). */
  targets: { id: string; startMs: number; endMs: number }[];
  /** The lines whose flag changed. */
  changed: { id: string; startMs: number; endMs: number }[];
  /** Lines whose voice clip must be made again (they shared a clip with a song line, or sing no more). */
  revoice: string[];
  /** Song lines in the project now. */
  songs: number;
}

/** True for a line kept as the original song. */
export const isSong = (line: { song?: boolean }): boolean => line.song === true;

/** A line counts as inside a window when at least half of it is. Pure. */
export function lineInWindow(line: { startMs: number; endMs: number }, w: SongWindow): boolean {
  const length = Math.max(1, line.endMs - line.startMs);
  const overlap = Math.min(line.endMs, w.endMs) - Math.max(line.startMs, w.startMs);
  return overlap >= length / 2;
}

/**
 * The lines a request names, in timeline order. Unknown ids and empty ranges
 * are refused (INVALID_EDIT), so a typo never marks nothing in silence. Pure.
 */
export function songTargets(lines: readonly TranscriptSegment[], request: SongMarkRequest): TranscriptSegment[] {
  if (request.lineIds?.length) {
    const byId = new Map(lines.map((l) => [l.id, l]));
    const unknown = request.lineIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) throw new AppErrorException('INVALID_EDIT', `Unknown line(s): ${unknown.slice(0, 5).join(', ')}.`);
    const wanted = new Set(request.lineIds);
    return lines.filter((l) => wanted.has(l.id));
  }
  const windows: SongWindow[] = [];
  if (request.fromMs !== undefined || request.toMs !== undefined) {
    const from = Number(request.fromMs);
    const to = Number(request.toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
      throw new AppErrorException('INVALID_EDIT', 'A range needs fromMs and toMs, and must end after it starts.');
    }
    windows.push({ startMs: from, endMs: to });
  }
  for (const w of request.windows ?? []) if (w.endMs > w.startMs) windows.push(w);
  if (windows.length === 0 && !request.windows) {
    throw new AppErrorException('INVALID_EDIT', 'Name the lines (lineIds) or a time range (fromMs, toMs).');
  }
  return lines.filter((l) => windows.some((w) => lineInWindow(l, w)));
}

/**
 * The lines with the song flag set (or cleared) on `ids`. A song line has no
 * voice to be out of date; a line that sings no more needs one (`voiced`: the
 * project has voices already). Pure.
 */
export function setSongFlags(
  lines: readonly TranscriptSegment[],
  ids: ReadonlySet<string>,
  song: boolean,
  voiced: boolean,
): { lines: TranscriptSegment[]; changed: string[] } {
  const changed: string[] = [];
  const out = lines.map((l) => {
    if (!ids.has(l.id) || isSong(l) === song) return l;
    changed.push(l.id);
    if (song) {
      const { ttsStale: _stale, ...rest } = l;
      return { ...rest, song: true };
    }
    const { song: _song, ...rest } = l;
    return voiced ? { ...rest, ttsStale: true as const } : rest;
  });
  return { lines: out, changed };
}

/** The text a unit says: its speakable members' texts, joined (like the TTS step's plan). */
function unitText(members: readonly TranscriptSegment[]): string {
  return members
    .map((m) => (m.translatedText ?? m.sourceText ?? '').trim())
    .filter((t) => hasSpeakableText(t))
    .join(' ');
}

/**
 * The synthesis units with no song line in any of them, and every other line
 * in one: a unit of song lines only goes; a unit that mixes song and spoken
 * lines is cut into runs of its spoken lines, each re-voiced (its clip said
 * the song line too); a spoken line in no unit (it sang before) gets its own,
 * re-voiced. `touched` names every line of a unit that changed (their
 * voice-synced subtitle timing no longer applies). Pure.
 */
export function songUnits(
  groups: readonly SynthesisGroup[],
  lines: readonly TranscriptSegment[],
): { groups: SynthesisGroup[]; revoice: string[]; touched: string[]; changed: boolean } {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: SynthesisGroup[] = [];
  const revoice: string[] = [];
  const touched: string[] = [];
  const covered = new Set<string>();
  for (const g of groups) {
    const members = g.segmentIds.map((id) => byId.get(id)).filter((l): l is TranscriptSegment => l !== undefined);
    for (const m of members) covered.add(m.id);
    if (!members.some(isSong)) {
      out.push(g);
      continue;
    }
    touched.push(...members.map((m) => m.id));
    // Runs of the spoken lines, in the unit's order: a song line breaks a run.
    const runs: TranscriptSegment[][] = [];
    let run: TranscriptSegment[] = [];
    for (const m of members) {
      if (isSong(m)) {
        if (run.length > 0) runs.push(run);
        run = [];
      } else {
        run.push(m);
      }
    }
    if (run.length > 0) runs.push(run);
    for (const r of runs) {
      out.push({
        id: r[0]!.id,
        segmentIds: r.map((m) => m.id),
        text: unitText(r),
        startMs: r[0]!.startMs,
        endMs: r[r.length - 1]!.endMs,
        ...(g.speakerId ? { speakerId: g.speakerId } : {}),
        ...(g.voiceId ? { voiceId: g.voiceId } : {}),
        ...(g.speakingRate !== undefined ? { speakingRate: g.speakingRate } : {}),
      });
      revoice.push(...r.map((m) => m.id));
    }
  }
  for (const l of lines) {
    if (covered.has(l.id) || isSong(l)) continue;
    out.push({
      id: l.id,
      segmentIds: [l.id],
      text: unitText([l]),
      startMs: l.startMs,
      endMs: l.endMs,
      ...(l.speakerId ? { speakerId: l.speakerId } : {}),
      ...(l.voiceId ? { voiceId: l.voiceId } : {}),
      ...(l.speakingRate !== undefined ? { speakingRate: l.speakingRate } : {}),
    });
    revoice.push(l.id);
    touched.push(l.id);
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return { groups: out, revoice, touched, changed: touched.length > 0 };
}

/** Song lines closer than this, with no spoken line between them, keep the original as one window. */
const SONG_JOIN_GAP_MS = 8000;

/**
 * Where the original plays as it is: the song lines' windows, sorted, joined
 * when only a short pause (and no spoken line) separates them. Pure.
 */
export function songWindows(lines: readonly TranscriptSegment[]): SongWindow[] {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: SongWindow[] = [];
  let open: SongWindow | undefined;
  for (const l of sorted) {
    if (!isSong(l)) {
      // A spoken line closes the window (its dub plays there, not the song).
      if (open && l.startMs < open.endMs + SONG_JOIN_GAP_MS) open = undefined;
      continue;
    }
    if (open && l.startMs <= open.endMs + SONG_JOIN_GAP_MS) {
      open.endMs = Math.max(open.endMs, l.endMs);
      continue;
    }
    open = { startMs: l.startMs, endMs: l.endMs };
    out.push(open);
  }
  return out;
}

/**
 * What the mix plays: the placed clips minus the units of song lines only
 * (a unit planned before its lines were marked), minus units whose clip is
 * not made yet and whose lines all wait for a new voice (a unit split around
 * a song line: they are silent until re-voiced, instead of failing the mix);
 * and the windows where the original stays. `exists` checks a clip file. Pure
 * apart from `exists`.
 */
export async function songMixPlan(
  aligned: readonly AlignedSegment[],
  groups: readonly SynthesisGroup[] | undefined,
  lines: readonly TranscriptSegment[],
  exists: (file: string) => Promise<boolean>,
): Promise<{ aligned: AlignedSegment[]; keepOriginal: SongWindow[]; dropped: string[]; waiting: string[] }> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const membersOf = new Map((groups ?? []).map((g) => [g.id, g.segmentIds]));
  const out: AlignedSegment[] = [];
  const dropped: string[] = [];
  const waiting: string[] = [];
  for (const a of aligned) {
    const members = (membersOf.get(a.segmentId) ?? [a.segmentId]).map((id) => byId.get(id)).filter((l): l is TranscriptSegment => l !== undefined);
    if (members.length > 0 && members.every(isSong)) {
      dropped.push(a.segmentId);
      continue;
    }
    if (members.length > 0 && members.every((m) => m.ttsStale === true) && a.audioPath && !(await exists(a.audioPath))) {
      waiting.push(a.segmentId);
      continue;
    }
    out.push(a);
  }
  return { aligned: out, keepOriginal: songWindows(lines), dropped, waiting };
}

/** Windows moved into a series part's own time, cut to it (`range`: the part's window of the parent). Pure. */
export function windowsInPart(windows: readonly SongWindow[], range: SongWindow): SongWindow[] {
  const length = range.endMs - range.startMs;
  return windows
    .map((w) => ({ startMs: Math.max(0, w.startMs - range.startMs), endMs: Math.min(length, w.endMs - range.startMs) }))
    .filter((w) => w.endMs > w.startMs);
}

/**
 * Undo one entry of a project's edit history (activity/history.ts): put the
 * lines back as they were before it, if they are still as it left them.
 *
 * An entry is undone through the same writes the editor and the agents use
 * (patchSegments for line fields, replaceSourceLines for a range), never by
 * writing the files directly: those keep the invariants (the timeline rules,
 * the re-fit after a timing change, source.json mirroring the speakers and
 * timing, clips marked out of date), and record the undo in the history as
 * an entry of its own, so an undo can be undone too.
 *
 * "Still as it left them" is checked on what an edit can change (text,
 * translation, timing, speaker, voice, pace, lock), not on what the app
 * derives (a clip regenerated since only clears its out-of-date mark). It is
 * checked again inside the write's lock (the precondition), so an edit that
 * lands between the check and the write is never overwritten. When a line
 * changed since, nothing is written and the answer says which line and how
 * (`changes`), so the user can decide.
 *
 * WHY: transcript edits overwrote the JSON with no history; undo existed only
 * in the open editor, for its own edits. In the 27.8-hour production an
 * agent replaced lines and applied 33 re-transcriptions, some of which wrote
 * credits and loops over good lines (claude-dubber report, 2026-11-23, F2).
 */
import fsp from 'node:fs/promises';

import {
  AppErrorException,
  type EditHistoryEntry,
  type SegmentPatch,
  type TranscriptSegment,
  type UndoEditResult,
} from '@videodubber/shared';

import { formatClock, getEdit, listEditSummaries, markEditUndone, summarizeEdit } from './history.js';

/** A field undo compares and restores. */
export type UndoField = 'sourceText' | 'translatedText' | 'timing' | 'speakerId' | 'voiceId' | 'speakingRate' | 'locked' | 'song';

/** What stops an undo, per line or for the whole entry (the UI words each kind). */
export interface UndoChange {
  /** The line, as it is now (or as the entry left it, when it is gone). */
  id?: string;
  atMs?: number;
  /**
   * `missing`: a line the change made is gone. `count`: the range holds
   * another number of lines now. `translated`: a range change, and the
   * project was translated since (its lines can no longer be restructured).
   * `structure`: the change added or removed lines by id. `already-undone`.
   * Else the field that differs.
   */
  what: UndoField | 'missing' | 'count' | 'translated' | 'structure' | 'already-undone';
  /** The value now, and the one the change left (texts shortened). */
  now?: string;
  expected?: string;
}

export type UndoPlan =
  /**
   * `songs`: lines whose song flag goes back (mark_song's changes). They are
   * written through markSongs, never as a patch: marking re-plans the voice
   * clips of those lines (a song line has none), which a patch cannot.
   */
  | { kind: 'patches'; patches: SegmentPatch[]; songs?: { song: boolean; lineIds: string[] }[] }
  | { kind: 'range'; fromMs: number; toMs: number; lines: { startMs: number; endMs: number; text: string; speakerId?: string }[] }
  /** The lines already read as before the change: nothing to write. */
  | { kind: 'nothing' }
  | { kind: 'refused'; reason: string; changes: UndoChange[] };

/** What a source edit can change, and a translation edit. */
const SOURCE_FIELDS: readonly UndoField[] = ['sourceText', 'timing', 'speakerId', 'song'];
const TRANSLATION_FIELDS: readonly UndoField[] = ['sourceText', 'translatedText', 'timing', 'speakerId', 'voiceId', 'speakingRate', 'locked', 'song'];

function valueOf(line: TranscriptSegment, field: UndoField): string {
  switch (field) {
    case 'timing':
      return `${line.startMs}-${line.endMs}`;
    case 'locked':
      return line.locked === true ? 'locked' : 'unlocked';
    case 'song':
      return line.song === true ? 'kept as the original song' : 'dubbed';
    case 'speakingRate':
      return line.speakingRate === undefined ? '' : String(line.speakingRate);
    case 'translatedText':
      return line.translatedText ?? '';
    case 'sourceText':
      return line.sourceText ?? '';
    default:
      return line[field] ?? '';
  }
}

/** How a value reads in a refusal: a clock for timing, a shortened text. */
function shown(line: TranscriptSegment, field: UndoField): string {
  if (field === 'timing') return `${formatClock(line.startMs)}–${formatClock(line.endMs)}`;
  const v = valueOf(line, field);
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}

const firstDifference = (a: TranscriptSegment, b: TranscriptSegment, fields: readonly UndoField[]): UndoField | undefined =>
  fields.find((f) => valueOf(a, f) !== valueOf(b, f));

const lineChange = (now: TranscriptSegment, expected: TranscriptSegment, field: UndoField): UndoChange => ({
  id: now.id,
  atMs: now.startMs,
  what: field,
  now: shown(now, field),
  expected: shown(expected, field),
});

/** One sentence for the refusal (MCP and logs; the UI words `changes` itself). */
function describe(changes: readonly UndoChange[]): string {
  const words: Record<UndoChange['what'], string> = {
    sourceText: 'its transcript text',
    translatedText: 'its translation',
    timing: 'its timing',
    speakerId: 'its speaker',
    voiceId: 'its voice',
    speakingRate: 'its pace',
    locked: 'its lock',
    song: 'whether it is kept as the song',
    missing: '',
    count: '',
    translated: '',
    structure: '',
    'already-undone': '',
  };
  const first = changes[0];
  if (!first) return 'It cannot be undone.';
  const where = first.id ? `line ${first.id}${first.atMs !== undefined ? ` (${formatClock(first.atMs)})` : ''}` : 'a line';
  const more = changes.length > 1 ? ` (and ${changes.length - 1} more)` : '';
  switch (first.what) {
    case 'missing':
      return `The lines it made are gone: ${where} is no longer there${more}.`;
    case 'count':
      return `That part of the transcript changed since: it now holds ${first.now} line(s) where this change left ${first.expected}.`;
    case 'translated':
      return 'The project was translated since, so its lines can no longer be restructured.';
    case 'structure':
      return 'This change added or removed lines; undo it by replacing the lines of its range.';
    case 'already-undone':
      return 'It was already undone.';
    default:
      return `It changed since: ${words[first.what]} of ${where} is now "${first.now}" (this change left "${first.expected}")${more}.`;
  }
}

const refused = (changes: UndoChange[]): UndoPlan => ({ kind: 'refused', reason: describe(changes), changes });

/**
 * What undoing `entry` takes, given the project's lines now: the patches or
 * the range to write, or why not. Pure.
 *
 * @param lines for a range entry the transcript (source.json); otherwise the
 *   lines the editor edits (translated.json, else source.json).
 * @param translated whether the project has a translation now.
 */
export function planUndo(entry: EditHistoryEntry, lines: readonly TranscriptSegment[], translated: boolean): UndoPlan {
  if (entry.undoneAt) return refused([{ what: 'already-undone' }]);
  return entry.range ? planRange(entry, entry.range, lines, translated) : planLines(entry, lines);
}

/** A range entry: the range must hold exactly the lines the change left; they become the lines it replaced. */
function planRange(
  entry: EditHistoryEntry,
  range: { fromMs: number; toMs: number },
  lines: readonly TranscriptSegment[],
  translated: boolean,
): UndoPlan {
  if (translated) return refused([{ what: 'translated' }]);
  // A line that crossed the range's edge was replaced too: widen the range to
  // every line the change removed or made, so they all fit back inside it.
  const all = [...entry.before, ...entry.after];
  const fromMs = Math.min(range.fromMs, ...all.map((l) => l.startMs));
  const toMs = Math.max(range.toMs, ...all.map((l) => l.endMs));
  const byStart = (a: TranscriptSegment, b: TranscriptSegment): number => a.startMs - b.startMs;
  const inside = lines.filter((s) => s.startMs < toMs && s.endMs > fromMs).sort(byStart);
  const left = [...entry.after].sort(byStart);
  if (inside.length !== left.length) {
    return refused([{ what: 'count', now: String(inside.length), expected: String(left.length), atMs: fromMs }]);
  }
  const changes: UndoChange[] = [];
  inside.forEach((now, i) => {
    const field = firstDifference(now, left[i]!, SOURCE_FIELDS);
    if (field) changes.push(lineChange(now, left[i]!, field));
  });
  if (changes.length > 0) return refused(changes);
  return {
    kind: 'range',
    fromMs,
    toMs,
    lines: [...entry.before].sort(byStart).map((l) => ({
      startMs: l.startMs,
      endMs: l.endMs,
      text: l.sourceText,
      ...(l.speakerId ? { speakerId: l.speakerId } : {}),
    })),
  };
}

/** An id entry: each line it changed must still read as it left it; each gets its old fields back. */
function planLines(entry: EditHistoryEntry, lines: readonly TranscriptSegment[]): UndoPlan {
  const fields = entry.target === 'source' ? SOURCE_FIELDS : TRANSLATION_FIELDS;
  const beforeById = new Map(entry.before.map((l) => [l.id, l]));
  const afterIds = new Set(entry.after.map((l) => l.id));
  if (entry.after.some((l) => !beforeById.has(l.id)) || entry.before.some((l) => !afterIds.has(l.id))) {
    return refused([{ what: 'structure' }]);
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const changes: UndoChange[] = [];
  const patches: SegmentPatch[] = [];
  const songs = new Map<boolean, string[]>();
  for (const left of entry.after) {
    let now = byId.get(left.id);
    if (!now || firstDifference(now, left, fields)) {
      // Renumbered since (lines replaced earlier in the video): the same line
      // by its content, when exactly one line reads so.
      const same = lines.filter((l) => !firstDifference(l, left, fields));
      if (same.length === 1) now = same[0];
    }
    if (!now) {
      changes.push({ id: left.id, atMs: left.startMs, what: 'missing' });
      continue;
    }
    const field = firstDifference(now, left, fields);
    if (field) {
      changes.push(lineChange(now, left, field));
      continue;
    }
    const before = beforeById.get(left.id)!;
    const patch = patchBack(now.id, before, left);
    if (patch === 'source-text') return refused([{ id: now.id, atMs: now.startMs, what: 'sourceText', now: shown(now, 'sourceText'), expected: shown(before, 'sourceText') }]);
    if (patch) patches.push(patch);
    if ((before.song === true) !== (left.song === true)) {
      const back = before.song === true;
      songs.set(back, [...(songs.get(back) ?? []), now.id]);
    }
  }
  if (changes.length > 0) return refused(changes);
  const songBack = [...songs].map(([song, lineIds]) => ({ song, lineIds }));
  if (patches.length === 0 && songBack.length === 0) return { kind: 'nothing' };
  return { kind: 'patches', patches, ...(songBack.length > 0 ? { songs: songBack } : {}) };
}

/**
 * The patch that gives line `id` back what `before` had where `after`
 * differs; undefined when nothing an edit can set differs. A changed
 * transcript text has no patch (only a range replacement writes it).
 */
function patchBack(id: string, before: TranscriptSegment, after: TranscriptSegment): SegmentPatch | 'source-text' | undefined {
  if ((before.sourceText ?? '') !== (after.sourceText ?? '')) return 'source-text';
  const patch: SegmentPatch = { id };
  if (before.startMs !== after.startMs || before.endMs !== after.endMs) {
    patch.startMs = before.startMs;
    patch.endMs = before.endMs;
  }
  if ((before.translatedText ?? '') !== (after.translatedText ?? '')) patch.translatedText = before.translatedText ?? '';
  if ((before.speakerId ?? '') !== (after.speakerId ?? '')) patch.speakerId = before.speakerId ?? null;
  if ((before.voiceId ?? '') !== (after.voiceId ?? '')) patch.voiceId = before.voiceId ?? null;
  if (before.speakingRate !== after.speakingRate) patch.speakingRate = before.speakingRate ?? null;
  if ((before.locked === true) !== (after.locked === true)) patch.locked = before.locked === true;
  return Object.keys(patch).length > 1 ? patch : undefined;
}

/** A refused undo, as the routes answer it: the reason, and each change that stops it. */
export class UndoRefusedError extends AppErrorException {
  constructor(
    reason: string,
    readonly changes: readonly UndoChange[],
  ) {
    super('INVALID_EDIT', `This change cannot be undone. ${reason}`, {
      remediation: 'Undo the later changes first (newest first), or correct the lines by hand.',
    });
    // AppErrorException sets its own prototype back (for transpiled targets),
    // which would make this one no longer an UndoRefusedError.
    Object.setPrototypeOf(this, UndoRefusedError.prototype);
  }
}

/** The writes an undo goes through (the orchestrator's own; tests inject fakes). */
export interface UndoDeps {
  /** A project's transcript and its translated lines (absent until translated). */
  paths(projectId: string): { sourceJson: string; translatedJson: string };
  replaceSourceLines(
    projectId: string,
    fromMs: number,
    toMs: number,
    lines: { startMs: number; endMs: number; text: string; speakerId?: string }[],
    opts: { summary: string; summaryKey?: string; summaryParams?: Record<string, string | number>; undoOf: string; precondition: (current: readonly TranscriptSegment[]) => void },
  ): Promise<unknown>;
  patchSegments(
    projectId: string,
    patches: SegmentPatch[],
    opts: { summary: string; summaryKey?: string; summaryParams?: Record<string, string | number>; undoOf: string; precondition: (base: readonly TranscriptSegment[]) => void },
  ): Promise<unknown>;
  /** Mark or unmark lines as the original song (Orchestrator.markSongs), recorded as this undo. */
  markSongs?(projectId: string, request: { lineIds: string[]; song: boolean }, opts: { summary: string; summaryKey?: string; summaryParams?: Record<string, string | number>; undoOf: string }): Promise<unknown>;
}

async function readSegments(file: string): Promise<TranscriptSegment[] | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
    return Array.isArray(parsed) ? parsed : (parsed.segments ?? []);
  } catch {
    return undefined;
  }
}

/** The summary an undo is recorded with. */
export function undoSummary(entry: Pick<EditHistoryEntry, 'summary'>): string {
  return `Undid: ${entry.summary}`;
}

/**
 * Undo `entryId` of `projectId`: check, write through the orchestrator, mark
 * the entry undone. Throws NOT-FOUND-like INVALID_EDIT when there is no such
 * entry, {@link UndoRefusedError} when a line changed since, and whatever the
 * write throws (RUN_IN_PROGRESS while a dub runs).
 */
export async function undoEdit(deps: UndoDeps, projectId: string, entryId: string): Promise<UndoEditResult> {
  const entry = await getEdit(projectId, entryId);
  if (!entry) {
    throw new AppErrorException('INVALID_EDIT', `This project has no history entry "${entryId}".`, {
      remediation: 'List the history again (it keeps the last 200 changes).',
    });
  }
  const paths = deps.paths(projectId);
  const translatedLines = await readSegments(paths.translatedJson);
  const translated = translatedLines !== undefined && translatedLines.length > 0;
  const lines = entry.range ? ((await readSegments(paths.sourceJson)) ?? []) : (translatedLines ?? (await readSegments(paths.sourceJson)) ?? []);
  const plan = planUndo(entry, lines, translated);
  if (plan.kind === 'refused') throw new UndoRefusedError(plan.reason, plan.changes);

  // Checked again inside the write's lock, against the lines it is about to change.
  const precondition = (current: readonly TranscriptSegment[]): void => {
    const again = planUndo(entry, current, entry.range ? false : translated);
    if (again.kind === 'refused') throw new UndoRefusedError(again.reason, again.changes);
  };
  const opts = {
    summary: undoSummary(entry),
    summaryKey: 'history.summary.undo',
    // An undo of an undo keeps the change it is about and counts the undos
    // (`depth`): the History tab words it "Undid: Undid: …" without nesting keys.
    summaryParams:
      entry.summaryKey === 'history.summary.undo'
        ? { ...(entry.summaryParams ?? {}), depth: Number(entry.summaryParams?.['depth'] ?? 1) + 1 }
        : { ...(entry.summaryParams ?? {}), of: entry.summaryKey ?? '', text: entry.summary },
    undoOf: entry.id,
    precondition,
  };
  if (plan.kind === 'range') await deps.replaceSourceLines(projectId, plan.fromMs, plan.toMs, plan.lines, opts);
  else if (plan.kind === 'patches') {
    if (plan.patches.length > 0) await deps.patchSegments(projectId, plan.patches, opts);
    if (plan.songs?.length) {
      // An entry of mark_song's: without this it was marked undone while every
      // line stayed a song (the flag is no field a patch carries).
      if (!deps.markSongs) throw new AppErrorException('INVALID_EDIT', 'This change marked lines as songs and cannot be undone here.');
      for (const group of plan.songs) {
        await deps.markSongs(projectId, group, { summary: opts.summary, summaryKey: opts.summaryKey, summaryParams: opts.summaryParams, undoOf: opts.undoOf });
      }
    }
  }

  await markEditUndone(projectId, entry.id);
  const summaries = await listEditSummaries(projectId);
  const undone = summaries.find((s) => s.id === entry.id) ?? { ...summarizeEdit(entry), undoneAt: new Date().toISOString() };
  const own = plan.kind === 'nothing' ? undefined : summaries.find((s) => s.undoOf === entry.id && !s.undoneAt);
  return { undone, ...(own ? { entry: own } : {}) };
}

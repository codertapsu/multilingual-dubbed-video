import crypto from 'node:crypto';

import type { ActivityInitiator, EditHistoryEntry, TranscriptSegment } from '@videodubber/shared';

import { currentInitiator } from './context.js';

export interface RecordEdit {
  projectId: string;
  target: 'source' | 'translation';
  /** What changed, in a sentence ("Replaced 14 lines at 24:12:04 (loop fixed)"). */
  summary: string;
  /**
   * The whole list of lines before and after the write; only the changed ones
   * are kept (matched by id). With `range`, the range's lines as given.
   */
  before: readonly TranscriptSegment[];
  after: readonly TranscriptSegment[];
  /** A structural change of this range (ids renumbered after it): kept as given, undone by range. */
  range?: { fromMs: number; toMs: number };
  /** Defaults to the current request's initiator (context.ts). */
  initiator?: ActivityInitiator;
}

/** Where a project's history lives, and how it is read and written (persistence plugs in here). */
export interface EditHistoryStore {
  append(entry: EditHistoryEntry): Promise<void>;
  list(projectId: string): Promise<EditHistoryEntry[]>;
  markUndone(projectId: string, entryId: string, at: string): Promise<void>;
}

/** In memory, until a persistent store is configured (`configureEditHistory`). */
class MemoryStore implements EditHistoryStore {
  private readonly byProject = new Map<string, EditHistoryEntry[]>();
  async append(entry: EditHistoryEntry): Promise<void> {
    const list = this.byProject.get(entry.projectId) ?? [];
    list.push(entry);
    this.byProject.set(entry.projectId, list.slice(-MAX_ENTRIES_PER_PROJECT));
  }
  async list(projectId: string): Promise<EditHistoryEntry[]> {
    return [...(this.byProject.get(projectId) ?? [])].reverse();
  }
  async markUndone(projectId: string, entryId: string, at: string): Promise<void> {
    const e = this.byProject.get(projectId)?.find((x) => x.id === entryId);
    if (e) e.undoneAt = at;
  }
}

/** `m:ss` / `h:mm:ss`, for history summaries ("Replaced 14 lines at 24:12:04–24:27:04"). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Entries kept per project (the plan's D3: diffs, the last 200). */
export const MAX_ENTRIES_PER_PROJECT = 200;

let store: EditHistoryStore = new MemoryStore();

/** Plug in the persistent store (per project, on disk). */
export function configureEditHistory(next: EditHistoryStore): void {
  store = next;
}

const sameLine = (a: TranscriptSegment, b: TranscriptSegment): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The lines a write changed: those of `before` that are gone or different,
 * and those of `after` that are new or different, matched by id. Pure; the
 * one place that decides what an entry keeps.
 */
export function changedLines(
  before: readonly TranscriptSegment[],
  after: readonly TranscriptSegment[],
): { before: TranscriptSegment[]; after: TranscriptSegment[] } {
  const b = new Map(before.map((s) => [s.id, s]));
  const a = new Map(after.map((s) => [s.id, s]));
  return {
    before: before.filter((s) => !a.has(s.id) || !sameLine(s, a.get(s.id)!)),
    after: after.filter((s) => !b.has(s.id) || !sameLine(s, b.get(s.id)!)),
  };
}

/**
 * Record one change to a project's lines. Every server-side write of lines
 * calls this (replace_lines, retranscribe apply, set_translations,
 * adjust_lines, rebuild with force, the editor's saves), so the project's
 * history says who changed what and the change can be undone. Nothing is
 * recorded when nothing changed. Never throws: losing a history entry must
 * not fail the edit.
 */
export async function recordEdit(edit: RecordEdit): Promise<EditHistoryEntry | undefined> {
  const diff = edit.range ? { before: [...edit.before], after: [...edit.after] } : changedLines(edit.before, edit.after);
  if (diff.before.length === 0 && diff.after.length === 0) return undefined;
  const entry: EditHistoryEntry = {
    id: `edit_${crypto.randomBytes(8).toString('hex')}`,
    projectId: edit.projectId,
    at: new Date().toISOString(),
    initiator: edit.initiator ?? currentInitiator(),
    summary: edit.summary,
    target: edit.target,
    ...(edit.range ? { range: { fromMs: edit.range.fromMs, toMs: edit.range.toMs } } : {}),
    before: diff.before,
    after: diff.after,
  };
  try {
    await store.append(entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** A project's history, newest first. */
export async function listEdits(projectId: string): Promise<EditHistoryEntry[]> {
  try {
    return await store.list(projectId);
  } catch {
    return [];
  }
}

export async function markEditUndone(projectId: string, entryId: string): Promise<void> {
  await store.markUndone(projectId, entryId, new Date().toISOString());
}

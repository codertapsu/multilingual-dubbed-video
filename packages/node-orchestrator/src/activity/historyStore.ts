/**
 * A project's edit history on disk (activity/history.ts records it):
 *
 *   <project>/history/index.json         the list, newest last, without lines
 *   <project>/history/<entryId>.json     one entry with its lines
 *
 * WHY two kinds of file: an entry keeps only the lines a write changed, but a
 * re-transcribed window changes ~300 of them and a translation batch can
 * change more (claude-dubber report, 2026-11-23). Kept as one file, every
 * editor save (a drag, a speaker fix) would rewrite megabytes of old entries
 * inside the save's own lock. The index stays small, the list reads only it,
 * and an entry's lines are read when they are shown or undone.
 *
 * Bounded: the newest {@link MAX_ENTRIES_PER_PROJECT} entries (the plan's D3)
 * and at most {@link MAX_HISTORY_BYTES} of entry files; older ones are deleted
 * as new ones come. Every write is atomic (temp file + rename,
 * writeTextAtomic), and a missing or broken index is rebuilt from the entry
 * files. Writes are serialized per project, so two edits never lose one
 * another's index line. A project's folder moves with its history
 * (Settings → Projects folder): the paths are resolved at each call.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { EditHistoryEntry, EditHistorySummary } from '@videodubber/shared';

import { KeyedMutex } from '../keyedMutex.js';
import { writeTextAtomic } from '../workspace/projectStore.js';
import { MAX_ENTRIES_PER_PROJECT, summarizeEdit, type EditHistoryStore } from './history.js';

/** Entry files beyond this many bytes in all are dropped, oldest first (the newest is always kept). */
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

/** recordEdit's ids: also what keeps a request's id from naming a file outside the folder. */
const ENTRY_ID = /^edit_[0-9a-f]{16}$/;

/** One line of the index: the summary, and how big its entry file is. */
type IndexItem = EditHistorySummary & { bytes?: number };

interface IndexFile {
  version: 1;
  /** Oldest first. */
  entries: IndexItem[];
}

export interface FileEditHistoryOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export class FileEditHistoryStore implements EditHistoryStore {
  private readonly lock = new KeyedMutex();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  /** @param dirOf a project's history folder (`<project>/history`), resolved at every call. */
  constructor(
    private readonly dirOf: (projectId: string) => string,
    opts: FileEditHistoryOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES_PER_PROJECT;
    this.maxBytes = opts.maxBytes ?? MAX_HISTORY_BYTES;
  }

  async append(entry: EditHistoryEntry): Promise<void> {
    if (!ENTRY_ID.test(entry.id)) throw new Error(`Not a history entry id: ${entry.id}`);
    const dir = this.dirOf(entry.projectId);
    await this.lock.run(dir, async () => {
      // The index first: rebuilt from the entry files (the first entry of a
      // project), it must not hold the one written now as well.
      const index = (await this.readIndex(dir)).filter((s) => s.id !== entry.id);
      const body = JSON.stringify(entry);
      await writeTextAtomic(path.join(dir, `${entry.id}.json`), body);
      index.push({ ...summarizeEdit(entry), bytes: Buffer.byteLength(body) });
      const dropped = trimIndex(index, this.maxEntries, this.maxBytes);
      await this.writeIndex(dir, index);
      for (const old of dropped) await fsp.rm(path.join(dir, `${old.id}.json`), { force: true }).catch(() => undefined);
    });
  }

  async summaries(projectId: string): Promise<EditHistorySummary[]> {
    const index = await this.readIndex(this.dirOf(projectId));
    return index.map(({ bytes: _bytes, ...summary }) => summary).reverse();
  }

  async list(projectId: string): Promise<EditHistoryEntry[]> {
    const out: EditHistoryEntry[] = [];
    for (const s of await this.summaries(projectId)) {
      const entry = await this.get(projectId, s.id);
      if (entry) out.push(entry);
    }
    return out;
  }

  async get(projectId: string, entryId: string): Promise<EditHistoryEntry | undefined> {
    if (!ENTRY_ID.test(entryId)) return undefined;
    const dir = this.dirOf(projectId);
    const entry = await readEntry(path.join(dir, `${entryId}.json`));
    if (!entry || entry.projectId !== projectId) return undefined;
    // Undone is kept in the index only (an entry file is never rewritten).
    const undoneAt = (await this.readIndex(dir)).find((s) => s.id === entryId)?.undoneAt;
    const { undoneAt: _stale, ...rest } = entry;
    return undoneAt ? { ...rest, undoneAt } : rest;
  }

  async markUndone(projectId: string, entryId: string, at: string): Promise<void> {
    const dir = this.dirOf(projectId);
    await this.lock.run(dir, async () => {
      const index = await this.readIndex(dir);
      const item = index.find((s) => s.id === entryId);
      if (!item) return;
      item.undoneAt = at;
      await this.writeIndex(dir, index);
    });
  }

  /** The index, oldest first; rebuilt from the entry files when missing or unreadable. */
  private async readIndex(dir: string): Promise<IndexItem[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.rebuild(dir);
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IndexFile>;
      if (Array.isArray(parsed.entries)) return parsed.entries.filter((e) => e && typeof e.id === 'string' && ENTRY_ID.test(e.id));
    } catch {
      /* a broken index: rebuilt below */
    }
    return this.rebuild(dir);
  }

  /** The index from the entry files themselves (none yet: empty). */
  private async rebuild(dir: string): Promise<IndexItem[]> {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const items: IndexItem[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ENTRY_ID.test(name.slice(0, -5))) continue;
      const file = path.join(dir, name);
      const entry = await readEntry(file);
      if (!entry) continue;
      const bytes = await fsp.stat(file).then(
        (s) => s.size,
        () => undefined,
      );
      items.push({ ...summarizeEdit(entry), ...(bytes !== undefined ? { bytes } : {}) });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async writeIndex(dir: string, entries: IndexItem[]): Promise<void> {
    const file: IndexFile = { version: 1, entries };
    await writeTextAtomic(path.join(dir, 'index.json'), JSON.stringify(file));
  }
}

/**
 * Drop the oldest items beyond `maxEntries`, then beyond `maxBytes` of entry
 * files (always keeping the newest). Mutates `index`; returns what it dropped.
 * Pure apart from that: tested on its own.
 */
export function trimIndex(index: IndexItem[], maxEntries: number, maxBytes: number): IndexItem[] {
  const dropped = index.length > maxEntries ? index.splice(0, index.length - maxEntries) : [];
  let total = index.reduce((n, e) => n + (e.bytes ?? 0), 0);
  while (index.length > 1 && total > maxBytes) {
    const old = index.shift()!;
    total -= old.bytes ?? 0;
    dropped.push(old);
  }
  return dropped;
}

async function readEntry(file: string): Promise<EditHistoryEntry | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as EditHistoryEntry;
    return parsed && typeof parsed.id === 'string' && Array.isArray(parsed.before) && Array.isArray(parsed.after) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

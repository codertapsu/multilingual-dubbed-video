/**
 * The activity list on disk (activity/registry.ts keeps it in memory), so it
 * survives a restart and a project keeps the story of its own work:
 *
 *   <config>/logs/activity.jsonl      everything
 *   <project>/logs/activity.jsonl     that project's entries
 *
 * JSON Lines, appended: one line is a whole entry as it was at that moment, so
 * the last line of an id is its state. A line is written when an entry
 * starts, changes state, step, title or result, and at most every 30 s while
 * only its percentage moves (a download reports many times a second).
 * Bounded: past its size the file becomes `activity.1.jsonl` (the previous
 * one is dropped), so there are at most two of each.
 *
 * WHY: the jobs of the 27.8-hour production ran for hours (speaker detection
 * 4 h 56 min) and the app was restarted in between; what ran, who started it
 * and how it ended must still be there afterwards (claude-dubber report,
 * 2026-11-23). What was still running when the app stopped is read back as
 * stopped ({@link settleInterrupted}): nothing runs it any more.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { ActivityEntry } from '@videodubber/shared';

import { renameReplacing } from '../fsRename.js';
import type { ActivityRegistry } from './registry.js';

export const APP_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_LOG_MAX_BYTES = 256 * 1024;
const PROGRESS_EVERY_MS = 30_000;

export interface ActivityLogOptions {
  /** `<config>/logs`: the app-wide file goes here. */
  logsDir: string;
  /**
   * A project's own file, or undefined when it must not be written now: its
   * folder is gone (deleted), or the projects are moving (a file held open
   * while its folder is renamed would stop the move on Windows).
   */
  projectFile?: (projectId: string, purpose: 'write' | 'read') => Promise<string | undefined>;
  maxBytes?: number;
  projectMaxBytes?: number;
  /** Least time between two lines of an entry whose percentage alone moved. */
  progressEveryMs?: number;
  now?: () => number;
}

/** The rotated sibling: `activity.jsonl` → `activity.1.jsonl`. */
export function rotatedFile(file: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.1${ext}`;
}

/** What of an entry decides whether a change is worth a line now. */
interface Written {
  at: number;
  key: string;
}

const significant = (e: ActivityEntry): string =>
  JSON.stringify([e.state, e.title, e.message ?? '', e.result ?? '', e.error?.code ?? '', e.initiator.kind, e.initiator.client ?? '', e.endedAt ?? '']);

export class ActivityLog {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly sizes = new Map<string, number>();
  private readonly written = new Map<string, Written>();
  private readonly now: () => number;

  constructor(private readonly opts: ActivityLogOptions) {
    this.now = opts.now ?? Date.now;
  }

  get appFile(): string {
    return path.join(this.opts.logsDir, 'activity.jsonl');
  }

  /** Write every change of `registry` from now on. Returns the unsubscribe. */
  attach(registry: Pick<ActivityRegistry, 'subscribe'>): () => void {
    return registry.subscribe((entry) => this.record(entry));
  }

  /** One change of an entry: a line when it matters (see the file's comment). */
  record(entry: ActivityEntry): void {
    const key = significant(entry);
    const prev = this.written.get(entry.id);
    const now = this.now();
    if (prev && prev.key === key && now - prev.at < (this.opts.progressEveryMs ?? PROGRESS_EVERY_MS)) return;
    if (entry.endedAt) this.written.delete(entry.id);
    else this.written.set(entry.id, { at: now, key });
    const { projectName: _name, ...stored } = entry;
    const line = `${JSON.stringify(stored)}\n`;
    this.append(this.appFile, line, this.opts.maxBytes ?? APP_LOG_MAX_BYTES, true);
    if (entry.projectId && this.opts.projectFile) {
      const projectId = entry.projectId;
      this.enqueue(`project:${projectId}`, async () => {
        const file = await this.opts.projectFile!(projectId, 'write').catch(() => undefined);
        if (file) await this.write(file, line, this.opts.projectMaxBytes ?? PROJECT_LOG_MAX_BYTES, false);
      });
    }
  }

  /** The app-wide log, newest first: the last state of each entry. */
  async readAll(limit = 1000): Promise<ActivityEntry[]> {
    await this.flush();
    return newestFirst(foldActivityLines(await readBoth(this.appFile)), limit);
  }

  /** A project's own log, newest first (older than what the app keeps in memory). */
  async readProject(projectId: string, limit = 500): Promise<ActivityEntry[]> {
    await this.flush();
    const file = await this.opts.projectFile?.(projectId, 'read').catch(() => undefined);
    if (!file) return [];
    return newestFirst(
      foldActivityLines(await readBoth(file)).filter((e) => e.projectId === projectId),
      limit,
    );
  }

  /** Every line asked for so far is on disk (tests, closing). */
  async flush(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  private append(file: string, line: string, maxBytes: number, createDir: boolean): void {
    this.enqueue(file, () => this.write(file, line, maxBytes, createDir));
  }

  /** Run `task` after the previous one of the same key; a failure never stops the next. */
  private enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(task).catch(() => undefined);
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private async write(file: string, line: string, maxBytes: number, createDir: boolean): Promise<void> {
    let size = this.sizes.get(file);
    if (size === undefined) {
      size = await fsp.stat(file).then(
        (s) => s.size,
        () => 0,
      );
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      try {
        await renameReplacing(file, rotatedFile(file));
        size = 0;
      } catch {
        /* still held open (an antivirus scan): rotate at the next line */
      }
    }
    try {
      await fsp.appendFile(file, line, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // The logs folder is not there yet. The app's own is made with its
      // parents; a project's only inside its existing folder, so a project
      // deleted meanwhile is never made again by its log.
      await fsp.mkdir(path.dirname(file), { recursive: createDir });
      await fsp.appendFile(file, line, 'utf8');
    }
    this.sizes.set(file, size + bytes);
  }
}

async function readBoth(file: string): Promise<string[]> {
  const read = (f: string): Promise<string> => fsp.readFile(f, 'utf8').catch(() => '');
  return [await read(rotatedFile(file)), await read(file)];
}

const isEntry = (v: unknown): v is ActivityEntry => {
  const e = v as Partial<ActivityEntry> | null;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.title === 'string' &&
    typeof e.state === 'string' &&
    typeof e.startedAt === 'string' &&
    typeof e.updatedAt === 'string' &&
    !!e.initiator &&
    typeof e.initiator.kind === 'string'
  );
};

/** The last state of each entry in JSON Lines texts (oldest text first); broken lines are skipped. Pure. */
export function foldActivityLines(texts: readonly string[]): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const text of texts) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEntry(parsed)) {
          byId.delete(parsed.id);
          byId.set(parsed.id, parsed);
        }
      } catch {
        /* a line cut short when the app stopped */
      }
    }
  }
  return [...byId.values()];
}

/** Newest first; within the same millisecond, the one written last first (the sort is stable). */
function newestFirst(entries: ActivityEntry[], limit: number): ActivityEntry[] {
  return entries
    .reverse()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** What an interrupted entry says it stopped with (the UI words it from the code). */
export const INTERRUPTED_MESSAGE = 'VideoDubber closed while this was running.';

/**
 * Entries read back after a restart: what had not ended stopped with the app
 * (nothing runs it any more), at the last moment it was heard from. Pure.
 */
export function settleInterrupted(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return entries.map((e) =>
    e.endedAt
      ? e
      : {
          ...e,
          state: 'cancelled' as const,
          endedAt: e.updatedAt,
          message: INTERRUPTED_MESSAGE,
          error: { code: 'CANCELLED' as const, message: INTERRUPTED_MESSAGE },
        },
  );
}

import crypto from 'node:crypto';

import { toAppError, type ActivityEntry, type ActivityInitiator, type AppError } from '@videodubber/shared';

import { currentInitiator } from './context.js';

/** How a job reports itself while it runs. Every method is safe to call after it ended (ignored). */
export interface ActivityHandle {
  readonly id: string;
  /** `percent` 0..100 or null (unknown); `message` the step it is on; `etaSec` when it can tell. */
  progress(percent: number | null, message?: string, etaSec?: number): void;
  done(result?: string): void;
  fail(error: unknown): void;
  cancelled(message?: string): void;
}

export interface StartActivity {
  kind: string;
  title: string;
  projectId?: string;
  /** Defaults to the current request's initiator (context.ts). */
  initiator?: ActivityInitiator;
  message?: string;
  /** Queued, not yet running. */
  waiting?: boolean;
  /** Reported by an agent for work outside the app (MCP `report_activity`). */
  external?: boolean;
}

/** Entries kept in memory (newest win); persistence keeps its own bounded log. */
const MAX_ENTRIES = 1000;

/**
 * Every long piece of work the app does, whoever started it: one list for the
 * window's activity panel and the agents (GET /activity), instead of each job
 * kind being visible only through its own route, or not at all.
 *
 * WHY: in the 27.8-hour production most of the work ran over MCP and never
 * appeared in the app: five hours of speaker detection (progress only through
 * `get_speakers`), 33 re-transcriptions, rebuilds, part creation (claude-dubber
 * report, 2026-11-23). New jobs call {@link start} and report through the
 * handle; listeners (the SSE stream, persistence) see every change.
 */
export class ActivityRegistry {
  private readonly entries = new Map<string, ActivityEntry>();
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();

  start(opts: StartActivity): ActivityHandle {
    const now = new Date().toISOString();
    const id = `act_${crypto.randomBytes(8).toString('hex')}`;
    this.put({
      id,
      kind: opts.kind,
      title: opts.title,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      initiator: opts.initiator ?? currentInitiator(),
      state: opts.waiting ? 'waiting' : 'running',
      percent: null,
      ...(opts.message ? { message: opts.message } : {}),
      startedAt: now,
      updatedAt: now,
      ...(opts.external ? { external: true } : {}),
    });
    const patch = (p: Partial<ActivityEntry>): void => {
      const cur = this.entries.get(id);
      if (!cur || cur.endedAt) return;
      this.put({ ...cur, ...p, updatedAt: new Date().toISOString() });
    };
    const end = (p: Partial<ActivityEntry>): void => {
      const at = new Date().toISOString();
      patch({ ...p, endedAt: at });
    };
    return {
      id,
      progress: (percent, message, etaSec) =>
        patch({
          state: 'running',
          percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent))),
          ...(message !== undefined ? { message } : {}),
          ...(etaSec !== undefined ? { etaSec: Math.max(0, Math.round(etaSec)) } : {}),
        }),
      done: (result) => end({ state: 'done', percent: 100, ...(result ? { result, message: result } : {}) }),
      fail: (error) => {
        const err: AppError = toAppError(error);
        end({ state: 'failed', error: err, message: err.message });
      },
      cancelled: (message) => end({ state: 'cancelled', ...(message ? { message } : {}) }),
    };
  }

  /** An agent's report about its own outside work, by the id it got from the first report. */
  report(id: string, patch: Partial<Pick<ActivityEntry, 'title' | 'state' | 'percent' | 'message' | 'result'>>): ActivityEntry | undefined {
    const cur = this.entries.get(id);
    if (!cur || !cur.external) return undefined;
    const ended = patch.state === 'done' || patch.state === 'failed' || patch.state === 'cancelled';
    const now = new Date().toISOString();
    const next: ActivityEntry = { ...cur, ...patch, updatedAt: now, ...(ended && !cur.endedAt ? { endedAt: now } : {}) };
    this.put(next);
    return next;
  }

  get(id: string): ActivityEntry | undefined {
    return this.entries.get(id);
  }

  /** Newest first; optionally one project's, optionally only what still runs. */
  list(filter: { projectId?: string; active?: boolean; limit?: number } = {}): ActivityEntry[] {
    const out = [...this.entries.values()]
      .filter((e) => (filter.projectId ? e.projectId === filter.projectId : true))
      .filter((e) => (filter.active ? !e.endedAt : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /** Every change, as it happens. Returns an unsubscribe function. */
  subscribe(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Entries read back from disk at start-up (persistence), never announced again. */
  restore(entries: readonly ActivityEntry[]): void {
    for (const e of entries) if (!this.entries.has(e.id)) this.entries.set(e.id, e);
    this.trim();
  }

  private put(entry: ActivityEntry): void {
    this.entries.set(entry.id, entry);
    this.trim();
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        /* a listener's failure never stops the job */
      }
    }
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const ended = [...this.entries.values()].filter((e) => e.endedAt).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const e of ended.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(e.id);
  }
}

/** The app's one registry. */
export const activity = new ActivityRegistry();

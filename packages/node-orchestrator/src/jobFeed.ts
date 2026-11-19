/**
 * One line per change of the downloads and dubs someone is following
 * (GET /jobs/events, NDJSON): what Mother Claude's Monitor watches through a
 * long batch instead of asking every 50 seconds, each answer adding to its
 * conversation. Agreed with its session (docs/plans/batch-downloads-branding-series.md).
 *
 * `seq` numbers every line the app has written, so a client that reconnects
 * with `since` gets only what it missed. Progress is thinned to every 25%, or
 * every five minutes, so a dub of an hour is a handful of lines. With
 * `untilDone` the stream ends once every named job has stopped (finished,
 * failed, cancelled, paused or waiting for a review): the command that reads
 * it exits, and that is the signal.
 *
 * Never a cookie, a token or a path in a line: ids, states, titles, numbers.
 */
import type { DownloadItem, PipelineState, Project } from '@videodubber/shared';

import type { EventBusRegistry, PipelineEvent } from './events.js';
import type { DownloadQueue } from './providers/download/queue.js';

export interface JobLine {
  seq: number;
  at: string;
  kind: 'download' | 'project';
  id: string;
  state: string;
  title?: string;
  /** 0-100. */
  progress?: number;
  /** The dub's current step. */
  step?: string;
  error?: { code: string; message: string; retryable: boolean };
}

const PROGRESS_STEP = 25;
const PROGRESS_EVERY_MS = 5 * 60_000;
const KEEP_LINES = 2000;
const RETRYABLE = new Set(['SOURCE_RATE_LIMITED', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'ENGINE_BUSY', 'UNKNOWN', 'CANCELLED']);

/** A download or dub has stopped: nothing will happen without someone acting. */
export function isStopped(line: Pick<JobLine, 'kind' | 'state'>): boolean {
  if (line.state === 'unknown') return true; // no such job: waiting would be forever
  return line.kind === 'download'
    ? line.state === 'done' || line.state === 'failed' || line.state === 'cancelled'
    : line.state === 'completed' || line.state === 'failed' || line.state === 'paused' || line.state === 'awaiting-review' || line.state === 'created';
}

export interface JobFeedDeps {
  downloads: DownloadQueue;
  buses: EventBusRegistry;
  getProject: (id: string) => Promise<{ project: Project; pipeline: PipelineState } | undefined>;
  /** A batch dub that starts once the models it needs have downloaded. */
  waitingForModels?: (projectId: string) => boolean;
  now?: () => number;
}

type Listener = (line: JobLine) => void;

export class JobFeed {
  private seq = 0;
  private readonly lines: JobLine[] = [];
  private readonly listeners = new Set<Listener>();
  /** The last line written per job, and when its progress was last written. */
  private readonly last = new Map<string, { line: JobLine; progressAt: number }>();
  private readonly watchedProjects = new Set<string>();

  constructor(private readonly deps: JobFeedDeps) {
    deps.downloads.subscribe((e) => {
      if (e.type === 'item' && !e.replay) this.offer(downloadLine(e.item));
    });
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Follow a dub's changes from now on (each project once, for the life of the app). */
  watchProject(id: string): void {
    if (this.watchedProjects.has(id)) return;
    this.watchedProjects.add(id);
    this.deps.buses.get(id).subscribe((e: PipelineEvent) => {
      if (e.type !== 'state' && e.type !== 'done' && e.type !== 'error') return;
      void this.deps.getProject(id).then((p) => {
        if (p) this.offer(projectLine(p.project, p.pipeline, this.deps.waitingForModels?.(id)));
      });
    });
  }

  /** The current line of a job (a fresh snapshot), or undefined when it does not exist. */
  async snapshot(kind: 'download' | 'project', id: string): Promise<JobLine | undefined> {
    if (kind === 'download') {
      const item = this.deps.downloads.get(id);
      return item ? { ...downloadLine(item), seq: this.seq, at: new Date(this.now).toISOString() } : undefined;
    }
    const p = await this.deps.getProject(id);
    return p
      ? { ...projectLine(p.project, p.pipeline, this.deps.waitingForModels?.(id)), seq: this.seq, at: new Date(this.now).toISOString() }
      : undefined;
  }

  /** Lines after `since` (as many as are still kept). */
  since(seq: number): JobLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write a line when the job's state changed, or its progress moved far enough. */
  private offer(candidate: Omit<JobLine, 'seq' | 'at'>): void {
    const key = `${candidate.kind}:${candidate.id}`;
    const prev = this.last.get(key);
    const now = this.now;
    if (prev && prev.line.state === candidate.state && prev.line.step === candidate.step) {
      const p = candidate.progress ?? 0;
      const q = prev.line.progress ?? 0;
      const crossed = Math.floor(p / PROGRESS_STEP) > Math.floor(q / PROGRESS_STEP);
      if (!crossed && now - prev.progressAt < PROGRESS_EVERY_MS) return;
    }
    const line: JobLine = { seq: ++this.seq, at: new Date(now).toISOString(), ...candidate };
    this.last.set(key, { line, progressAt: now });
    this.lines.push(line);
    if (this.lines.length > KEEP_LINES) this.lines.splice(0, this.lines.length - KEEP_LINES);
    for (const l of this.listeners) l(line);
  }
}

function downloadLine(item: DownloadItem): Omit<JobLine, 'seq' | 'at'> {
  return {
    kind: 'download',
    id: item.id,
    state: item.state,
    ...(item.source?.title ? { title: item.source.title } : {}),
    ...(item.percent !== null ? { progress: Math.round(item.percent) } : {}),
    ...(item.error && (item.state === 'failed' || item.state === 'queued')
      ? { error: { code: item.error.code, message: item.error.message, retryable: RETRYABLE.has(item.error.code) } }
      : {}),
  };
}

function projectLine(project: Project, pipeline: PipelineState, waiting = false): Omit<JobLine, 'seq' | 'at'> {
  // A failed step keeps its message; the code is not stored with it.
  const failed = pipeline.steps.find((s) => s.status === 'failed' && s.error);
  const state = waiting ? 'waiting-for-models' : pipeline.awaitingReview ? 'awaiting-review' : project.status;
  return {
    kind: 'project',
    id: project.id,
    state,
    title: project.name,
    progress: Math.round(pipeline.progressPercent),
    ...(pipeline.currentStep && state === 'running' ? { step: pipeline.currentStep } : {}),
    ...(state === 'failed' && failed?.error ? { error: { code: 'UNKNOWN', message: failed.error, retryable: true } } : {}),
  };
}

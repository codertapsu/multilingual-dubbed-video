/**
 * The rules ActivityService follows for the work it learns about from GET
 * /queue (dubs, renders, series), from the download stream and from the
 * projects-folder move, as pure functions: what is listed, and what is news.
 *
 * News is a change the app SAW happen. A dub that finished yesterday is not in
 * the queue at all, and the download list the server replays on connect is
 * state the app is only now learning: announcing either would be a storm of
 * notices at every launch. So a dub is announced only when it was seen
 * running and then left, and a download only when it was seen in another
 * state before (across a reconnect too: that change did happen).
 */
import type { PipelineStepId, Project, PipelineState, ProjectsFolderInfo } from '../models';
import type { DownloadItem, DownloadState } from '../models/download';

// ------------------------------------------------------------------ dubs

/**
 * What ActivityService reads of GET /queue. Narrower than QueueState on
 * purpose: the UI's copy of that type lacks `step`/`progressPercent`, which
 * the server sends (shared RunningEntry).
 */
export interface QueueView {
  paused: boolean;
  running: readonly { projectId: string; name: string; step?: string; progressPercent?: number }[];
  entries: readonly { projectId: string; name: string }[];
}

/**
 * The dubs that were seen running and are now neither running nor waiting:
 * they ended (finished, failed, paused, cancelled). Their project says how.
 * One that went back to the queue has not ended.
 */
export function runsThatEnded(seenRunning: Iterable<string>, queue: QueueView): string[] {
  const live = new Set([...queue.running.map((r) => r.projectId), ...queue.entries.map((e) => e.projectId)]);
  return [...seenRunning].filter((id) => !live.has(id));
}

/** How a run ended, as its project and pipeline say once it left the queue. */
export type RunOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; step?: PipelineStepId }
  /** Stopped at the transcript-review checkpoint (settings.reviewBeforeSynthesis): the user's turn. */
  | { kind: 'review' }
  /** Paused or cancelled by someone, or taken out of the queue: they know, nothing to announce. */
  | { kind: 'stopped' }
  /** The project still says running: look again on the next poll. */
  | { kind: 'unsettled' };

export function runOutcome(
  project: Pick<Project, 'status'>,
  pipeline: Pick<PipelineState, 'awaitingReview' | 'steps'> | null | undefined,
): RunOutcome {
  switch (project.status) {
    case 'completed':
      return { kind: 'done' };
    case 'failed': {
      const step = pipeline?.steps.find((s) => s.status === 'failed')?.id;
      return step ? { kind: 'failed', step } : { kind: 'failed' };
    }
    case 'paused':
      // A pause is a stop, never a failure (CLAUDE.md); only the review stop asks for the user.
      return pipeline?.awaitingReview ? { kind: 'review' } : { kind: 'stopped' };
    case 'running':
    case 'queued':
      return { kind: 'unsettled' };
    default:
      return { kind: 'stopped' };
  }
}

/**
 * A run first seen mixing or rendering is a render (Export's "Render again",
 * the studio's Render), and is announced as one: "is dubbed" would claim a
 * whole dub happened. Seen earlier, it is a dub.
 */
export function isRenderRun(firstStep: string | undefined): boolean {
  return firstStep === 'audio-mix' || firstStep === 'render';
}

/** The notice for an ended run: translation keys, for the service to fill in. */
export interface RunNotice {
  tone: 'success' | 'error' | 'info';
  /** The task's state in the list afterwards. */
  state: 'done' | 'failed';
  titleKey: string;
  /** A fixed body (`review-body`), or null when the caller says which step failed. */
  bodyKey: string | null;
}

export function runNotice(outcome: RunOutcome, run: { seriesParent: boolean; render: boolean }): RunNotice | null {
  if (outcome.kind === 'done') {
    if (run.seriesParent) return { tone: 'success', state: 'done', titleKey: 'activity.series-done-title', bodyKey: 'activity.series-done-body' };
    return { tone: 'success', state: 'done', titleKey: run.render ? 'activity.render-done-title' : 'activity.dub-done-title', bodyKey: null };
  }
  if (outcome.kind === 'failed') {
    const titleKey = run.seriesParent
      ? 'activity.series-failed-title'
      : run.render
        ? 'activity.render-failed-title'
        : 'activity.dub-failed-title';
    return { tone: 'error', state: 'failed', titleKey, bodyKey: null };
  }
  if (outcome.kind === 'review') return { tone: 'info', state: 'done', titleKey: 'activity.review-title', bodyKey: 'activity.review-body' };
  return null;
}

/** Where a dub is followed: a series on its own page (Home opens it there too), anything else on its progress page. */
export function runLink(projectId: string, seriesParent: boolean): string {
  return `/project/${encodeURIComponent(projectId)}/${seriesParent ? 'series' : 'processing'}`;
}

/** How long until the next look at the queue: steady, slowing down while the backend does not answer. */
export function queuePollDelay(consecutiveFailures: number): number {
  const base = 4000;
  return consecutiveFailures <= 0 ? base : Math.min(30_000, base * 2 ** consecutiveFailures);
}

// ------------------------------------------------------------- downloads

/** How a download shows in the list: working, waiting its turn, or not at all (its end is announced instead). */
export function downloadListing(item: Pick<DownloadItem, 'state'>): 'running' | 'waiting' | null {
  switch (item.state) {
    case 'resolving':
    case 'downloading':
    case 'merging':
      return 'running';
    case 'queued':
      return 'waiting';
    default:
      return null;
  }
}

/**
 * Whether a download's new state is news: it finished or failed since the app
 * last saw it. `previous` undefined = the app sees it for the first time (the
 * list replayed at launch, a download added that was already done): state,
 * not news.
 */
export function downloadNews(previous: DownloadState | undefined, item: Pick<DownloadItem, 'state'>): 'done' | 'failed' | null {
  if (previous === undefined || previous === item.state) return null;
  if (item.state === 'done') return 'done';
  if (item.state === 'failed') return 'failed';
  return null;
}

/** A download's name in the list: the video's title once the site answered, else what was pasted. */
export function downloadLabel(item: Pick<DownloadItem, 'input' | 'source'>): string {
  return item.source?.title ?? item.input;
}

// ------------------------------------------------------------ the move

/** A projects-folder move's progress (null when none runs). */
export function moveProgress(info: Pick<ProjectsFolderInfo, 'moving'>): { done: number; total: number; percent: number | null } | null {
  const m = info.moving;
  if (!m) return null;
  return { done: m.done, total: m.total, percent: m.total > 0 ? Math.round((m.done / m.total) * 100) : null };
}

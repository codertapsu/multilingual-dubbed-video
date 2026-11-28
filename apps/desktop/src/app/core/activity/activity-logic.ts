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
import type { ActivityEntry, ActivityInitiator, ActivityPhrase } from './activity-models';

// ------------------------------------------------------------------ dubs

/**
 * What ActivityService reads of GET /queue. Narrower than QueueState on
 * purpose: the UI's copy of that type lacks `step`/`progressPercent`, which
 * the server sends (shared RunningEntry).
 */
export interface QueueView {
  paused: boolean;
  /** Paused for an app update: the queue goes on by itself once the app is back. */
  pausedForUpdate?: boolean;
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

// ------------------------------------------------- the server's list (GET /activity)

/**
 * Kinds of work this app already follows from their own streams (dubs from
 * GET /queue, downloads, installs, the move): listed once, from there, with
 * their own links, notices and replay rules. The server's activity list holds
 * them too (for the per-project Activity view and the agents), so its entries
 * of these kinds are never listed a second time in the top bar.
 */
export const FOLLOWED_ELSEWHERE: ReadonlySet<string> = new Set([
  'dub.run',
  'dub.render',
  'download',
  'engine.install',
  'model.install',
  'projects.move',
]);

export function followedElsewhere(kind: string): boolean {
  return FOLLOWED_ELSEWHERE.has(kind);
}

const KIND_KEYS: Record<string, string> = {
  'dub.run': 'activity.kind-dub-run',
  'dub.render': 'activity.kind-dub-render',
  download: 'activity.kind-download',
  'engine.install': 'activity.kind-engine-install',
  'model.install': 'activity.kind-model-install',
  'projects.move': 'activity.kind-projects-move',
  'voices.regenerate': 'activity.kind-voices-regenerate',
  'speakers.detect': 'activity.kind-speakers-detect',
  'lines.retranscribe': 'activity.kind-lines-retranscribe',
  'series.plan': 'activity.kind-series-plan',
  'series.rebuild': 'activity.kind-series-rebuild',
  'project.join': 'activity.kind-project-join',
  external: 'activity.kind-external',
};

/** The family of a kind the UI has no exact name for (`picture.watermark` → picture). */
const KIND_FAMILY_KEYS: Record<string, string> = {
  speakers: 'activity.kind-speakers',
  lines: 'activity.kind-lines',
  series: 'activity.kind-series',
  project: 'activity.kind-project',
  picture: 'activity.kind-picture',
  voices: 'activity.kind-voices-regenerate',
};

/**
 * The translation key naming a kind of work, or null when the UI does not
 * know it (the server's own title is shown then). Kinds are named by the job
 * that reports them (`speakers.detect`, `picture.…`): a family name covers
 * the ones added later.
 */
export function kindLabelKey(kind: string): string | null {
  return KIND_KEYS[kind] ?? KIND_FAMILY_KEYS[kind.split('.')[0] ?? ''] ?? null;
}

/**
 * An agent's name as people know it, from the name its MCP client gives in
 * its handshake (`claude-code`, `claude-ai`…); else that name as it is, or
 * null when it gave none.
 */
export function agentName(client: string | undefined): string | null {
  if (!client) return null;
  const c = client.toLowerCase();
  if (c.includes('mother')) return 'Mother Claude';
  if (c.includes('claude-code') || c.includes('claude code')) return 'Claude Code';
  if (c === 'claude-ai' || c.includes('claude desktop') || c.includes('claude-desktop')) return 'Claude Desktop';
  return client;
}

/** Who started a piece of work, as a translation key and its parameters. */
export function initiatorView(initiator: ActivityInitiator, external?: boolean): { key: string; params?: Record<string, string> } {
  const name = agentName(initiator.client);
  if (external) return name ? { key: 'activity.reported-by', params: { name } } : { key: 'activity.reported-by-agent' };
  switch (initiator.kind) {
    case 'ui':
      return { key: 'activity.by-you' };
    case 'mcp':
      return name ? { key: 'activity.by-agent', params: { name } } : { key: 'activity.by-some-agent' };
    case 'scheduler':
      return { key: 'activity.by-app' };
    default:
      return { key: 'activity.by-unknown' };
  }
}

/** Where an entry is looked at: its project's Activity page, or the app's. */
export function entryLink(entry: Pick<ActivityEntry, 'projectId'>): string {
  return entry.projectId ? `/project/${encodeURIComponent(entry.projectId)}/activity` : '/activity';
}

/** How an entry of the server's list shows in the top bar. */
export interface RegistryRow {
  /** `job:<entry id>`. */
  id: string;
  state: 'running' | 'waiting' | 'done' | 'failed';
  percent: number | null;
  link: string;
}

/**
 * Whether (and how) an entry of the server's list is a row of the top bar:
 * not the kinds followed elsewhere (no row twice), not what was stopped
 * (whoever stopped it knows, as for a paused dub), and not what ended before
 * this window saw it run (a replay of history).
 */
export function registryRow(entry: ActivityEntry, opts: { replay: boolean; seenRunning: boolean }): RegistryRow | null {
  if (followedElsewhere(entry.kind) || entry.state === 'cancelled') return null;
  if (entry.endedAt && opts.replay && !opts.seenRunning) return null;
  return { id: `job:${entry.id}`, state: entry.state, percent: entry.percent, link: entryLink(entry) };
}

/**
 * Whether an entry's end is news worth a notice: it ended while this window
 * watched it. The window's own re-voicing is left out (the editor shows it).
 */
export function announceEnd(entry: ActivityEntry, opts: { replay: boolean; seenRunning: boolean }): boolean {
  if (opts.replay || !opts.seenRunning || !entry.endedAt) return false;
  if (entry.state !== 'done' && entry.state !== 'failed') return false;
  if (followedElsewhere(entry.kind)) return false;
  return !(entry.kind === 'voices.regenerate' && entry.initiator.kind === 'ui' && entry.state === 'done');
}

/**
 * A list of entries with `incoming` merged in: one per id (the latest),
 * newest first by start, at most `max`. Pure; the Activity page's list.
 */
export function mergeEntries(list: readonly ActivityEntry[], incoming: readonly ActivityEntry[], max = 300): ActivityEntry[] {
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const e of incoming) {
    const prev = byId.get(e.id);
    if (prev && prev.updatedAt > e.updatedAt) continue;
    // A change streamed before the name was looked up keeps the name already known.
    byId.set(e.id, e.projectName || !prev?.projectName ? e : { ...e, projectName: prev.projectName });
  }
  return [...byId.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, max);
}

/** Translates a key with its values (TranslateService.instant). */
export type ActivityTranslate = (key: string, params?: Record<string, string | number>) => string;

/**
 * A phrase in the reader's language (ActivityPhrase): its key with its values,
 * then its parts joined with ", ". A value named `…Key` is a key translated
 * first (`stepKey: 'opt.step.tts'` gives `step`). Undefined when this version
 * has no such key (a newer app wrote it): the caller shows the English text.
 */
export function phraseText(phrase: ActivityPhrase, t: ActivityTranslate): string | undefined {
  const params: Record<string, string | number> = { ...(phrase.params ?? {}) };
  for (const [name, value] of Object.entries(phrase.params ?? {})) {
    if (name.endsWith('Key') && typeof value === 'string') params[name.slice(0, -3)] = t(value);
  }
  const head = t(phrase.key, params);
  if (head === phrase.key) return undefined;
  const parts: string[] = [];
  for (const part of phrase.parts ?? []) {
    const text = phraseText(part, t);
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return [head, ...parts].join(', ');
}

/** An entry's title, step or result in the reader's language, else its English text. */
export function entryText(entry: ActivityEntry, field: 'title' | 'message' | 'result', t: ActivityTranslate): string | undefined {
  const phrase = entry[`${field}Phrase`];
  return (phrase ? phraseText(phrase, t) : undefined) ?? entry[field];
}

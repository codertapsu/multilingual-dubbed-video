import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { environment } from '../environment';
import { TranslateService } from '../i18n';
import { UpdateService, formatMegabytes } from '../update/update.service';
import { DownloadEventsService, type DownloadChange } from '../ipc/download-events.service';
import { IpcService } from '../ipc/ipc.service';
import type { AppError, ErrorCode, PipelineStepId, Project, ProjectsFolderInfo } from '../models';
import type { DownloadItem, DownloadState } from '../models/download';
import type { ProjectWithPipeline } from '../models/view-models';
import type { SetupEvent } from '../models/setup';
import { PIPELINE_STEP_LABELS } from '../util/format';
import { describeError } from '../../shared/error-banner/error-view';
import {
  announceEnd,
  downloadLabel,
  downloadListing,
  downloadNews,
  entryText,
  initiatorView,
  isRenderRun,
  kindLabelKey,
  moveProgress,
  queuePollDelay,
  registryRow,
  runLink,
  runNotice,
  runOutcome,
  runsThatEnded,
  type ActivityTranslate,
  type QueueView,
  type RunOutcome,
} from './activity-logic';
import type { ActivityAgentSession, ActivityEntry } from './activity-models';

/** One piece of background work: an engine pack, a model, a dub, a video download, the projects-folder move. */
export interface ActivityTask {
  /**
   * `engine:<packId>`, `setup:<item>` (`whisper:large-v3`, `argos:en->vi`,
   * `piper:<voice>`), `dub:<projectId>`, `download:<id>`, `move:projects`;
   * `job:<entry id>` for the server's activity list (speaker detection,
   * re-transcription, re-voicing, joins, what agents report…); and the
   * summaries `dub:waiting`, `download:waiting`, `queue:paused`.
   */
  id: string;
  kind: 'engine' | 'model' | 'dub' | 'download' | 'move' | 'queue' | 'update' | 'job';
  /** Who started it, in words ("Claude Code", "you"), for the server's entries. */
  by?: string;
  label: string;
  /** 0..100, or null while the size is unknown. */
  percent: number | null;
  message: string;
  /** `waiting`: queued for its turn, or held by the paused queue; not in {@link ActivityService.running}. */
  state: 'running' | 'waiting' | 'done' | 'failed';
  error?: AppError;
  /** Where the user manages it. */
  link: string;
  /** An anchor on that page (`opt-pause-queue`); Settings scrolls to it. */
  fragment?: string;
  /** What the link says when "Open" would not ("Resume in Settings"). */
  linkLabel?: string;
  updatedAt: number;
}

/**
 * An engine pack's or a model's task, as {@link ActivityService.engine} and
 * {@link ActivityService.setupItem} return it. These only run, finish or fail:
 * waiting is for dubs and downloads in a queue. The narrower type keeps the
 * rows that read them (Settings' install-state.ts) exhaustive over three states.
 */
export type InstallTask = ActivityTask & { kind: 'engine' | 'model'; state: 'running' | 'done' | 'failed' };

/** A short notice in the corner: a download finished, or failed. */
export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  link?: string;
  fragment?: string;
  linkLabel?: string;
}

/** Settings section that manages an engine of each kind (settings-sections.ts). */
const SECTION_OF_KIND: Record<string, string> = { stt: 'stt', translation: 'translation', tts: 'tts' };

/** How long a finished task stays listed, and a success notice stays up. */
const DONE_TTL_MS = 2 * 60_000;
const TOAST_MS = 6000;

/** Running work first, then what waits its turn, then what ended (newest first within each). */
const STATE_ORDER: Record<ActivityTask['state'], number> = { running: 0, waiting: 1, failed: 2, done: 2 };

/** How often a running projects-folder move is looked at (Settings → General's own pace). */
const MOVE_POLL_MS = 700;
const MOVE_TASK = 'move:projects';
/** Polls to wait for an ended run's project to say how it ended, before letting it go quietly. */
const SETTLE_TRIES = 5;

/**
 * Background work the app is doing for the user, wherever they are in it.
 *
 * Engine packs and models download for minutes, and every screen used to
 * follow them with a stream of its own that died with the screen: after
 * "Install" on a large voice engine and a visit elsewhere, Settings showed no
 * sign of it (user report, 0.17.0), and a model download that silently did
 * nothing could be clicked again and again with no answer. This service keeps
 * ONE connection to each server stream for the app's life. Both streams replay
 * the work in flight to a new subscriber (engines/engineBus.ts,
 * setup/setupBus.ts), so a reconnect, or a screen opened late, sees the same
 * state. Screens read progress from here; the top bar lists it; finished and
 * failed work is announced in a corner notice.
 *
 * The same went for everything else that runs long (UX audit, 2026-11-21):
 * dubs, renders and series were followed only by Processing while it was
 * open, video downloads only by the Download screen, the projects-folder move
 * only by Settings → General, and nothing said a dub had finished or failed.
 * Those are followed here too: dubs from GET /queue (activity-logic.ts says
 * what is news), downloads from their stream (DownloadEventsService, now the
 * app's), the move by polling while it runs ({@link followProjectsMove}).
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);
  private readonly downloads = inject(DownloadEventsService);
  /** The registry's phrases in the reader's language (activity-logic `entryText`). */
  private readonly say: ActivityTranslate = (key, params) => this.i18n.instant(key, params);

  private readonly _tasks = signal<ReadonlyMap<string, ActivityTask>>(new Map());
  private readonly _toasts = signal<Toast[]>([]);
  private nextToast = 1;
  private started = false;
  private engineSource: EventSource | null = null;
  private setupSource: EventSource | null = null;
  /** Events that arrive right after a (re)connect are the server's replay: state, not news. */
  private engineReplayUntil = 0;
  private setupReplayUntil = 0;
  private engineNames = new Map<string, { name: string; kind: string }>();

  /** Newest first: running work, then what waits its turn, then what finished or failed lately. */
  readonly tasks = computed(() =>
    [...this._tasks().values()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt - a.updatedAt),
  );
  readonly running = computed(() => this.tasks().filter((t) => t.state === 'running'));
  /** Dubs and downloads waiting their turn, and the paused queue. */
  readonly waiting = computed(() => this.tasks().filter((t) => t.state === 'waiting'));
  readonly failed = computed(() => this.tasks().filter((t) => t.state === 'failed'));
  readonly toasts = this._toasts.asReadonly();
  /** Bumped when an engine pack finished installing: lists that show packs reload. */
  readonly engineChanges = signal(0);
  /** Bumped when a model download run ended: lists that show models reload. */
  readonly setupChanges = signal(0);
  /** The AI agents (MCP sessions) seen in the last hour, newest first. */
  readonly agents = signal<ActivityAgentSession[]>([]);

  private readonly update = inject(UpdateService);

  constructor() {
    // The app update is listed too: the update dialog can be hidden while the
    // ~280 MB download goes on, and the 0.17.0 update was given up on because
    // nothing on screen said it was moving.
    effect(() => {
      const s = this.update.status();
      const percent = this.update.percent();
      untracked(() => this.showUpdate(s, percent));
    });
  }

  /** Follow everything for the app's life (idempotent). */
  start(): void {
    if (this.started || !environment.orchestratorUrl) return;
    this.started = true;
    void this.loadEngineNames();
    this.connectEngines(0);
    this.connectSetup(0);
    this.downloads.onChange((change) => this.onDownloadChange(change));
    this.downloads.connect();
    this.pollQueueLater(0);
    this.pollRegistryLater(0);
    this.pollAgentsLater(0);
  }

  /** An engine pack's install, when one is in progress (or just ended). */
  engine(packId: string): InstallTask | undefined {
    return asInstallTask(this._tasks().get(`engine:${packId}`));
  }

  /** A model download (`whisper:large-v3`…), when one is in progress (or just ended). */
  setupItem(item: string): InstallTask | undefined {
    return asInstallTask(this._tasks().get(`setup:${item}`));
  }

  /**
   * The user asked for this now: list it as starting at once, before the
   * server's first progress event, so the click is answered immediately.
   */
  markStarting(kind: 'engine' | 'model', key: string, label?: string): void {
    const id = kind === 'engine' ? `engine:${key}` : `setup:${key}`;
    this.upsert(id, {
      kind,
      label: label ?? (kind === 'engine' ? this.engineLabel(key) : this.setupLabel(key)),
      percent: null,
      message: this.i18n.instant('activity.starting'),
      state: 'running',
      // A model's own page: an Argos pack (`argos:en->vi`) failing to start linked to Speech-to-text.
      link: kind === 'engine' ? this.engineLink(key) : this.setupLink(key),
    });
  }

  /** The start request itself failed: the work never began. */
  markFailed(kind: 'engine' | 'model', key: string, error: AppError): void {
    const id = kind === 'engine' ? `engine:${key}` : `setup:${key}`;
    const task = this._tasks().get(id);
    const label = task?.label ?? (kind === 'engine' ? this.engineLabel(key) : this.setupLabel(key));
    const link = kind === 'engine' ? this.engineLink(key) : this.setupLink(key);
    this.upsert(id, { state: 'failed', error, message: error.message, ...(task ? {} : { kind, label, percent: null, link }) });
    this.toast({ tone: 'error', title: this.i18n.instant('activity.failed-title', { name: label }), message: this.failureLine(error) });
  }

  /**
   * A failure in one line, for a notice or the list: the code's own words in
   * the user's language, or the server's when the code says nothing specific
   * (shared/error-banner/error-view.ts, as the error banner reads it).
   */
  failureLine(error: AppError): string {
    const view = describeError(error);
    return view?.message ?? (view ? this.i18n.instant(view.titleKey) : error.message);
  }

  dismiss(id: string): void {
    if (!this._tasks().has(id)) return;
    this._tasks.update((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }

  /** Drop what finished or failed; what runs or waits stays (it is still going on). */
  clearFinished(): void {
    this._tasks.update((m) => new Map([...m].filter(([, t]) => t.state === 'running' || t.state === 'waiting')));
  }

  toast(t: Omit<Toast, 'id'>): void {
    const toast = { ...t, id: this.nextToast++ };
    this._toasts.update((list) => [...list.slice(-3), toast]);
    if (t.tone !== 'error') setTimeout(() => this.closeToast(toast.id), TOAST_MS);
  }

  closeToast(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  // ---------------------------------------------------------------- engines

  private async loadEngineNames(): Promise<void> {
    try {
      const res = await this.ipc.getEngines();
      this.engineNames = new Map(res.available.map((p) => [p.id, { name: p.displayName, kind: p.kind }]));
      // Labels given before the names arrived ("tts-vieneu-cuda") become names.
      this._tasks.update((m) => {
        const next = new Map(m);
        for (const [id, t] of next) if (t.kind === 'engine') next.set(id, { ...t, label: this.engineLabel(id.slice('engine:'.length)), link: this.engineLink(id.slice('engine:'.length)) });
        return next;
      });
    } catch {
      /* labels fall back to pack ids */
    }
  }

  private engineLabel(packId: string): string {
    return this.engineNames.get(packId)?.name ?? packId;
  }

  private engineLink(packId: string): string {
    const kind = this.engineNames.get(packId)?.kind;
    return `/settings/${(kind && SECTION_OF_KIND[kind]) || 'engines'}`;
  }

  private connectEngines(attempt: number): void {
    const es = new EventSource(`${environment.orchestratorUrl}/engines/events`);
    this.engineSource = es;
    es.onopen = () => {
      this.engineReplayUntil = Date.now() + 1500;
      attempt = 0;
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      let event: { type: string; packId?: string; percent?: number | null; message?: string; error?: AppError };
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!event.packId) return;
      const id = `engine:${event.packId}`;
      const replay = Date.now() < this.engineReplayUntil;
      const label = this.engineLabel(event.packId);
      const link = this.engineLink(event.packId);
      if (event.type === 'progress') {
        this.upsert(id, { kind: 'engine', label, link, percent: event.percent ?? null, message: event.message ?? '', state: 'running' });
      } else if (event.type === 'done') {
        this.upsert(id, { kind: 'engine', label, link, percent: 100, message: this.i18n.instant('activity.installed'), state: 'done' });
        this.engineChanges.update((n) => n + 1);
        this.expireLater(id);
        if (!replay) this.toast({ tone: 'success', title: this.i18n.instant('activity.installed-title', { name: label }), link, linkLabel: this.i18n.instant('activity.open') });
      } else if (event.type === 'error' && event.error) {
        this.upsert(id, { kind: 'engine', label, link, percent: null, message: event.error.message, state: 'failed', error: event.error });
        this.engineChanges.update((n) => n + 1);
        if (!replay) this.toast({ tone: 'error', title: this.i18n.instant('activity.failed-title', { name: label }), message: this.failureLine(event.error), link, linkLabel: this.i18n.instant('activity.open') });
      }
    };
    es.onerror = () => {
      // EventSource retries a transient error by itself; a closed one is ours to reopen.
      if (es.readyState !== EventSource.CLOSED) return;
      this.engineSource = null;
      setTimeout(() => this.connectEngines(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
    };
  }

  // ---------------------------------------------------------------- models

  private setupLabel(item: string): string {
    const [kind, rest = ''] = item.split(':');
    if (kind === 'whisper') return this.i18n.instant('activity.label-whisper', { model: rest });
    if (kind === 'argos') {
      const [from, to] = rest.split('->');
      return this.i18n.instant('activity.label-argos', { from: from ?? '', to: to ?? '' });
    }
    if (kind === 'piper') return this.i18n.instant('activity.label-piper', { voice: rest });
    return item;
  }

  private setupLink(item: string): string {
    if (item.startsWith('whisper:')) return '/settings/stt';
    if (item.startsWith('argos:')) return '/settings/translation';
    return '/voices';
  }

  private connectSetup(attempt: number): void {
    const es = new EventSource(`${environment.orchestratorUrl}/setup/events`);
    this.setupSource = es;
    es.onopen = () => {
      this.setupReplayUntil = Date.now() + 1500;
      attempt = 0;
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      let event: SetupEvent;
      try {
        event = JSON.parse(ev.data) as SetupEvent;
      } catch {
        return;
      }
      const replay = Date.now() < this.setupReplayUntil;
      if (event.type === 'progress') {
        const id = `setup:${event.item}`;
        // A replayed item of a run that already ended is history, not work.
        if (replay && this._tasks().get(id)?.state === 'done') return;
        this.upsert(id, {
          kind: 'model',
          label: this.setupLabel(event.item),
          link: this.setupLink(event.item),
          percent: event.percent,
          message: event.message,
          state: 'running',
        });
      } else if (event.type === 'item-done') {
        const id = `setup:${event.item}`;
        const label = this.setupLabel(event.item);
        const known = this._tasks().get(id);
        this.upsert(id, { kind: 'model', label, link: this.setupLink(event.item), percent: 100, message: this.i18n.instant('activity.downloaded'), state: 'done' });
        this.expireLater(id);
        if (!replay && known?.state === 'running') {
          this.toast({ tone: 'success', title: this.i18n.instant('activity.downloaded-title', { name: label }) });
        }
      } else if (event.type === 'done') {
        // The run is over: whatever it listed is no longer running.
        this.settleSetup('done');
        this.setupChanges.update((n) => n + 1);
      } else if (event.type === 'error') {
        this.settleSetup('failed', event.error);
        this.setupChanges.update((n) => n + 1);
        if (!replay) this.toast({ tone: 'error', title: this.i18n.instant('activity.download-failed-title'), message: this.failureLine(event.error) });
      }
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      this.setupSource = null;
      setTimeout(() => this.connectSetup(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt));
    };
  }

  /** End every model task still running, as the run ended. */
  private settleSetup(state: 'done' | 'failed', error?: AppError): void {
    this._tasks.update((m) => {
      const next = new Map(m);
      for (const [id, t] of next) {
        if (t.kind !== 'model' || t.state !== 'running') continue;
        next.set(id, {
          ...t,
          state,
          percent: state === 'done' ? 100 : t.percent,
          message: state === 'done' ? this.i18n.instant('activity.downloaded') : (error?.message ?? t.message),
          ...(error ? { error } : {}),
          updatedAt: Date.now(),
        });
        if (state === 'done') this.expireLater(id);
      }
      return next;
    });
  }

  // ---------------------------------------------------------------- dubs

  /** Dubs seen running, by project: their name, and the step they were first seen in. */
  private readonly runs = new Map<string, { name: string; firstStep?: string }>();
  /** Runs that left the queue, until their project says how they ended. */
  private readonly ending = new Map<string, { name: string; firstStep?: string; tries: number }>();
  private queueFailures = 0;

  private pollQueueLater(delay: number): void {
    setTimeout(() => void this.pollQueue(), delay);
  }

  /**
   * Dubs, renders and series parts, from GET /queue: no stream carries them
   * yet, and Home already polls it the same way. A self-scheduling timer, so a
   * slow answer (the backend still starting) never piles requests up.
   */
  private async pollQueue(): Promise<void> {
    try {
      const queue: QueueView = await this.ipc.getQueue();
      this.queueFailures = 0;
      this.applyQueue(queue);
      await this.settleEndedRuns();
    } catch {
      // The backend is starting or down (the shell's notice says which): the list stays as it was.
      this.queueFailures++;
    } finally {
      this.pollQueueLater(queuePollDelay(this.queueFailures));
    }
  }

  private applyQueue(queue: QueueView): void {
    const ended = new Set(runsThatEnded(this.runs.keys(), queue));
    const runningNow = new Set(queue.running.map((r) => r.projectId));
    for (const [id, run] of [...this.runs]) {
      if (runningNow.has(id)) continue;
      this.runs.delete(id);
      // Ended: its project says how. Otherwise it is back in the queue: the waiting count has it.
      if (ended.has(id)) this.ending.set(id, { ...run, tries: 0 });
      else this.dismiss(`dub:${id}`);
    }

    for (const r of queue.running) {
      this.runs.set(r.projectId, { name: r.name, firstStep: this.runs.get(r.projectId)?.firstStep ?? r.step });
      // Running again (a quick retry) before its end was read: that end is old news.
      this.ending.delete(r.projectId);
      this.upsertIfChanged(`dub:${r.projectId}`, {
        kind: 'dub',
        label: r.name,
        percent: typeof r.progressPercent === 'number' ? r.progressPercent : null,
        message: this.stepLabel(r.step),
        state: 'running',
        link: runLink(r.projectId, false),
      });
    }

    const waiting = queue.entries.length;
    if (queue.paused) {
      // Why nothing starts, and where to change it: the dubs it holds are counted in it.
      this.dismiss('dub:waiting');
      this.upsertIfChanged('queue:paused', {
        kind: 'queue',
        label: this.i18n.instant('activity.queue-paused'),
        percent: null,
        message: this.i18n.instant(waiting > 0 ? 'activity.queue-paused-waiting' : 'activity.queue-paused-empty', { n: waiting }),
        state: 'waiting',
        link: '/settings/performance',
        fragment: 'opt-pause-queue',
        linkLabel: this.i18n.instant('activity.resume'),
      });
    } else {
      this.dismiss('queue:paused');
      if (waiting > 0) {
        this.upsertIfChanged('dub:waiting', {
          kind: 'dub',
          label: this.i18n.instant('activity.dubs-waiting', { n: waiting }),
          percent: null,
          message: '',
          state: 'waiting',
          // Home lists the queue in order ("Up next").
          link: '/',
        });
      } else {
        this.dismiss('dub:waiting');
      }
    }
  }

  /** Ask each ended run's project how it ended; announce what is news. */
  private async settleEndedRuns(): Promise<void> {
    for (const [id, run] of [...this.ending]) {
      let res: ProjectWithPipeline;
      try {
        res = await this.ipc.getProject(id);
      } catch {
        this.retrySettle(id, run);
        continue;
      }
      const outcome = runOutcome(res.project, res.pipeline);
      if (outcome.kind === 'unsettled') {
        this.retrySettle(id, run);
        continue;
      }
      this.ending.delete(id);
      this.announceRun(id, run, res.project, outcome);
    }
  }

  /** Look again on the next poll; after a few, let the run go without a word. */
  private retrySettle(id: string, run: { tries: number }): void {
    if (++run.tries < SETTLE_TRIES) return;
    this.ending.delete(id);
    this.dismiss(`dub:${id}`);
  }

  private announceRun(id: string, run: { name: string; firstStep?: string }, project: Project, outcome: RunOutcome): void {
    const taskId = `dub:${id}`;
    const seriesParent = project.series?.role === 'parent';
    const notice = runNotice(outcome, { seriesParent, render: isRenderRun(run.firstStep) });
    if (!notice) {
      // Paused or cancelled: whoever did it knows.
      this.dismiss(taskId);
      return;
    }
    const name = project.name || run.name;
    const link = runLink(id, seriesParent);
    const failedStep = outcome.kind === 'failed' ? this.stepLabel(outcome.step) : '';
    const body = notice.bodyKey
      ? this.i18n.instant(notice.bodyKey)
      : failedStep
        ? this.i18n.instant('activity.failed-at-step', { step: failedStep })
        : '';
    this.upsert(taskId, {
      kind: 'dub',
      label: name,
      percent: outcome.kind === 'done' ? 100 : null,
      message: body || this.i18n.instant(notice.state === 'done' ? 'activity.finished' : 'activity.failed'),
      state: notice.state,
      link,
    });
    // A dub waiting for its review stays listed: the next move is the user's.
    if (outcome.kind === 'done') this.expireLater(taskId);
    this.toast({
      tone: notice.tone,
      title: this.i18n.instant(notice.titleKey, { name }),
      ...(body ? { message: body } : {}),
      link,
      linkLabel: this.i18n.instant('activity.open'),
    });
  }

  private stepLabel(step: string | undefined): string {
    if (!step || !Object.prototype.hasOwnProperty.call(PIPELINE_STEP_LABELS, step)) return '';
    return this.i18n.instant(PIPELINE_STEP_LABELS[step as PipelineStepId]);
  }

  // ---------------------------------------------------------------- video downloads

  /**
   * The state each download was last seen in. Kept across reconnects, unlike
   * the stream's list: a download that finished while the stream was down
   * did finish, and is announced.
   */
  private readonly downloadStates = new Map<string, DownloadState>();

  private onDownloadChange(change: DownloadChange): void {
    if (change.type === 'item') {
      const { item } = change;
      const news = downloadNews(this.downloadStates.get(item.id), item);
      this.downloadStates.set(item.id, item.state);
      if (news) this.announceDownload(item, news);
    } else if (change.type === 'removed') {
      this.downloadStates.delete(change.id);
      this.dismiss(`download:${change.id}`);
    }
    this.listDownloads();
  }

  /** A row per download at work; those waiting their turn as one count (a batch can be dozens). */
  private listDownloads(): void {
    const working = new Set<string>();
    let waiting = 0;
    for (const item of this.downloads.items()) {
      const listing = downloadListing(item);
      if (listing === 'waiting') waiting++;
      if (listing !== 'running') continue;
      const id = `download:${item.id}`;
      working.add(id);
      this.upsertIfChanged(id, {
        kind: 'download',
        label: downloadLabel(item),
        percent: item.percent,
        message: this.i18n.instant(`source-video.state-${item.state}`),
        state: 'running',
        link: '/download',
      });
    }
    // Rows of downloads no longer at work (an ended one was just announced, and is no longer `running`).
    for (const t of this._tasks().values()) {
      if (t.kind === 'download' && t.state === 'running' && !working.has(t.id)) this.dismiss(t.id);
    }
    if (waiting > 0) {
      this.upsertIfChanged('download:waiting', {
        kind: 'download',
        label: this.i18n.instant('activity.downloads-waiting', { n: waiting }),
        percent: null,
        message: '',
        state: 'waiting',
        link: '/download',
      });
    } else {
      this.dismiss('download:waiting');
    }
  }

  private announceDownload(item: DownloadItem, news: 'done' | 'failed'): void {
    const id = `download:${item.id}`;
    const name = downloadLabel(item);
    const open = { link: '/download', linkLabel: this.i18n.instant('activity.open') };
    if (news === 'done') {
      this.upsert(id, { kind: 'download', label: name, percent: 100, message: this.i18n.instant('activity.downloaded'), state: 'done', link: open.link });
      this.expireLater(id);
      this.toast({ tone: 'success', title: this.i18n.instant('activity.video-done-title', { name }), ...open });
      return;
    }
    const message = item.error ? this.failureLine(item.error) : this.i18n.instant('activity.failed');
    this.upsert(id, { kind: 'download', label: name, percent: null, message, state: 'failed', ...(item.error ? { error: item.error } : {}), link: open.link });
    this.toast({ tone: 'error', title: this.i18n.instant('activity.video-failed-title', { name }), message, ...open });
  }

  // ---------------------------------------------------------------- projects folder

  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Follow a move of the projects folder until it ends, wherever the user
   * goes meanwhile: a task with its progress, and a notice when it ended.
   * Settings → General showed its progress only while open, and nothing said
   * the move had ended (UX audit, 2026-11-21). Pass the answer that says it
   * runs (`moving`) so it is listed at once. Idempotent; a move that is not
   * running is not followed.
   */
  followProjectsMove(info?: ProjectsFolderInfo): void {
    if (info) this.showMove(info);
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => void this.pollMove(), info ? MOVE_POLL_MS : 0);
  }

  private async pollMove(): Promise<void> {
    this.moveTimer = null;
    let info: ProjectsFolderInfo;
    try {
      info = await this.ipc.getProjectsFolder();
    } catch {
      // The backend is busy or restarting: the move runs on regardless; look again.
      if (this._tasks().get(MOVE_TASK)?.state === 'running') this.moveTimer = setTimeout(() => void this.pollMove(), MOVE_POLL_MS * 4);
      return;
    }
    if (info.moving) {
      this.showMove(info);
      this.moveTimer = setTimeout(() => void this.pollMove(), MOVE_POLL_MS);
    } else {
      this.endMove(info);
    }
  }

  private showMove(info: ProjectsFolderInfo): void {
    const progress = moveProgress(info);
    if (!progress) return;
    this.upsertIfChanged(MOVE_TASK, {
      kind: 'move',
      label: this.i18n.instant('activity.move-label'),
      percent: progress.percent,
      message: this.i18n.instant('activity.move-progress', { done: progress.done, total: progress.total }),
      state: 'running',
      link: '/settings/general',
      fragment: 'projects-folder',
    });
  }

  /** The move ended: say how, once. A move never seen running here is not announced. */
  private endMove(info: ProjectsFolderInfo): void {
    if (this._tasks().get(MOVE_TASK)?.state !== 'running') return;
    const where = { link: '/settings/general', fragment: 'projects-folder', linkLabel: this.i18n.instant('activity.open') };
    if (info.lastError) {
      const { code, message, remediation } = info.lastError;
      const body = this.i18n.instant('activity.move-failed-body');
      this.upsert(MOVE_TASK, { state: 'failed', percent: null, message: body, error: { code: code as ErrorCode, message, ...(remediation ? { remediation } : {}) } });
      this.toast({ tone: 'error', title: this.i18n.instant('activity.move-failed-title'), message: body, ...where });
      return;
    }
    const body = this.i18n.instant('activity.move-done-body', { folder: info.projectsDir });
    this.upsert(MOVE_TASK, { state: 'done', percent: 100, message: body });
    this.expireLater(MOVE_TASK);
    this.toast({ tone: 'success', title: this.i18n.instant('activity.move-done-title'), message: body, ...where });
  }

  // ---------------------------------------------------------------- app update

  private showUpdate(s: ReturnType<UpdateService['status']>, percent: number | null): void {
    const id = 'update:app';
    if (s.phase === 'idle') {
      if (this._tasks().has(id)) this.dismiss(id);
      return;
    }
    const label = this.i18n.instant('activity.label-update', { version: s.version ?? '' });
    const where = { kind: 'update' as const, label, link: '/settings/general', fragment: 'updates' };
    const locale = this.i18n.locale();
    switch (s.phase) {
      case 'downloading': {
        const amount = s.total
          ? `${formatMegabytes(s.downloaded, locale)} / ${formatMegabytes(s.total, locale)}`
          : s.downloaded > 0
            ? formatMegabytes(s.downloaded, locale)
            : this.i18n.instant('activity.starting');
        this.upsertIfChanged(id, { ...where, state: 'running', percent, message: amount });
        return;
      }
      case 'installing':
        this.upsertIfChanged(id, { ...where, state: 'running', percent: null, message: this.i18n.instant('update.progress.installing') });
        return;
      case 'ready':
        this.upsertIfChanged(id, { ...where, state: 'waiting', percent: 100, message: this.i18n.instant('update.progress.ready') });
        return;
      case 'failed':
        this.upsert(id, {
          ...where,
          state: 'failed',
          percent: null,
          message: this.i18n.instant('update.progress.failed-title'),
          error: { code: 'UNKNOWN', message: s.error ?? this.i18n.instant('update.progress.failed-title') },
        });
        return;
    }
  }

  // ---------------------------------------------------------------- the server's list

  /**
   * The server's activity list (GET /activity): every long piece of work,
   * whoever started it. The kinds this service already follows from their
   * own streams are left to them (activity-logic.ts FOLLOWED_ELSEWHERE: no
   * row twice); the rest (speaker detection, re-transcription, re-voicing,
   * joins, picture detection, series planning and rebuilds, what agents
   * report) were invisible here, and an agent's work was invisible
   * everywhere (claude-dubber report, 2026-11-23, R3).
   *
   * Polled (`since` the last change seen), not streamed: the window already
   * holds three event streams to the orchestrator for its whole life
   * (engines, models, downloads) and a project's own on its pages, and the
   * webview (Chromium) opens at most six connections to one host. A fourth
   * stream for the app's life left one connection for every other request;
   * two windows' worth hung the second outright (UI check, 2026-11-24).
   * GET /activity/events stays for other clients.
   */
  private registrySince = '';
  private registryPrimed = false;
  private registryFailures = 0;
  /** The `updatedAt` of each entry last applied (a poll repeats the one at `since`). */
  private readonly registrySeen = new Map<string, string>();
  /** Entries seen while they ran: a later end of one is news, a replayed end of another is not. */
  private readonly seenRunning = new Set<string>();

  private pollRegistryLater(delay: number): void {
    setTimeout(() => void this.pollRegistry(), delay);
  }

  private async pollRegistry(): Promise<void> {
    try {
      const replay = !this.registryPrimed;
      const entries = await this.ipc.activity({ limit: replay ? 200 : 100, ...(this.registrySince ? { since: this.registrySince } : {}) });
      this.registryFailures = 0;
      // Oldest change first, so the latest state of each entry is the one kept.
      for (const entry of [...entries].reverse()) {
        const key = `${entry.updatedAt}|${entry.state}|${entry.percent}|${entry.message ?? ''}`;
        if (this.registrySeen.get(entry.id) === key) continue;
        this.registrySeen.set(entry.id, key);
        if (entry.updatedAt > this.registrySince) this.registrySince = entry.updatedAt;
        this.onRegistryEntry(entry, replay);
      }
      this.registryPrimed = true;
      while (this.registrySeen.size > 1000) this.registrySeen.delete(this.registrySeen.keys().next().value!);
    } catch {
      // The backend is starting or down: the list stays as it was.
      this.registryFailures++;
    } finally {
      this.pollRegistryLater(queuePollDelay(this.registryFailures));
    }
  }

  private onRegistryEntry(entry: ActivityEntry, replay: boolean): void {
    const seen = this.seenRunning.has(entry.id);
    if (entry.endedAt) this.seenRunning.delete(entry.id);
    else this.seenRunning.add(entry.id);
    const id = `job:${entry.id}`;
    const row = registryRow(entry, { replay, seenRunning: seen });
    if (!row) {
      this.dismiss(id);
      return;
    }
    const label = this.entryLabel(entry);
    this.upsertIfChanged(id, {
      kind: 'job',
      label,
      percent: row.percent,
      message: entryText(entry, 'message', this.say) ?? (entry.endedAt ? '' : (entryText(entry, 'title', this.say) ?? '')),
      state: row.state,
      link: row.link,
      by: this.entryBy(entry),
      ...(entry.error ? { error: entry.error } : {}),
    });
    if (row.state === 'done') this.expireLater(id);
    if (!announceEnd(entry, { replay, seenRunning: seen })) return;
    const where = { link: row.link, linkLabel: this.i18n.instant('activity.open') };
    if (entry.state === 'failed') {
      this.toast({
        tone: 'error',
        title: this.i18n.instant('activity.job-failed-title', { name: label }),
        ...(entry.error ? { message: this.failureLine(entry.error) } : {}),
        ...where,
      });
    } else {
      this.toast({ tone: 'success', title: this.i18n.instant('activity.job-done-title', { name: label }), ...where });
    }
  }

  /** An entry's name in the list: what kind of work, for which project ("Detecting speakers · Part 3"). */
  entryLabel(entry: ActivityEntry): string {
    const key = entry.external ? null : kindLabelKey(entry.kind);
    const what = key ? this.i18n.instant(key) : entry.title;
    return entry.projectName ? `${what} · ${entry.projectName}` : what;
  }

  /** Who started an entry, in words. */
  entryBy(entry: ActivityEntry): string {
    const view = initiatorView(entry.initiator, entry.external);
    return this.i18n.instant(view.key, view.params);
  }

  // ---------------------------------------------------------------- connected agents

  private agentFailures = 0;

  private pollAgentsLater(delay: number): void {
    setTimeout(() => void this.pollAgents(true), delay);
  }

  /**
   * The agents seen in the last hour (GET /activity/agents), every 30 s:
   * the top bar shows itself while one is connected, and lists them.
   */
  private async pollAgents(reschedule: boolean): Promise<void> {
    try {
      this.agents.set(await this.ipc.activityAgents());
      this.agentFailures = 0;
    } catch {
      this.agentFailures++;
    } finally {
      if (reschedule) this.pollAgentsLater(Math.min(5 * 60_000, 30_000 * 2 ** this.agentFailures));
    }
  }

  /** Look at the agents again now (the panel was opened). */
  refreshAgents(): void {
    void this.pollAgents(false);
  }

  // ---------------------------------------------------------------- state

  private upsert(id: string, patch: Partial<ActivityTask>): void {
    this._tasks.update((m) => {
      const next = new Map(m);
      const prev = next.get(id);
      const fragment = patch.fragment ?? prev?.fragment;
      const linkLabel = patch.linkLabel ?? prev?.linkLabel;
      const by = patch.by ?? prev?.by;
      next.set(id, {
        id,
        kind: patch.kind ?? prev?.kind ?? 'engine',
        label: patch.label ?? prev?.label ?? id,
        percent: patch.percent !== undefined ? patch.percent : (prev?.percent ?? null),
        message: patch.message ?? prev?.message ?? '',
        state: patch.state ?? prev?.state ?? 'running',
        ...(patch.error ? { error: patch.error } : patch.state && patch.state !== 'failed' ? {} : prev?.error ? { error: prev.error } : {}),
        link: patch.link ?? prev?.link ?? '/settings',
        ...(fragment ? { fragment } : {}),
        ...(linkLabel ? { linkLabel } : {}),
        ...(by ? { by } : {}),
        updatedAt: Date.now(),
      });
      return next;
    });
  }

  /** {@link upsert}, unless nothing would change: the pollers repeat the same state every few seconds. */
  private upsertIfChanged(id: string, patch: Partial<ActivityTask>): void {
    const prev = this._tasks().get(id);
    if (prev && (Object.keys(patch) as (keyof ActivityTask)[]).every((k) => prev[k] === patch[k])) return;
    this.upsert(id, patch);
  }

  private expireLater(id: string): void {
    setTimeout(() => {
      const t = this._tasks().get(id);
      if (t && t.state === 'done' && Date.now() - t.updatedAt >= DONE_TTL_MS - 50) this.dismiss(id);
    }, DONE_TTL_MS);
  }
}

/** An `engine:`/`setup:` task as the install it is (they are only ever written that way). */
function asInstallTask(task: ActivityTask | undefined): InstallTask | undefined {
  if (!task || task.state === 'waiting' || (task.kind !== 'engine' && task.kind !== 'model')) return undefined;
  return task as InstallTask;
}

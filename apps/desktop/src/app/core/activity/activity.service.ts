import { computed, inject, Injectable, signal } from '@angular/core';

import { environment } from '../environment';
import { TranslateService } from '../i18n';
import { IpcService } from '../ipc/ipc.service';
import type { AppError } from '../models';
import type { SetupEvent } from '../models/setup';

/** One piece of background work the user started: an engine pack, a model. */
export interface ActivityTask {
  /** `engine:<packId>` or `setup:<item>` (`whisper:large-v3`, `argos:en->vi`, `piper:<voice>`). */
  id: string;
  kind: 'engine' | 'model';
  label: string;
  /** 0..100, or null while the size is unknown. */
  percent: number | null;
  message: string;
  state: 'running' | 'done' | 'failed';
  error?: AppError;
  /** Where the user manages it. */
  link: string;
  updatedAt: number;
}

/** A short notice in the corner: a download finished, or failed. */
export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  link?: string;
  linkLabel?: string;
}

/** Settings section that manages an engine of each kind (settings-sections.ts). */
const SECTION_OF_KIND: Record<string, string> = { stt: 'stt', translation: 'translation', tts: 'tts' };

/** How long a finished task stays listed, and a success notice stays up. */
const DONE_TTL_MS = 2 * 60_000;
const TOAST_MS = 6000;

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
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);

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

  /** Newest first: running work, then what finished or failed lately. */
  readonly tasks = computed(() =>
    [...this._tasks().values()].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.updatedAt - a.updatedAt),
  );
  readonly running = computed(() => this.tasks().filter((t) => t.state === 'running'));
  readonly failed = computed(() => this.tasks().filter((t) => t.state === 'failed'));
  readonly toasts = this._toasts.asReadonly();
  /** Bumped when an engine pack finished installing: lists that show packs reload. */
  readonly engineChanges = signal(0);
  /** Bumped when a model download run ended: lists that show models reload. */
  readonly setupChanges = signal(0);

  /** Connect to both streams for the app's life (idempotent). */
  start(): void {
    if (this.started || !environment.orchestratorUrl) return;
    this.started = true;
    void this.loadEngineNames();
    this.connectEngines(0);
    this.connectSetup(0);
  }

  /** An engine pack's install, when one is in progress (or just ended). */
  engine(packId: string): ActivityTask | undefined {
    return this._tasks().get(`engine:${packId}`);
  }

  /** A model download (`whisper:large-v3`…), when one is in progress (or just ended). */
  setupItem(item: string): ActivityTask | undefined {
    return this._tasks().get(`setup:${item}`);
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
      link: kind === 'engine' ? this.engineLink(key) : '/settings/stt',
    });
  }

  /** The start request itself failed: the work never began. */
  markFailed(kind: 'engine' | 'model', key: string, error: AppError): void {
    const id = kind === 'engine' ? `engine:${key}` : `setup:${key}`;
    const task = this._tasks().get(id);
    this.upsert(id, { state: 'failed', error, message: error.message, ...(task ? {} : { kind, label: key, percent: null, link: '/settings' }) });
    this.toast({ tone: 'error', title: this.i18n.instant('activity.failed-title', { name: task?.label ?? key }), message: error.message });
  }

  dismiss(id: string): void {
    this._tasks.update((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }

  clearFinished(): void {
    this._tasks.update((m) => new Map([...m].filter(([, t]) => t.state === 'running')));
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
        if (!replay) this.toast({ tone: 'error', title: this.i18n.instant('activity.failed-title', { name: label }), message: event.error.message, link, linkLabel: this.i18n.instant('activity.open') });
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
        if (!replay) this.toast({ tone: 'error', title: this.i18n.instant('activity.download-failed-title'), message: event.error.message });
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

  // ---------------------------------------------------------------- state

  private upsert(id: string, patch: Partial<ActivityTask>): void {
    this._tasks.update((m) => {
      const next = new Map(m);
      const prev = next.get(id);
      next.set(id, {
        id,
        kind: patch.kind ?? prev?.kind ?? 'engine',
        label: patch.label ?? prev?.label ?? id,
        percent: patch.percent !== undefined ? patch.percent : (prev?.percent ?? null),
        message: patch.message ?? prev?.message ?? '',
        state: patch.state ?? prev?.state ?? 'running',
        ...(patch.error ? { error: patch.error } : patch.state && patch.state !== 'failed' ? {} : prev?.error ? { error: prev.error } : {}),
        link: patch.link ?? prev?.link ?? '/settings',
        updatedAt: Date.now(),
      });
      return next;
    });
  }

  private expireLater(id: string): void {
    setTimeout(() => {
      const t = this._tasks().get(id);
      if (t && t.state === 'done' && Date.now() - t.updatedAt >= DONE_TTL_MS - 50) this.dismiss(id);
    }, DONE_TTL_MS);
  }
}

import { computed, Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

import { environment } from '../environment';
import type { DownloadItem, DownloadQueueEvent } from '../models/download';

/** Connection lifecycle of the download SSE stream. */
export type DownloadStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * One change to the list, for whoever follows downloads app-wide
 * (ActivityService). `replay` marks the list the server sends on (re)connect;
 * `reset` comes first, when the list is emptied for that replay.
 */
export type DownloadChange =
  | { type: 'item'; item: DownloadItem; replay: boolean }
  | { type: 'removed'; id: string }
  | { type: 'reset' };

/**
 * DownloadEventsService — the download list, kept live from one EventSource on
 * `${orchestratorUrl}/download/events`.
 *
 * The orchestrator sends every download on connect (`replay`) and then each
 * change, so the list is right after a navigation or a reload mid-download
 * without a separate fetch. SSE is consumed directly in BOTH the browser and
 * the Tauri webview (it must NOT be forwarded through Rust).
 *
 * The connection belongs to the app, not to a screen. The Download screen was
 * its only consumer and closed it in ngOnDestroy, so a download started there
 * went unwatched the moment the user left: nothing said it finished or failed
 * (UX audit, 2026-11-21). ActivityService opens it at startup; `connect()` is
 * idempotent and `disconnect()` keeps it open, so the screens call them as
 * before. A stream the server closed is reopened with a backoff.
 */
@Injectable({ providedIn: 'root' })
export class DownloadEventsService {
  private source: EventSource | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly listeners = new Set<(change: DownloadChange) => void>();

  private readonly byId: WritableSignal<ReadonlyMap<string, DownloadItem>> = signal(new Map());
  private readonly _status: WritableSignal<DownloadStreamStatus> = signal<DownloadStreamStatus>('idle');

  readonly status: Signal<DownloadStreamStatus> = this._status.asReadonly();
  /** Every download, newest first. */
  readonly items: Signal<DownloadItem[]> = computed(() =>
    [...this.byId().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  /**
   * Make sure the stream is open (the server replays the whole list on
   * connect). Open already: nothing happens, and the list stays as it is.
   */
  connect(): void {
    if (this.source) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempt = 0;
    this.open();
  }

  /**
   * Called by a screen it is leaving. The stream stays open: the app follows
   * downloads wherever the user is (see the class comment).
   */
  disconnect(): void {
    /* the app owns the connection */
  }

  /** Follow every change of the list, for the app's life. Returns the unsubscribe. */
  onChange(listener: (change: DownloadChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Put a download into the list at once (the answer to POST /downloads), before its event arrives. */
  upsert(item: DownloadItem): void {
    this.byId.update((m) => new Map(m).set(item.id, item));
    this.emit({ type: 'item', item, replay: false });
  }

  private open(): void {
    this.clearConnectTimer();
    this._status.set('connecting');

    const es = new EventSource(`${environment.orchestratorUrl}/download/events`);
    this.source = es;
    es.onopen = () => {
      this._status.set('open');
      this.attempt = 0;
      this.clearConnectTimer();
      // The server replays the whole list right after this (on our reconnect
      // and on the browser's own): start it from empty, so a download removed
      // meanwhile does not linger.
      this.byId.set(new Map());
      this.emit({ type: 'reset' });
    };
    es.onmessage = (ev: MessageEvent<string>) => this.handleMessage(ev.data);
    es.onerror = () => {
      // EventSource retries a transient error by itself; a closed one is ours to reopen.
      if (es.readyState !== EventSource.CLOSED) return;
      this._status.set('error');
      if (this.source === es) this.source = null;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, Math.min(30_000, 1000 * 2 ** this.attempt++));
    };
    this.connectTimer = setTimeout(() => {
      if (this._status() !== 'open') this._status.set('error');
    }, 10000);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private emit(change: DownloadChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        /* one broken follower must not stop the list */
      }
    }
  }

  private handleMessage(raw: string): void {
    let event: DownloadQueueEvent;
    try {
      event = JSON.parse(raw) as DownloadQueueEvent;
    } catch {
      return; // a malformed frame must not take the list down
    }
    if (event.type === 'item') {
      this.byId.update((m) => new Map(m).set(event.item.id, event.item));
      this.emit({ type: 'item', item: event.item, replay: event.replay === true });
    } else if (event.type === 'removed') {
      this.byId.update((m) => {
        const next = new Map(m);
        next.delete(event.id);
        return next;
      });
      this.emit({ type: 'removed', id: event.id });
    }
  }
}

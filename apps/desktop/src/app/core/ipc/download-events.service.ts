import { computed, Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

import { environment } from '../environment';
import type { DownloadItem, DownloadQueueEvent } from '../models/download';

/** Connection lifecycle of the download SSE stream. */
export type DownloadStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * DownloadEventsService — the download list, kept live from one EventSource on
 * `${orchestratorUrl}/download/events`.
 *
 * The orchestrator sends every download on connect (`replay`) and then each
 * change, so the list is right after a navigation or a reload mid-download
 * without a separate fetch. SSE is consumed directly in BOTH the browser and
 * the Tauri webview (it must NOT be forwarded through Rust).
 */
@Injectable({ providedIn: 'root' })
export class DownloadEventsService {
  private source: EventSource | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly byId: WritableSignal<ReadonlyMap<string, DownloadItem>> = signal(new Map());
  private readonly _status: WritableSignal<DownloadStreamStatus> = signal<DownloadStreamStatus>('idle');

  readonly status: Signal<DownloadStreamStatus> = this._status.asReadonly();
  /** Every download, newest first. */
  readonly items: Signal<DownloadItem[]> = computed(() =>
    [...this.byId().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  /** Open (or re-open) the stream; the server replays the whole list first. */
  connect(): void {
    this.disconnect();
    this._status.set('connecting');
    this.byId.set(new Map());

    const es = new EventSource(`${environment.orchestratorUrl}/download/events`);
    this.source = es;
    es.onopen = () => {
      this._status.set('open');
      this.clearConnectTimer();
    };
    es.onmessage = (ev: MessageEvent<string>) => this.handleMessage(ev.data);
    es.onerror = () => {
      // EventSource reconnects by itself on a transient error; only a closed
      // stream is worth reporting.
      if (es.readyState === EventSource.CLOSED) this._status.set('error');
    };
    this.connectTimer = setTimeout(() => {
      if (this._status() !== 'open') this._status.set('error');
    }, 10000);
  }

  /** Put a download into the list at once (the answer to POST /downloads), before its event arrives. */
  upsert(item: DownloadItem): void {
    this.byId.update((m) => new Map(m).set(item.id, item));
  }

  disconnect(): void {
    this.clearConnectTimer();
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this._status.set('closed');
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
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
      this.upsert(event.item);
    } else if (event.type === 'removed') {
      this.byId.update((m) => {
        const next = new Map(m);
        next.delete(event.id);
        return next;
      });
    }
  }
}

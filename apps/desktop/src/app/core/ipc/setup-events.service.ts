import { Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

import { environment } from '../environment';
import type { AppError } from '../models';
import type { SetupEvent, SetupStatus } from '../models/setup';

/** Connection lifecycle of the setup SSE stream. */
export type SetupStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** A log line accumulated during the model download. */
export interface SetupLogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Per-item download progress (keyed by the install `item` id). */
export interface SetupItemProgress {
  item: string;
  /** 0..100, or null when the size is unknown (indeterminate). */
  percent: number | null;
  message: string;
  done: boolean;
}

const MAX_LOG_LINES = 1000;

/**
 * SetupEventsService — owns a single EventSource to
 * `${orchestratorUrl}/setup/events` (a global setup channel).
 *
 * Mirrors {@link PipelineEventsService}: SSE is consumed directly in BOTH the
 * browser and the Tauri webview (it must NOT be forwarded through Rust). The
 * onboarding wizard subscribes to these signals to render per-item progress
 * bars and a live log while models download.
 *
 * Exposes:
 *  - items()    map of item id -> progress (ordered by first-seen)
 *  - logs()     accumulated log lines (capped)
 *  - status()   connection status
 *  - error()    last AppError from an {type:"error"} event
 *  - done()     true once the {type:"done"} event arrives
 *  - finalStatus() the SetupStatus carried by the done event (if any)
 */
@Injectable({ providedIn: 'root' })
export class SetupEventsService {
  private source: EventSource | null = null;

  private readonly _items: WritableSignal<SetupItemProgress[]> = signal<
    SetupItemProgress[]
  >([]);
  private readonly _logs: WritableSignal<SetupLogLine[]> = signal<SetupLogLine[]>([]);
  private readonly _status: WritableSignal<SetupStreamStatus> =
    signal<SetupStreamStatus>('idle');
  private readonly _error: WritableSignal<AppError | null> = signal(null);
  private readonly _done: WritableSignal<boolean> = signal(false);
  private readonly _finalStatus: WritableSignal<SetupStatus | null> = signal(null);

  readonly items: Signal<SetupItemProgress[]> = this._items.asReadonly();
  readonly logs: Signal<SetupLogLine[]> = this._logs.asReadonly();
  readonly status: Signal<SetupStreamStatus> = this._status.asReadonly();
  readonly error: Signal<AppError | null> = this._error.asReadonly();
  readonly done: Signal<boolean> = this._done.asReadonly();
  readonly finalStatus: Signal<SetupStatus | null> = this._finalStatus.asReadonly();

  /**
   * Open (or re-open) the global setup event stream. Resets the accumulated
   * items/logs/done state so each install run starts clean. Safe to call again
   * — it tears down any existing stream first.
   */
  connect(): void {
    this.disconnect();

    this._status.set('connecting');
    this._error.set(null);
    this._done.set(false);
    this._finalStatus.set(null);
    this._items.set([]);
    this._logs.set([]);

    const url = `${environment.orchestratorUrl}/setup/events`;
    const es = new EventSource(url);
    this.source = es;

    es.onopen = () => this._status.set('open');
    es.onmessage = (ev: MessageEvent<string>) => this.handleMessage(ev.data);
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors; only surface an error
      // state when the connection is genuinely closed.
      if (es.readyState === EventSource.CLOSED) {
        this._status.set('error');
      }
    };
  }

  /** Close the stream. Signals retain their last values for the summary view. */
  disconnect(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this._status() !== 'error') {
      this._status.set('closed');
    }
  }

  /** Parse and route one SSE `data:` payload. */
  private handleMessage(raw: string): void {
    let event: SetupEvent;
    try {
      event = JSON.parse(raw) as SetupEvent;
    } catch {
      // Tolerate non-JSON keepalive / comment frames silently.
      return;
    }

    switch (event.type) {
      case 'progress':
        this.upsertItem(event.item, {
          percent: event.percent,
          message: event.message,
        });
        break;

      case 'item-done':
        this.upsertItem(event.item, { percent: 100, done: true });
        break;

      case 'log':
        this.appendLog({ level: event.level, message: event.message });
        break;

      case 'done':
        this._finalStatus.set(event.status);
        this._done.set(true);
        break;

      case 'error':
        this._error.set(event.error);
        break;

      default:
        // Exhaustiveness guard — unknown event types are ignored.
        break;
    }
  }

  /** Merge a partial progress update into an item (creating it if new). */
  private upsertItem(item: string, patch: Partial<Omit<SetupItemProgress, 'item'>>): void {
    this._items.update((items) => {
      const idx = items.findIndex((i) => i.item === item);
      if (idx === -1) {
        return [
          ...items,
          {
            item,
            percent: patch.percent ?? null,
            message: patch.message ?? '',
            done: patch.done ?? false,
          },
        ];
      }
      const next = items.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  /** Append a log line with a hard cap to keep memory bounded. */
  private appendLog(line: SetupLogLine): void {
    this._logs.update((lines) => {
      const next = lines.length >= MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES + 1) : lines;
      return [...next, line];
    });
  }
}

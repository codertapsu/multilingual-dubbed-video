import { Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

import { environment } from '../environment';
import type { AppError } from '../models';
import type { DownloadEvent, DownloadPhase } from '../models/download';

/** Connection lifecycle of the download SSE stream. */
export type DownloadStreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** What the screen renders for the active job. */
export interface DownloadProgressState {
  jobId: string;
  phase: DownloadPhase;
  /** 0..100, or null when the server sent no content-length (indeterminate). */
  percent: number | null;
}

/**
 * DownloadEventsService — owns a single EventSource to
 * `${orchestratorUrl}/download/events`.
 *
 * Mirrors {@link SetupEventsService}. SSE is consumed directly in BOTH the
 * browser and the Tauri webview (it must NOT be forwarded through Rust).
 *
 * The orchestrator replays the latest state of every live job on connect, so
 * navigating away and back mid-download resumes the correct progress rather
 * than showing an idle screen while bytes are still moving.
 */
@Injectable({ providedIn: 'root' })
export class DownloadEventsService {
  private source: EventSource | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _progress: WritableSignal<DownloadProgressState | null> = signal(null);
  private readonly _status: WritableSignal<DownloadStreamStatus> =
    signal<DownloadStreamStatus>('idle');
  private readonly _error: WritableSignal<AppError | null> = signal(null);
  private readonly _completedPath: WritableSignal<string | null> = signal(null);

  readonly progress: Signal<DownloadProgressState | null> = this._progress.asReadonly();
  readonly status: Signal<DownloadStreamStatus> = this._status.asReadonly();
  readonly error: Signal<AppError | null> = this._error.asReadonly();
  readonly completedPath: Signal<string | null> = this._completedPath.asReadonly();

  /** Open (or re-open) the stream, clearing any previous job's state. */
  connect(): void {
    this.disconnect();

    this._status.set('connecting');
    this._error.set(null);
    this._completedPath.set(null);
    this._progress.set(null);

    const es = new EventSource(`${environment.orchestratorUrl}/download/events`);
    this.source = es;

    es.onopen = () => {
      this._status.set('open');
      this.clearConnectTimer();
    };
    es.onmessage = (ev: MessageEvent<string>) => this.handleMessage(ev.data);
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors; only surface an error
      // once the connection is genuinely closed.
      if (es.readyState === EventSource.CLOSED) {
        this.fail('Lost connection to the download progress stream.');
      }
    };

    this.connectTimer = setTimeout(() => {
      if (this._status() !== 'open') {
        this.fail('Could not connect to the download progress stream.');
      }
    }, 10000);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private fail(message: string): void {
    this.clearConnectTimer();
    this._status.set('error');
    if (!this._error()) {
      this._error.set({
        code: 'WORKER_UNAVAILABLE',
        message,
        remediation:
          'The backend connection dropped. The download may still be running — reopen this screen to check.',
      });
    }
  }

  /** Close the stream. Signals retain their last values for the summary view. */
  disconnect(): void {
    this.clearConnectTimer();
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this._status() !== 'error') {
      this._status.set('closed');
    }
  }

  /** Clear the finished/failed state so the screen can accept a new link. */
  reset(): void {
    this._progress.set(null);
    this._error.set(null);
    this._completedPath.set(null);
  }

  private handleMessage(raw: string): void {
    let event: DownloadEvent;
    try {
      event = JSON.parse(raw) as DownloadEvent;
    } catch {
      // Tolerate non-JSON keepalive / comment frames silently.
      return;
    }

    // A replayed terminal event describes a job that was already over before
    // this screen opened. Resuming a RUNNING download is the point of replay;
    // resurrecting a finished one just shows the user a result — or worse, an
    // error — for something they did not start in this session.
    if (event.replay && (event.type === 'done' || event.type === 'error')) return;

    switch (event.type) {
      case 'progress':
        this._progress.set({
          jobId: event.jobId,
          phase: event.phase,
          percent: event.percent,
        });
        break;

      case 'done':
        this._progress.set({ jobId: event.jobId, phase: 'merging', percent: 100 });
        this._completedPath.set(event.filePath);
        break;

      case 'error':
        this._error.set(event.error);
        break;

      default:
        // Exhaustiveness guard — unknown event types are ignored.
        break;
    }
  }
}

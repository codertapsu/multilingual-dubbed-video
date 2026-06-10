import { Injectable, signal, type Signal, type WritableSignal } from '@angular/core';

import { environment } from '../environment';
import type { AppError, PipelineState, PipelineStepState } from '../models';
import type { LogLine, PipelineEvent } from '../models/view-models';

/** Connection lifecycle of the SSE stream. */
export type StreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

const MAX_LOG_LINES = 1000;

/**
 * PipelineEventsService — owns a single EventSource to
 * `${orchestratorUrl}/projects/:id/events`.
 *
 * SSE is used directly in BOTH the browser and the Tauri webview (the webview
 * can reach http://127.0.0.1:5100 over localhost), per the architecture note
 * that SSE must NOT be forwarded through Rust.
 *
 * Exposes reactive signals so components can render with zero RxJS plumbing:
 *  - pipeline()    latest PipelineState (from {type:"state"} and {type:"step"})
 *  - logs()        accumulated log lines (capped)
 *  - lastStep()    most recent step update
 *  - status()      connection status
 *  - error()       last AppError pushed by the stream
 */
@Injectable({ providedIn: 'root' })
export class PipelineEventsService {
  private source: EventSource | null = null;
  private currentProjectId: string | null = null;

  private readonly _pipeline: WritableSignal<PipelineState | null> = signal(null);
  private readonly _logs: WritableSignal<LogLine[]> = signal<LogLine[]>([]);
  private readonly _lastStep: WritableSignal<PipelineStepState | null> = signal(null);
  private readonly _status: WritableSignal<StreamStatus> = signal<StreamStatus>('idle');
  private readonly _error: WritableSignal<AppError | null> = signal(null);
  private readonly _done: WritableSignal<boolean> = signal(false);

  readonly pipeline: Signal<PipelineState | null> = this._pipeline.asReadonly();
  readonly logs: Signal<LogLine[]> = this._logs.asReadonly();
  readonly lastStep: Signal<PipelineStepState | null> = this._lastStep.asReadonly();
  readonly status: Signal<StreamStatus> = this._status.asReadonly();
  readonly error: Signal<AppError | null> = this._error.asReadonly();
  readonly done: Signal<boolean> = this._done.asReadonly();

  /**
   * Open (or re-open) the event stream for a project. Safe to call when an
   * existing stream is open — it tears down the old one first. Resets logs
   * unless reconnecting to the same project.
   */
  connect(projectId: string): void {
    if (this.source && this.currentProjectId === projectId) {
      return; // already streaming this project
    }
    this.disconnect();

    this.currentProjectId = projectId;
    this._status.set('connecting');
    this._error.set(null);
    this._done.set(false);
    this._logs.set([]);

    const url = `${environment.orchestratorUrl}/projects/${encodeURIComponent(
      projectId,
    )}/events`;

    const es = new EventSource(url);
    this.source = es;

    es.onopen = () => this._status.set('open');

    es.onmessage = (ev: MessageEvent<string>) => this.handleMessage(ev.data);

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors; only flag an error
      // state when the connection is genuinely closed.
      if (es.readyState === EventSource.CLOSED) {
        this._status.set('error');
      }
    };
  }

  /** Close the stream and clear the active project. Signals retain last values. */
  disconnect(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    this.currentProjectId = null;
    if (this._status() !== 'error') {
      this._status.set('closed');
    }
  }

  /** Parse and route one SSE `data:` payload. */
  private handleMessage(raw: string): void {
    let event: PipelineEvent;
    try {
      event = JSON.parse(raw) as PipelineEvent;
    } catch {
      // Tolerate non-JSON keepalive / comment frames silently.
      return;
    }

    switch (event.type) {
      case 'state':
        this._pipeline.set(event.pipeline);
        break;

      case 'step': {
        this._lastStep.set(event.step);
        this.patchStep(event.step);
        break;
      }

      case 'log':
        this.appendLog({
          level: event.level,
          message: event.message,
          ts: event.ts,
        });
        break;

      case 'error':
        this._error.set(event.error);
        break;

      case 'done':
        this._done.set(true);
        break;

      default:
        // Exhaustiveness guard — unknown event types are ignored.
        break;
    }
  }

  /** Merge a single step update into the cached pipeline state (immutably). */
  private patchStep(step: PipelineStepState): void {
    const current = this._pipeline();
    if (!current) return;
    const steps = current.steps.map((s) => (s.id === step.id ? step : s));
    this._pipeline.set({ ...current, steps, updatedAt: new Date().toISOString() });
  }

  /** Append a log line with a hard cap to keep memory bounded. */
  private appendLog(line: LogLine): void {
    this._logs.update((lines) => {
      const next = lines.length >= MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES + 1) : lines;
      return [...next, line];
    });
  }
}

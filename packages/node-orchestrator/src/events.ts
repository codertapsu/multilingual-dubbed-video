/**
 * Per-project event bus.
 *
 * The pipeline runner and logger publish typed events here; the SSE endpoint
 * (`GET /projects/:id/events`) subscribes and forwards them to the webview.
 *
 * Event payloads match the contract exactly:
 *   {type:"state", pipeline}
 *   {type:"log", level, message, ts}
 *   {type:"step", step}
 *   {type:"done"}
 *   {type:"error", error:AppError}
 */
import { EventEmitter } from 'node:events';
import type { AppError, PipelineState, PipelineStepState } from '@videodubber/shared';

/** Log severity levels emitted over SSE. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Full pipeline state snapshot. */
export interface StateEvent {
  type: 'state';
  pipeline: PipelineState;
}

/** A single log line. */
export interface LogEvent {
  type: 'log';
  level: LogLevel;
  message: string;
  /** ISO-8601 timestamp. */
  ts: string;
}

/** A single step transition (lighter than a full state snapshot). */
export interface StepEvent {
  type: 'step';
  step: PipelineStepState;
}

/** Terminal: pipeline finished successfully. */
export interface DoneEvent {
  type: 'done';
}

/** Terminal: pipeline failed. */
export interface ErrorEvent {
  type: 'error';
  error: AppError;
}

/** Discriminated union of everything sent over the SSE channel. */
export type PipelineEvent = StateEvent | LogEvent | StepEvent | DoneEvent | ErrorEvent;

/** Listener signature for {@link ProjectEventBus.subscribe}. */
export type PipelineEventListener = (event: PipelineEvent) => void;

const EVENT_NAME = 'pipeline-event';

/**
 * A thin typed wrapper around {@link EventEmitter} for a single project.
 *
 * `setMaxListeners` is bumped because multiple SSE clients (the desktop app
 * plus possibly the orchestrator's own logging) may attach concurrently.
 */
export class ProjectEventBus {
  private readonly emitter = new EventEmitter();
  /** Last full state snapshot + last terminal, for replay-on-connect. */
  private lastState: StateEvent | null = null;
  private terminal: DoneEvent | ErrorEvent | null = null;

  constructor(public readonly projectId: string) {
    this.emitter.setMaxListeners(64);
  }

  /** Publish an event to all subscribers (and record state for replay). */
  emit(event: PipelineEvent): void {
    if (event.type === 'state') {
      this.lastState = event;
    } else if (event.type === 'done' || event.type === 'error') {
      this.terminal = event;
    }
    this.emitter.emit(EVENT_NAME, event);
  }

  /**
   * Subscribe; returns an unsubscribe function. The last full `state` snapshot
   * (and any terminal) is **replayed** to the new listener first, so a client
   * connecting mid-run — or re-opening after a retry — immediately re-syncs the
   * full pipeline state instead of waiting for the next `step`/`log` frame.
   */
  subscribe(listener: PipelineEventListener): () => void {
    if (this.lastState) listener(this.lastState);
    if (this.terminal) listener(this.terminal);
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  /** Current subscriber count (used to decide whether to keep buffering). */
  listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME);
  }
}

/**
 * Registry of per-project event buses. Buses are created lazily and reused so
 * that an SSE client connecting mid-run shares the same bus the runner uses.
 */
export class EventBusRegistry {
  private readonly buses = new Map<string, ProjectEventBus>();

  /** Get (or lazily create) the bus for a project id. */
  get(projectId: string): ProjectEventBus {
    let bus = this.buses.get(projectId);
    if (!bus) {
      bus = new ProjectEventBus(projectId);
      this.buses.set(projectId, bus);
    }
    return bus;
  }

  /** Drop the bus for a project (e.g. on delete). */
  delete(projectId: string): void {
    this.buses.delete(projectId);
  }
}

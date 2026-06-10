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

  constructor(public readonly projectId: string) {
    this.emitter.setMaxListeners(64);
  }

  /** Publish an event to all subscribers. */
  emit(event: PipelineEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: PipelineEventListener): () => void {
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

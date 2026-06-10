/**
 * Global setup event bus.
 *
 * The first-run installer publishes {@link SetupEvent}s here; the SSE endpoint
 * (`GET /setup/events`) subscribes and forwards them to the webview. Unlike the
 * per-project pipeline bus, setup is a single global channel (only one install
 * runs at a time), so a single bus instance is shared across the server.
 *
 * Mirrors the {@link ProjectEventBus} pattern from `src/events.ts`.
 */
import { EventEmitter } from 'node:events';
import type { SetupEvent } from '@videodubber/shared';

/** Listener signature for {@link SetupEventBus.subscribe}. */
export type SetupEventListener = (event: SetupEvent) => void;

const EVENT_NAME = 'setup-event';

/**
 * A thin typed wrapper around {@link EventEmitter} for the single global setup
 * channel. `setMaxListeners` is bumped because the webview plus the wizard's
 * own logging may attach concurrently.
 */
export class SetupEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  /** Publish an event to all subscribers. */
  emit(event: SetupEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: SetupEventListener): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  /** Current subscriber count. */
  listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME);
  }
}

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
  /** Latest progress/item-done per item, for replay-on-connect. */
  private readonly itemState = new Map<string, SetupEvent>();
  /** Last terminal (done/error) of the current run, for replay. */
  private terminal: SetupEvent | null = null;

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  /** Publish an event to all subscribers (and record it for replay). */
  emit(event: SetupEvent): void {
    if (event.type === 'progress' || event.type === 'item-done') {
      this.itemState.set(event.item, event);
    } else if (event.type === 'done' || event.type === 'error') {
      this.terminal = event;
    }
    this.emitter.emit(EVENT_NAME, event);
  }

  /**
   * Forget the current run's snapshot. Call at the START of a new install so a
   * client that connects mid-run doesn't replay stale state from a prior run.
   */
  reset(): void {
    this.itemState.clear();
    this.terminal = null;
  }

  /** The events that bring a fresh subscriber up to the current state. */
  snapshot(): SetupEvent[] {
    const events: SetupEvent[] = [...this.itemState.values()];
    if (this.terminal) events.push(this.terminal);
    return events;
  }

  /**
   * Subscribe; returns an unsubscribe function. The current snapshot is
   * **replayed** to the new listener first, so an SSE client that connects after
   * the install already started still sees the in-flight items (no lost frames).
   */
  subscribe(listener: SetupEventListener): () => void {
    for (const event of this.snapshot()) listener(event);
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  /** Current subscriber count. */
  listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME);
  }
}

/**
 * Global engine-pack install event bus (SSE channel for GET /engines/events).
 * Mirrors {@link SetupEventBus}: a single global channel since one engine-pack
 * install runs at a time.
 */
import { EventEmitter } from 'node:events';
import type { EngineInstallEvent } from '@videodubber/shared';

export type EngineEventListener = (event: EngineInstallEvent) => void;

const EVENT_NAME = 'engine-event';

export class EngineEventBus {
  private readonly emitter = new EventEmitter();
  /** Latest in-flight event per pack, for replay-on-connect. A pack drops out
   *  once it finishes ('done') so completed installs aren't replayed forever. */
  private readonly packState = new Map<string, EngineInstallEvent>();

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  emit(event: EngineInstallEvent): void {
    if (event.type === 'progress' || event.type === 'error') {
      this.packState.set(event.packId, event);
    } else if (event.type === 'done') {
      this.packState.delete(event.packId);
    }
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Events that bring a fresh subscriber up to the current state. */
  snapshot(): EngineInstallEvent[] {
    return [...this.packState.values()];
  }

  /**
   * Subscribe; the current per-pack snapshot is **replayed** to the new listener
   * first, so an SSE client that connects after an install started still sees
   * the in-flight pack(s) instead of an empty stream.
   */
  subscribe(listener: EngineEventListener): () => void {
    for (const event of this.snapshot()) listener(event);
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME);
  }
}

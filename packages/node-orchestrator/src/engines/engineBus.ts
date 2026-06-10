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

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  emit(event: EngineInstallEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  subscribe(listener: EngineEventListener): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  listenerCount(): number {
    return this.emitter.listenerCount(EVENT_NAME);
  }
}

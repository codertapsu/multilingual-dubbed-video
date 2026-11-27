/**
 * Who currently "owns" the exclusive heavy-engine lane.
 *
 * Heavy engines (llama.cpp, whisper.cpp, LibreTranslate, separation, alignment)
 * are started with `{ exclusive: true }`, which UNLOADS every other heavy engine
 * to free RAM/VRAM for the current phase. That is correct for one project run
 * — its phases are sequential — but catastrophic across concurrent work: a
 * second run (or an editor action like "regenerate this segment") would stop the
 * engine a running dub is mid-request against, surfacing as ENGINE_UNAVAILABLE
 * deep inside a step.
 *
 * Rather than trusting that every current call site is well-behaved (there are
 * several, and the next one is always one PR away), ownership is enforced at the
 * chokepoint — {@link EngineManager.ensureRunning} — and the owner is carried
 * IMPLICITLY through an AsyncLocalStorage context, so no provider signature has
 * to change. Work that runs outside any context is treated as unowned and may
 * claim a free lane; work belonging to a different owner is refused with
 * ENGINE_BUSY, or, for a dub, waits for its turn (lane sharing).
 *
 * A dub's context also carries its run's abort signal, so a dub waiting for
 * the graphics card stops waiting when it is paused, and a reporter its step
 * sets, so the wait shows in the step ("Waiting for the graphics card").
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a dub waiting for the graphics card waits for: the owner holding the
 * lane (a project id, `editor:<project>`, `preview:<voice>`), or the app that
 * holds the card (scheduler/gpuHolds.ts, by its display name).
 */
export interface LaneWait {
  owner?: string;
  app?: string;
}

/** Told what this work waits for while it waits for the lane, and undefined once the wait is over. */
export type LaneWaitReporter = (wait: LaneWait | undefined) => void;

/** The async-context payload: which logical owner this work belongs to. */
interface EngineOwnerContext {
  ownerId: string;
  /** The run's signal: a wait for the lane ends when it aborts. */
  signal?: AbortSignal;
  onLaneWait?: LaneWaitReporter;
}

const storage = new AsyncLocalStorage<EngineOwnerContext>();

/**
 * Run `fn` with every heavy-engine acquisition inside it attributed to
 * `ownerId` (a project id for a pipeline run, `editor:<projectId>` for a
 * one-off editor action). Nested calls inherit the innermost owner.
 */
export function withEngineOwner<T>(ownerId: string, fn: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
  return storage.run({ ownerId, ...(opts.signal ? { signal: opts.signal } : {}) }, fn);
}

/** The owner of the currently-executing async work, if any. */
export function currentEngineOwner(): string | undefined {
  return storage.getStore()?.ownerId;
}

/** The abort signal of the current owner's run, if it has one. */
export function currentEngineSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * Report this owner's waits for the lane to `report` (a step sets it as it
 * starts; undefined stops reporting). No-op outside an owner context.
 */
export function setLaneWaitReporter(report: LaneWaitReporter | undefined): void {
  const store = storage.getStore();
  if (!store) return;
  if (report) store.onLaneWait = report;
  else delete store.onLaneWait;
}

/** The current owner's reporter for lane waits, if a step set one. */
export function currentLaneWaitReporter(): LaneWaitReporter | undefined {
  return storage.getStore()?.onLaneWait;
}

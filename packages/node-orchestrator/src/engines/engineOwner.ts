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
 * ENGINE_BUSY.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The async-context payload: which logical owner this work belongs to. */
interface EngineOwnerContext {
  ownerId: string;
}

const storage = new AsyncLocalStorage<EngineOwnerContext>();

/**
 * Run `fn` with every heavy-engine acquisition inside it attributed to
 * `ownerId` (a project id for a pipeline run, `editor:<projectId>` for a
 * one-off editor action). Nested calls inherit the innermost owner.
 */
export function withEngineOwner<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ownerId }, fn);
}

/** The owner of the currently-executing async work, if any. */
export function currentEngineOwner(): string | undefined {
  return storage.getStore()?.ownerId;
}

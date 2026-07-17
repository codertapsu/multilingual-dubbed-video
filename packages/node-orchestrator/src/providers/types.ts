/**
 * Cancellable provider interfaces.
 *
 * The shared {@link SttProvider} / {@link TranslationProvider} /
 * {@link TtsProvider} contracts declare single-argument methods. Inside the
 * orchestrator we want to thread an {@link AbortSignal} so worker calls can be
 * cancelled mid-pipeline. These interfaces widen the shared ones with an
 * OPTIONAL trailing `signal` argument.
 *
 * Because the extra parameter is optional, any class implementing one of these
 * is still structurally assignable to the corresponding shared interface (and
 * vice-versa, a shared provider with no signal param still satisfies these).
 */
import type {
  SttInput,
  SttProvider,
  SttResult,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from '@videodubber/shared';

/** STT provider that optionally accepts a cancellation signal. */
export interface CancellableSttProvider extends SttProvider {
  transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult>;
}

/** Translation provider that optionally accepts a cancellation signal. */
export interface CancellableTranslationProvider extends TranslationProvider {
  translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult>;
  /**
   * Can run the review-and-refine pass (instruction-following + document
   * context). Providers set this true when they also expose
   * {@link TranslationRefiner.chatComplete}.
   */
  supportsRefinement?: boolean;
}

/**
 * The refine pass's engine capability: a provider that exposes a one-shot
 * chat completion. The refine step type-narrows a translation provider to
 * this via {@link isTranslationRefiner}.
 */
export interface TranslationRefiner {
  chatComplete(system: string | undefined, user: string, signal?: AbortSignal): Promise<string>;
}

/** Structural check: a refinement-capable provider with the chat primitive. */
export function isTranslationRefiner(
  p: CancellableTranslationProvider,
): p is CancellableTranslationProvider & TranslationRefiner {
  return p.supportsRefinement === true && typeof (p as Partial<TranslationRefiner>).chatComplete === 'function';
}

/** TTS provider that optionally accepts a cancellation signal. */
export interface CancellableTtsProvider extends TtsProvider {
  synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult>;
}

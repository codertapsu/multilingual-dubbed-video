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
}

/** TTS provider that optionally accepts a cancellation signal. */
export interface CancellableTtsProvider extends TtsProvider {
  synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult>;
}

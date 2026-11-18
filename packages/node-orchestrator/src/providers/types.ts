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
  /**
   * The model this provider would translate with right now, when that can
   * change without the provider's id changing (the Claude model chosen in
   * Settings, the local chat model installed). Part of a translation
   * checkpoint's key, so a model switched during a pause starts fresh.
   */
  modelIdentity?(): Promise<string | undefined>;
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

/** What an engine returns for a voice made from a recording. */
export interface VoiceEnrollmentResult {
  /** Hash of the voice data: names the voice in clip caches and seeds. */
  fingerprint: string;
  engineVersion: string;
  codeFrames?: number;
}

/** A TTS provider whose engine can make a voice from a recording (VieNeu 3.8). */
export interface VoiceCloner {
  enroll(
    referencePath: string,
    outPath: string,
    opts: { denoise: boolean },
    signal?: AbortSignal,
  ): Promise<VoiceEnrollmentResult>;
}

export function isVoiceCloner(p: CancellableTtsProvider): p is CancellableTtsProvider & VoiceCloner {
  return typeof (p as Partial<VoiceCloner>).enroll === 'function';
}

/**
 * Turns a voice-profile id ("vp_…") into the voice file of a provider's engine,
 * enrolling the kept recording on first use with that engine. Implemented by
 * voices/profileService.ts and handed to the providers that can clone.
 */
export interface VoiceRefResolver {
  resolve(
    profileId: string,
    providerId: string,
    enroll: (referencePath: string, outPath: string) => Promise<VoiceEnrollmentResult>,
    signal?: AbortSignal,
  ): Promise<{ file: string; fingerprint: string }>;
}

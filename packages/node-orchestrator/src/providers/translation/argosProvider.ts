/**
 * Local translation provider backed by the Argos Translate Python worker
 * (port 5102). Sends source/target reduced to their base subtags and preserves
 * segment ids/order in the response.
 */
import {
  toArgosLanguage,
  type TranslationInput,
  type TranslationProvider,
  type TranslationResult,
} from '@videodubber/shared';
import { getWorkerJson, postWorkerJson } from '../workerHttp.js';

/** Raw shape of POST /translate-segments. */
interface WorkerTranslateResponse {
  segments: { id: string; translatedText: string }[];
}

/** Raw shape of GET /languages. */
export interface WorkerLanguagesResponse {
  installed: { from: string; to: string }[];
  available?: { from: string; to: string }[];
}

/** Argos Translate local translation provider. */
export class ArgosTranslationProvider implements TranslationProvider {
  readonly id = 'argos';
  readonly displayName = 'Argos Translate (local)';
  readonly isLocal = true;

  constructor(
    private readonly workerUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /** Translate segments, reducing languages to base subtags for Argos. */
  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    const body = {
      sourceLanguage: toArgosLanguage(input.sourceLanguage),
      targetLanguage: toArgosLanguage(input.targetLanguage),
      segments: input.segments,
      glossary: input.glossary,
    };

    const data = await postWorkerJson<WorkerTranslateResponse>(
      `${this.workerUrl.replace(/\/$/, '')}/translate-segments`,
      body,
      { timeoutMs: this.timeoutMs, workerName: 'Translation worker', signal },
    );

    return { segments: data.segments ?? [] };
  }

  /** Fetch installed/available Argos language pairs for the UI. */
  async listLanguages(signal?: AbortSignal): Promise<WorkerLanguagesResponse> {
    return getWorkerJson<WorkerLanguagesResponse>(`${this.workerUrl.replace(/\/$/, '')}/languages`, {
      timeoutMs: this.timeoutMs,
      workerName: 'Translation worker',
      signal,
    });
  }
}

/**
 * Local STT provider backed by the faster-whisper Python worker (port 5101).
 *
 * Translates language codes to whisper's base-subtag form before sending, and
 * maps the worker's JSON response onto the shared {@link SttResult} type.
 */
import {
  toWhisperLanguage,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TranscriptSegment,
} from '@videodubber/shared';
import { postWorkerJson } from '../workerHttp.js';

/** Raw shape returned by the STT worker's POST /transcribe. */
interface WorkerTranscribeResponse {
  segments: TranscriptSegment[];
  detectedLanguage: string;
  durationMs: number;
}

/** faster-whisper local STT provider. */
export class FasterWhisperProvider implements SttProvider {
  readonly id = 'faster-whisper';
  readonly displayName = 'faster-whisper (local)';
  readonly isLocal = true;

  constructor(
    private readonly workerUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Transcribe audio via the worker. `language` (if present) is reduced to its
   * base subtag for whisper (e.g. `vi-VN` -> `vi`).
   */
  async transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
    const body = {
      audioPath: input.audioPath,
      language: input.language ? toWhisperLanguage(input.language) : undefined,
      model: input.model,
      wordTimestamps: input.wordTimestamps,
    };

    const data = await postWorkerJson<WorkerTranscribeResponse>(
      `${this.workerUrl.replace(/\/$/, '')}/transcribe`,
      body,
      { timeoutMs: this.timeoutMs, workerName: 'STT worker', signal },
    );

    return {
      segments: data.segments ?? [],
      detectedLanguage: data.detectedLanguage,
      durationMs: data.durationMs,
    };
  }
}

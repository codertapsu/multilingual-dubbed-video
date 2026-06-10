/**
 * Cloud speech-to-text via OpenAI's transcription API.
 *
 * Uploads the extracted 16 kHz mono WAV to /v1/audio/transcriptions with
 * `response_format=verbose_json`, which returns timed segments. Privacy note:
 * this sends THE WHOLE AUDIO TRACK to OpenAI — the UI marks the provider as
 * cloud and the docs spell out what leaves the machine.
 *
 * SDK-free (plain fetch + FormData) so the cloud path adds no bundle weight.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  normalizeLanguageCode,
  type TranscriptSegment,
  type SttInput,
  type SttResult,
} from '@videodubber/shared';
import type { CancellableSttProvider } from '../types.js';
import type { CredentialsStore } from '../../credentials/credentialsStore.js';
import { cloudFetch, requireCredential } from '../cloud/cloudHttp.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';

/** Raw verbose_json segment shape from OpenAI. */
interface OpenAiVerboseSegment {
  start: number;
  end: number;
  text: string;
}

/** Map OpenAI verbose_json segments to the shared transcript contract. */
export function mapOpenAiSegments(segments: OpenAiVerboseSegment[]): TranscriptSegment[] {
  return segments
    .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
    .map((s, index) => ({
      id: `seg_${String(index + 1).padStart(4, '0')}`,
      index,
      startMs: Math.max(0, Math.round(s.start * 1000)),
      endMs: Math.max(0, Math.round(s.end * 1000)),
      sourceText: s.text.trim(),
    }));
}

/** OpenAI cloud transcription provider. */
export class OpenAiSttProvider implements CancellableSttProvider {
  readonly id = 'openai-stt';
  readonly displayName = 'OpenAI Whisper (cloud)';
  readonly isLocal = false;
  readonly credentialService = 'openai' as const;

  constructor(
    private readonly credentials: CredentialsStore,
    private readonly timeoutMs: number,
  ) {}

  async transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const baseUrl = (cred.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = cred.model ?? DEFAULT_MODEL;

    const audio = await readFile(input.audioPath).catch((err: unknown) => {
      throw new AppErrorException('UNSUPPORTED_MEDIA', `Could not read the audio file for upload: ${input.audioPath}`, {
        cause: String(err),
      });
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(input.audioPath));
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    const language = normalizeLanguageCode(input.language ?? '').split('-')[0];
    if (language) form.append('language', language);

    const response = await cloudFetch(
      `${baseUrl}/audio/transcriptions`,
      { method: 'POST', body: form },
      { service: this.credentialService, timeoutMs: this.timeoutMs, signal },
    );

    const data = (await response.json()) as {
      language?: string;
      duration?: number;
      segments?: OpenAiVerboseSegment[];
    };

    const segments = mapOpenAiSegments(data.segments ?? []);
    return {
      segments,
      detectedLanguage: normalizeLanguageCode(data.language ?? input.language ?? ''),
      durationMs: Math.round((data.duration ?? 0) * 1000) || (segments.at(-1)?.endMs ?? 0),
    };
  }
}

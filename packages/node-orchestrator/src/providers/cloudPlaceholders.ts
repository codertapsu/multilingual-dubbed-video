/**
 * Cloud provider PLACEHOLDERS (optional / future).
 *
 * VideoDubber is local/offline-first. These classes are registered in the
 * provider registry so the UI can list them, but every method throws
 * WORKER_UNAVAILABLE with a clear "not implemented" remediation. Each class
 * documents:
 *   - which environment variable holds its credentials, and
 *   - what data WOULD be sent to the third-party service if implemented,
 * so privacy implications are explicit before anyone wires them up.
 *
 * NOTE: none of these read or log secrets. Implementing them is intentionally
 * left as a TODO.
 */
import {
  AppErrorException,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TranslationInput,
  type TranslationProvider,
  type TranslationResult,
  type TtsInput,
  type TtsProvider,
  type TtsResult,
} from '@videodubber/shared';

/** Throw a consistent "not implemented" error for a cloud provider. */
function notImplemented(providerName: string, envVars: string[], dataSent: string): never {
  throw new AppErrorException('WORKER_UNAVAILABLE', `${providerName} is not implemented (cloud provider placeholder).`, {
    remediation: `This is an optional future cloud provider. To enable it you must implement the client and set: ${envVars.join(
      ', ',
    )}. Data that would be sent to the cloud: ${dataSent}. For now use the local providers.`,
    docsRef: 'docs/PROVIDERS.md#cloud-providers',
  });
}

/**
 * OpenAI Whisper / gpt-4o-transcribe STT placeholder.
 * Credentials: OPENAI_API_KEY.
 * Would upload: the extracted audio file (original_16k_mono.wav).
 */
export class OpenAiSttProvider implements SttProvider {
  readonly id = 'openai-stt';
  readonly displayName = 'OpenAI STT (cloud, not implemented)';
  readonly isLocal = false;

   
  async transcribe(_input: SttInput): Promise<SttResult> {
    // TODO: POST audio to https://api.openai.com/v1/audio/transcriptions
    return notImplemented(
      'OpenAI STT',
      ['OPENAI_API_KEY'],
      'the extracted audio (uploaded to OpenAI) plus the source language hint',
    );
  }
}

/**
 * DeepL translation placeholder.
 * Credentials: DEEPL_API_KEY.
 * Would send: each segment's source text.
 */
export class DeeplTranslationProvider implements TranslationProvider {
  readonly id = 'deepl';
  readonly displayName = 'DeepL (cloud, not implemented)';
  readonly isLocal = false;

   
  async translateSegments(_input: TranslationInput): Promise<TranslationResult> {
    // TODO: POST to https://api-free.deepl.com/v2/translate
    return notImplemented('DeepL', ['DEEPL_API_KEY'], 'each segment source text (sent to DeepL servers)');
  }
}

/**
 * Google Cloud Translation placeholder.
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS.
 * Would send: each segment's source text.
 */
export class GoogleTranslationProvider implements TranslationProvider {
  readonly id = 'google-translate';
  readonly displayName = 'Google Translate (cloud, not implemented)';
  readonly isLocal = false;

   
  async translateSegments(_input: TranslationInput): Promise<TranslationResult> {
    // TODO: use @google-cloud/translate
    return notImplemented(
      'Google Translate',
      ['GOOGLE_APPLICATION_CREDENTIALS'],
      'each segment source text (sent to Google Cloud)',
    );
  }
}

/**
 * Azure Speech (Neural TTS) placeholder.
 * Credentials: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION.
 * Would send: each segment's translated text.
 */
export class AzureTtsProvider implements TtsProvider {
  readonly id = 'azure-tts';
  readonly displayName = 'Azure Neural TTS (cloud, not implemented)';
  readonly isLocal = false;

   
  async synthesizeSegments(_input: TtsInput): Promise<TtsResult> {
    // TODO: call Azure Cognitive Services Speech SDK / REST
    return notImplemented(
      'Azure Neural TTS',
      ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
      'each segment translated text (sent to Azure)',
    );
  }
}

/**
 * ElevenLabs TTS placeholder.
 * Credentials: ELEVENLABS_API_KEY.
 * Would send: each segment's translated text. Voice cloning is NOT supported
 * and would require explicit, documented consent.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = 'elevenlabs-tts';
  readonly displayName = 'ElevenLabs TTS (cloud, not implemented)';
  readonly isLocal = false;

   
  async synthesizeSegments(_input: TtsInput): Promise<TtsResult> {
    // TODO: POST to https://api.elevenlabs.io/v1/text-to-speech
    return notImplemented(
      'ElevenLabs TTS',
      ['ELEVENLABS_API_KEY'],
      'each segment translated text (sent to ElevenLabs). Voice cloning is intentionally NOT included.',
    );
  }
}

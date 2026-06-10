/**
 * Provider registry.
 *
 * Maps a `providerId` to a concrete provider instance for each capability
 * (STT / translation / TTS). Local providers are the defaults:
 *   - STT:         `faster-whisper`
 *   - Translation: `argos`
 *   - TTS:         `piper-local`
 *
 * Cloud providers (per-phase, opt-in) are fetch-based adapters that read their
 * API key from the {@link CredentialsStore} ON EVERY CALL — registering them is
 * free, and nothing cloud-related runs until a project actually selects one:
 *   - STT:         `openai-stt`
 *   - Translation: `openai-translate`, `anthropic-translate`, `gemini-translate`
 *   - TTS:         `openai-tts`
 *
 * The registry is the single composition point, so tests can build a registry
 * out of mocked providers and inject it into the pipeline runner.
 */
import { AppErrorException, type CloudServiceId } from '@videodubber/shared';
import type { OrchestratorConfig } from '../config.js';
import { CredentialsStore } from '../credentials/credentialsStore.js';
import type {
  CancellableSttProvider,
  CancellableTranslationProvider,
  CancellableTtsProvider,
} from './types.js';
import { FasterWhisperProvider } from './stt/fasterWhisperProvider.js';
import { OpenAiSttProvider } from './stt/openaiSttProvider.js';
import { ArgosTranslationProvider } from './translation/argosProvider.js';
import { LlmTranslationProvider } from './translation/llmTranslationProvider.js';
import { LocalTtsProvider } from './tts/localTtsProvider.js';
import { OpenAiTtsProvider } from './tts/openaiTtsProvider.js';

/** Default provider ids per capability. */
export const DEFAULT_PROVIDER_IDS = {
  stt: 'faster-whisper',
  translation: 'argos',
  tts: 'piper-local',
} as const;

/** Lightweight descriptor for listing providers in the UI. */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  isLocal: boolean;
  /** Cloud service whose API key this provider needs (cloud providers only). */
  credentialService?: CloudServiceId;
}

/** Holds all known providers and resolves them by id. */
export class ProviderRegistry {
  private readonly stt = new Map<string, CancellableSttProvider>();
  private readonly translation = new Map<string, CancellableTranslationProvider>();
  private readonly tts = new Map<string, CancellableTtsProvider>();

  /** Register an STT provider. */
  registerStt(provider: CancellableSttProvider): void {
    this.stt.set(provider.id, provider);
  }

  /** Register a translation provider. */
  registerTranslation(provider: CancellableTranslationProvider): void {
    this.translation.set(provider.id, provider);
  }

  /** Register a TTS provider. */
  registerTts(provider: CancellableTtsProvider): void {
    this.tts.set(provider.id, provider);
  }

  /** Resolve an STT provider by id, falling back to the default. */
  getStt(id?: string): CancellableSttProvider {
    return this.resolve(this.stt, id, DEFAULT_PROVIDER_IDS.stt, 'STT');
  }

  /** Resolve a translation provider by id, falling back to the default. */
  getTranslation(id?: string): CancellableTranslationProvider {
    return this.resolve(this.translation, id, DEFAULT_PROVIDER_IDS.translation, 'translation');
  }

  /** Resolve a TTS provider by id, falling back to the default. */
  getTts(id?: string): CancellableTtsProvider {
    return this.resolve(this.tts, id, DEFAULT_PROVIDER_IDS.tts, 'TTS');
  }

  /** List all registered providers grouped by capability (for the UI). */
  describe(): { stt: ProviderDescriptor[]; translation: ProviderDescriptor[]; tts: ProviderDescriptor[] } {
    const map = (p: {
      id: string;
      displayName: string;
      isLocal: boolean;
      credentialService?: CloudServiceId;
    }): ProviderDescriptor => ({
      id: p.id,
      displayName: p.displayName,
      isLocal: p.isLocal,
      ...(p.credentialService ? { credentialService: p.credentialService } : {}),
    });
    return {
      stt: [...this.stt.values()].map(map),
      translation: [...this.translation.values()].map(map),
      tts: [...this.tts.values()].map(map),
    };
  }

  private resolve<T extends { id: string }>(
    map: Map<string, T>,
    id: string | undefined,
    defaultId: string,
    kind: string,
  ): T {
    const wanted = id && id.length > 0 ? id : defaultId;
    const provider = map.get(wanted) ?? map.get(defaultId);
    if (!provider) {
      throw new AppErrorException('UNKNOWN', `No ${kind} provider registered for id "${wanted}".`, {
        remediation: `Register a ${kind} provider or pick one of: ${[...map.keys()].join(', ')}.`,
      });
    }
    return provider;
  }
}

/**
 * Build the default registry from config: local providers wired to the worker
 * URLs, plus the fetch-based cloud adapters bound to the credentials store.
 * Tests bypass this and construct their own.
 */
export function createDefaultRegistry(
  config: OrchestratorConfig,
  credentials: CredentialsStore = new CredentialsStore(config.configDir),
): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Local (default) providers.
  registry.registerStt(new FasterWhisperProvider(config.sttWorkerUrl, config.workerRequestTimeoutMs));
  registry.registerTranslation(
    new ArgosTranslationProvider(config.translationWorkerUrl, config.workerRequestTimeoutMs),
  );
  registry.registerTts(new LocalTtsProvider(config.ttsWorkerUrl, config.workerRequestTimeoutMs));

  // Cloud providers (opt-in per phase; keys resolved lazily per call, so an
  // unconfigured provider costs nothing until a project selects it).
  registry.registerStt(new OpenAiSttProvider(credentials, config.workerRequestTimeoutMs));
  registry.registerTranslation(new LlmTranslationProvider('openai', credentials, config.workerRequestTimeoutMs));
  registry.registerTranslation(new LlmTranslationProvider('anthropic', credentials, config.workerRequestTimeoutMs));
  registry.registerTranslation(new LlmTranslationProvider('gemini', credentials, config.workerRequestTimeoutMs));
  registry.registerTts(new OpenAiTtsProvider(credentials, config.workerRequestTimeoutMs));

  return registry;
}

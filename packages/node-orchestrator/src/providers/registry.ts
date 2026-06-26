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
import { WhisperCppProvider } from './stt/whisperCppProvider.js';
import { ArgosTranslationProvider } from './translation/argosProvider.js';
import { LibreTranslateProvider } from './translation/libreTranslateProvider.js';
import { LlmTranslationProvider } from './translation/llmTranslationProvider.js';
import { LocalLlmTranslationProvider } from './translation/localLlmTranslationProvider.js';
import { LocalTtsProvider } from './tts/localTtsProvider.js';
import { NeuralTtsProvider } from './tts/neuralTtsProvider.js';
import { OpenAiTtsProvider } from './tts/openaiTtsProvider.js';
import type { EngineManager } from '../engines/engineManager.js';
import type { EnginePackStore } from '../engines/enginePackStore.js';
import { requireInstalledPack, resolveLocalLlmModelPath } from '../engines/packSelection.js';
import { availablePacks } from '../engines/enginePackCatalog.js';

/**
 * Default local-LLM models per backend (overridable via env).
 *
 * The default is the **4B** TranslateGemma — the only size that is comfortable on
 * a no-GPU 8–16 GB machine (12B is ~7–8 GB and ~1–5 tok/s CPU-only). Bigger sizes
 * are an explicit opt-in: for the managed llama.cpp path the user installs a
 * `translategemma-12b`/`-27b` model pack (the launch uses whichever GGUF is
 * installed, so it is inherently tier-aware); for Ollama they `ollama pull
 * translategemma:12b` and set OLLAMA_MODEL. Note the llama.cpp path loads the
 * model by FILE (resolveLocalLlmModelPath), so LLAMACPP_MODEL is only a label.
 */
export const OLLAMA_URL = process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434/v1';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL?.trim() || 'translategemma:4b';
const LLAMACPP_MODEL = process.env.LLAMACPP_MODEL?.trim() || 'translategemma-4b';

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
  /** Engine-pack family this provider needs (local pack-gated providers). */
  requiresEnginePack?: string;
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
      requiresEnginePack?: string;
    }): ProviderDescriptor => ({
      id: p.id,
      displayName: p.displayName,
      isLocal: p.isLocal,
      ...(p.credentialService ? { credentialService: p.credentialService } : {}),
      ...(p.requiresEnginePack ? { requiresEnginePack: p.requiresEnginePack } : {}),
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
  engines?: EngineManager,
  store?: EnginePackStore,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const timeout = config.workerRequestTimeoutMs;

  // Local (default) providers — always present, no engine pack required.
  registry.registerStt(new FasterWhisperProvider(config.sttWorkerUrl, timeout));
  registry.registerTranslation(new ArgosTranslationProvider(config.translationWorkerUrl, timeout));
  registry.registerTts(new LocalTtsProvider(config.ttsWorkerUrl, timeout));

  // Cloud providers (opt-in per phase; keys resolved lazily per call, so an
  // unconfigured provider costs nothing until a project selects it).
  registry.registerStt(new OpenAiSttProvider(credentials, timeout));
  registry.registerTranslation(new LlmTranslationProvider('openai', credentials, timeout));
  registry.registerTranslation(new LlmTranslationProvider('anthropic', credentials, timeout));
  registry.registerTranslation(new LlmTranslationProvider('gemini', credentials, timeout));
  registry.registerTts(new OpenAiTtsProvider(credentials, timeout));

  // Ollama: a user-run local LLM daemon — no engine pack, no key. Available
  // whenever the daemon answers (the /providers route preflights it).
  registry.registerTranslation(
    new LocalLlmTranslationProvider({
      id: 'ollama',
      displayName: 'TranslateGemma (via Ollama)',
      backend: 'ollama',
      model: OLLAMA_MODEL,
      resolveBaseUrl: async () => OLLAMA_URL,
      timeoutMs: timeout,
    }),
  );

  // Engine-pack-backed local engines (registered only when the runtime is
  // wired). They list in the UI as "needs engine pack" until installed; calling
  // one without its pack throws ENGINE_PACK_MISSING.
  if (engines && store) {
    registry.registerStt(
      new WhisperCppProvider(engines, () => requireInstalledPack(store, 'whisper-cpp'), timeout),
    );
    registry.registerTranslation(
      new LocalLlmTranslationProvider({
        id: 'llama-cpp',
        displayName: 'TranslateGemma (built-in)',
        backend: 'llama-cpp',
        model: LLAMACPP_MODEL,
        resolveBaseUrl: async () => {
          // Needs BOTH: a llama.cpp runtime binary pack AND a TranslateGemma model
          // pack. Resolve the GGUF first so a missing-model install fails fast with
          // a clear ENGINE_PACK_MISSING instead of starting a model-less server.
          const packId = await requireInstalledPack(store, 'local-llm');
          const model = await resolveLocalLlmModelPath(store);
          return engines.ensureRunning(packId, { exclusive: true, model });
        },
        timeoutMs: timeout,
      }),
    );
    // LibreTranslate (optional engine pack). Same engine as Argos (so not the
    // default); offered for users who want the LibreTranslate server.
    registry.registerTranslation(new LibreTranslateProvider(engines, store, timeout));
    // Two SEPARATE VieNeu options. v2 (24 kHz; preset voices CC BY-NC) and
    // v3-Turbo (48 kHz; Apache-2.0) each have their own pack + venv.
    registry.registerTts(
      new NeuralTtsProvider('neural-tts-v2', 'VieNeu Neural TTS v2 (Vietnamese)', 'neural-tts-v2', engines, store, timeout),
    );
    registry.registerTts(
      new NeuralTtsProvider('neural-tts', 'VieNeu Neural TTS v3 (Vietnamese)', 'neural-tts', engines, store, timeout),
    );
    // OmniVoice — massively-multilingual neural TTS, Apple Silicon ONLY (MLX).
    // Registered only where its pack can actually run, so it isn't offered as a
    // permanently-uninstallable option on Windows/Intel. (Its pack `tts-omnivoice`
    // is gated to darwin/arm64; here we mirror that gate at registration.)
    if (availablePacks().some((p) => p.id === 'tts-omnivoice')) {
      registry.registerTts(
        // exclusive=true: OmniVoice's ~2 GB MLX model evicts other resident heavy
        // engines before loading (it's marked heavy: true in ENGINE_LAUNCH_SPECS).
        new NeuralTtsProvider('omnivoice', 'OmniVoice Neural TTS (multilingual)', 'omnivoice', engines, store, timeout, true),
      );
    }
  }

  return registry;
}

import { describe, expect, it } from 'vitest';
import { AppErrorException, type Project } from '@videodubber/shared';
import type { CredentialsStore } from '../credentials/credentialsStore.js';
import type { EnginePackStore } from '../engines/enginePackStore.js';
import { assertRunReady, checkProviderReadiness, type OllamaProbe } from './readiness.js';
import { availablePacks } from '../engines/enginePackCatalog.js';
import { ProviderRegistry } from './registry.js';
import { FakeSttProvider, FakeTtsProvider } from '../test/fixtures.js';
import type { TranslationInput, TranslationResult, TranslationProvider } from '@videodubber/shared';

/** Minimal translation provider with controllable traits. */
function fakeTranslation(traits: Partial<TranslationProvider> & { id: string }): TranslationProvider {
  return {
    isLocal: true,
    displayName: traits.id,
    ...traits,
    async translateSegments(input: TranslationInput): Promise<TranslationResult> {
      return { segments: input.segments.map((s) => ({ id: s.id, translatedText: s.sourceText })) };
    },
  } as TranslationProvider;
}

function registryWith(translation: TranslationProvider): ProviderRegistry {
  const r = new ProviderRegistry();
  r.registerStt(new FakeSttProvider([])); // id: faster-whisper
  r.registerTranslation(translation);
  r.registerTts(new FakeTtsProvider()); // id: piper-local
  return r;
}

/** Credentials fake whose describe() we fully control (no env interference). */
function fakeCreds(configured: string[]): CredentialsStore {
  return {
    describe: async () =>
      (['openai', 'anthropic', 'gemini'] as const).map((service) => ({
        service,
        configured: configured.includes(service),
      })),
  } as unknown as CredentialsStore;
}

const noPacks = { isInstalled: async () => false } as unknown as EnginePackStore;

function projectWith(translationProviderId: string): Project {
  return {
    settings: { sttProviderId: 'faster-whisper', translationProviderId, ttsProviderId: 'piper-local' },
  } as unknown as Project;
}

const probe = (p: OllamaProbe) => async () => p;

describe('checkProviderReadiness', () => {
  it('flags Ollama when the daemon is unreachable (the bug)', async () => {
    const results = await checkProviderReadiness(projectWith('ollama'), {
      registry: registryWith(fakeTranslation({ id: 'ollama', displayName: 'Ollama' })),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      probeOllama: probe({ daemon: false, model: false }),
    });
    const t = results.find((r) => r.phase === 'translation')!;
    expect(t.ready).toBe(false);
    expect(t.status).toBe('daemon-unreachable');
    expect(t.action?.kind).toBe('guide');
    // The local defaults (whisper/piper) are reported ready.
    expect(results.find((r) => r.phase === 'stt')?.ready).toBe(true);
    expect(results.find((r) => r.phase === 'tts')?.ready).toBe(true);
  });

  it('flags a local provider whose worker is still booting, and the run gate blocks', async () => {
    const results = await checkProviderReadiness(projectWith('argos'), {
      registry: registryWith(fakeTranslation({ id: 'argos' })),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      probeWorker: async (phase) => phase !== 'stt', // STT worker still booting; others up
    });
    const stt = results.find((r) => r.phase === 'stt')!;
    expect(stt.ready).toBe(false);
    expect(stt.status).toBe('worker-loading');
    expect(results.find((r) => r.phase === 'translation')?.ready).toBe(true);
    expect(results.find((r) => r.phase === 'tts')?.ready).toBe(true);
    // The run-start gate refuses to begin while a mandatory worker is loading.
    expect(() => assertRunReady(results)).toThrow(AppErrorException);
  });

  it('treats local providers as ready when no worker probe is wired (back-compat)', async () => {
    const results = await checkProviderReadiness(projectWith('argos'), {
      registry: registryWith(fakeTranslation({ id: 'argos' })),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      // no probeWorker
    });
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('flags Ollama when the daemon is up but the model is not pulled', async () => {
    const results = await checkProviderReadiness(projectWith('ollama'), {
      registry: registryWith(fakeTranslation({ id: 'ollama' })),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      probeOllama: probe({ daemon: true, model: false }),
    });
    const t = results.find((r) => r.phase === 'translation')!;
    expect(t.status).toBe('model-missing');
    expect(t.action?.kind).toBe('pull-ollama-model');
  });

  it('reports Ollama ready when daemon + model are present', async () => {
    const results = await checkProviderReadiness(projectWith('ollama'), {
      registry: registryWith(fakeTranslation({ id: 'ollama' })),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      probeOllama: probe({ daemon: true, model: true }),
    });
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('flags a cloud provider whose API key is not configured', async () => {
    const results = await checkProviderReadiness(projectWith('openai-translate'), {
      registry: registryWith(
        fakeTranslation({ id: 'openai-translate', isLocal: false, credentialService: 'openai' }),
      ),
      credentials: fakeCreds([]), // no keys
      enginePackStore: noPacks,
    });
    const t = results.find((r) => r.phase === 'translation')!;
    expect(t.status).toBe('cloud-key-missing');
    expect(t.action?.kind).toBe('open-credentials');
  });

  it('reports a cloud provider ready once its key is configured', async () => {
    const results = await checkProviderReadiness(projectWith('openai-translate'), {
      registry: registryWith(
        fakeTranslation({ id: 'openai-translate', isLocal: false, credentialService: 'openai' }),
      ),
      credentials: fakeCreds(['openai']),
      enginePackStore: noPacks,
    });
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('reports a neural-TTS provider ready once its engine pack is installed', async () => {
    const installedPacks = { isInstalled: async () => true } as unknown as EnginePackStore;
    const r = new ProviderRegistry();
    r.registerStt(new FakeSttProvider([]));
    r.registerTranslation(fakeTranslation({ id: 'argos' }));
    r.registerTts({
      id: 'neural-tts',
      displayName: 'VieNeu Neural TTS',
      isLocal: true,
      requiresEnginePack: 'neural-tts',
    } as unknown as Parameters<ProviderRegistry['registerTts']>[0]);
    const project = {
      settings: { sttProviderId: 'faster-whisper', translationProviderId: 'argos', ttsProviderId: 'neural-tts' },
    } as unknown as Project;

    // The neural pack runs on every platform (torch-free), so it's installable
    // on the test host; with it installed the provider is ready (no espeak gate).
    const packSupported = availablePacks(process.platform, process.arch).some((p) => p.id === 'tts-neural');
    expect(packSupported).toBe(true);

    const results = await checkProviderReadiness(project, {
      registry: r,
      credentials: fakeCreds([]),
      enginePackStore: installedPacks,
    });
    expect(results.find((x) => x.phase === 'tts')!.ready).toBe(true);
  });

  it('only checks phases at-or-after the retry step', async () => {
    // Retry from audio-mix: STT/translation/TTS are all already done -> nothing checked.
    const results = await checkProviderReadiness(
      projectWith('ollama'),
      {
        registry: registryWith(fakeTranslation({ id: 'ollama' })),
        credentials: fakeCreds([]),
        enginePackStore: noPacks,
        probeOllama: probe({ daemon: false, model: false }),
      },
      'audio-mix',
    );
    expect(results).toHaveLength(0);
  });
});

describe('assertRunReady', () => {
  it('does not throw when everything is ready', () => {
    expect(() =>
      assertRunReady([{ phase: 'stt', providerId: 'faster-whisper', status: 'ready', ready: true, message: 'Ready.' }]),
    ).not.toThrow();
  });

  it('throws a mapped AppError for the first not-ready provider', () => {
    try {
      assertRunReady([
        { phase: 'translation', providerId: 'ollama', status: 'daemon-unreachable', ready: false, message: 'down', remediation: 'start it' },
      ]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppErrorException);
      const e = err as AppErrorException;
      expect(e.appError.code).toBe('ENGINE_UNAVAILABLE');
      expect(e.appError.remediation).toBe('start it');
    }
  });

  it('maps engine-pack / cloud statuses to 424-class codes', () => {
    const grab = (status: 'engine-pack-missing' | 'cloud-key-missing') => {
      try {
        assertRunReady([{ phase: 'tts', providerId: 'x', status, ready: false, message: 'm' }]);
      } catch (err) {
        return (err as AppErrorException).appError.code;
      }
      return undefined;
    };
    expect(grab('engine-pack-missing')).toBe('ENGINE_PACK_MISSING');
    expect(grab('cloud-key-missing')).toBe('CLOUD_CREDENTIALS_MISSING');
  });
});

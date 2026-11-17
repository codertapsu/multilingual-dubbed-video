import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException, type Project } from '@videodubber/shared';
import type { CredentialsStore } from '../credentials/credentialsStore.js';
import { EnginePackStore } from '../engines/enginePackStore.js';
import { recommendedPackFor } from '../engines/packSelection.js';
import {
  assertRunReady,
  checkProviderReadiness,
  downloadStartedReadiness,
  selfInstallingModelPack,
  type OllamaProbe,
  type ReadinessDeps,
} from './readiness.js';
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
      packUsable: async () => true, // venv present + runnable
    });
    expect(results.find((x) => x.phase === 'tts')!.ready).toBe(true);
  });

  it('reports an installed-but-broken pack (missing venv) as engine-pack-missing', async () => {
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

    const results = await checkProviderReadiness(project, {
      registry: r,
      credentials: fakeCreds([]),
      enginePackStore: installedPacks,
      packUsable: async () => false, // recorded but venv missing/broken
    });
    const tts = results.find((x) => x.phase === 'tts')!;
    expect(tts.ready).toBe(false);
    expect(tts.status).toBe('engine-pack-missing');
    expect(tts.message).toContain('incomplete');
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

describe('model-presence run gate', () => {
  const fullProject = {
    settings: {
      sttProviderId: 'faster-whisper',
      sttModel: 'small',
      translationProviderId: 'argos',
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      ttsProviderId: 'piper-local',
      ttsVoiceId: 'vi_VN-vais1000-medium',
    },
  } as unknown as Project;
  const reg = (): ProviderRegistry => registryWith(fakeTranslation({ id: 'argos' }));

  it('blocks the STT phase when its Whisper model is not downloaded yet', async () => {
    const results = await checkProviderReadiness(fullProject, {
      registry: reg(),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      installedModels: async () => ({
        whisperModels: [],
        argosPairs: [{ from: 'en', to: 'vi' }],
        piperVoices: ['vi_VN-vais1000-medium'],
      }),
    });
    const stt = results.find((r) => r.phase === 'stt')!;
    expect(stt.ready).toBe(false);
    expect(stt.status).toBe('model-missing');
    // The other phases (their models present) stay ready.
    expect(results.find((r) => r.phase === 'translation')!.ready).toBe(true);
    expect(results.find((r) => r.phase === 'tts')!.ready).toBe(true);
  });

  it('is ready once every default model is installed', async () => {
    const results = await checkProviderReadiness(fullProject, {
      registry: reg(),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
      installedModels: async () => ({
        whisperModels: ['small'],
        argosPairs: [{ from: 'en', to: 'vi' }],
        piperVoices: ['vi_VN-vais1000-medium'],
      }),
    });
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('does not gate models when installedModels is not wired (back-compat)', async () => {
    const results = await checkProviderReadiness(fullProject, {
      registry: reg(),
      credentials: fakeCreds([]),
      enginePackStore: noPacks,
    });
    expect(results.every((r) => r.ready)).toBe(true);
  });
});

describe('managed llama.cpp (TranslateGemma) readiness', () => {
  let dir: string;
  let store: EnginePackStore;
  const runtimePackId = recommendedPackFor('local-llm')?.id; // platform-specific (metal/cuda/vulkan/linux)

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-rd-llm-'));
    store = new EnginePackStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const llamaProject = projectWith('llama-cpp');
  const reg = () => registryWith(fakeTranslation({ id: 'llama-cpp', displayName: 'TranslateGemma (built-in)' }));
  const installRuntime = async (): Promise<void> => {
    const p = store.packDir(runtimePackId!);
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server'), '#!/bin/sh\n');
    await store.add({ id: runtimePackId!, path: p, installedAt: '2026-01-01T00:00:00Z' });
  };
  const installModel = async (): Promise<void> => {
    const p = store.packDir('translategemma-4b');
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-4b', path: p, installedAt: '2026-01-01T00:00:00Z' });
  };

  it('flags the runtime engine pack as missing when nothing is installed', async () => {
    if (!runtimePackId) return; // no llama.cpp pack on this platform
    const results = await checkProviderReadiness(llamaProject, { registry: reg(), credentials: fakeCreds([]), enginePackStore: store });
    const t = results.find((r) => r.phase === 'translation')!;
    expect(t.ready).toBe(false);
    expect(t.status).toBe('engine-pack-missing');
    expect(t.message).toMatch(/runtime/);
  });

  it('flags the MODEL as missing when the runtime is installed but no model pack is', async () => {
    if (!runtimePackId) return;
    await installRuntime();
    const results = await checkProviderReadiness(llamaProject, { registry: reg(), credentials: fakeCreds([]), enginePackStore: store });
    const t = results.find((r) => r.phase === 'translation')!;
    expect(t.ready).toBe(false);
    expect(t.status).toBe('engine-pack-missing');
    expect(t.message).toMatch(/no TranslateGemma model/i);
    expect(t.action?.ref).toBe('translategemma-4b');
  });

  it('is ready once both the runtime and a model pack are installed', async () => {
    if (!runtimePackId) return;
    await installRuntime();
    await installModel();
    const results = await checkProviderReadiness(llamaProject, { registry: reg(), credentials: fakeCreds([]), enginePackStore: store });
    expect(results.find((r) => r.phase === 'translation')!.ready).toBe(true);
  });
});

// The run gate used to check only whisper.cpp's RUNTIME, so a project whose
// speech model was never downloaded started anyway and died at step 3 with
// "failed to open 'models/ggml-base.en.bin'". Runs on every OS: whisper.cpp is
// Windows-only, so the platform is passed rather than read from the host.
describe('whisper.cpp readiness (runtime + the project’s speech model)', () => {
  let dir: string;
  let store: EnginePackStore;
  const win = { platform: 'win32' as const, arch: 'x64' };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-rd-whisper-'));
    store = new EnginePackStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const registry = (): ProviderRegistry => {
    const r = new ProviderRegistry();
    r.registerStt({
      id: 'whisper-cpp',
      displayName: 'whisper.cpp (accelerated, local)',
      isLocal: true,
      requiresEnginePack: 'whisper-cpp',
      transcribe: async () => ({ segments: [], detectedLanguage: '', durationMs: 0 }),
    } as never);
    r.registerTranslation(fakeTranslation({ id: 'argos' }));
    r.registerTts(new FakeTtsProvider());
    return r;
  };
  const project = (sttModel?: string): Project =>
    ({
      settings: {
        sttProviderId: 'whisper-cpp',
        ...(sttModel ? { sttModel } : {}),
        translationProviderId: 'argos',
        ttsProviderId: 'piper-local',
      },
    }) as unknown as Project;
  const install = async (id: string, file?: string): Promise<void> => {
    const p = store.packDir(id);
    await mkdir(p, { recursive: true });
    if (file) await writeFile(path.join(p, file), 'x');
    await store.add({ id, path: p, installedAt: '2026-11-17T00:00:00Z' });
  };
  const stt = async (sttModel: string | undefined, extra: Partial<ReadinessDeps> = {}) =>
    (await checkProviderReadiness(project(sttModel), {
      registry: registry(),
      credentials: fakeCreds([]),
      enginePackStore: store,
      ...win,
      ...extra,
    })).find((r) => r.phase === 'stt')!;

  it('asks for the runtime first', async () => {
    const r = await stt('large-v3-turbo');
    expect(r.ready).toBe(false);
    expect(r.status).toBe('engine-pack-missing');
    expect(r.action).toEqual({ kind: 'install-pack', ref: 'whisper-cpp-cuda' });
  });

  it('with the runtime but not the model, names the model and its size, and offers it', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    const r = await stt('large-v3-turbo');
    expect(r.ready).toBe(false);
    expect(r.status).toBe('engine-pack-missing');
    expect(r.message).toContain('"large-v3-turbo"');
    expect(r.message).toContain('1.5 GB');
    expect(r.action).toEqual({ kind: 'install-pack', ref: 'whisper-model-large-v3-turbo' });
    // ...which is what the run gate downloads by itself at Start.
    expect(selfInstallingModelPack(r)).toBe('whisper-model-large-v3-turbo');
    const started = downloadStartedReadiness(r, 'whisper-model-large-v3-turbo');
    expect(started).toMatchObject({ ready: false, status: 'model-missing' });
    expect(started.message).toMatch(/"large-v3-turbo" \(about 1\.5 GB\) is downloading/);
  });

  it('says "downloading" while the model is already being fetched', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    const r = await stt('large-v3-turbo', { packInstalling: (id) => id === 'whisper-model-large-v3-turbo' });
    expect(r).toMatchObject({ ready: false, status: 'model-missing' });
    expect(r.message).toMatch(/is downloading/);
    // Already on its way: nothing more to start.
    expect(selfInstallingModelPack(r)).toBeUndefined();
  });

  it('is ready with the runtime and the project’s own model', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    await install('whisper-model-large-v3-turbo', 'model.bin');
    expect((await stt('large-v3-turbo')).ready).toBe(true);
  });

  it('another installed size does not stand in for the project’s model', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    await install('whisper-model-large-v3-turbo', 'model.bin');
    const r = await stt('medium');
    expect(r.ready).toBe(false);
    expect(r.action?.ref).toBe('whisper-model-medium');
  });

  it('defaults to the runner’s "small" when the project never chose a model', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    expect((await stt(undefined)).action?.ref).toBe('whisper-model-small');
  });

  it('refuses a faster-whisper-only model with an explanation, and starts no download', async () => {
    await install('whisper-cpp-cuda', 'whisper-server.exe');
    const r = await stt('phowhisper-medium');
    expect(r).toMatchObject({ ready: false, status: 'model-missing' });
    expect(r.message).toMatch(/cannot run the "phowhisper-medium"/);
    expect(r.remediation).toMatch(/faster-whisper/);
    expect(r.action?.kind).not.toBe('install-pack');
    expect(selfInstallingModelPack(r)).toBeUndefined();
  });

  it('never self-installs a runtime, or any other provider’s pack', () => {
    const base = { phase: 'stt' as const, ready: false, status: 'engine-pack-missing' as const, message: '' };
    expect(selfInstallingModelPack({ ...base, providerId: 'whisper-cpp', action: { kind: 'install-pack', ref: 'whisper-cpp-cuda' } })).toBeUndefined();
    expect(selfInstallingModelPack({ ...base, providerId: 'llama-cpp', action: { kind: 'install-pack', ref: 'translategemma-4b' } })).toBeUndefined();
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

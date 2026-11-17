import { describe, expect, it } from 'vitest';
import type { ProviderDefaults } from '@videodubber/shared';
import { recommendProjectSettings, type Phase } from './projectDefaults.js';

/** A machine described by which providers are usable. */
function machine(usableIds: string[], saved: ProviderDefaults = {}, recommendedModel = 'large-v3-turbo') {
  const asked: string[] = [];
  return {
    asked,
    deps: {
      providerDefaults: async () => saved,
      usable: async (phase: Phase | 'refine', id: string) => {
        asked.push(`${phase}:${id}`);
        return usableIds.includes(id);
      },
      recommendedSttModel: async () => recommendedModel,
    },
  };
}

const ALL_LOCAL = ['faster-whisper', 'argos', 'piper-local'];

describe('recommendProjectSettings', () => {
  it('uses the GPU engines the user installed (the RTX 3050 case from the hardware audit)', async () => {
    const m = machine([...ALL_LOCAL, 'whisper-cpp', 'llama-cpp', 'llama-cpp-chat', 'neural-tts']);
    const { settings, notes } = await recommendProjectSettings(m.deps, { sourceLanguage: 'zh', targetLanguage: 'vi-VN' });
    expect(settings).toMatchObject({
      sourceLanguage: 'zh',
      targetLanguage: 'vi-VN',
      sttProviderId: 'whisper-cpp',
      sttModel: 'large-v3-turbo',
      translationProviderId: 'llama-cpp',
      refineProviderId: 'llama-cpp-chat',
      ttsProviderId: 'neural-tts',
      autoSelectedPhases: ['stt', 'translation', 'tts'],
    });
    expect(notes.join('\n')).toMatch(/whisper\.cpp on the graphics card/);
    expect(notes.join('\n')).toMatch(/re-reads the whole translation/);
  });

  it('keeps a saved choice that still works, and marks nothing as auto-picked for it', async () => {
    const m = machine([...ALL_LOCAL, 'whisper-cpp', 'anthropic-translate'], {
      sttProviderId: 'faster-whisper',
      translationProviderId: 'anthropic-translate',
      sttModel: 'medium',
    });
    const { settings } = await recommendProjectSettings(m.deps, { targetLanguage: 'en-US' });
    expect(settings.sttProviderId).toBe('faster-whisper');
    expect(settings.sttModel).toBe('medium');
    expect(settings.translationProviderId).toBe('anthropic-translate');
    // A context-aware translator needs no review pass on top.
    expect(settings.refineProviderId).toBeUndefined();
    expect(settings.autoSelectedPhases).toBeUndefined();
  });

  it('replaces a saved choice that can no longer run (its key or pack was removed)', async () => {
    const m = machine([...ALL_LOCAL, 'whisper-cpp'], { sttProviderId: 'openai-stt', translationProviderId: 'gemini-translate' });
    const { settings } = await recommendProjectSettings(m.deps, { targetLanguage: 'vi-VN' });
    expect(settings.sttProviderId).toBe('whisper-cpp');
    expect(settings.translationProviderId).toBe('argos');
  });

  it('keeps faster-whisper for a speech model whisper.cpp has no build of', async () => {
    const m = machine([...ALL_LOCAL, 'whisper-cpp'], { sttModel: 'phowhisper-medium' });
    const { settings } = await recommendProjectSettings(m.deps, { targetLanguage: 'vi-VN' });
    expect(settings.sttProviderId).toBe('faster-whisper');
    expect(settings.sttModel).toBe('phowhisper-medium');
  });

  it('adds the review pass to a context-free translator, and uses the chat model alone when it is all there is', async () => {
    const withChat = machine([...ALL_LOCAL, 'llama-cpp-chat']);
    const a = await recommendProjectSettings(withChat.deps, { targetLanguage: 'vi-VN' });
    expect(a.settings.translationProviderId).toBe('llama-cpp-chat');
    expect(a.settings.refineProviderId).toBeUndefined();

    const savedArgos = machine([...ALL_LOCAL, 'llama-cpp-chat'], { translationProviderId: 'argos' });
    const b = await recommendProjectSettings(savedArgos.deps, { targetLanguage: 'vi-VN' });
    expect(b.settings.translationProviderId).toBe('argos');
    expect(b.settings.refineProviderId).toBe('llama-cpp-chat');
  });

  it('a fresh CPU-only machine gets the built-in engines and the recommended model', async () => {
    const m = machine(ALL_LOCAL, {}, 'large-v3-turbo');
    const { settings, notes } = await recommendProjectSettings(m.deps, { targetLanguage: 'vi-VN' });
    expect(settings).toMatchObject({
      sttProviderId: 'faster-whisper',
      sttModel: 'large-v3-turbo',
      translationProviderId: 'argos',
      ttsProviderId: 'piper-local',
    });
    expect(settings.refineProviderId).toBeUndefined();
    expect(settings.autoSelectedPhases).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it('VieNeu is a Vietnamese voice: other dub languages keep Piper', async () => {
    const m = machine([...ALL_LOCAL, 'neural-tts']);
    const { settings } = await recommendProjectSettings(m.deps, { targetLanguage: 'en-US' });
    expect(settings.ttsProviderId).toBe('piper-local');
  });
});

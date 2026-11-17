/**
 * Run admission vs the GPU voice pack.
 *
 * VieNeu has a light CPU pack and a GPU pack under ONE launch spec, so the spec
 * says "not heavy". The GPU build holds VRAM and takes the heavy lane when it
 * synthesizes (engineManager isHeavyPack); if admission did not know that, a
 * second dub could start beside a TranslateGemma run and fail at step 6 with
 * ENGINE_BUSY, or two models could fight over an 8 GB card.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectSettings } from '@videodubber/shared';
import { classifyWorkload, lastHeavyStep } from './workload.js';
import { isGpuPack, isHeavyPack } from '../engines/engineManager.js';
import type { ProviderRegistry } from '../providers/registry.js';

const local = (requiresEnginePack?: string) => ({
  isLocal: true,
  ...(requiresEnginePack ? { requiresEnginePack } : {}),
});

/** A registry whose TTS is the VieNeu provider and everything else is built in. */
const registry = {
  getStt: () => local(),
  getTranslation: () => local(),
  getTts: () => local('neural-tts'),
} as unknown as ProviderRegistry;

const settings = {
  sttProviderId: 'faster-whisper',
  translationProviderId: 'argos',
  ttsProviderId: 'neural-tts',
} as ProjectSettings;

describe('classifyWorkload and the GPU voice pack', () => {
  it('treats VieNeu as light when only the CPU pack is installed', () => {
    expect(classifyWorkload(settings, registry).needsHeavyEngine).toBe(false);
  });

  it('admits a VieNeu run as heavy when its family runs on a GPU here', () => {
    const w = classifyWorkload(settings, registry, { gpuFamilies: new Set(['neural-tts']) });
    expect(w.needsHeavyEngine).toBe(true);
    expect(w.heavyFamily).toBe('neural-tts');
  });

  it('does not take the lane for a retry that never reaches the voice step', () => {
    const w = classifyWorkload(settings, registry, {
      gpuFamilies: new Set(['neural-tts']),
      fromStep: 'render',
    });
    expect(w.needsHeavyEngine).toBe(false);
  });
});

describe('classifyWorkload and the context engine', () => {
  // Argos + Piper is light by its providers, but with the Gemma chat installed
  // its repairs and auto-fit start llama.cpp, which takes the heavy lane.
  const lightSettings = { ...settings, ttsProviderId: 'piper-local' } as ProjectSettings;
  const lightRegistry = { ...registry, getTts: () => local() } as unknown as ProviderRegistry;
  const gemmaChat = local('local-llm');

  it('admits a light run as heavy when its context work runs on the local chat model', () => {
    expect(classifyWorkload(lightSettings, lightRegistry).needsHeavyEngine).toBe(false);
    const w = classifyWorkload(lightSettings, lightRegistry, { contextEngine: gemmaChat });
    expect(w.needsHeavyEngine).toBe(true);
    expect(w.heavyFamily).toBe('local-llm');
  });

  it('keeps the lane free when the run never reaches a step that uses it', () => {
    expect(
      classifyWorkload(lightSettings, lightRegistry, { contextEngine: gemmaChat, fromStep: 'audio-mix' }).needsHeavyEngine,
    ).toBe(false);
    // From alignment, only auto-fit would use it.
    const noAutoFit = { ...lightSettings, autoFitOverflow: false } as ProjectSettings;
    expect(classifyWorkload(noAutoFit, lightRegistry, { contextEngine: gemmaChat, fromStep: 'alignment' }).needsHeavyEngine).toBe(
      false,
    );
    expect(
      classifyWorkload(lightSettings, lightRegistry, { contextEngine: gemmaChat, fromStep: 'alignment' }).needsHeavyEngine,
    ).toBe(true);
  });

  it('leaves a cloud run cloud-only when its context engine is a cloud model', () => {
    const cloud = { getStt: () => ({ isLocal: false }), getTranslation: () => ({ isLocal: false }), getTts: () => ({ isLocal: false }) };
    const w = classifyWorkload(settings, cloud as unknown as ProviderRegistry, { contextEngine: { isLocal: false } });
    expect(w).toMatchObject({ needsHeavyEngine: false, cloudOnly: true });
  });
});

describe('lastHeavyStep', () => {
  it('is alignment (auto-fit re-translates and re-voices), or audio-mix when vocal separation runs there', () => {
    expect(lastHeavyStep(settings)).toBe('alignment');
    expect(lastHeavyStep({ ...settings, originalAudioMode: 'replace-vocals' })).toBe('audio-mix');
    // No separation engine wired: the mix falls back to ducking, which is ffmpeg only.
    expect(lastHeavyStep({ ...settings, originalAudioMode: 'replace-vocals' }, { separationAvailable: false })).toBe('alignment');
  });
});

describe('isHeavyPack', () => {
  it('counts a GPU pack as heavy even when its family spec is light', () => {
    expect(isGpuPack('tts-neural-cuda')).toBe(true);
    expect(isHeavyPack('tts-neural-cuda', 'neural-tts')).toBe(true);
    expect(isHeavyPack('tts-neural', 'neural-tts')).toBe(false);
    // Families that were heavy stay heavy, whatever the accelerator.
    expect(isHeavyPack('llama-cpp-vulkan', 'local-llm')).toBe(true);
  });
});

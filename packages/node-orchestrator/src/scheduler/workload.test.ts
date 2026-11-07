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
import { classifyWorkload } from './workload.js';
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

describe('isHeavyPack', () => {
  it('counts a GPU pack as heavy even when its family spec is light', () => {
    expect(isGpuPack('tts-neural-cuda')).toBe(true);
    expect(isHeavyPack('tts-neural-cuda', 'neural-tts')).toBe(true);
    expect(isHeavyPack('tts-neural', 'neural-tts')).toBe(false);
    // Families that were heavy stay heavy, whatever the accelerator.
    expect(isHeavyPack('llama-cpp-vulkan', 'local-llm')).toBe(true);
  });
});

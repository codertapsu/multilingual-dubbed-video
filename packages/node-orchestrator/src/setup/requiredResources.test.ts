import { describe, expect, it } from 'vitest';
import type { InstalledModels, ProjectSettings } from '@videodubber/shared';
import { computeRequiredResources, hasRequiredResources } from './requiredResources.js';

const empty: InstalledModels = { whisperModels: [], argosPairs: [], piperVoices: [] };

function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    sourceLanguage: 'en-US',
    targetLanguage: 'vi-VN',
    subtitleExportMode: 'srt-file',
    processingMode: 'local',
    sttProviderId: 'faster-whisper',
    translationProviderId: 'argos',
    ttsProviderId: 'piper-local',
    sttModel: 'small',
    includeOriginalBackgroundAudio: true,
    duckOriginalAudio: true,
    duckingLevelDb: -12,
    ttsGainDb: 0,
    maxSpeedRatio: 1.6,
    allowedOverflowMs: 1500,
    ...overrides,
  };
}

describe('computeRequiredResources', () => {
  it('lists the whisper model + argos pair when nothing is installed', () => {
    const req = computeRequiredResources(settings(), empty);
    expect(req.whisperModel).toBe('small');
    expect(req.argosPairs).toEqual([{ from: 'en', to: 'vi' }]);
    expect(req.piperVoices).toBeUndefined(); // no explicit voice
    expect(hasRequiredResources(req)).toBe(true);
  });

  it('omits resources that are already installed', () => {
    const installed: InstalledModels = {
      whisperModels: ['small'],
      argosPairs: [{ from: 'en', to: 'vi' }],
      piperVoices: [],
    };
    const req = computeRequiredResources(settings(), installed);
    expect(req.whisperModel).toBeUndefined();
    expect(req.argosPairs).toBeUndefined();
    expect(hasRequiredResources(req)).toBe(false);
  });

  it('includes an explicitly-chosen Piper voice when missing', () => {
    const req = computeRequiredResources(settings({ ttsVoiceId: 'vi_VN-vais1000-medium' }), empty);
    expect(req.piperVoices).toEqual(['vi_VN-vais1000-medium']);
  });

  it('skips non-local providers (cloud / Ollama / whisper.cpp bring their own)', () => {
    const req = computeRequiredResources(
      settings({ sttProviderId: 'openai-stt', translationProviderId: 'ollama', ttsProviderId: 'openai-tts' }),
      empty,
    );
    expect(hasRequiredResources(req)).toBe(false);
  });

  it('does not request a same-language argos pair', () => {
    const req = computeRequiredResources(settings({ sourceLanguage: 'en-US', targetLanguage: 'en-GB' }), empty);
    expect(req.argosPairs).toBeUndefined();
  });
});

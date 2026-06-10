import { describe, expect, it } from 'vitest';
import { COMMON_LANGUAGES } from '@videodubber/shared';
import {
  ARGOS_AVAILABLE,
  PIPER_VOICES,
  WHISPER_MODELS,
  buildCatalog,
  findPiperVoice,
  findWhisperModel,
} from './catalog.js';

describe('setup catalog shape', () => {
  it('builds a catalog with all four sections populated', () => {
    const catalog = buildCatalog();
    expect(catalog.whisperModels.length).toBeGreaterThan(0);
    expect(catalog.languages.length).toBeGreaterThan(0);
    expect(catalog.argosAvailable.length).toBeGreaterThan(0);
    expect(catalog.piperVoices.length).toBeGreaterThan(0);
  });

  it('exposes the COMMON_LANGUAGES list as catalog.languages', () => {
    const catalog = buildCatalog();
    expect(catalog.languages).toEqual([...COMMON_LANGUAGES]);
  });

  it('returns fresh array copies (not the frozen module constants)', () => {
    const catalog = buildCatalog();
    expect(catalog.whisperModels).not.toBe(WHISPER_MODELS);
    expect(catalog.argosAvailable).not.toBe(ARGOS_AVAILABLE);
    expect(catalog.piperVoices).not.toBe(PIPER_VOICES);
  });

  it('offers the standard whisper tiers including a single recommended', () => {
    const ids = WHISPER_MODELS.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['tiny', 'base', 'small', 'medium', 'large-v3']));
    const recommended = WHISPER_MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]?.id).toBe('base');
  });

  it('every whisper model has a positive approx size', () => {
    for (const model of WHISPER_MODELS) {
      expect(model.approxSizeMb).toBeGreaterThan(0);
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  it('includes the en->vi Argos pair (and others)', () => {
    expect(ARGOS_AVAILABLE).toEqual(
      expect.arrayContaining([
        { from: 'en', to: 'vi' },
        { from: 'en', to: 'es' },
        { from: 'en', to: 'fr' },
        { from: 'en', to: 'de' },
      ]),
    );
  });

  it('includes the Vietnamese vais1000 Piper voice with HuggingFace resolve URLs', () => {
    const vi = findPiperVoice('vi_VN-vais1000-medium');
    expect(vi).toBeDefined();
    expect(vi?.language).toBe('vi-VN');
    expect(vi?.url).toContain('huggingface.co/rhasspy/piper-voices/resolve/main');
    expect(vi?.url).toMatch(/vi_VN-vais1000-medium\.onnx$/);
    expect(vi?.configUrl).toBe(`${vi?.url}.json`);
  });

  it('every piper voice has matching .onnx / .onnx.json URLs and a size', () => {
    for (const voice of PIPER_VOICES) {
      expect(voice.url).toMatch(/\.onnx$/);
      expect(voice.configUrl).toBe(`${voice.url}.json`);
      expect(voice.approxSizeMb).toBeGreaterThan(0);
      expect(voice.id.length).toBeGreaterThan(0);
    }
  });

  it('finders return undefined for unknown ids', () => {
    expect(findPiperVoice('nope')).toBeUndefined();
    expect(findWhisperModel('nope')).toBeUndefined();
    expect(findWhisperModel('base')?.id).toBe('base');
  });
});

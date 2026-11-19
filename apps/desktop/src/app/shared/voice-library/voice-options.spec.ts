import { describe, expect, it } from 'vitest';
import type { VoiceLibraryItem } from '../../core/models';
import { keptVoice, libraryEngineFor, voiceOptions } from './voice-options';

const voice = (over: Partial<VoiceLibraryItem> & { id: string }): VoiceLibraryItem => ({
  kind: 'preset',
  engine: 'piper',
  name: over.id,
  languages: ['vi-VN'],
  license: { category: 'permissive', label: 'CC0' },
  sizeMb: 60,
  hasPreview: true,
  installed: false,
  engineInstalled: true,
  engineAvailable: true,
  favorite: false,
  ...over,
});

const LIB: VoiceLibraryItem[] = [
  voice({ id: 'vieneu-v3-duc-tri', engine: 'vieneu-classic', name: 'Đức Trí' }),
  voice({ id: 'vieneu38-hai-dang', engine: 'vieneu', name: 'Hải Đăng', recommended: true }),
  voice({ id: 'vieneu38-thuc-doan', engine: 'vieneu', name: 'Thục Đoan' }),
  voice({ id: 'openai-alloy', engine: 'openai', name: 'Alloy', languages: ['*'] }),
  voice({ id: 'kokoro-af_alloy', engine: 'kokoro', name: 'Alloy', languages: ['en-US'] }),
];

describe('libraryEngineFor', () => {
  it('names the library engines, OpenAI included', () => {
    expect(libraryEngineFor('vieneu-tts')).toBe('vieneu');
    expect(libraryEngineFor('zerotts')).toBe('zerotts');
    expect(libraryEngineFor('openai-tts')).toBe('openai');
  });

  it('leaves the engines with their own voice catalog (and unknown ones) to it', () => {
    expect(libraryEngineFor('piper-local')).toBeNull();
    expect(libraryEngineFor('neural-tts')).toBeNull();
    expect(libraryEngineFor('omnivoice')).toBeNull();
    expect(libraryEngineFor(undefined)).toBeNull();
  });
});

describe('voiceOptions', () => {
  const ids = (engine: Parameters<typeof voiceOptions>[1], language: string) =>
    voiceOptions(LIB, engine, language, (v) => v.name).map((v) => v.id);

  it("lists only the engine's own voices: never a VieNeu v3 voice under VieNeu-TTS 3.8", () => {
    expect(ids('vieneu', 'vi-VN')).toEqual(['vieneu38-hai-dang', 'vieneu38-thuc-doan']);
  });

  it('offers multilingual voices for any language, and nothing an engine lacks', () => {
    expect(ids('openai', 'vi-VN')).toEqual(['openai-alloy']);
    expect(ids('kokoro', 'vi-VN')).toEqual([]);
  });
});

describe('keptVoice', () => {
  const offered = [{ id: 'vieneu38-thuc-doan' }, { id: 'vieneu38-hai-dang', recommended: true }];

  it('keeps the chosen voice while the engine still offers it', () => {
    expect(keptVoice('vieneu38-thuc-doan', offered)).toBe('vieneu38-thuc-doan');
  });

  it("replaces a voice the options do not list (another engine's) with the recommended one", () => {
    expect(keptVoice('vieneu-v3-duc-tri', offered)).toBe('vieneu38-hai-dang');
    expect(keptVoice(undefined, offered)).toBe('vieneu38-hai-dang');
  });

  it('falls back to the first voice, or to none', () => {
    expect(keptVoice('x', [{ id: 'a' }, { id: 'b' }])).toBe('a');
    expect(keptVoice('vieneu-v3-duc-tri', [])).toBeUndefined();
  });
});

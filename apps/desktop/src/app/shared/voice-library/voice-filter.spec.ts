import { describe, expect, it } from 'vitest';
import type { VoiceLibraryItem } from '../../core/models';
import {
  describeVoice,
  EMPTY_FILTER,
  filterVoices,
  foldText,
  languageOptions,
  licenseTone,
  matchesFilter,
  speaks,
} from './voice-filter';

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
  voice({ id: 'vi_VN-vais1000-medium', name: 'vais1000', recommended: true, installed: true }),
  voice({ id: 'vieneu38-hai-dang', engine: 'vieneu', name: 'Hải Đăng', gender: 'male', accent: 'north', recommended: true }),
  voice({ id: 'vieneu38-thuc-doan', engine: 'vieneu', name: 'Thục Đoan', gender: 'female', accent: 'south' }),
  voice({ id: 'zerotts-maichi', engine: 'zerotts', name: 'Mai Chi', gender: 'female', tags: ['trẻ', 'kể chuyện'] }),
  voice({
    id: 'en_GB-vctk-medium',
    name: 'vctk',
    languages: ['en-GB'],
    speakers: [{ index: 0, name: 'p225' }],
    license: { category: 'attribution', label: 'CC BY 4.0' },
  }),
  voice({ id: 'kokoro-af_heart', engine: 'kokoro', name: 'Heart', languages: ['en-US'], recommended: true }),
  voice({ id: 'supertonic-f1', engine: 'supertonic', name: 'F1', languages: ['en', 'vi', 'ko'], license: { category: 'use-restricted', label: 'OpenRAIL-M' } }),
  voice({ id: 'openai-alloy', engine: 'openai', name: 'Alloy', languages: ['*'], license: { category: 'service-terms', label: 'OpenAI terms' } }),
];

describe('voice filter', () => {
  it('matches languages on the base subtag; "*" speaks everything', () => {
    expect(speaks(LIB[0]!, 'vi')).toBe(true);
    expect(speaks(LIB[0]!, 'vi_VN')).toBe(true);
    expect(speaks(LIB[4]!, 'vi')).toBe(false);
    expect(speaks(LIB[7]!, 'ja')).toBe(true);
  });

  it('searches without diacritics, in tags and speaker names', () => {
    expect(foldText('Hải Đăng')).toBe('hai dang');
    const hit = (query: string) => filterVoices(LIB, { ...EMPTY_FILTER, query }).map((v) => v.id);
    expect(hit('hai dang')).toEqual(['vieneu38-hai-dang']);
    expect(hit('ke chuyen')).toEqual(['zerotts-maichi']);
    expect(hit('p225')).toEqual(['en_GB-vctk-medium']);
  });

  it('combines filters with AND', () => {
    const f = { ...EMPTY_FILTER, language: 'vi', gender: 'female' as const, accent: 'south' as const };
    expect(filterVoices(LIB, f).map((v) => v.id)).toEqual(['vieneu38-thuc-doan']);
    expect(matchesFilter(LIB[0]!, { ...EMPTY_FILTER, installedOnly: true })).toBe(true);
    expect(matchesFilter(LIB[1]!, { ...EMPTY_FILTER, installedOnly: true })).toBe(false);
    expect(filterVoices(LIB, { ...EMPTY_FILTER, license: 'use-restricted' }).map((v) => v.id)).toEqual(['supertonic-f1']);
  });

  it('orders a Vietnamese list: favourites, recommended, installed, then the Vietnamese engines', () => {
    const lib = LIB.map((v) => (v.id === 'zerotts-maichi' ? { ...v, favorite: true } : v));
    const ids = filterVoices(lib, { ...EMPTY_FILTER, language: 'vi' }).map((v) => v.id);
    expect(ids[0]).toBe('zerotts-maichi');
    // Both recommended: the installed Piper voice first, then VieNeu.
    expect(ids.slice(1, 3)).toEqual(['vi_VN-vais1000-medium', 'vieneu38-hai-dang']);
    expect(ids.indexOf('vieneu38-thuc-doan')).toBeLessThan(ids.indexOf('supertonic-f1'));
  });

  it('lists languages with the UI language first, then by voice count', () => {
    const opts = languageOptions(LIB, 'vi');
    expect(opts[0]).toEqual({ code: 'vi', count: 5 });
    expect(opts.map((o) => o.code)).toContain('ko');
    expect(opts.find((o) => o.code === 'en')?.count).toBe(3);
  });

  it('colours every licence category', () => {
    expect(licenseTone('permissive')).toBe('completed');
    expect(licenseTone('non-commercial')).toBe('failed');
    expect(licenseTone('use-restricted')).toBe('warning');
    expect(licenseTone('unknown')).toBe('skipped');
  });

  it("labels a cloned voice, and one from the project's video, as such", () => {
    const t = (k: string) => ({ 'voices.label-cloned': 'cloned', 'voices.label-from-video': 'from this video', 'voices.female': 'Female' })[k] ?? k;
    expect(describeVoice(LIB[2]!, t)).toBe('Thục Đoan — Female · voices.accent-south');
    const mine = voice({ id: 'vp_1', kind: 'profile', engine: 'vieneu', name: 'Me', scope: { kind: 'library' } });
    expect(describeVoice(mine, t)).toBe('Me — cloned');
    const speaker = voice({ id: 'vp_2', kind: 'profile', engine: 'vieneu', name: 'Speaker 1', scope: { kind: 'project', projectId: 'p' } });
    expect(describeVoice(speaker, t)).toBe('Speaker 1 — from this video');
  });
});

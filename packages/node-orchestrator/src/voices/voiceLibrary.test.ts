import { describe, expect, it } from 'vitest';
import { VOICE_ENGINE_PROVIDER, voiceEngineOfId, type VoiceProfile } from '@videodubber/shared';
import {
  allCatalogVoices,
  findCatalogVoice,
  VOICE_CATALOGS,
  VOICE_ENGINES,
  voiceEngineOfPack,
  voiceSpeaks,
} from './voiceCatalog.js';
import { foldText, libraryItems, queryVoices, type VoiceLibraryState } from './voiceLibrary.js';
// The same validator `pnpm check` runs over these files.
// @ts-expect-error -- plain .mjs script without type declarations
import { checkCatalogs } from '../../../../scripts/check-voice-catalog.mjs';

const state = (over: Partial<VoiceLibraryState> = {}): VoiceLibraryState => ({
  installedPiper: new Set(),
  installedPacks: new Set(),
  availablePacks: new Set(['tts-neural', 'tts-vieneu']),
  favorites: new Set(),
  cloudServices: new Set(),
  ...over,
});

describe('voice catalog', () => {
  it('passes the catalog check that pnpm check runs', () => {
    const catalogs = VOICE_CATALOGS.map((c) => [`${c.engine}.json`, c]);
    expect(checkCatalogs(catalogs)).toEqual([]);
  });

  it("routes every id to its own engine by prefix, as projects store only the id", () => {
    for (const v of allCatalogVoices()) expect(voiceEngineOfId(v.id), v.id).toBe(v.engine);
  });

  it('keeps every voice the app has shipped, under its old id', () => {
    for (const id of [
      'vieneu-v3-ngoc-lan',
      'vieneu-v3-gia-bao',
      'vieneu-v3-trong-huu',
      'vieneu-v3-binh-an',
      'vieneu-v3-ngoc-linh',
      'vi_VN-vais1000-medium',
      'en_US-lessac-medium',
    ]) {
      expect(findCatalogVoice(id), id).toBeDefined();
    }
    expect(allCatalogVoices().filter((v) => v.engine === 'vieneu-classic')).toHaveLength(10);
  });

  it('offers the 25 voices of VieNeu 3.8, with "Hải Đăng" as its default', () => {
    const v38 = allCatalogVoices().filter((v) => v.engine === 'vieneu');
    expect(v38).toHaveLength(25);
    expect(v38.filter((v) => v.recommended).map((v) => v.name)).toEqual(['Hải Đăng']);
    expect(new Set(v38.map((v) => v.accent))).toEqual(new Set(['north', 'central', 'south']));
  });

  it('resolves a Piper speaker id to its model, only for a speaker it has', () => {
    expect(findCatalogVoice('vi_VN-vivos-x_low#3')?.id).toBe('vi_VN-vivos-x_low');
    expect(findCatalogVoice('vi_VN-vivos-x_low#9999')).toBeUndefined();
    expect(findCatalogVoice('vi_VN-vais1000-medium#1')).toBeUndefined(); // single speaker
  });

  it('matches languages on the base subtag, and "*" matches all', () => {
    expect(voiceSpeaks({ languages: ['vi-VN'] }, 'vi')).toBe(true);
    expect(voiceSpeaks({ languages: ['vi-VN'] }, 'vi_VN')).toBe(true);
    expect(voiceSpeaks({ languages: ['en-US'] }, 'vi')).toBe(false);
    expect(voiceSpeaks({ languages: ['*'] }, 'ko')).toBe(true);
  });

  it('names the provider of each engine, and the engine of each pack', () => {
    for (const e of VOICE_ENGINES) expect(e.providerId).toBe(VOICE_ENGINE_PROVIDER[e.id]);
    expect(voiceEngineOfPack('tts-neural')?.id).toBe('vieneu-classic');
    expect(voiceEngineOfPack('tts-vieneu-cuda')?.id).toBe('vieneu');
  });
});

describe('voice library', () => {
  const catalog = allCatalogVoices();

  it('marks a Piper voice installed only when its files are on disk', () => {
    const items = libraryItems(catalog, VOICE_ENGINES, state({ installedPiper: new Set(['vi_VN-vais1000-medium']) }));
    const vais = items.find((i) => i.id === 'vi_VN-vais1000-medium')!;
    const hours = items.find((i) => i.id === 'vi_VN-25hours_single-low')!;
    expect(vais).toMatchObject({ installed: true, engineInstalled: true, engineAvailable: true });
    expect(hours).toMatchObject({ installed: false, engineInstalled: true });
  });

  it('marks pack voices installed when ANY of their engine packs is installed', () => {
    const cpu = libraryItems(catalog, VOICE_ENGINES, state({ installedPacks: new Set(['tts-neural']) }));
    expect(cpu.find((i) => i.id === 'vieneu-v3-ngoc-lan')).toMatchObject({ installed: true, engineInstalled: true });
    expect(cpu.find((i) => i.id === 'vieneu38-hai-dang')).toMatchObject({ installed: false, engineAvailable: true });
    const gpu = libraryItems(catalog, VOICE_ENGINES, state({ installedPacks: new Set(['tts-vieneu-cuda']) }));
    expect(gpu.find((i) => i.id === 'vieneu38-hai-dang')).toMatchObject({ installed: true });
  });

  it('says when an engine cannot run here at all, without hiding its voices', () => {
    const items = libraryItems(catalog, VOICE_ENGINES, state({ availablePacks: new Set() }));
    const zero = items.find((i) => i.id === 'zerotts-maichi')!;
    expect(zero.engineAvailable).toBe(false);
    expect(queryVoices(items, { language: 'vi' }).voices.some((v) => v.id === 'zerotts-maichi')).toBe(true);
  });

  it('a cloud voice is usable only with its key', () => {
    const without = libraryItems(catalog, VOICE_ENGINES, state());
    const withKey = libraryItems(catalog, VOICE_ENGINES, state({ cloudServices: new Set(['openai']) }));
    expect(without.find((i) => i.id === 'openai-alloy')?.installed).toBe(false);
    expect(withKey.find((i) => i.id === 'openai-alloy')?.installed).toBe(true);
  });

  it('carries a licence badge on every item', () => {
    for (const i of libraryItems(catalog, VOICE_ENGINES, state())) {
      expect(i.license.label, i.id).toBeTruthy();
      expect(i.license.category, i.id).toBeTruthy();
    }
  });

  it('filters by language, gender, accent, licence, engine and text (diacritics-insensitive)', () => {
    const items = libraryItems(catalog, VOICE_ENGINES, state());
    const south = queryVoices(items, { language: 'vi-VN', engine: 'vieneu', accent: 'south', gender: 'female' }).voices;
    expect(south.length).toBeGreaterThan(0);
    expect(south.every((v) => v.accent === 'south' && v.gender === 'female' && v.engine === 'vieneu')).toBe(true);

    expect(queryVoices(items, { q: 'hai dang' }).voices.map((v) => v.id)).toContain('vieneu38-hai-dang');
    expect(foldText('Đức Trí')).toBe('duc tri');

    const nc = queryVoices(items, { license: 'non-commercial' }).voices;
    expect(nc.length).toBeGreaterThan(0);
    expect(nc.every((v) => v.license.category === 'non-commercial')).toBe(true);

    // A speaker name of a multi-speaker model is searchable.
    expect(queryVoices(items, { q: 'p225' }).voices.some((v) => v.id.startsWith('en_GB-vctk'))).toBe(true);
  });

  it('orders a Vietnamese list: favourites, recommended, installed, then Vietnamese engines first', () => {
    const items = libraryItems(
      catalog,
      VOICE_ENGINES,
      state({ favorites: new Set(['zerotts-kimoanh']), installedPiper: new Set(['vi_VN-vais1000-medium']) }),
    );
    const ids = queryVoices(items, { language: 'vi' }).voices.map((v) => v.id);
    expect(ids[0]).toBe('zerotts-kimoanh');
    // Recommended voices next, the installed one first, then by engine:
    // VieNeu 3.8, the ten older VieNeu voices, ZeroTTS, then the rest.
    expect(ids.slice(1, 5)).toEqual(['vi_VN-vais1000-medium', 'vieneu38-hai-dang', 'vieneu-v3-ngoc-lan', 'zerotts-maichi']);
    expect(ids.indexOf('vieneu38-hai-dang')).toBeLessThan(ids.indexOf('vieneu38-adam'));
  });

  it('pages after filtering, and reports the total', () => {
    const items = libraryItems(catalog, VOICE_ENGINES, state());
    const all = queryVoices(items, { language: 'en' });
    const page = queryVoices(items, { language: 'en', offset: 5, limit: 10 });
    expect(page.total).toBe(all.total);
    expect(page.voices.map((v) => v.id)).toEqual(all.voices.slice(5, 15).map((v) => v.id));
  });

  it("lists profiles, and hides other projects' private voices", () => {
    const profile = (id: string, scope: VoiceProfile['scope']): VoiceProfile => ({
      id,
      name: id,
      createdAt: '',
      updatedAt: '',
      scope,
      engine: 'vieneu',
      source: { kind: 'recording' },
      checks: { speechMs: 8000, warnings: [] },
      consent: { statementVersion: '1', statementText: 'x', acceptedAt: '', relation: 'self', method: 'declaration' },
      enrollments: {},
    });
    const items = libraryItems(
      catalog,
      VOICE_ENGINES,
      state({
        profiles: [
          profile('vp_mine', { kind: 'library' }),
          profile('vp_projA', { kind: 'project', projectId: 'A' }),
        ],
      }),
    );
    expect(queryVoices(items, { kind: 'profile' }).voices.map((v) => v.id)).toEqual(['vp_mine']);
    expect(queryVoices(items, { kind: 'profile', projectId: 'A' }).voices.map((v) => v.id).sort()).toEqual([
      'vp_mine',
      'vp_projA',
    ]);
    // A profile speaks its engine's languages and comes first.
    expect(queryVoices(items, { language: 'vi' }).voices[0]!.id).toBe('vp_mine');
  });
});

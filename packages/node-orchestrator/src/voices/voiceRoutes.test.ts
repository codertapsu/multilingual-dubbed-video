import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceLibraryResponse } from '@videodubber/shared';
import { toHttpError } from '../httpErrors.js';
import { findCatalogVoice } from './voiceCatalog.js';
import { VoicePreviewCache } from './previewCache.js';
import { VoiceFavorites } from './voicePreferences.js';
import { parseVoiceQuery, planVoiceInstall, registerVoiceRoutes, type VoicePackState } from './voiceRoutes.js';

const pack = (over: Partial<VoicePackState> & { id: string }): VoicePackState => ({
  displayName: over.id,
  approxSizeMb: 1000,
  installed: false,
  available: true,
  fits: true,
  installing: false,
  ...over,
});

describe('parseVoiceQuery', () => {
  it('reads every filter and drops values it does not know', () => {
    expect(
      parseVoiceQuery({
        language: 'vi-VN',
        engine: 'vieneu,nope,piper',
        gender: 'female',
        accent: 'south',
        license: 'permissive,bogus',
        installed: 'true',
        favorite: '0',
        kind: 'preset',
        q: ' hai dang ',
        limit: '20',
        offset: '40',
      }),
    ).toEqual({
      language: 'vi-VN',
      engine: ['vieneu', 'piper'],
      gender: 'female',
      accent: 'south',
      license: ['permissive'],
      installed: true,
      favorite: false,
      kind: 'preset',
      q: 'hai dang',
      limit: 20,
      offset: 40,
    });
    expect(parseVoiceQuery({ gender: 'x', limit: '-3', installed: 'maybe' })).toEqual({});
  });
});

describe('planVoiceInstall', () => {
  it('downloads the model of a Piper voice, also for a chosen speaker', () => {
    expect(planVoiceInstall('vi_VN-vivos-x_low#7', [])).toMatchObject({ piperModel: 'vi_VN-vivos-x_low' });
  });

  it("installs the engine pack that runs well here; the user's pick wins", () => {
    const packs = [pack({ id: 'tts-vieneu-cuda', fits: false }), pack({ id: 'tts-vieneu', approxSizeMb: 900 })];
    expect(planVoiceInstall('vieneu38-hai-dang', packs)).toEqual({ packId: 'tts-vieneu', downloadMb: 900 });
    expect(planVoiceInstall('vieneu38-hai-dang', packs, 'tts-vieneu-cuda')).toMatchObject({ packId: 'tts-vieneu-cuda' });
  });

  it('needs nothing when an engine pack is already installed', () => {
    const packs = [pack({ id: 'tts-neural', installed: true })];
    expect(planVoiceInstall('vieneu-v3-ngoc-lan', packs)).toEqual({ downloadMb: 0 });
  });

  it('refuses a pack that does not provide the voice, an unknown voice, and a cloud voice', () => {
    expect(() => planVoiceInstall('vieneu38-hai-dang', [pack({ id: 'tts-vieneu' })], 'llama-cpp-cuda')).toThrow(
      /does not provide/,
    );
    expect(() => planVoiceInstall('nope', [])).toThrow(/Unknown voice/);
    expect(() => planVoiceInstall('openai-alloy', [])).toThrow(/API key/);
  });
});

describe('voice routes', () => {
  let tmp: string;
  const sample = Buffer.from('ID3 fake mp3 bytes');

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-voice-routes-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function server(fetchImpl: typeof fetch) {
    const app = Fastify();
    const installPiperVoice = vi.fn();
    const installPack = vi.fn(async (id: string) => [id]);
    registerVoiceRoutes(app, {
      libraryState: async () => ({
        installedPiper: new Set(['vi_VN-vais1000-medium']),
        installedPacks: new Set(),
        availablePacks: new Set(['tts-vieneu', 'tts-neural']),
        cloudServices: new Set(),
      }),
      favorites: new VoiceFavorites(tmp),
      previews: new VoicePreviewCache(tmp, fetchImpl),
      packStates: async (ids) => ids.map((id) => pack({ id, available: id === 'tts-vieneu' || id === 'tts-neural' })),
      installPiperVoice,
      installPack,
      sendError: (reply, err) => {
        const { status, body } = toHttpError(err);
        return reply.status(status).send(body);
      },
    });
    await app.ready();
    return { app, installPiperVoice, installPack };
  }

  it('lists the library with the filters applied, and favourites persist', async () => {
    const { app } = await server(vi.fn() as unknown as typeof fetch);
    const fav = await app.inject({ method: 'PUT', url: '/voices/vieneu38-mai-anh/favorite', payload: { favorite: true } });
    expect(fav.json()).toEqual({ id: 'vieneu38-mai-anh', favorite: true });

    const res = await app.inject({ method: 'GET', url: '/voices?language=vi&limit=3' });
    const body = res.json<VoiceLibraryResponse>();
    expect(body.voices).toHaveLength(3);
    expect(body.voices[0]).toMatchObject({ id: 'vieneu38-mai-anh', favorite: true });
    expect(body.total).toBeGreaterThan(40);
    expect(body.engines.length).toBeGreaterThan(0);

    const unknown = await app.inject({ method: 'PUT', url: '/voices/not-a-voice/favorite', payload: { favorite: true } });
    expect(unknown.statusCode).toBe(404);
  });

  it('serves a preview only after checking its sha256, then from the cache', async () => {
    const voice = findCatalogVoice('vi_VN-vais1000-medium')!;
    // Point the pinned preview at our fake bytes.
    const preview = { ...voice.preview!, sha256: createHash('sha256').update(sample).digest('hex'), bytes: sample.length };
    vi.spyOn(voice, 'preview', 'get').mockReturnValue(preview);
    const fetchImpl = vi.fn(async () => new Response(sample));
    const { app } = await server(fetchImpl as unknown as typeof fetch);

    const first = await app.inject({ method: 'GET', url: '/voices/vi_VN-vais1000-medium/preview' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('audio/mpeg');
    expect(first.rawPayload.equals(sample)).toBe(true);
    await app.inject({ method: 'GET', url: '/voices/vi_VN-vais1000-medium/preview' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never serves a preview that fails its checksum', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('tampered')));
    const { app } = await server(fetchImpl as unknown as typeof fetch);
    const res = await app.inject({ method: 'GET', url: '/voices/zerotts-maichi/preview' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await fsp.readdir(path.join(tmp, 'cache', 'voice-previews')).catch(() => [])).toEqual([]);
  });

  it('installs a Piper voice by its model, and a pack voice by its engine pack', async () => {
    const { app, installPiperVoice, installPack } = await server(vi.fn() as unknown as typeof fetch);
    const piper = await app.inject({ method: 'POST', url: `/voices/${encodeURIComponent('vi_VN-vivos-x_low#2')}/install` });
    expect(piper.statusCode).toBe(202);
    expect(installPiperVoice).toHaveBeenCalledWith('vi_VN-vivos-x_low');

    const v38 = await app.inject({ method: 'POST', url: '/voices/vieneu38-hai-dang/install', payload: {} });
    expect(v38.statusCode).toBe(202);
    expect(v38.json()).toMatchObject({ started: true, enginePacks: ['tts-vieneu'] });
    expect(installPack).toHaveBeenCalledWith('tts-vieneu');
  });
});

/**
 * The routes Voice Mask calls (its packages/control/src/videodubber/client.ts),
 * against the real server: GPU holds (POST/PUT/DELETE /scheduler/holds and
 * their place in GET /queue), the installed packs' pinned files
 * (GET /engines/installed), and the app's name in GET /health.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { loadConfig } from './config.js';
import { EnginePackStore } from './engines/enginePackStore.js';
import { createServer } from './server.js';
import { MAX_LIVE_HOLDS } from './scheduler/gpuHolds.js';
import { FakeMediaService } from './test/fixtures.js';

let tmp: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-holds-server-'));
  const configDir = path.join(tmp, 'config');
  // One installed model pack, its file where the catalog says it goes.
  const store = new EnginePackStore(configDir);
  const packDir = store.packDir('translategemma-4b');
  await fsp.mkdir(packDir, { recursive: true });
  await fsp.writeFile(path.join(packDir, 'model.gguf'), Buffer.alloc(1234, 7));
  await store.add({ id: 'translategemma-4b', path: packDir, version: 'test-1', installedAt: '2026-11-25T00:00:00.000Z' });
  app = await createServer({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects'), configDir, modelsDir: path.join(tmp, 'models') }),
    media: new FakeMediaService(),
  });
});

afterEach(async () => {
  await app.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

const voiceMask = { holder: 'voice-mask', lanes: ['gpu'], reason: 'live session: translated speech', ttlSec: 30 };

describe('GPU holds over HTTP (Voice Mask, 2026-11-25)', () => {
  it('take, renew, show in the queue, release; a release of a gone hold is still 204', async () => {
    const made = await app.inject({ method: 'POST', url: '/scheduler/holds', payload: voiceMask });
    expect(made.statusCode).toBe(201);
    const hold = made.json() as { holdId: string; expiresAt: string; ttlSec: number };
    expect(hold.ttlSec).toBe(30);
    expect(Date.parse(hold.expiresAt) - Date.now()).toBeGreaterThan(25_000);

    const renewed = await app.inject({ method: 'PUT', url: `/scheduler/holds/${hold.holdId}`, payload: {} });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toEqual({ holdId: hold.holdId, expiresAt: expect.any(String) });

    const queue = (await app.inject({ method: 'GET', url: '/queue' })).json() as { holds: { holdId: string; holder: string; name: string; reason: string }[] };
    expect(queue.holds).toEqual([
      expect.objectContaining({ holdId: hold.holdId, holder: 'voice-mask', name: 'Voice Mask', lanes: ['gpu'], reason: 'live session: translated speech' }),
    ]);

    expect((await app.inject({ method: 'DELETE', url: `/scheduler/holds/${hold.holdId}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/scheduler/holds/${hold.holdId}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'PUT', url: `/scheduler/holds/${hold.holdId}`, payload: {} })).statusCode).toBe(404);
    expect(((await app.inject({ method: 'GET', url: '/queue' })).json() as { holds: unknown[] }).holds).toEqual([]);
  });

  it('clamps the TTL, refuses a bad body (400) and holds past the cap (429)', async () => {
    const long = await app.inject({ method: 'POST', url: '/scheduler/holds', payload: { ...voiceMask, ttlSec: 3600 } });
    expect(long.json()).toMatchObject({ ttlSec: 120 });
    const bad = await app.inject({ method: 'POST', url: '/scheduler/holds', payload: { ...voiceMask, lanes: ['cpu'] } });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { message: string } }).error.message).toContain('lanes');
    for (let i = 1; i < MAX_LIVE_HOLDS; i++) {
      expect((await app.inject({ method: 'POST', url: '/scheduler/holds', payload: voiceMask })).statusCode).toBe(201);
    }
    expect((await app.inject({ method: 'POST', url: '/scheduler/holds', payload: voiceMask })).statusCode).toBe(429);
  });

  it('is refused from a web page, as the other changes are; a caller with no Origin (Node) is served', async () => {
    const evil = { origin: 'https://example.com' };
    expect((await app.inject({ method: 'POST', url: '/scheduler/holds', payload: voiceMask, headers: evil })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/scheduler/holds/hold_x', payload: {}, headers: evil })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/scheduler/holds/hold_x', headers: evil })).statusCode).toBe(403);
    const fromApp = await app.inject({ method: 'POST', url: '/scheduler/holds', payload: voiceMask, headers: { origin: 'http://tauri.localhost' } });
    expect(fromApp.statusCode).toBe(201);
  });
});

describe('the installed packs, read-only', () => {
  it("lists each installed pack's pinned files: absolute path, size on disk, the sha256 it was checked against", async () => {
    const res = await app.inject({ method: 'GET', url: '/engines/installed' });
    expect(res.statusCode).toBe(200);
    const packs = res.json() as { id: string; version?: string; files: { path: string; size: number; sha256: string }[] }[];
    const tg = packs.find((p) => p.id === 'translategemma-4b')!;
    expect(tg).toMatchObject({ version: 'test-1', kind: 'translation' });
    expect(tg.files).toEqual([
      { path: path.join(tmp, 'config', 'engines', 'translategemma-4b', 'model.gguf'), size: 1234, sha256: '81200d03e843d2ec1ece6eeafe7d13cb6e5211e1fcd336ade55790b683a08330' },
    ]);
  });
});

describe('GET /health names the app', () => {
  it('so discovery can check by name, not by shape', async () => {
    expect(((await app.inject({ method: 'GET', url: '/health' })).json() as { app: string }).app).toBe('videodubber');
  });
});

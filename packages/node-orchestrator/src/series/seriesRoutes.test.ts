/**
 * The 0.18.0 series and create routes through the real server (app.inject):
 * a local file linked into a project when asked (1.2), a part edited after
 * it was made (2.2), the series a new one can continue (5.2), a subset
 * rebuild that names an unknown part.
 *
 * Every worker and self URL points at ports nothing listens on: on a machine
 * where the app itself runs, the defaults (5100–5103) are its own processes,
 * and a test must never reach them.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@videodubber/shared';

import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import { FakeMediaService, defaultSettings } from '../test/fixtures.js';

describe('series and create routes', () => {
  let tmp: string;
  let app: FastifyInstance;
  let video: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-series-routes-'));
    const root = path.join(tmp, 'VideoDubber');
    video = path.join(root, 'local', 'joined.mp4');
    await fsp.mkdir(path.dirname(video), { recursive: true });
    await fsp.writeFile(video, Buffer.alloc(4096, 3));
    app = await createServer({
      config: loadConfig({
        projectsDir: path.join(root, 'projects'),
        configDir: root,
        modelsDir: path.join(root, 'models'),
        orchestratorUrl: 'http://127.0.0.1:5240',
        sttWorkerUrl: 'http://127.0.0.1:5241',
        translationWorkerUrl: 'http://127.0.0.1:5242',
        ttsWorkerUrl: 'http://127.0.0.1:5243',
      }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const create = async (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/projects', payload: { name: 'Joined', inputVideoPath: video, settings: defaultSettings(), ...body } });

  it('links a local file into the project when asked, and copies it otherwise', async () => {
    const linked = (await create({ linkInputVideo: true })).json() as Project;
    // The same bytes under a second name: no 18 GB copy on the same drive.
    expect((await fsp.stat(video)).nlink).toBe(2);
    expect((await fsp.stat(linked.inputVideoPath)).size).toBe(4096);
    const copied = (await create({})).json() as Project;
    expect((await fsp.stat(copied.inputVideoPath)).nlink).toBe(1);
    expect((await fsp.stat(video)).nlink).toBe(2);
  });

  it('edits only parts, lists no series when there is none, and names an unknown part', async () => {
    const plain = (await create({})).json() as Project;
    const empty = await app.inject({ method: 'PATCH', url: `/projects/${plain.id}/series-part`, payload: {} });
    expect(empty.statusCode).toBe(400);
    const notPart = await app.inject({ method: 'PATCH', url: `/projects/${plain.id}/series-part`, payload: { title: 'X' } });
    expect(notPart.statusCode).toBe(400);
    expect(notPart.json()).toMatchObject({ error: { code: 'INVALID_EDIT' } });
    expect((await app.inject({ method: 'GET', url: '/series' })).json()).toEqual([]);
    const rebuild = await app.inject({ method: 'POST', url: `/projects/${plain.id}/series/rebuild-parts`, payload: { parts: [2] } });
    expect(rebuild.statusCode).toBe(400);
  });
});

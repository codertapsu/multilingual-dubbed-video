import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { projectOutputThumbnailPath, type DownloadItem, type Project } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { FakeMediaService } from './test/fixtures.js';

/** The download queue's routes, presets, a dub per download, outputs and the job stream. */
describe('downloads, presets and batch dubs', () => {
  let tmp: string;
  let app: FastifyInstance;
  let video: string;
  const root = (): string => path.join(tmp, 'VideoDubber');

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-dl-'));
    // A download that finished in an earlier session, in the downloads folder beside the projects.
    video = path.join(root(), 'downloads', 'Clip.mp4');
    await fsp.mkdir(path.dirname(video), { recursive: true });
    await fsp.writeFile(video, Buffer.alloc(4096, 7));
    const done: DownloadItem = {
      id: 'dl_done000001',
      input: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
      page: 2,
      state: 'done',
      percent: 100,
      sourceKey: 'bilibili:BV1xx411c7mD:p2',
      source: {
        providerId: 'bilibili',
        sourceKey: 'bilibili:BV1xx411c7mD:p2',
        url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
        title: '视频',
        page: 2,
        partCount: 3,
        partTitle: '第二集',
        ownerName: 'UP主',
        durationSec: 3600,
      },
      filePath: video,
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(root(), 'download-queue.json'), JSON.stringify({ version: 1, items: [done] }));
    app = await createServer({
      config: loadConfig({ projectsDir: path.join(root(), 'projects'), configDir: root(), modelsDir: path.join(root(), 'models') }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('lists the queue and turns away what it cannot download', async () => {
    const list = (await app.inject({ method: 'GET', url: '/downloads' })).json() as DownloadItem[];
    expect(list.map((i) => i.id)).toEqual(['dl_done000001']);
    expect(list[0]).not.toHaveProperty('outputPath');

    expect((await app.inject({ method: 'POST', url: '/downloads', payload: { items: [] } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/downloads', payload: { items: [{ input: 'https://example.com/x' }] } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ added: [], rejected: [{ input: 'https://example.com/x', error: { code: 'INVALID_VIDEO_LINK' } }] });
    // The same video again is the same download, not a second one.
    const again = await app.inject({ method: 'POST', url: '/downloads', payload: { items: [{ input: 'BV1xx411c7mD', page: 2 }] } });
    expect(again.json()).toMatchObject({ added: [], existing: [{ id: 'dl_done000001' }] });
    expect((await app.inject({ method: 'GET', url: '/downloads/dl_nope' })).statusCode).toBe(404);
  });

  it('keeps presets, and makes a linked project per finished download from one', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { name: 'Kênh A', targetLanguage: 'vi-VN', sourceLanguage: 'zh', settings: { subtitleExportMode: 'burned-in' } },
    });
    expect(created.statusCode).toBe(201);
    const preset = created.json() as { id: string };
    expect(((await app.inject({ method: 'GET', url: '/presets' })).json() as unknown[]).length).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/presets', payload: { name: 'no language' } })).statusCode).toBe(400);

    const dub = await app.inject({
      method: 'POST',
      url: '/downloads/dub',
      payload: { downloadIds: ['dl_done000001', 'dl_missing'], presetId: preset.id },
    });
    expect(dub.statusCode).toBe(200);
    const [made, missing] = (dub.json() as { results: { projectId?: string; name?: string; error?: { code: string } }[] }).results;
    expect(missing?.error?.code).toBe('INVALID_EDIT');
    expect(made?.name).toBe('视频 - P2 第二集');

    const project = (await app.inject({ method: 'GET', url: `/projects/${made!.projectId}` })).json() as { project: Project };
    expect(project.project.settings).toMatchObject({ targetLanguage: 'vi-VN', sourceLanguage: 'zh', subtitleExportMode: 'burned-in' });
    expect(project.project.source?.sourceKey).toBe('bilibili:BV1xx411c7mD:p2');
    // Linked, not copied: one set of bytes under two names.
    expect((await fsp.stat(video)).nlink).toBe(2);
    const item = (await app.inject({ method: 'GET', url: '/downloads/dl_done000001' })).json() as DownloadItem;
    expect(item.projectIds).toEqual([made!.projectId]);

    const outputs = (await app.inject({ method: 'GET', url: `/projects/${made!.projectId}/outputs` })).json() as Record<string, unknown>;
    expect(outputs).toMatchObject({ finished: false, files: [], source: { ownerName: 'UP主' }, published: [] });
    // The thumbnail the render leaves beside the video is one of its files.
    const thumb = projectOutputThumbnailPath(project.project);
    await fsp.mkdir(path.dirname(thumb), { recursive: true });
    await fsp.writeFile(thumb, Buffer.alloc(2048, 1));
    const withThumb = (await app.inject({ method: 'GET', url: `/projects/${made!.projectId}/outputs` })).json() as { files: unknown[] };
    expect(withThumb.files).toEqual([{ kind: 'thumbnail', path: thumb, sizeBytes: 2048 }]);

    expect((await app.inject({ method: 'POST', url: `/projects/${made!.projectId}/published`, payload: { url: 'nope' } })).statusCode).toBe(400);
    const pub = await app.inject({ method: 'POST', url: `/projects/${made!.projectId}/published`, payload: { url: 'https://facebook.com/p/1', part: 2 } });
    expect(pub.json()).toMatchObject({ published: [{ url: 'https://facebook.com/p/1', part: 2 }] });
  });

  it('splits long downloads into parts only with an AI set up in Settings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/downloads/dub',
      payload: { downloadIds: ['dl_done000001'], targetLanguage: 'vi-VN', sourceLanguage: 'zh', series: { maxMinutes: 20 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'CLOUD_CREDENTIALS_MISSING' } });
    // Refused before anything was made.
    const item = (await app.inject({ method: 'GET', url: '/downloads/dl_done000001' })).json() as DownloadItem;
    expect(item.projectIds ?? []).toEqual([]);
  });

  it('lets Claude choose the cuts once its key is set, asked for by its short name too', async () => {
    const saved = await app.inject({ method: 'PUT', url: '/credentials', payload: { service: 'anthropic', apiKey: 'sk-ant-api03-test-key-0000000000000000' } });
    expect(saved.statusCode).toBe(200);
    // The registry's id: the first draft listed "anthropic", which no provider is called.
    const options = (await app.inject({ method: 'GET', url: '/series/ai-options' })).json() as { id: string; ready: boolean }[];
    expect(options.find((o) => o.id === 'anthropic-translate')).toMatchObject({ ready: true });

    // Without the spoken language (and no preset), the whole batch is refused up front.
    const noLanguage = await app.inject({ method: 'POST', url: '/downloads/dub', payload: { downloadIds: ['dl_done000001'], targetLanguage: 'vi-VN' } });
    expect(noLanguage.statusCode).toBe(400);
    expect(noLanguage.json()).toMatchObject({ error: { code: 'INVALID_LANGUAGE' } });

    const dub = await app.inject({
      method: 'POST',
      url: '/downloads/dub',
      payload: { downloadIds: ['dl_done000001'], targetLanguage: 'vi-VN', sourceLanguage: 'zh', series: { aiProviderId: 'anthropic', maxMinutes: 20 } },
    });
    expect(dub.statusCode).toBe(200);
    const [made] = (dub.json() as { results: { projectId?: string; series?: boolean }[] }).results;
    // An hour is over 1.5 x 20 minutes: dubbed as a series.
    expect(made).toMatchObject({ series: true });
    const { project } = (await app.inject({ method: 'GET', url: `/projects/${made!.projectId}` })).json() as { project: Project };
    expect(project.series).toMatchObject({ role: 'parent', settings: { aiProviderId: 'anthropic-translate', minMinutes: 15, maxMinutes: 20 } });
  });

  it('streams one NDJSON line per job and ends once every named job has stopped', async () => {
    const res = await app.inject({ method: 'GET', url: '/jobs/events?downloads=dl_done000001,dl_unknown&untilDone=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; id: string; state: string; title?: string });
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'download', id: 'dl_done000001', state: 'done', title: '视频' }),
      expect.objectContaining({ kind: 'download', id: 'dl_unknown', state: 'unknown' }),
    ]);
    expect((await app.inject({ method: 'GET', url: '/jobs/events' })).statusCode).toBe(400);
  });
});

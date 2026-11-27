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
  /** A two-hour video, for a preset's series block. */
  let longVideo: string;
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
    // A download whose site says 5:07:58 for a file of ten seconds (BV1oSeb6cE7G
    // said 5:07:58 for a file of 4:06:21, 2026-11-27).
    const short = path.join(root(), 'downloads', 'Short.mp4');
    await fsp.writeFile(short, Buffer.alloc(4096, 5));
    const wrongSite: DownloadItem = {
      ...done,
      id: 'dl_wrongsite1',
      input: 'https://www.bilibili.com/video/BV1oSeb6cE7G',
      sourceKey: 'bilibili:BV1oSeb6cE7G:p1',
      source: { ...done.source!, sourceKey: 'bilibili:BV1oSeb6cE7G:p1', url: 'https://www.bilibili.com/video/BV1oSeb6cE7G', page: 1, partCount: 1, durationSec: 18_478 },
      filePath: short,
    };
    await fsp.writeFile(path.join(root(), 'download-queue.json'), JSON.stringify({ version: 1, items: [done, wrongSite] }));
    longVideo = path.join(tmp, 'Long.mp4');
    await fsp.writeFile(longVideo, Buffer.alloc(1024, 3));
    app = await createServer({
      config: loadConfig({ projectsDir: path.join(root(), 'projects'), configDir: root(), modelsDir: path.join(root(), 'models') }),
      // The finished download plays the hour its site says.
      media: new FakeMediaService({ segmentDurations: new Map([[longVideo, 7_200_000], [video, 3_600_000]]) }),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('lists the queue and turns away what it cannot download', async () => {
    const list = (await app.inject({ method: 'GET', url: '/downloads' })).json() as DownloadItem[];
    expect(list.map((i) => i.id).sort()).toEqual(['dl_done000001', 'dl_wrongsite1']);
    for (const item of list) expect(item).not.toHaveProperty('outputPath');

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

    // The file's own length decides, never the site's figure.
    const wrong = await app.inject({
      method: 'POST',
      url: '/downloads/dub',
      payload: { downloadIds: ['dl_wrongsite1'], targetLanguage: 'vi-VN', sourceLanguage: 'zh', series: { aiProviderId: 'anthropic', maxMinutes: 20 } },
    });
    const [whole] = (wrong.json() as { results: { projectId?: string; series?: boolean }[] }).results;
    expect(whole?.projectId).toBeTruthy();
    expect(whole?.series).toBeFalsy();
  });

  it('makes a project from a preset: its settings under the job\'s own, its folder named after the project', async () => {
    const preset = (
      await app.inject({
        method: 'POST',
        url: '/presets',
        payload: {
          name: 'Tiệm phim',
          targetLanguage: 'vi-VN',
          sourceLanguage: 'zh',
          outputDir: path.join(tmp, 'out', '{series}'),
          settings: { subtitleExportMode: 'burned-in', duckingLevelDb: -12 },
          series: { minMinutes: 30, maxMinutes: 40, ai: 'anthropic', autoStart: false },
        },
      })
    ).json() as { id: string };
    const res = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Tập: 1', inputVideoPath: video, presetId: preset.id, settings: { duckingLevelDb: -6 } },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json() as Project;
    expect(project.settings).toMatchObject({ sourceLanguage: 'zh', targetLanguage: 'vi-VN', subtitleExportMode: 'burned-in', duckingLevelDb: -6 });
    // The preset's engines sit on the machine's recommended ones: a whole set of settings.
    expect(project.settings.sttProviderId).toBeTruthy();
    expect(project.outputDir).toBe(path.join(tmp, 'out', 'Tập 1'));
    // An hour: not longer than the hour the preset's series asks for, so dubbed whole.
    expect(project.series).toBeUndefined();
    expect(res.json()).not.toHaveProperty('presetId');

    const unknown = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', inputVideoPath: video, presetId: 'preset_nope' } });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('makes a long video from a preset with a series block a series, with the preset\'s choices', async () => {
    await app.inject({ method: 'PUT', url: '/credentials', payload: { service: 'anthropic', apiKey: 'sk-ant-api03-test-key-0000000000000000' } });
    const preset = (
      await app.inject({
        method: 'POST',
        url: '/presets',
        payload: {
          name: 'Tiệm phim',
          targetLanguage: 'vi-VN',
          sourceLanguage: 'zh',
          series: { minMinutes: 30, maxMinutes: 40, ai: 'anthropic', recapSec: 4, autoStart: false, nameTemplate: '{series} - Phần {n} - {title}' },
        },
      })
    ).json() as { id: string; series?: Record<string, unknown> };
    expect(preset.series).toMatchObject({ aiProviderId: 'anthropic-translate' });
    const res = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Dài', inputVideoPath: longVideo, presetId: preset.id } });
    expect(res.statusCode).toBe(201);
    const project = res.json() as Project;
    expect(project.series).toMatchObject({
      role: 'parent',
      settings: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4, autoStart: false, nameTemplate: '{series} - Phần {n} - {title}' },
    });
    // A job that asks for a series itself lays its choices over the preset's.
    const own = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Ngắn', inputVideoPath: video, presetId: preset.id, series: { autoStart: true } },
    });
    expect((own.json() as Project).series).toMatchObject({ role: 'parent', settings: { minMinutes: 30, maxMinutes: 40, autoStart: true } });
    // The batch takes the preset's series block too.
    const dub = await app.inject({ method: 'POST', url: '/downloads/dub', payload: { downloadIds: ['dl_done000001'], presetId: preset.id } });
    const [made] = (dub.json() as { results: { projectId?: string; series?: boolean }[] }).results;
    // An hour is not over 1.5 x 40 minutes: dubbed whole.
    expect(made?.projectId).toBeTruthy();
    expect(made?.series).toBeFalsy();
  });

  it('offers built-in presets on this computer\'s engines only, even when Settings save a cloud AI', async () => {
    // The user chose Claude for translation in Settings, with its key: New project uses it.
    await app.inject({ method: 'PUT', url: '/credentials', payload: { service: 'anthropic', apiKey: 'sk-ant-api03-test-key-0000000000000000' } });
    await app.inject({ method: 'PUT', url: '/preferences', payload: { providerDefaults: { translationProviderId: 'anthropic-translate' } } });
    const defaults = (await app.inject({ method: 'GET', url: '/project-defaults?sourceLanguage=zh&targetLanguage=vi-VN' })).json() as { settings: { translationProviderId: string } };
    expect(defaults.settings.translationProviderId).toBe('anthropic-translate');

    const builtins = (await app.inject({ method: 'GET', url: '/presets/builtin?sourceLanguage=zh&targetLanguage=vi-VN' })).json() as {
      id: string;
      settings: Record<string, unknown>;
      builtin: { kind: string; tradeoffs: { key: string }[] };
    }[];
    expect(builtins.map((p) => p.id)).toEqual(['builtin:quality', 'builtin:balanced', 'builtin:economy']);
    for (const p of builtins) {
      expect(p.settings.translationProviderId).not.toBe('anthropic-translate');
      expect(p.builtin.tradeoffs.map((t) => t.key)).toContain('wizard.builtin.kept-local');
    }

    // A project from one: its engines over the saved cloud choice, the call's languages.
    const made = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Nhanh', inputVideoPath: video, presetId: 'builtin:economy', settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN' } },
    });
    expect(made.statusCode).toBe(201);
    const project = made.json() as Project;
    expect(project.settings).toMatchObject({ processingMode: 'local', refineProviderId: 'none', autoFitOverflow: false, diarize: false, renderQuality: 'fast' });
    expect(project.settings.translationProviderId).not.toBe('anthropic-translate');
    // A built-in preset works for any language, so the job names them.
    const noLanguage = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'x', inputVideoPath: video, presetId: 'builtin:quality' } });
    expect(noLanguage.statusCode).toBe(400);
    expect(noLanguage.json()).toMatchObject({ error: { code: 'INVALID_LANGUAGE' } });
    const unknown = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'x', inputVideoPath: video, presetId: 'builtin:fastest', settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN' } },
    });
    expect(unknown.json()).toMatchObject({ error: { code: 'INVALID_EDIT' } });
  });

  it('exports the transcript with every flag its lines carry', async () => {
    const project = (
      await app.inject({
        method: 'POST',
        url: '/projects',
        payload: { name: 'Xuất', inputVideoPath: video, presetId: 'builtin:balanced', settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN' } },
      })
    ).json() as Project;
    await fsp.mkdir(path.join(project.workspaceDir, 'subtitles'), { recursive: true });
    await fsp.writeFile(
      path.join(project.workspaceDir, 'subtitles', 'source.json'),
      JSON.stringify({
        segments: [
          { id: 'seg_0001', index: 0, startMs: 0, endMs: 1000, sourceText: '月亮代表我的心', song: true },
          { id: 'seg_0002', index: 1, startMs: 1000, endMs: 2000, sourceText: '快跑', speakerId: 'SPEAKER_01', speakerLowConfidence: true, loopSuspect: true },
        ],
      }),
    );
    const json = (await app.inject({ method: 'POST', url: `/projects/${project.id}/transcript/export`, payload: { format: 'json' } })).json() as { path: string };
    const lines = (JSON.parse(await fsp.readFile(json.path, 'utf8')) as { lines: Record<string, unknown>[] }).lines;
    expect(lines[0]).toMatchObject({ source: '月亮代表我的心', song: true });
    expect(lines[1]).toMatchObject({ speakerId: 'SPEAKER_01', speakerLowConfidence: true, loopSuspect: true });
    const tsv = (await app.inject({ method: 'POST', url: `/projects/${project.id}/transcript/export`, payload: { format: 'tsv' } })).json() as { path: string };
    const rows = (await fsp.readFile(tsv.path, 'utf8')).split('\n');
    expect(rows[1]!.split('\t').at(-1)).toBe('song');
    expect(rows[2]!.split('\t').at(-1)).toBe('loop?,speaker?');
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

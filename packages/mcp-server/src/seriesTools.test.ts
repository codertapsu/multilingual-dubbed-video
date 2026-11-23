/**
 * The 0.18.0 series and create tools (docs/plans/production-requests-2026-11-23.md
 * 1.2, 2.1–2.4, 5.2) driven the way an agent drives them: a real MCP client
 * over the in-memory transport, against a fake app on a local port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { VideoDubberApi } from './api.js';
import { createVideoDubberServer } from './server.js';

type Route = (req: IncomingMessage, body: unknown, res: ServerResponse) => unknown;

interface Fake {
  routes: Map<string, Route>;
  calls: { method: string; path: string; body: unknown }[];
  url: string;
  close(): Promise<void>;
}

async function startFake(): Promise<Fake> {
  const routes = new Map<string, Route>();
  const calls: Fake['calls'] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const pathOnly = (req.url ?? '').split('?')[0]!;
    calls.push({ method: req.method ?? 'GET', path: req.url ?? '', body });
    const route = routes.get(`${req.method} ${pathOnly}`);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNKNOWN', message: `no route ${req.method} ${pathOnly}` } }));
      return;
    }
    const out = await route(req, body, res);
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  routes.set('GET /health', () => ({ status: 'ok', version: '0.18.0', platform: 'win32-x64' }));
  return {
    routes,
    calls,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const settings = {
  sourceLanguage: 'zh',
  targetLanguage: 'vi-VN',
  subtitleExportMode: 'burned-in',
  processingMode: 'local',
  sttProviderId: 'whisper-cpp',
  translationProviderId: 'llama-cpp',
  ttsProviderId: 'neural-tts',
};

const project = (over: Record<string, unknown> = {}) => ({
  id: 'proj_new',
  name: 'Mùa 12',
  inputVideoPath: 'C:/v/s12.mp4',
  workspaceDir: 'C:/nonexistent/proj_new',
  outputDir: 'C:/nonexistent/proj_new/render',
  status: 'created',
  createdAt: '2026-11-23T00:00:00Z',
  updatedAt: '2026-11-23T00:00:00Z',
  settings,
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  parentId: 'proj_series',
  name: 'Xuyên Không',
  state: 'parts',
  settings: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4 },
  plan: { parts: [], notes: [], createdAt: '2026-11-23T01:00:00Z' },
  parts: [
    { index: 23, projectId: 'proj_p23', title: 'Một', startMs: 0, endMs: 60_000, status: 'completed' },
    { index: 24, projectId: 'proj_p24', title: 'Hai', startMs: 60_000, endMs: 120_000, status: 'queued' },
  ],
  ...over,
});

describe('series and create tools (0.18.0)', () => {
  let fake: Fake;
  let client: Client;

  const connect = async (opts: { createProjectTimeoutMs?: number } = {}) => {
    const server = createVideoDubberServer({
      api: new VideoDubberApi({ baseUrl: fake.url }),
      version: 'test',
      pollMs: 20,
      workBudgetMs: 1500,
      ...opts,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientSide);
  };

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as { type: string; text?: string }[])[0];
    return { text: first?.text ?? '', isError: res.isError === true };
  };

  const createRoutes = (): void => {
    fake.routes.set('GET /project-defaults', () => ({ settings: { ...settings, ttsProviderId: 'piper-local' }, notes: [] }));
    fake.routes.set('POST /projects/proj_new/probe', () => ({ durationMs: 90_000 }));
    fake.routes.set('POST /projects/proj_new/ensure-resources', () => ({ installing: false }));
  };

  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await fake.close();
  });

  it('create_project links the video and says, on a timeout, where the project may still appear', async () => {
    createRoutes();
    fake.routes.set('GET /storage/projects-folder', () => ({ projectsDir: 'D:/VideoDubber/projects' }));
    // The app copies an 18 GB file: longer than the client waits.
    fake.routes.set('POST /projects', () => new Promise((r) => setTimeout(() => r(project()), 600)));
    await connect({ createProjectTimeoutMs: 150 });
    const r = await call('create_project', { videoPath: 'E:/raw/joined.mp4', targetLanguage: 'vi-VN', sourceLanguage: 'zh' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('may still appear');
    expect(r.text).toContain('Do not create it again');
    expect(r.text).toContain('list_projects');
    expect(r.text).toContain('D:/VideoDubber/projects');
    expect(r.text).not.toContain('Unexpected error');
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as Record<string, unknown>;
    expect(body.linkInputVideo).toBe(true);
  });

  it('create_project names the parts from a template and continues a series from its settings', async () => {
    createRoutes();
    fake.routes.set('GET /series/ai-options', () => [{ id: 'anthropic-translate', ready: true, viaMotherClaude: true }]);
    fake.routes.set('GET /projects/proj_p24', () => ({
      project: project({
        id: 'proj_p24',
        settings: {
          ...settings,
          speakerVoices: [{ speakerId: 'SPEAKER_00', voiceId: 'clone-a' }],
          burnSubtitleStyle: { position: 'raised', coverOriginal: true },
        },
      }),
      pipeline: { projectId: 'proj_p24', status: 'completed', progressPercent: 100, steps: [], updatedAt: '' },
    }));
    fake.routes.set('POST /projects', (_q, body) =>
      project({
        series: {
          role: 'parent',
          state: 'analysing',
          settings: { ...(body as { series: object }).series, continues: 'proj_series', seriesName: 'Xuyên Không', partNumberOffset: 48 },
        },
      }),
    );
    await connect();
    const r = await call('create_project', {
      videoPath: 'E:/raw/s12.mp4',
      targetLanguage: 'vi-VN',
      series: { continues: 'proj_p24', nameTemplate: '{series} - Tập {nn}: {title}', minMinutes: 30, maxMinutes: 40 },
    });
    expect(r.isError).toBe(false);
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as {
      settings: Record<string, unknown>;
      series: Record<string, unknown>;
      linkInputVideo: boolean;
    };
    expect(body.series).toMatchObject({ continues: 'proj_p24', nameTemplate: '{series} - Tập {nn}: {title}', minMinutes: 30, maxMinutes: 40 });
    // The engines and look carry on (the defaults here would pick piper-local); the speakers' voices do not.
    expect(body.settings).toMatchObject({ ttsProviderId: 'neural-tts', sourceLanguage: 'zh', burnSubtitleStyle: { position: 'raised' } });
    expect(body.settings.speakerVoices).toBeUndefined();
    expect(r.text).toContain('Continues "Xuyên Không": its parts are numbered from 49');
  });

  it('edit_part finds a part by its number and says when it renders again', async () => {
    fake.routes.set('GET /projects/proj_series/series', () => view());
    fake.routes.set('PATCH /projects/proj_p23/series-part', (_q, body) => ({
      project: project({
        id: 'proj_p23',
        name: 'Xuyên Không - Tập 23: Mới',
        series: { role: 'part', parentId: 'proj_series', index: 23, count: 48, seriesName: 'Xuyên Không', title: (body as { title: string }).title, recapEndMs: 0 },
      }),
      renderAgain: true,
    }));
    await connect();
    const r = await call('edit_part', { projectId: 'proj_series', part: 23, title: 'Mới' });
    expect(r.isError).toBe(false);
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ title: 'Mới' });
    expect(r.text).toContain('Part 23 (proj_p23): "Xuyên Không - Tập 23: Mới", titled "Mới"');
    expect(r.text).toContain('set to render again');
    const missing = await call('edit_part', { projectId: 'proj_series', part: 60, title: 'X' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('has no part 60');
    expect((await call('edit_part', { projectId: 'proj_p23' })).isError).toBe(true);
  });

  it('rebuild_parts sends the part numbers and says which kept their place in the queue', async () => {
    fake.routes.set('POST /projects/proj_series/series/rebuild-parts', () => ({
      parts: [
        { projectId: 'proj_p23', index: 23, rebuilt: false, skipped: 'running', reason: 'is being dubbed now' },
        { projectId: 'proj_p24', index: 24, rebuilt: true, queued: true, oldLines: 510, newLines: 530, speakers: 6 },
      ],
    }));
    await connect();
    const r = await call('rebuild_parts', { projectId: 'proj_series', parts: [23, 24] });
    expect(fake.calls.find((c) => c.path.endsWith('/rebuild-parts'))!.body).toEqual({ force: false, parts: [23, 24] });
    expect(r.text).toContain('- part 23 (proj_p23): left as it was: it is being dubbed now; rebuild it once that is done, or pause it first');
    expect(r.text).toContain('- part 24 (proj_p24): 510 -> 530 lines, 6 speaker(s), still waiting in the queue at the same place');
  });

  it('replan_series plans again, keeping the edited titles when asked, and shows the new plan', async () => {
    let reads = 0;
    fake.routes.set('GET /projects/proj_series/series', () => {
      reads += 1;
      if (reads === 1) return view({ state: 'review', parts: [{ index: 1, title: 'Cũ', startMs: 0, endMs: 60_000 }] });
      if (reads === 2) return view({ state: 'planning', parts: [] });
      return view({
        state: 'review',
        plan: { parts: [{ index: 1, startMs: 0, endMs: 60_000, title: 'Của tôi', summary: '', cutBy: 'start' }], notes: ['kept'], createdAt: '2026-11-23T02:00:00Z' },
        parts: [{ index: 1, title: 'Của tôi', startMs: 0, endMs: 60_000 }],
      });
    });
    fake.routes.set('POST /projects/proj_series/series/replan', () => ({ planning: true }));
    await connect();
    const r = await call('replan_series', { projectId: 'proj_series', keepTitles: true });
    expect(fake.calls.find((c) => c.path.endsWith('/replan'))!.body).toEqual({ keepTitles: true });
    expect(r.text).toContain('Series "Xuyên Không" (proj_series): review');
    expect(r.text).toContain('"Của tôi"');
  });

  it('get_series shows a continued series, its name template and each part\'s name', async () => {
    fake.routes.set('GET /projects/proj_s12/series', () =>
      view({
        parentId: 'proj_s12',
        settings: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4, nameTemplate: '{series} - Tập {nn}', partNumberOffset: 48 },
        continues: { parentId: 'proj_series', name: 'Xuyên Không' },
        parts: [{ index: 49, projectId: 'proj_p49', name: 'Xuyên Không - Tập 49', title: 'Mùa mới', summary: 'Bắt đầu.', startMs: 0, endMs: 60_000, status: 'created' }],
      }),
    );
    await connect();
    const r = await call('get_series', { projectId: 'proj_s12' });
    expect(r.text).toContain('Continues "Xuyên Không" (proj_series): parts numbered from 49.');
    expect(r.text).toContain('Parts named "{series} - Tập {nn}".');
    expect(r.text).toContain('- part 49: 00:00.00-01:00.00 "Mùa mới" (Bắt đầu.) project proj_p49 "Xuyên Không - Tập 49", created');
  });
});

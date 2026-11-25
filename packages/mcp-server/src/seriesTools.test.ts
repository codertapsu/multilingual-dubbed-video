/**
 * The 0.18.0 series and create tools (docs/plans/production-requests-2026-11-23.md
 * 1.2, 2.1–2.4, 5.2) driven the way an agent drives them: a real MCP client
 * over the in-memory transport, against a fake app on a local port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // A client that gave up (a timeout) has no answer to receive.
    if (res.headersSent || res.writableEnded || res.destroyed) return;
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
    let copied!: () => void;
    const copying = new Promise<void>((done) => (copied = done));
    fake.routes.set('POST /projects', () => new Promise((r) => setTimeout(() => (r(project()), copied()), 400)));
    await connect({ createProjectTimeoutMs: 150 });
    const r = await call('create_project', { videoPath: 'E:/raw/joined.mp4', targetLanguage: 'vi-VN', sourceLanguage: 'zh' });
    // The app finishes its copy after the agent stopped waiting: nothing is answered to it.
    await copying;
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

  it('create_project from a preset sends its id and only the call\'s own choices, and says the preset made a series', async () => {
    createRoutes();
    fake.routes.set('GET /presets', () => [
      {
        id: 'preset_1',
        name: 'Tiệm phim',
        targetLanguage: 'vi-VN',
        sourceLanguage: 'zh',
        settings: { ttsProviderId: 'neural-tts' },
        outputDir: 'D:\\Dubs\\{series}',
        series: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic', autoStart: false },
        createdAt: '',
        updatedAt: '',
      },
    ]);
    fake.routes.set('POST /projects', () =>
      project({
        series: { role: 'parent', state: 'analysing', settings: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4, autoStart: false } },
      }),
    );
    await connect();
    const r = await call('create_project', { videoPath: 'E:/raw/long.mp4', presetId: 'preset_1', settings: { duckingLevelDb: -6 } });
    expect(r.isError).toBe(false);
    // The app lays the call over the preset: no defaults are read or sent from here.
    expect(fake.calls.some((c) => c.path.startsWith('/project-defaults'))).toBe(false);
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ presetId: 'preset_1', settings: { duckingLevelDb: -6 }, linkInputVideo: true });
    expect(body.settings).not.toHaveProperty('targetLanguage');
    expect(body.series).toBeUndefined();
    expect(r.text).toContain('from the preset "Tiệm phim"');
    expect(r.text).toContain('Made as a series of 30-40 min parts');
    expect(r.text).toContain('autoStart=false');

    // A preset id that does not exist, or neither a language nor a preset: refused before anything is made.
    const made = fake.calls.filter((c) => c.method === 'POST' && c.path === '/projects').length;
    const unknown = await call('create_project', { videoPath: 'E:/raw/x.mp4', presetId: 'preset_nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('there is no preset "preset_nope"');
    expect(unknown.text).not.toContain('Unexpected error');
    const noLanguage = await call('create_project', { videoPath: 'E:/raw/x.mp4' });
    expect(noLanguage.isError).toBe(true);
    expect(noLanguage.text).toContain('say which language to dub into');
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/projects')).toHaveLength(made);
  });

  it('list_presets shows the built-in presets, and create_project takes one with the call\'s languages', async () => {
    createRoutes();
    fake.routes.set('GET /presets', () => []);
    const builtin = (id: string, name: string, text: string) => ({
      id,
      name,
      targetLanguage: 'vi-VN',
      settings: { processingMode: 'local', renderQuality: 'fast' },
      builtin: { kind: id.slice('builtin:'.length), tradeoffs: [{ key: 'k', text }] },
      createdAt: '',
      updatedAt: '',
    });
    fake.routes.set('GET /presets/builtin', () => [
      builtin('builtin:quality', 'Highest quality', 'The largest speech model.'),
      builtin('builtin:economy', 'Lowest cost', 'A fast render.'),
    ]);
    fake.routes.set('POST /projects', () => project());
    await connect();
    const listed = await call('list_presets');
    expect(listed.text).toContain("No presets of the user's yet.");
    expect(listed.text).toContain('Built in, worked out for this computer (its own engines only, never a cloud AI');
    expect(listed.text).toContain('- builtin:economy "Lowest cost": A fast render.');

    const refused = await call('create_project', { videoPath: 'E:/raw/x.mp4', presetId: 'builtin:economy' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('works for any language');
    const r = await call('create_project', { videoPath: 'E:/raw/x.mp4', presetId: 'builtin:economy', targetLanguage: 'vi-VN', sourceLanguage: 'zh' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('from the preset "Lowest cost"');
    expect(fake.calls.find((c) => c.path.startsWith('/presets/builtin?'))!.path).toBe('/presets/builtin?sourceLanguage=zh&targetLanguage=vi-VN');
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ presetId: 'builtin:economy', settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN' } });
  });

  it('create_project says a preset\'s video was dubbed whole when it is too short for the preset\'s series', async () => {
    createRoutes();
    fake.routes.set('GET /presets', () => [
      { id: 'preset_1', name: 'Tiệm phim', targetLanguage: 'vi-VN', sourceLanguage: 'zh', settings: {}, series: { maxMinutes: 40 }, createdAt: '', updatedAt: '' },
    ]);
    fake.routes.set('POST /projects', () => project());
    await connect();
    const r = await call('create_project', { videoPath: 'E:/raw/short.mp4', presetId: 'preset_1' });
    expect(r.text).toContain('Dubbed whole: the video is not long enough');
  });

  it('replace_lines takes many ranges, inline or from a JSON file, as one history entry', async () => {
    fake.routes.set('POST /projects/proj_1/lines/replace-many', (_q, body) => {
      const ranges = (body as { ranges: { fromMs: number; toMs: number; lines: unknown[] }[] }).ranges;
      return { replaced: 7, made: 3, ranges: ranges.map((r) => ({ fromMs: r.fromMs, toMs: r.toMs, replaced: 3, lines: r.lines })) };
    });
    await connect();
    const ranges = [
      { fromMs: 1000, toMs: 5000, lines: [{ startMs: 1500, endMs: 3000, text: '大家小点声' }] },
      { fromMs: 9000, toMs: 12_000, lines: [{ startMs: 9500, endMs: 11_000, text: '快跑' }, { startMs: 11_100, endMs: 11_900, text: '走' }] },
    ];
    const inline = await call('replace_lines', { projectId: 'proj_1', ranges });
    expect(inline.text).toContain('Replaced 7 line(s) with 3 in 2 range(s), as one history entry');
    expect((fake.calls.find((c) => c.path.endsWith('/replace-many'))!.body as { ranges: unknown[] }).ranges).toEqual(ranges);
    const dir = await mkdtemp(join(tmpdir(), 'vd-mcp-ranges-'));
    try {
      const file = join(dir, 'fix.json');
      await writeFile(file, JSON.stringify({ ranges }), 'utf8');
      const fromFile = await call('replace_lines', { projectId: 'proj_1', file });
      expect(fromFile.isError).toBe(false);
      expect(fake.calls.filter((c) => c.path.endsWith('/replace-many'))).toHaveLength(2);
      const nothing = await call('replace_lines', { projectId: 'proj_1' });
      expect(nothing).toMatchObject({ isError: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dismiss_warnings sets the named warnings aside and says what remains', async () => {
    fake.routes.set('POST /projects/proj_1/warnings/dismiss', (_q, body) => ({
      dismissed: (body as { codes?: string[] }).codes ? 2 : 3,
      codes: ['stt-no-speech'],
      warnings: [{ code: 'speakers-failed' }],
    }));
    await connect();
    const r = await call('dismiss_warnings', { projectId: 'proj_1', codes: ['stt-no-speech'] });
    expect(fake.calls.find((c) => c.path.endsWith('/warnings/dismiss'))!.body).toEqual({ codes: ['stt-no-speech'] });
    expect(r.text).toBe('Dismissed 2 warning(s) (stt-no-speech). 1 remain.');
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

/**
 * join_videos / get_join / retry_join driven as Claude drives them: a real MCP
 * client over the SDK's in-memory transport, against a fake orchestrator that
 * answers only the routes these tools use.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { VideoDubberApi } from './api.js';
import { aboutDuration } from './joinTools.js';
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

const files = [
  { path: 'D:/v/持械入大宋 P1.mp4', name: '持械入大宋 P1.mp4', startMs: 0, durationMs: 36_000_000 },
  { path: 'D:/v/持械入大宋 P2.mp4', name: '持械入大宋 P2.mp4', startMs: 36_000_000, durationMs: 9_826_357 },
];

const fileInfo = (name: string, durationMs: number, over: Record<string, unknown> = {}) => ({
  path: `D:/v/${name}`,
  name,
  sizeBytes: 6e9,
  durationMs,
  video: { codec: 'h264', profile: 'High', width: 1080, height: 1920, fps: 25, pixFmt: 'yuv420p' },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
  ...over,
});

const okCheck = (over: Record<string, unknown> = {}) => ({
  files: [fileInfo('持械入大宋 P1.mp4', 36_000_000), fileInfo('持械入大宋 P2.mp4', 9_826_357, { audio: { codec: 'aac', sampleRate: 44100, channels: 2 } })],
  ok: true,
  mode: 'copy',
  mismatches: [],
  totalDurationMs: 45_826_357,
  mixedSampleRates: true,
  disk: { folder: 'D:/VideoDubber/projects', needBytes: 12.8e9, freeBytes: 100e9, enough: true },
  ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  projectId: 'proj_1',
  state: 'running',
  mode: 'copy',
  files,
  totalDurationMs: 45_826_357,
  percent: 37,
  etaSec: 250,
  currentFile: 0,
  startedAt: '2026-11-24T00:00:00Z',
  attempts: 1,
  startWhenDone: false,
  ...over,
});

const project = {
  id: 'proj_1',
  name: '持械入大宋',
  inputVideoPath: 'D:/VideoDubber/projects/proj_1/input/original.mp4',
  workspaceDir: 'D:/VideoDubber/projects/proj_1',
  outputDir: 'D:/VideoDubber/projects/proj_1/render',
  status: 'created',
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
  settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN', subtitleExportMode: 'burned-in', processingMode: 'local', sttProviderId: 'whisper-cpp', translationProviderId: 'llama-cpp', ttsProviderId: 'vieneu-tts' },
  inputFiles: files,
};

describe('join tools', () => {
  let fake: Fake;
  let client: Client;

  const connect = async (workBudgetMs = 2000) => {
    const server = createVideoDubberServer({ api: new VideoDubberApi({ baseUrl: fake.url }), version: 'test', pollMs: 10, workBudgetMs });
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

  const posted = (path: string) => fake.calls.find((c) => c.method === 'POST' && c.path === path)?.body as Record<string, unknown> | undefined;

  beforeEach(async () => {
    fake = await startFake();
    fake.routes.set('GET /project-defaults', () => ({
      settings: { ...project.settings, renderQuality: 'auto', reviewBeforeSynthesis: false },
      notes: ['VieNeu voices are installed.'],
    }));
    fake.routes.set('POST /join/check', () => okCheck());
    fake.routes.set('POST /projects/join', () => ({ project, join: status({ state: 'waiting', percent: null }) }));
    fake.routes.set('POST /projects/proj_1/ensure-resources', () => ({ installing: false }));
    let polls = 0;
    fake.routes.set('GET /projects/proj_1/join', () =>
      ++polls < 3 ? status() : status({ state: 'done', percent: 100, result: { durationMs: 45_826_357, sizeBytes: 12.6e9 } }),
    );
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await fake.close();
  });

  it('checks, makes the project from the app\'s defaults, and follows the join to the end', async () => {
    await connect();
    const r = await call('join_videos', {
      videoPaths: files.map((f) => f.path),
      targetLanguage: 'vi-VN',
      sourceLanguage: 'zh',
      settings: { reviewBeforeSynthesis: true },
    });
    expect(r.isError).toBe(false);
    expect(posted('/join/check')).toEqual({ videoPaths: files.map((f) => f.path), renderQuality: 'auto' });
    expect(posted('/projects/join')).toMatchObject({
      name: '',
      videoPaths: files.map((f) => f.path),
      settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN', reviewBeforeSynthesis: true, ttsProviderId: 'vieneu-tts' },
      reencode: false,
      start: false,
    });
    expect(posted('/projects/proj_1/ensure-resources')).toBeDefined();
    expect(r.text).toContain('Created "持械入大宋" (proj_1) from 2 videos.');
    expect(r.text).toContain('Note: VieNeu voices are installed.');
    expect(r.text).toContain('Joined 2 videos (12:43:46.36, 11.7 GB): the project\'s video is ready.');
    expect(r.text).toContain('Picture: copied as it is');
    expect(r.text).toContain('2. 持械入大宋 P2.mp4 at 10:00:00.00 (2:43:46.36)');
    expect(r.text).toContain('Next: start_dubbing.');
  });

  it('reports the cost of a re-encode and makes nothing until the user agrees', async () => {
    fake.routes.set('POST /join/check', () =>
      okCheck({
        mode: 'reencode',
        mismatches: [{ field: 'resolution', index: 1, value: '720×1280', expected: '1080×1920' }],
        reencode: { target: { width: 1080, height: 1920, fps: 25 }, encoder: 'h264_nvenc', estimatedSec: 7800, estimatedBytes: 9.5e9 },
      }),
    );
    await connect();
    const args = { videoPaths: files.map((f) => f.path), targetLanguage: 'vi-VN', sourceLanguage: 'zh' };
    const refused = await call('join_videos', args);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Nothing was made yet');
    expect(refused.text).toContain('持械入大宋 P2.mp4: picture size 720×1280, the first file 1080×1920');
    expect(refused.text).toContain('1080×1920 at 25 fps with h264_nvenc: about 2 h 10 min on this computer, about 8.8 GB');
    expect(refused.text).toContain('reencode=true');
    expect(posted('/projects/join')).toBeUndefined();

    const agreed = await call('join_videos', { ...args, reencode: true });
    expect(agreed.isError).toBe(false);
    expect(posted('/projects/join')).toMatchObject({ reencode: true });
  });

  it('refuses files that cannot be joined, and a drive without room, before making anything', async () => {
    fake.routes.set('POST /join/check', () =>
      okCheck({ ok: false, files: [fileInfo('a.mp4', 1000), fileInfo('b.mp3', 1000, { video: undefined, error: { code: 'UNSUPPORTED_MEDIA', message: 'b.mp3 has no picture to join.' } })] }),
    );
    await connect();
    const bad = await call('join_videos', { videoPaths: ['D:/v/a.mp4', 'D:/v/b.mp3'], targetLanguage: 'vi-VN', sourceLanguage: 'zh' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('2. b.mp3 (00:01.00, 5.6 GB): CANNOT BE JOINED: b.mp3 has no picture to join.');

    fake.routes.set('POST /join/check', () => okCheck({ disk: { folder: 'D:/VideoDubber/projects', needBytes: 19.6e9, freeBytes: 9.8e9, enough: false } }));
    const full = await call('join_videos', { videoPaths: files.map((f) => f.path), targetLanguage: 'vi-VN', sourceLanguage: 'zh' });
    expect(full.isError).toBe(true);
    expect(full.text).toContain('needs about 18.3 GB free in D:/VideoDubber/projects');
    expect(full.text).toContain('9.1 GB is free');
    expect(posted('/projects/join')).toBeUndefined();
  });

  it('hands over to get_join when the join outlasts the call, and starts the dub itself when asked', async () => {
    fake.routes.set('GET /projects/proj_1/join', () => status({ startWhenDone: true }));
    await connect(60);
    const r = await call('join_videos', { videoPaths: files.map((f) => f.path), targetLanguage: 'vi-VN', sourceLanguage: 'zh', start: true });
    expect(r.isError).toBe(false);
    expect(posted('/projects/join')).toMatchObject({ start: true });
    expect(r.text).toContain('Joining 2 videos: 37%, about 4 min left (file 1 of 2: 持械入大宋 P1.mp4).');
    expect(r.text).toContain('get_join(projectId="proj_1", waitSeconds=50); the dub starts by itself once the videos are joined.');
  });

  it('defaults a series to Claude through Mother Claude, as create_project does', async () => {
    fake.routes.set('GET /series/ai-options', () => [
      { id: 'openai-translate', ready: true },
      { id: 'anthropic-translate', ready: true, viaMotherClaude: true },
    ]);
    await connect();
    const r = await call('join_videos', {
      videoPaths: files.map((f) => f.path),
      targetLanguage: 'vi-VN',
      sourceLanguage: 'zh',
      series: { minMinutes: 30, maxMinutes: 40 },
    });
    expect(posted('/projects/join')).toMatchObject({
      series: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4, autoStart: true },
    });
    expect(r.text).toContain('Series: autoStart=true.');
  });

  it('get_join waits for the end; a failed join says why and how to retry', async () => {
    await connect();
    const done = await call('get_join', { projectId: 'proj_1', waitSeconds: 5 });
    expect(done.text).toContain('Joined 2 videos');

    fake.routes.set('GET /projects/proj_1/join', () =>
      status({ state: 'failed', percent: null, error: { code: 'UNKNOWN', message: 'The joined video came out short.', remediation: 'Check that each video plays to its end.' } }),
    );
    const failed = await call('get_join', { projectId: 'proj_1' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('The join FAILED: The joined video came out short.\nHow to fix: Check that each video plays to its end.');
    expect(failed.text).toContain('retry_join with projectId "proj_1" joins again.');
  });

  it('retry_join joins again, accepting a re-encode when told to', async () => {
    fake.routes.set('POST /projects/proj_1/join/restart', () => status({ state: 'waiting', percent: null }));
    await connect();
    const r = await call('retry_join', { projectId: 'proj_1', reencode: true });
    expect(posted('/projects/proj_1/join/restart')).toEqual({ reencode: true });
    expect(r.text).toContain('Joined 2 videos');
  });

  it('says durations in words', () => {
    expect(aboutDuration(20)).toBe('under a minute');
    expect(aboutDuration(250)).toBe('about 4 min');
    expect(aboutDuration(7800)).toBe('about 2 h 10 min');
  });
});

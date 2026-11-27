/**
 * The MCP server driven the way Claude drives it: a real MCP client over the
 * SDK's in-memory transport, against a fake VideoDubber orchestrator on a local
 * HTTP port that answers only the routes these tools use (SSE streams too).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  routes.set('GET /health', () => ({ status: 'ok', version: '0.11.1', platform: 'win32-x64' }));
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

/** Write SSE frames, then keep the stream open like the app does. */
function sse(res: ServerResponse, events: unknown[], delayMs = 20): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(': ping\n\n');
  let i = 0;
  const tick = (): void => {
    if (i >= events.length || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
    setTimeout(tick, delayMs);
  };
  setTimeout(tick, delayMs);
}

const project = (over: Record<string, unknown> = {}) => ({
  id: 'proj_1',
  name: 'wukong',
  inputVideoPath: 'C:/v/wukong.mp4',
  workspaceDir: 'C:/nonexistent/proj_1',
  outputDir: 'C:/nonexistent/proj_1/render',
  status: 'created',
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
  mediaInfo: { durationMs: 90_000 },
  settings: {
    sourceLanguage: 'zh',
    targetLanguage: 'vi-VN',
    subtitleExportMode: 'burned-in',
    processingMode: 'local',
    sttProviderId: 'whisper-cpp',
    sttModel: 'large-v3-turbo',
    translationProviderId: 'llama-cpp',
    ttsProviderId: 'neural-tts',
  },
  ...over,
});

const pipeline = (over: Record<string, unknown> = {}) => ({
  projectId: 'proj_1',
  status: 'idle',
  progressPercent: 0,
  steps: [
    { id: 'stt', label: 'STT', status: 'completed', progressPercent: 100 },
    { id: 'translation', label: 'Translate', status: 'completed', progressPercent: 100 },
    { id: 'tts', label: 'TTS', status: 'pending', progressPercent: 0 },
  ],
  updatedAt: '2026-11-17T00:00:00Z',
  ...over,
});

const seg = (id: string, startMs: number, endMs: number, sourceText: string, extra: Record<string, unknown> = {}) => ({
  id,
  index: Number(id.slice(4)) - 1,
  startMs,
  endMs,
  sourceText,
  ...extra,
});

describe('VideoDubber MCP server', () => {
  let fake: Fake;
  let client: Client;

  const connect = async (opts: { workBudgetMs?: number; baseUrl?: string } = {}) => {
    const server = createVideoDubberServer({
      api: new VideoDubberApi({ baseUrl: opts.baseUrl ?? fake.url }),
      version: 'test',
      pollMs: 20,
      ...(opts.workBudgetMs !== undefined ? { workBudgetMs: opts.workBudgetMs } : {}),
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

  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await fake.close();
  });

  it('offers the whole workflow, with honest read-only hints', async () => {
    await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        // 0.18.0: songs kept as the original (casting is cast_voices, below).
        'mark_song',
        'adjust_lines', 'cancel_dubbing', 'create_project', 'download_video', 'get_download', 'get_project',
        'get_status', 'get_transcript', 'get_translation_context', 'get_translation_report', 'install_engine',
        'install_voice', 'list_engines',
        'list_languages', 'list_projects', 'list_providers', 'list_voices', 'open_output_folder', 'pause_dubbing', 'run_next',
        'regenerate_voices', 'render_video', 'set_save_folder', 'set_translation_context', 'set_translations',
        'start_dubbing', 'update_settings',
        // Batches (Mother Claude's flow, agreed 2026-11-19).
        'download_videos', 'list_downloads', 'cancel_download', 'retry_download', 'delete_download', 'wait_jobs',
        'follow_jobs_command', 'list_presets', 'dub_downloads', 'get_outputs', 'mark_published',
        'set_download_login', 'get_download_login', 'delete_project', 'list_brand_kit', 'get_series',
        'set_split_plan', 'start_series',
        // One project from several videos (0.18.0).
        'join_videos', 'get_join', 'retry_join',
        // Production hardening (0.17.0).
        'get_queue', 'get_diagnostics', 'rebuild_parts', 'replace_lines', 'retranscribe_range', 'export_transcript', 'get_speakers', 'detect_speakers', 'cast_voices',
        // 0.18.0: series, create, continue.
        'edit_part', 'replan_series',
        // Activity and edit history (0.18.0).
        'get_activity', 'report_activity', 'get_history', 'undo_edit',
        // Picture options (0.18.0).
        'detect_watermark',
        // Warnings set aside once checked (0.19.0).
        'dismiss_warnings',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
    const ro = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
    expect(ro('get_transcript')).toBe(true);
    expect(ro('set_translations')).toBe(false);
    expect(ro('get_queue')).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['dub_video', 'improve_translation']);
  });

  it('says plainly that the app is not running, and how to start it', async () => {
    const closed = await startFake();
    await closed.close(); // a port nothing listens on
    await connect({ baseUrl: closed.url });
    const r = await call('list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/VideoDubber is not running/);
    expect(r.text).toMatch(/pnpm dev/);
  });

  it('passes the app\'s own error and remedy through', async () => {
    fake.routes.set('POST /projects/proj_1/run', (_q, _b, res) => {
      res.writeHead(424, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'ENGINE_PACK_MISSING',
            message: 'whisper.cpp needs the "large-v3-turbo" speech model (about 1.5 GB), which is not downloaded yet.',
            remediation: 'Press Start (or Retry) to download it.',
          },
        }),
      );
    });
    await connect();
    const r = await call('start_dubbing', { projectId: 'proj_1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('speech model (about 1.5 GB)');
    expect(r.text).toContain('How to fix: Press Start');
    expect(r.text).toContain('ENGINE_PACK_MISSING');
  });

  it('get_status shows the hardware and what is worth installing', async () => {
    fake.routes.set('GET /system', () => ({
      profile: {
        cpuModel: 'Intel i5-13400F',
        cpuCores: 16,
        totalRamMb: 32768,
        appleSilicon: false,
        gpus: [{ name: 'NVIDIA GeForce RTX 3050', vramMb: 8192, driverVersion: '621.24' }],
      },
    }));
    fake.routes.set('GET /engines', () => ({ installed: [{ id: 'whisper-cpp-cuda' }], available: [] }));
    fake.routes.set('GET /engines/recommended', () => ({
      recommendations: [
        { packId: 'whisper-cpp-cuda', reason: 'GPU speech-to-text' },
        { packId: 'whisper-model-large-v3-turbo', reason: 'the model it runs' },
      ],
      fits: [],
    }));
    await connect();
    const r = await call('get_status');
    expect(r.text).toContain('VideoDubber 0.11.1');
    expect(r.text).toContain('NVIDIA GeForce RTX 3050 8 GB (driver 621.24)');
    expect(r.text).toContain('whisper-model-large-v3-turbo: the model it runs');
    expect(r.text).not.toContain('whisper-cpp-cuda: GPU'); // installed: not offered again
  });

  it('create_project starts from the app\'s defaults, lets Claude override them, probes and fetches models', async () => {
    fake.routes.set('GET /project-defaults', () => ({
      settings: { ...project().settings, sourceLanguage: '', reviewBeforeSynthesis: false },
      notes: ['Using whisper.cpp on the GPU.'],
    }));
    fake.routes.set('POST /projects', (_q, body) => ({ ...project(), ...(body as object), id: 'proj_9' }));
    fake.routes.set('POST /projects/proj_9/probe', () => ({ durationMs: 90_000 }));
    fake.routes.set('POST /projects/proj_9/ensure-resources', () => ({ installing: true, enginePacks: ['whisper-model-large-v3-turbo'] }));
    await connect();
    const r = await call('create_project', {
      videoPath: 'D:/videos/wukong 3.mp4',
      targetLanguage: 'vi-VN',
      sourceLanguage: 'zh',
      settings: { reviewBeforeSynthesis: true },
    });
    expect(r.isError).toBe(false);
    const created = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as {
      name: string;
      settings: Record<string, unknown>;
    };
    expect(created.name).toBe('wukong 3');
    expect(created.settings).toMatchObject({ sourceLanguage: 'zh', targetLanguage: 'vi-VN', reviewBeforeSynthesis: true, sttProviderId: 'whisper-cpp' });
    expect(fake.calls.some((c) => c.path === '/project-defaults?targetLanguage=vi-VN&sourceLanguage=zh')).toBe(true);
    expect(r.text).toContain('proj_9');
    expect(r.text).toContain('Note: Using whisper.cpp on the GPU.');
    expect(r.text).toContain('whisper-model-large-v3-turbo');
  });

  it('create_project saves where Claude is told to, and get_project says where that is', async () => {
    fake.routes.set('GET /project-defaults', () => ({ settings: project().settings, notes: [] }));
    fake.routes.set('POST /projects', (_q, body) => ({
      ...project(),
      id: 'proj_9',
      outputDir: (body as { outputDir: string }).outputDir,
      outputFileName: 'wukong 3.vi',
    }));
    fake.routes.set('POST /projects/proj_9/probe', () => ({ durationMs: 90_000 }));
    fake.routes.set('POST /projects/proj_9/ensure-resources', () => ({ installing: false }));
    fake.routes.set('GET /projects/proj_9', () => ({
      project: project({ id: 'proj_9', outputDir: 'D:/Dubs', outputFileName: 'wukong 3.vi' }),
      pipeline: pipeline(),
    }));
    await connect();

    const r = await call('create_project', { videoPath: 'D:/videos/wukong 3.mp4', targetLanguage: 'vi-VN', saveTo: ' D:/Dubs ' });
    expect(r.isError).toBe(false);
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as { outputDir?: string };
    expect(body.outputDir).toBe('D:/Dubs');
    expect(r.text).toContain('Saves to: D:/Dubs/wukong 3.vi.mp4');

    const g = await call('get_project', { projectId: 'proj_9' });
    expect(g.text).toContain('Saves to: D:/Dubs/wukong 3.vi.mp4');
  });

  it('create_project leaves the folder to the app when Claude names none', async () => {
    fake.routes.set('GET /project-defaults', () => ({ settings: project().settings, notes: [] }));
    fake.routes.set('POST /projects', () => ({ ...project(), id: 'proj_9' }));
    fake.routes.set('POST /projects/proj_9/probe', () => ({ durationMs: 90_000 }));
    fake.routes.set('POST /projects/proj_9/ensure-resources', () => ({ installing: false }));
    await connect();
    await call('create_project', { videoPath: 'D:/videos/wukong.mp4', targetLanguage: 'vi-VN' });
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/projects')!.body as Record<string, unknown>;
    expect('outputDir' in body).toBe(false);
  });

  it('set_save_folder moves a project to a folder, or back to the default', async () => {
    fake.routes.set('PUT /projects/proj_1/output-dir', (_q, body) => {
      const dir = (body as { outputDir: string | null }).outputDir;
      return dir ? project({ outputDir: dir, outputFileName: 'wukong.vi' }) : project();
    });
    await connect();

    const chosen = await call('set_save_folder', { projectId: 'proj_1', folder: 'D:/Dubs' });
    expect(chosen.text).toContain('Saves to: D:/Dubs/wukong.vi.mp4');
    const back = await call('set_save_folder', { projectId: 'proj_1' });
    expect(back.text).toContain('Saves to: C:/nonexistent/proj_1/render/output.mp4');
    const bodies = fake.calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(bodies).toEqual([{ outputDir: 'D:/Dubs' }, { outputDir: null }]);
  });

  describe('translation work', () => {
    const timeline = (translated: boolean, extra: Record<string, Record<string, unknown>> = {}) => ({
      projectId: 'proj_1',
      translated,
      aligned: translated,
      units: [],
      cueOverrides: {},
      media: { videoPath: 'x' },
      segments: [
        seg('seg_0001', 0, 4480, '谁又给小爷我干哪儿来了', { ...(translated ? { translatedText: 'Ai lại đưa tiểu gia đến đây' } : {}), ...extra.seg_0001 }),
        seg('seg_0002', 4480, 5960, '这里不是三界', { ...(translated ? { translatedText: 'Nơi này không phải tam giới mà là chốn tiên cảnh xa xôi' } : {}), ...extra.seg_0002 }),
        seg('seg_0003', 30_000, 46_960, '虎哥 这啥地方啊', { ...(translated ? { translatedText: 'Hổ ca, đây là đâu?' } : {}), ...extra.seg_0003 }),
      ],
    });

    it('get_transcript shows each line\'s budget, length and fit, and can list only what needs work', async () => {
      fake.routes.set('GET /projects/proj_1', () => ({ project: project(), pipeline: pipeline() }));
      fake.routes.set('GET /projects/proj_1/timeline', () =>
        timeline(true, { seg_0003: { alignment: { segmentId: 'seg_0003', status: 'timing-conflict', speedRatio: 1.6, overflowMs: 420 } } }),
      );
      await connect();
      const all = await call('get_transcript', { projectId: 'proj_1' });
      expect(all.text).toContain('3 lines, 3 translated, 0 flagged by the checks, 0 over budget, 1 timing conflicts');
      // 1.48 s plus a second of the pause after it (the window the pipeline's
      // prompts budget) at the shared Vietnamese rate: aim 11, at most 13.
      expect(all.text).toContain(
        'seg_0002 00:04.48-00:05.96 (1.5s, ≤13 syllables (aim 11)) | 这里不是三界 => Nơi này không phải tam giới mà là chốn tiên cảnh xa xôi [13]',
      );
      expect(all.text).toContain('fit 1.60x timing-conflict +420ms');
      const attention = await call('get_transcript', { projectId: 'proj_1', filter: 'attention' });
      expect(attention.text).toContain('seg_0003');
      expect(attention.text).not.toContain('seg_0001 ');
      expect(attention.text).not.toContain('seg_0002 ');
    });

    it('get_transcript budgets at the voice\'s measured pace and surfaces lines the checks flagged', async () => {
      fake.routes.set('GET /projects/proj_1', () => ({ project: project(), pipeline: pipeline() }));
      fake.routes.set('GET /projects/proj_1/timeline', () => ({
        ...timeline(true, { seg_0001: { qualityFlags: ['pinyin'] } }),
        // VieNeu measured at 3.5 syllables/s: the same 2.48 s window allows fewer.
        speechRate: { perSecond: 3.5, source: 'measured' },
      }));
      await connect();
      const all = await call('get_transcript', { projectId: 'proj_1' });
      expect(all.text).toContain('1 flagged by the checks, 1 over budget');
      expect(all.text).toContain("Budgets use the voice's measured pace of 3.5/s.");
      expect(all.text).toContain('(1.5s, ≤10 syllables (aim 9))');
      expect(all.text).toContain('NEEDS FIX: pinyin');
      const attention = await call('get_transcript', { projectId: 'proj_1', filter: 'attention' });
      expect(attention.text).toContain('seg_0001 ');
      expect(attention.text).toContain('seg_0002 ');
    });

    it('set_translations refuses a partial first translation (an artifact that exists must be complete)', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => timeline(false));
      await connect();
      const r = await call('set_translations', { projectId: 'proj_1', lines: [{ id: 'seg_0001', text: 'Ai lại đưa ta đến đây?' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('all 3 lines must be saved together');
      expect(fake.calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('set_translations saves edits once a translation exists, and says what happens next', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => timeline(true));
      fake.routes.set('PUT /projects/proj_1/segments', () => ({ ok: true }));
      fake.routes.set('GET /projects/proj_1', () => ({ project: project(), pipeline: pipeline({ awaitingReview: true }) }));
      await connect();
      const r = await call('set_translations', {
        projectId: 'proj_1',
        lines: [
          { id: 'seg_0002', text: '  Đây đâu phải tam giới  ' },
          { id: 'seg_0001', text: 'Ai lại đưa tiểu gia đến đây' },
        ],
      });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('Saved 2 lines (1 changed)');
      expect(r.text).toContain('paused for review: start_dubbing continues');
      const put = fake.calls.find((c) => c.method === 'PUT')!.body as { segments: { id: string; translatedText: string }[] };
      expect(put.segments).toContainEqual({ id: 'seg_0002', translatedText: 'Đây đâu phải tam giới' });
    });

    it('set_translations rejects unknown ids and empty text before touching anything', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => timeline(true));
      await connect();
      const r = await call('set_translations', {
        projectId: 'proj_1',
        lines: [{ id: 'seg_9999', text: 'x' }, { id: 'seg_0001', text: '   ' }],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Unknown line ids: seg_9999');
      expect(r.text).toContain('Empty text for: seg_0001');
      expect(fake.calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('regenerate_voices works through out-of-date lines, re-reading after each one', async () => {
      const stale = new Set(['seg_0001', 'seg_0002', 'seg_0003']);
      fake.routes.set('GET /projects/proj_1/timeline', () => {
        const doc = timeline(true);
        for (const s of doc.segments) (s as Record<string, unknown>).ttsStale = stale.has(s.id);
        return doc;
      });
      for (const id of stale) {
        fake.routes.set(`POST /projects/proj_1/segments/${id}/tts`, () => {
          stale.delete(id);
          // Re-voicing seg_0001 re-voices its merged partner seg_0002 too.
          if (id === 'seg_0001') stale.delete('seg_0002');
          return { alignment: { segmentId: id } };
        });
      }
      await connect();
      const r = await call('regenerate_voices', { projectId: 'proj_1' });
      expect(r.text).toContain('Re-voiced 2 line(s). Nothing left out of date');
      const voiced = fake.calls.filter((c) => c.path.endsWith('/tts')).map((c) => c.path.split('/')[4]);
      expect(voiced).toEqual(['seg_0001', 'seg_0003']);
    });

    it('regenerate_voices stops at its time budget and says how much is left', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => {
        const doc = timeline(true);
        for (const s of doc.segments) (s as Record<string, unknown>).ttsStale = true;
        return doc;
      });
      for (const id of ['seg_0001', 'seg_0002', 'seg_0003']) {
        fake.routes.set(`POST /projects/proj_1/segments/${id}/tts`, async () => {
          await new Promise((r) => setTimeout(r, 30));
          return {};
        });
      }
      await connect({ workBudgetMs: 10 });
      const r = await call('regenerate_voices', { projectId: 'proj_1' });
      expect(r.text).toMatch(/Re-voiced 1 line\(s\); 3 still to do\. Call regenerate_voices again/);
    });

    it('render_video refuses while voices are out of date', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => timeline(true, { seg_0002: { ttsStale: true } }));
      await connect();
      const r = await call('render_video', { projectId: 'proj_1' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('1 line(s) have out-of-date voices');
      expect(fake.calls.some((c) => c.path.endsWith('/retry'))).toBe(false);
    });

    it('render_video re-mixes from audio-mix, switching the subtitle mode first when asked', async () => {
      fake.routes.set('GET /projects/proj_1/timeline', () => timeline(true));
      fake.routes.set('PUT /projects/proj_1/settings', () => ({ project: project() }));
      fake.routes.set('POST /projects/proj_1/retry', () => ({ started: true }));
      await connect();
      const r = await call('render_video', { projectId: 'proj_1', subtitleExportMode: 'srt-file' });
      expect(r.isError).toBe(false);
      const order = fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
      expect(order).toEqual(['PUT /projects/proj_1/settings', 'POST /projects/proj_1/retry']);
      expect(fake.calls.find((c) => c.path.endsWith('/retry'))!.body).toEqual({ stepId: 'audio-mix' });
    });
  });

  // 0.18.0 (plan 1.4, 6.2): the crowd shares a pool of voices; songs keep the original.
  describe('casting and songs', () => {
    it('cast_voices shows the pools by voice, the soundalikes left out and the unknown-gender speakers with their lines', async () => {
      fake.routes.set('POST /projects/proj_1/speakers/cast', () => ({
        unconfirmed: [],
        assignments: [
          { speakerId: 'SPEAKER_00', voiceId: 'vp_thien', voiceName: 'Thiện Minh (clone)', by: 'pitch-rank' },
          { speakerId: 'SPEAKER_01', voiceId: 'vieneu38-hai-dang', voiceName: 'Hải Đăng', by: 'pitch-rank' },
          { speakerId: 'SPEAKER_02', voiceId: 'vieneu38-hai-dang', voiceName: 'Hải Đăng', by: 'pool' },
          { speakerId: 'SPEAKER_03', voiceId: 'vieneu38-hai-dang', voiceName: 'Hải Đăng', by: 'pool' },
        ],
        defaults: { male: 'vieneu38-hai-dang' },
        unassigned: ['SPEAKER_09'],
        pools: {
          male: {
            minorSpeakers: 2,
            size: 3,
            voices: [{ voiceId: 'vieneu38-hai-dang', name: 'Hải Đăng', from: 'reused', sharedWith: 'SPEAKER_01', speakers: ['SPEAKER_02', 'SPEAKER_03'], minutes: 3 }],
          },
        },
        soundalikes: [{ voiceId: 'vieneu38-thien-minh', name: 'Thiện Minh', cloneId: 'vp_thien', cloneName: 'Thiện Minh - Nam - Miền Bắc', similarity: 0.84 }],
        unknown: [{ speakerId: 'SPEAKER_09', minutes: 2.31, lines: 14, samples: [{ id: 'seg_0123', text: '你是谁', startMs: 723_000, endMs: 726_000 }] }],
        notes: [
          'male: 2 minor speaker(s) share 1 voice(s), about 2 each; speakers who answer each other get different voices where possible.',
          'male: no spare built-in voice, so the voices of the least-heard cast speaker(s) SPEAKER_01 are shared too.',
          'Built-in voice "Thiện Minh" is left out of shared use: it sounds like your cloned voice "Thiện Minh - Nam - Miền Bắc" (0.84).',
          '1 speaker(s) of unknown gender keep the project voice (set them in the editor).',
        ],
      }));
      await connect();
      const r = await call('cast_voices', { projectId: 'proj_1', minorVoices: 0, minorPool: { male: ['vieneu38-hai-dang'] } });
      expect(fake.calls.find((c) => c.path.endsWith('/speakers/cast'))?.body).toMatchObject({ minorVoices: null, minorPool: { male: ['vieneu38-hai-dang'] } });
      expect(r.text).toContain('- SPEAKER_01 -> Hải Đăng (vieneu38-hai-dang, pitch-rank)');
      expect(r.text).not.toContain('- SPEAKER_02 ->');
      expect(r.text).toContain("  - Hải Đăng (vieneu38-hai-dang, also SPEAKER_01's voice): 2 speaker(s): SPEAKER_02, SPEAKER_03");
      expect(r.text).toContain('A speaker detected later: male -> vieneu38-hai-dang, female -> (project voice).');
      expect(r.text).toContain('Left out of shared use: built-in "Thiện Minh" (vieneu38-thien-minh) sounds like the user\'s clone "Thiện Minh - Nam - Miền Bắc" (0.84).');
      expect(r.text).toContain('- SPEAKER_09: 2.3 min, 14 line(s); longest: seg_0123 12:03.00 "你是谁"');
      // Said once: the notes the lines above already carry are not repeated.
      expect(r.text).toContain('Note: male: no spare built-in voice');
      expect(r.text).not.toContain('Note: male: 2 minor speaker(s)');
      expect(r.text).not.toContain('Note: Built-in voice');
    });

    it('mark_song keeps lines as the original song, says which clips need a new voice, and needs lines or a range', async () => {
      fake.routes.set('POST /projects/proj_1/songs', () => ({
        song: true,
        targets: [
          { id: 'seg_0002', startMs: 4480, endMs: 5960 },
          { id: 'seg_0003', startMs: 30_000, endMs: 46_960 },
        ],
        changed: [{ id: 'seg_0002', startMs: 4480, endMs: 5960 }],
        revoice: ['seg_0001'],
        songs: 2,
        parts: [{ projectId: 'proj_p1', index: 1, ok: true }, { projectId: 'proj_p2', index: 2, ok: false, skipped: 'dubbing now' }],
      }));
      await connect();
      const r = await call('mark_song', { projectId: 'proj_1', lineIds: ['seg_0002', 'seg_0003'], applyToParts: true });
      expect(fake.calls.find((c) => c.path.endsWith('/songs'))?.body).toEqual({ song: true, applyToParts: true, lineIds: ['seg_0002', 'seg_0003'] });
      expect(r.text).toContain('Kept as the original song: 1 line(s) (seg_0002 00:04.48-00:05.96); 1 already were. The project has 2 song line(s) now.');
      expect(r.text).toContain('1 line(s) need a new voice clip');
      expect(r.text).toContain('- part 2 (proj_p2): skipped, dubbing now');
      const none = await call('mark_song', { projectId: 'proj_1' });
      expect(none.isError).toBe(true);
    });

    it('get_transcript marks song lines and the app\'s suggestions, and lists them with filter="songs"', async () => {
      fake.routes.set('GET /projects/proj_1', () => ({ project: project(), pipeline: pipeline() }));
      fake.routes.set('GET /projects/proj_1/timeline', () => ({
        projectId: 'proj_1',
        translated: true,
        aligned: true,
        units: [],
        cueOverrides: {},
        media: { videoPath: 'x' },
        segments: [
          seg('seg_0001', 0, 4480, '谁又给小爷我干哪儿来了', { translatedText: 'Ai lại đưa tiểu gia đến đây' }),
          // An untranslated song line needs nothing: it has no voice, and its subtitle is off.
          seg('seg_0002', 4480, 9960, '夢裡淚水為誰流', { song: true }),
          seg('seg_0003', 30_000, 36_000, '風雨中的你', { translatedText: 'Em trong mưa gió' }),
        ],
      }));
      fake.routes.set('GET /projects/proj_1/songs', () => ({ songs: [], suggestions: [{ lineId: 'seg_0003', reasons: ['traditional', 'sung'] }], songSubtitles: false }));
      await connect();
      const all = await call('get_transcript', { projectId: 'proj_1' });
      expect(all.text).toContain('1 kept as the original song (no voice; subtitles off), 1 suggested as sung');
      expect(all.text).toContain('{SONG: the original plays, no voice}');
      expect(all.text).toContain('{SONG? traditional+sung: keep the original with mark_song}');
      const attention = await call('get_transcript', { projectId: 'proj_1', filter: 'attention' });
      expect(attention.text).not.toContain('seg_0002 ');
      const songs = await call('get_transcript', { projectId: 'proj_1', filter: 'songs' });
      expect(songs.text).toContain('Showing song lines and suggested songs 1-2 of 2.');
      expect(songs.text).not.toContain('seg_0001 ');
    });

    it('update_settings takes the song subtitles and the minor voices, and names the step for the first', async () => {
      fake.routes.set('PUT /projects/proj_1/settings', () => ({ project: project() }));
      await connect();
      const r = await call('update_settings', { projectId: 'proj_1', settings: { songSubtitles: true, minorVoices: 5 } });
      expect(fake.calls.find((c) => c.method === 'PUT')?.body).toEqual({ songSubtitles: true, minorVoices: 5 });
      expect(r.text).toContain('fromStep="render"');
    });
  });

  it('get_translation_report says what the passes did, starting with a failed character sheet', async () => {
    fake.routes.set('GET /projects/proj_1/translation-report', () => ({
      translation: {
        characterSheet: {
          status: 'failed',
          engine: 'Gemma chat',
          attempts: [{ mode: 'full', error: 'The local model did not answer within 30 min.' }, { mode: 'glossary-only' }],
        },
        quality: {
          checked: 120,
          repaired: [{ id: 'seg_0007', before: 'Nữ Th娲', after: 'Nữ Oa' }],
          flagged: [{ id: 'seg_0040', flags: ['pinyin'] }],
        },
        autoFit: {
          units: 3,
          changes: [{ id: 'seg_0012', before: 'Ta chỉ cần rụng một sợi lông', after: 'Rụng một sợi lông' }],
          rejected: [{ id: 'seg_0013', reason: 'cut too far (3 of 9)' }],
          stillLong: ['seg_0013'],
        },
      },
      review: {
        reviewed: 120,
        changes: [{ id: 'seg_0003', before: 'Câu số 03', after: 'Ngươi làm gì vậy?' }],
        rejected: [{ id: 'seg_0004', reason: 'fails line checks: wrong-script' }],
      },
    }));
    await connect();
    const out = (await call('get_translation_report', { projectId: 'proj_1' })).text;
    expect(out).toContain('Character sheet: FAILED with "Gemma chat" (full: The local model did not answer within 30 min.; glossary-only: failed)');
    expect(out).toContain('Line checks (120 lines): 1 repaired, 1 still flagged.');
    expect(out).toContain('flagged seg_0040: pinyin');
    expect(out).toContain('Review (120 lines): 1 changed, 1 refused by the checks.');
    expect(out).toContain('refused seg_0004: fails line checks: wrong-script');
    expect(out).toContain('Auto-fit (3 over-long unit(s)): 1 line(s) shortened, 1 refused, 1 still long.');
  });

  it("get_queue says when another app holds the graphics card, and why a dub waits for it", async () => {
    fake.routes.set('GET /queue', () => ({
      maxProjects: 2,
      budgetPoints: 4,
      usedPoints: 0,
      paused: false,
      running: [],
      holds: [{ holdId: 'hold_abc', holder: 'voice-mask', name: 'Voice Mask', lanes: ['gpu'], reason: 'live session', createdAt: '2026-11-25T14:00:00.000Z', expiresAt: '2026-11-25T14:00:30.000Z' }],
      entries: [{ projectId: 'proj_1', name: 'Tập 7', position: 1, reason: 'gpu-hold', message: 'Waiting: Voice Mask is using the graphics card.', heldBy: 'Voice Mask' }],
    }));
    await connect();
    const r = await call('get_queue');
    expect(r.text).toContain('Voice Mask is using the graphics card (hold hold_abc, until 2026-11-25T14:00:30.000Z, renewed by its app): live session.');
    expect(r.text).toContain('gpu-hold (Waiting: Voice Mask is using the graphics card.)');
  });

  it('pause_dubbing pauses, and get_project says where it stopped and how to continue', async () => {
    let paused = false;
    fake.routes.set('POST /projects/proj_1/pause', () => {
      paused = true;
      return { ok: true };
    });
    fake.routes.set('GET /projects/proj_1', () => ({
      project: project({ status: paused ? 'paused' : 'running' }),
      pipeline: paused
        ? pipeline({ status: 'paused', currentStep: 'tts', pausedStep: 'tts', pausedAt: '2026-11-17T10:00:00Z' })
        : pipeline({ status: 'running', currentStep: 'tts' }),
    }));
    await connect();

    const r = await call('pause_dubbing', { projectId: 'proj_1' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Paused at "tts"');
    const g = await call('get_project', { projectId: 'proj_1' });
    expect(g.text).toContain('PAUSED at "tts" since 2026-11-17T10:00:00Z');
    expect(g.text).toContain('start_dubbing');
  });

  it("dub_downloads says how a series made from a preset starts: the made project's own choice", async () => {
    const parent = (autoStart: boolean) => ({
      role: 'parent' as const,
      state: 'analysing' as const,
      settings: { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic-translate', recapSec: 4, autoStart },
    });
    let autoStart = false;
    fake.routes.set('GET /presets/preset_b3644eee88', () => ({ id: 'preset_b3644eee88', name: 'Trung → Việt (series)', targetLanguage: 'vi-VN', settings: {} }));
    fake.routes.set('GET /presets', () => [{ id: 'preset_b3644eee88', name: 'Trung → Việt (series)', targetLanguage: 'vi-VN', settings: {} }]);
    fake.routes.set('POST /downloads/dub', () => ({
      results: [
        { downloadId: 'dl_1', projectId: 'proj_long', name: 'Long', series: true, queued: true },
        { downloadId: 'dl_2', projectId: 'proj_short', name: 'Short', queued: true },
      ],
    }));
    fake.routes.set('GET /projects/proj_long', () => ({ project: project({ id: 'proj_long', series: parent(autoStart) }), pipeline: pipeline() }));
    await connect();
    // The preset's series block says false: the reply said "autoStart=true" (2026-11-27).
    const r = await call('dub_downloads', { downloadIds: ['dl_1', 'dl_2'], presetId: 'preset_b3644eee88' });
    expect(r.text).toContain('Series: autoStart=false. It stops at review after its analysis');
    autoStart = true;
    expect((await call('dub_downloads', { downloadIds: ['dl_1', 'dl_2'], presetId: 'preset_b3644eee88' })).text).toContain('Series: autoStart=true.');
  });

  it('get_project names every line to look at after the dub, list_projects counts them (H7)', async () => {
    const flagged = Array.from({ length: 7 }, (_, i) => ({ id: `seg_${String(i + 1).padStart(4, '0')}`, flags: i === 0 ? ['pinyin', 'no-diacritics'] : ['wrong-script'] }));
    fake.routes.set('GET /projects/proj_1', () => ({ project: project({ status: 'completed' }), pipeline: pipeline({ status: 'completed', progressPercent: 100 }) }));
    fake.routes.set('GET /projects/proj_1/issues', () => ({ flagged, overruns: [{ id: 'seg_0040', overflowMs: 1240 }] }));
    fake.routes.set('GET /projects', () => [
      { ...project({ status: 'completed' }), issues: { flagged: 7, overruns: 1 } },
      project({ id: 'proj_2', name: 'clean', status: 'completed' }),
    ]);
    await connect();
    const g = await call('get_project', { projectId: 'proj_1' });
    expect(g.text).toContain(
      'Lines to look at:\n  7 line(s) still fail the translation checks: seg_0001 (a pinyin name, no diacritics), seg_0002 (letters of another script), ',
    );
    // All seven, where the warning names five.
    expect(g.text).toContain('seg_0007 (letters of another script).');
    expect(g.text).toContain('1 voice(s) run into the next line by more than 0.3 s even at the fastest speed allowed: seg_0040 (+1.2 s).');
    const l = await call('list_projects');
    expect(l.text).toContain('updated 2026-11-17T00:00:00Z, 7 line(s) flagged, 1 voice(s) running over');
    expect(l.text).toMatch(/proj_2 "clean" completed, [^\n]*updated 2026-11-17T00:00:00Z$/m);
  });

  it('get_project says nothing of lines to look at when there are none, or when the app is older', async () => {
    fake.routes.set('GET /projects/proj_1', () => ({ project: project({ status: 'completed' }), pipeline: pipeline({ status: 'completed', progressPercent: 100 }) }));
    await connect();
    expect((await call('get_project', { projectId: 'proj_1' })).text).not.toContain('Lines to look at');
    fake.routes.set('GET /projects/proj_1/issues', () => ({ flagged: [], overruns: [] }));
    expect((await call('get_project', { projectId: 'proj_1' })).text).not.toContain('Lines to look at');
  });

  it('get_project waits for the dub to move on, then reports it', async () => {
    let reads = 0;
    fake.routes.set('GET /projects/proj_1', () => {
      reads++;
      return {
        project: project({ status: 'running' }),
        pipeline:
          reads < 3
            ? pipeline({ status: 'running', currentStep: 'tts', steps: [{ id: 'tts', label: 'TTS', status: 'running', progressPercent: 12 }] })
            : pipeline({ status: 'running', currentStep: 'alignment', steps: [{ id: 'tts', label: 'TTS', status: 'completed', progressPercent: 100 }, { id: 'alignment', label: 'Align', status: 'running', progressPercent: 5 }] }),
      };
    });
    await connect();
    const r = await call('get_project', { projectId: 'proj_1', waitSeconds: 5 });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(r.text).toContain('at "alignment"');
  });

  it("get_project says the app's time left: a render redo is not timed from the dub days earlier", async () => {
    // claude-dubber, 2026-11-25: a render-only redo at 89% read "about 2 h 25 min left".
    const steps = [
      { id: 'stt', label: 'STT', status: 'completed', progressPercent: 100, startedAt: '2026-11-20T08:00:00Z', finishedAt: '2026-11-20T09:00:00Z' },
      { id: 'render', label: 'Render', status: 'running', progressPercent: 40, startedAt: new Date(Date.now() - 120_000).toISOString() },
    ];
    let etaSec: number | undefined = 240;
    fake.routes.set('GET /projects/proj_1', () => ({
      project: project({ status: 'running' }),
      pipeline: pipeline({ status: 'running', currentStep: 'render', progressPercent: 89, steps }),
      ...(etaSec !== undefined ? { etaSec } : {}),
    }));
    await connect();
    const pipelineLine = async () => (await call('get_project', { projectId: 'proj_1' })).text.split('\n').find((l) => l.startsWith('Pipeline:'));
    expect(await pipelineLine()).toBe('Pipeline: running, 89%, at "render", about 4 min left');
    etaSec = undefined; // too early to tell: no guess of its own
    expect(await pipelineLine()).toBe('Pipeline: running, 89%, at "render"');
  });

  it('download_video follows the app\'s download events to the file', async () => {
    const source = { title: 'Wukong', partCount: 1, url: 'https://www.bilibili.com/video/BV1xx411c7mD' };
    const item = (state: string, extra: object = {}) => ({ id: 'dl_7', input: 'BV1xx411c7mD', page: 1, state, percent: 40, source, ...extra });
    fake.routes.set('POST /download/start', () => ({ jobId: 'dl_7' }));
    fake.routes.set('GET /downloads/dl_7', () => item('downloading'));
    fake.routes.set('GET /download/events', (_q, _b, res) =>
      sse(res, [
        { type: 'item', item: { ...item('downloading'), id: 'dl_other', percent: 99 } },
        { type: 'item', item: item('downloading') },
        { type: 'item', item: item('done', { percent: 100, filePath: 'C:/Users/me/VideoDubber/downloads/wukong.mp4', heightPx: 720 }) },
      ]),
    );
    await connect();
    const r = await call('download_video', { url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"Wukong": done (720p): C:/Users/me/VideoDubber/downloads/wukong.mp4');
    expect(r.text).toContain('downloadIds ["dl_7"]');
  });

  it('get_download says plainly when the app knows no such download', async () => {
    fake.routes.set('GET /downloads/dl_gone', (_q, _b, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'SOURCE_UNAVAILABLE', message: 'There is no download "dl_gone".' } }));
    });
    await connect();
    const r = await call('get_download', { jobId: 'dl_gone', waitSeconds: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('There is no download "dl_gone"');
  });

  it('set_download_login reads the cookie export, deletes it, and sends only bilibili.com cookies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vd-mcp-cookies-'));
    const file = join(dir, 'cookies-x.txt');
    await writeFile(
      file,
      [
        '# Netscape HTTP Cookie File',
        '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\tsecret-session',
        '.bilibili.com\tTRUE\t/\tFALSE\t1893456000\tbuvid3\tdevice-id',
        '.example.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tnot-bilibili',
      ].join('\n'),
    );
    let sent: unknown;
    fake.routes.set('POST /download/providers/bilibili/session/import', (_q, body) => {
      sent = body;
      return { configured: true, check: { valid: true, uname: 'khanh', premium: false } };
    });
    await connect();
    const r = await call('set_download_login', { cookiesFile: file });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Logged in to Bilibili as khanh: downloads get up to 1080p.');
    expect(r.text).not.toContain('secret');
    expect(sent).toEqual({
      cookies: [
        { domain: '.bilibili.com', name: 'SESSDATA', value: 'secret-session' },
        { domain: '.bilibili.com', name: 'buvid3', value: 'device-id' },
      ],
    });
    await expect(stat(file)).rejects.toThrow();

    // Not an export: refused, and deleted all the same.
    await writeFile(file, Buffer.alloc(70 * 1024, 65));
    const bad = await call('set_download_login', { cookiesFile: file });
    expect(bad.isError).toBe(true);
    await expect(stat(file)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('follow_jobs_command gives a curl line for the job stream', async () => {
    await connect();
    const r = await call('follow_jobs_command', { downloadIds: ['dl_1', 'dl_2'], projectIds: ['proj_9'] });
    expect(r.text).toContain('curl.exe -sN "');
    expect(r.text).toContain('/jobs/events?downloads=dl_1%2Cdl_2&projects=proj_9&untilDone=1"');
  });

  it('install_engine listens before it starts the install, so a fast install is not missed', async () => {
    let subscribed = false;
    fake.routes.set('GET /engines/events', (_q, _b, res) => {
      subscribed = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      (globalThis as { __res?: ServerResponse }).__res = res;
    });
    fake.routes.set('POST /engines/install', () => {
      expect(subscribed).toBe(true);
      const res = (globalThis as { __res?: ServerResponse }).__res!;
      res.write(`data: ${JSON.stringify({ type: 'done', packId: 'whisper-model-large-v3-turbo' })}\n\n`);
      return { started: true };
    });
    await connect();
    const r = await call('install_engine', { packId: 'whisper-model-large-v3-turbo' });
    expect(r.text).toBe('Installed whisper-model-large-v3-turbo.');
  });

  it('install_voice follows the engine it starts, and Piper voices on the setup stream', async () => {
    const streams: Record<string, ServerResponse> = {};
    for (const path of ['/engines/events', '/setup/events']) {
      fake.routes.set(`GET ${path}`, (_q, _b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': ping\n\n');
        streams[path] = res;
      });
    }
    fake.routes.set('POST /voices/vieneu38-hai-dang/install', () => {
      expect(Object.keys(streams).sort()).toEqual(['/engines/events', '/setup/events']);
      setTimeout(() => streams['/engines/events']!.write(`data: ${JSON.stringify({ type: 'done', packId: 'tts-vieneu' })}\n\n`), 20);
      return { started: true, enginePacks: ['tts-vieneu'], downloadMb: 900 };
    });
    await connect();
    expect((await call('install_voice', { voiceId: 'vieneu38-hai-dang' })).text).toBe(
      'Installed vieneu38-hai-dang (with the tts-vieneu engine).',
    );

    fake.routes.set('POST /voices/vi_VN-vivos-x_low%233/install', () => {
      setTimeout(
        () => streams['/setup/events']!.write(`data: ${JSON.stringify({ type: 'item-done', item: 'piper:vi_VN-vivos-x_low' })}\n\n`),
        20,
      );
      return { started: true, enginePacks: [], downloadMb: 27 };
    });
    expect((await call('install_voice', { voiceId: 'vi_VN-vivos-x_low#3' })).text).toBe('Installed vi_VN-vivos-x_low#3.');
  });

  it('list_voices shows the provider, licence and state of each voice', async () => {
    fake.routes.set('GET /voices', (req) => {
      const q = new URL(req.url ?? '', 'http://fake').searchParams;
      expect(q.get('language')).toBe('vi-VN');
      expect(q.get('engine')).toBe('vieneu-classic'); // "neural" is the old name
      return {
        total: 1,
        engines: [{ id: 'vieneu-classic', providerId: 'neural-tts' }],
        voices: [
          {
            id: 'vieneu-v3-ngoc-lan',
            kind: 'preset',
            engine: 'vieneu-classic',
            name: 'Ngọc Lan',
            languages: ['vi-VN'],
            gender: 'female',
            license: { category: 'permissive', label: 'Apache-2.0' },
            sizeMb: 0,
            installed: true,
            engineInstalled: true,
            engineAvailable: true,
            recommended: true,
          },
        ],
      };
    });
    await connect();
    const r = await call('list_voices', { language: 'vi-VN', engine: 'neural' });
    expect(r.text).toContain('- vieneu-v3-ngoc-lan: Ngọc Lan [recommended] — neural-tts; vi-VN; female; licence Apache-2.0 (permissive); INSTALLED');
  });

  it('update_settings names the step to redo from', async () => {
    fake.routes.set('PUT /projects/proj_1/settings', () => ({ project: project() }));
    await connect();
    const r = await call('update_settings', { projectId: 'proj_1', settings: { ttsVoiceId: 'vieneu-v3-ngoc-huyen', subtitleExportMode: 'srt-file' } });
    expect(r.text).toContain('fromStep="tts"');
  });

  it('detect_watermark: proposals with their confidence, the preview to look at, and the settings to apply', async () => {
    let answer: unknown = { state: 'running', percent: 40, message: 'Looking at frames (40/100)' };
    fake.routes.set('POST /projects/proj_1/picture/detect', () => answer);
    await connect();

    const running = await call('detect_watermark', { projectId: 'proj_1' });
    expect(running.text).toBe('Still looking (40 %: Looking at frames (40/100)). Call detect_watermark again in a minute: it continues this detection.');
    expect(fake.calls.at(-1)!.body).toEqual({ fresh: false, waitMs: 45_000 });

    answer = {
      state: 'done',
      result: {
        at: '2026-11-23T10:00:00Z',
        videoWidth: 1080,
        videoHeight: 1920,
        regions: [{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur', corner: 'top-right', confidence: 0.82 }],
        band: { y: 0.755, h: 0.06, confidence: 0.77, method: 'speech', twoLineShare: 0.08 },
        previewPath: 'C:/p/proj_1/picture/preview.jpg',
        frameAtMs: 61_000,
        frames: 100,
        notes: [],
      },
    };
    const done = await call('detect_watermark', { projectId: 'proj_1', fresh: true });
    expect(done.isError).toBe(false);
    expect(done.text).toContain('- top-right: x=0.66 y=0.014 w=0.31 h=0.04, confidence 0.82');
    expect(done.text).toContain('y=0.755 h=0.06 (76 %–82 % of the height), from frames during speech against silence, confidence 0.77; 8 % of the frames with text had two lines.');
    expect(done.text).toContain('Preview (boxes red, band yellow): C:/p/proj_1/picture/preview.jpg');
    expect(done.text).toContain(
      'update_settings with settings={"blurRegions":[{"x":0.66,"y":0.014,"w":0.31,"h":0.04,"mode":"blur"}],"burnSubtitleStyle":{"coverOriginal":"blur","coverBand":{"y":0.755,"h":0.06},"subtitlesInBand":true}}',
    );

    answer = { state: 'failed', error: { code: 'UNSUPPORTED_MEDIA', message: 'No video stream', remediation: 'Check the file.' } };
    const failed = await call('detect_watermark', { projectId: 'proj_1' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('The detection failed: No video stream\nHow to fix: Check the file.');
  });

  it('update_settings takes the picture options and redoes from the render', async () => {
    fake.routes.set('PUT /projects/proj_1/settings', (_req, body) => ({ project: project({ settings: { ...project().settings, ...(body as object) } }) }));
    await connect();
    const r = await call('update_settings', {
      projectId: 'proj_1',
      settings: {
        blurRegions: [{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'pixelate', strength: 7 }],
        burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: 0.755, h: 0.06 }, subtitlesInBand: true },
      },
      applyToParts: true,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('hides 1 part(s) of the picture; source subtitles blurred at 76 % of the height');
    expect(r.text).toContain('fromStep="render"');
    expect(fake.calls.at(-1)!.path).toBe('/projects/proj_1/settings?applyToParts=true');

    const bad = await call('update_settings', { projectId: 'proj_1', settings: { blurRegions: [{ x: 2, y: 0, w: 0.1, h: 0.1, mode: 'blur' }] } });
    expect(bad.isError).toBe(true);
  });

  it('the dub_video prompt walks Claude through the best-quality path', async () => {
    await connect();
    const p = await client.getPrompt({ name: 'dub_video', arguments: { video: 'D:/v/a.mp4', target_language: 'vi-VN' } });
    const body = (p.messages[0]!.content as { text: string }).text;
    expect(body).toContain('reviewBeforeSynthesis=true');
    expect(body).toContain('Read the WHOLE transcript');
    expect(body).toContain('never merge or split lines');
  });
});

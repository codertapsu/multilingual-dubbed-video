/**
 * The MCP server driven the way Claude drives it: a real MCP client over the
 * SDK's in-memory transport, against a fake VideoDubber orchestrator on a local
 * HTTP port that answers only the routes these tools use (SSE streams too).
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
        'adjust_lines', 'cancel_dubbing', 'create_project', 'download_video', 'get_download', 'get_project',
        'get_status', 'get_transcript', 'get_translation_context', 'get_translation_report', 'install_engine', 'list_engines',
        'list_languages', 'list_projects', 'list_providers', 'list_voices', 'open_output_folder',
        'regenerate_voices', 'render_video', 'set_translation_context', 'set_translations', 'start_dubbing',
        'update_settings',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
    const ro = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
    expect(ro('get_transcript')).toBe(true);
    expect(ro('set_translations')).toBe(false);
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

  it('download_video follows the app\'s download events to the file', async () => {
    fake.routes.set('POST /download/start', () => ({ jobId: 'job-7' }));
    fake.routes.set('GET /download/events', (_q, _b, res) =>
      sse(res, [
        { type: 'progress', jobId: 'other', phase: 'video', percent: 99 },
        { type: 'progress', jobId: 'job-7', phase: 'video', percent: 40 },
        { type: 'done', jobId: 'job-7', filePath: 'C:/Users/me/VideoDubber/downloads/wukong.mp4', title: 'Wukong' },
      ]),
    );
    await connect();
    const r = await call('download_video', { url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Downloaded "Wukong" to:\nC:/Users/me/VideoDubber/downloads/wukong.mp4');
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

  it('update_settings names the step to redo from', async () => {
    fake.routes.set('PUT /projects/proj_1/settings', () => ({ project: project() }));
    await connect();
    const r = await call('update_settings', { projectId: 'proj_1', settings: { ttsVoiceId: 'vieneu-v3-ngoc-huyen', subtitleExportMode: 'srt-file' } });
    expect(r.text).toContain('fromStep="tts"');
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

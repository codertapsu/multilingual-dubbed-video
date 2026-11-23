/**
 * The tools for a project's lines and speakers (retranscribe_range,
 * detect_speakers, get_speakers, get_project's jobs), driven by a real MCP
 * client against a fake app on a local port (as server.test.ts does).
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
    calls.push({ method: req.method ?? 'GET', path: pathOnly, body });
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

const MIN = 60_000;

const window = (fromMs: number, toMs: number, summary: string) => ({
  fromMs,
  toMs,
  lines: 1,
  loops: { removed: 0, kept: 0, left: 0 },
  speakers: { carried: 1, unassigned: 0 },
  replaced: 1,
  summary,
});

describe('the tools for lines and speakers', () => {
  let fake: Fake;
  let client: Client;

  const connect = async (): Promise<void> => {
    const server = createVideoDubberServer({ api: new VideoDubberApi({ baseUrl: fake.url }), version: 'test', pollMs: 20 });
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
    await connect();
  });
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await fake.close();
  });

  it('re-transcribes up to 15 minutes at once, saying what the loop check and the speakers did', async () => {
    fake.routes.set('POST /projects/proj_1/lines/retranscribe', () => ({
      fromMs: 59_000,
      toMs: 100_000,
      lines: [
        { startMs: 61_000, endMs: 63_000, text: '你认得老夫吗？', speakerId: 'SPEAKER_01' },
        { startMs: 64_500, endMs: 66_000, text: '晚辈昔日有幸见过' },
        { startMs: 90_000, endMs: 91_000, text: '回身', loopSuspect: true },
      ],
      loops: [{ status: 'replaced' }, { status: 'removed' }, { status: 'left' }],
      speakers: { carried: 1, unassigned: 2 },
      applied: { replaced: 4, lines: [{ id: 'seg_0002' }, { id: 'seg_0003' }, { id: 'seg_0004' }] },
      windows: [],
    }));
    const r = await call('retranscribe_range', { projectId: 'proj_1', fromMs: 60_000, toMs: 100_000, apply: true });
    expect(r.isError).toBe(false);
    expect(fake.calls.find((c) => c.path.endsWith('/retranscribe'))!.body).toEqual({ fromMs: 60_000, toMs: 100_000, noContext: true, apply: true });
    expect(r.text).toContain('Heard 3 line(s) in 01:00.00-01:40.00 (no context), widened to the whole lines across its edges: 00:59.00-01:40.00:');
    expect(r.text).toContain('- 01:01.00-01:03.00 [SPEAKER_01] 你认得老夫吗？');
    expect(r.text).toContain('- 01:30.00-01:31.00 LOOP? 回身');
    expect(r.text).toContain('Loop check: 2 loop(s) or credit line(s) removed');
    expect(r.text).toContain('1 loop(s) could not be checked and are marked LOOP?');
    expect(r.text).toContain('2 line(s) have none: detect_speakers with fromMs=59000 and toMs=100000');
    expect(r.text).toContain('Applied: replaced 4 line(s) with 3 (seg_0002, seg_0003, seg_0004).');
  });

  it('follows a long range as a job, window by window, and again later by its id', async () => {
    let reads = 0;
    const job = (state: string, done: number) => ({
      id: 'act_1',
      state,
      fromMs: 0,
      toMs: 40 * MIN,
      apply: true,
      windows: 3,
      done,
      startedAt: '2026-11-23T10:00:00Z',
      results: [window(0, 15 * MIN, 'Re-transcribed 0:00–15:00: 1 line'), window(15 * MIN, 30 * MIN, 'Re-transcribed 15:00–30:00: 1 line'), window(30 * MIN, 40 * MIN, 'Re-transcribed 30:00–40:00: 1 line, 1 without a speaker')].slice(0, done),
      ...(state === 'done' ? { result: { lines: 3, replaced: 3, loops: { removed: 1, kept: 0, left: 0 }, speakers: { carried: 2, unassigned: 1 } } } : {}),
    });
    fake.routes.set('POST /projects/proj_1/lines/retranscribe', (_req, _body, res) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job: job('running', 0) }));
    });
    fake.routes.set('GET /projects/proj_1/lines/retranscribe/act_1', () => {
      reads += 1;
      return reads < 3 ? job('running', reads) : job('done', 3);
    });
    const r = await call('retranscribe_range', { projectId: 'proj_1', fromMs: 0, toMs: 40 * MIN, apply: true, waitSeconds: 5 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Re-transcription job act_1 (00:00.00-40:00.00, applying each window as it is heard): done, 3 window(s).');
    expect(r.text).toContain('- Re-transcribed 15:00–30:00: 1 line (replaced 1)');
    expect(r.text).toContain('In all: 3 line(s) heard, 3 old line(s) replaced.');
    expect(r.text).toContain('1 line(s) have no speaker: detect_speakers with fromMs=0 and toMs=2400000');

    // Not waited for: it says how to follow it.
    reads = 0;
    const early = await call('retranscribe_range', { projectId: 'proj_1', fromMs: 0, toMs: 40 * MIN, apply: true, waitSeconds: 0 });
    expect(early.text).toContain('running, 0 of 3 window(s) done (0%)');
    expect(early.text).toContain('call retranscribe_range with jobId="act_1"');
    const later = await call('retranscribe_range', { projectId: 'proj_1', jobId: 'act_1', waitSeconds: 0 });
    expect(later.text).toContain('running, 1 of 3 window(s) done');

    const none = await call('retranscribe_range', { projectId: 'proj_1' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('Give fromMs and toMs');
  });

  it('detects the speakers of a range and answers with the result when it is quick', async () => {
    let started = false;
    fake.routes.set('POST /projects/proj_1/speakers/detect', () => {
      started = true;
      return { started: true };
    });
    fake.routes.set('GET /projects/proj_1/speakers', () => ({
      speakers: [],
      job: started ? { state: 'done', done: 1, total: 1, range: { fromMs: 20 * MIN, toMs: 21 * MIN }, relabelled: 12, added: 1, detectedParts: 0 } : undefined,
    }));
    const r = await call('detect_speakers', { projectId: 'proj_1', fromMs: 20 * MIN, toMs: 21 * MIN });
    expect(r.isError).toBe(false);
    expect(fake.calls.find((c) => c.path.endsWith('/speakers/detect'))!.body).toEqual({ fromMs: 20 * MIN, toMs: 21 * MIN });
    expect(r.text).toContain('Speakers detected over 20:00.00-21:00.00: 12 line(s) changed speaker, 1 new speaker(s) (from the saved detection');
    // The whole video: started, followed elsewhere.
    const whole = await call('detect_speakers', { projectId: 'proj_1', numSpeakers: 4 });
    expect(whole.text).toContain('Speaker detection started.');
    expect(fake.calls.filter((c) => c.path.endsWith('/speakers/detect'))[1]!.body).toEqual({ numSpeakers: 4 });
  });

  it('says when a detection was interrupted by the app closing, and lists the jobs of a project', async () => {
    fake.routes.set('GET /projects/proj_1/speakers', () => ({ speakers: [], job: { state: 'interrupted', done: 3, total: 12 } }));
    const s = await call('get_speakers', { projectId: 'proj_1' });
    expect(s.text).toContain('was interrupted: the app closed while it ran, at part 3 of 12. Call detect_speakers again: the parts already done are kept.');

    fake.routes.set('GET /projects/proj_1', () => ({
      project: {
        id: 'proj_1',
        name: 'wukong',
        inputVideoPath: 'C:/v/wukong.mp4',
        workspaceDir: 'C:/nonexistent/proj_1',
        outputDir: 'C:/nonexistent/proj_1/render',
        status: 'created',
        createdAt: '2026-11-17T00:00:00Z',
        updatedAt: '2026-11-17T00:00:00Z',
        settings: { sourceLanguage: 'zh', targetLanguage: 'vi-VN', subtitleExportMode: 'burned-in', processingMode: 'local' },
      },
      pipeline: { projectId: 'proj_1', status: 'idle', progressPercent: 0, steps: [], updatedAt: '2026-11-17T00:00:00Z' },
    }));
    fake.routes.set('GET /projects/proj_1/jobs', () => ({
      jobs: [
        { id: 'a', kind: 'lines.retranscribe', title: 'Re-transcribing 0:00–1:00:00', state: 'running', percent: 25, message: '1/4: Re-transcribed 0:00–15:00: 300 lines', startedAt: 'x', etaSec: 1500, initiator: { kind: 'mcp', client: 'claude-code' } },
        { id: 'b', kind: 'speakers.detect', title: 'Detecting speakers', state: 'interrupted', percent: 25, message: 'Part 3/12', startedAt: 'y', initiator: { kind: 'unknown' } },
      ],
    }));
    const p = await call('get_project', { projectId: 'proj_1' });
    expect(p.text).toContain('Jobs outside the dub:');
    expect(p.text).toContain('  - Re-transcribing 0:00–1:00:00: running 25% (1/4: Re-transcribed 0:00–15:00: 300 lines), about 25 min left [started by claude-code]');
    expect(p.text).toContain('  - Detecting speakers: interrupted (Part 3/12) (detect_speakers again continues from the parts done)');
  });
});

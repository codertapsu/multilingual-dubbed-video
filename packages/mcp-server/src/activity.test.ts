/**
 * Who asked, as the MCP server tells the app (x-vd-initiator / x-vd-client /
 * x-vd-session / x-vd-tool), and the activity and history tools, against a
 * fake app on a local port that records each request's headers.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { initiatorHeaders, VideoDubberApi } from './api.js';
import { createVideoDubberServer } from './server.js';

type Route = (body: unknown, req: IncomingMessage, res: ServerResponse) => unknown;

let server: Server;
let url: string;
let routes: Map<string, Route>;
let calls: { method: string; path: string; body: unknown; headers: IncomingHttpHeaders }[];
let client: Client;

beforeEach(async () => {
  routes = new Map();
  calls = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const pathOnly = (req.url ?? '').split('?')[0]!;
    calls.push({ method: req.method ?? 'GET', path: req.url ?? '', body, headers: req.headers });
    const route = routes.get(`${req.method} ${pathOnly}`);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNKNOWN', message: `no route ${req.method} ${pathOnly}` } }));
      return;
    }
    const out = await route(body, req, res);
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routes.set('GET /health', () => ({ status: 'ok' }));
});

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
});

async function connect(clientName = 'Claude Desktop'): Promise<void> {
  const mcp = createVideoDubberServer({ api: new VideoDubberApi({ baseUrl: url }), version: 'test', pollMs: 20 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientSide);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as { type: string; text?: string }[])[0];
  return { text: first?.text ?? '', isError: res.isError === true };
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'act_1',
  kind: 'dub.run',
  title: 'Dubbing “Tập 1”',
  projectId: 'proj_1',
  projectName: 'Tập 1',
  initiator: { kind: 'mcp', client: 'claude-code' },
  state: 'running',
  percent: 42,
  message: 'Translate',
  startedAt: new Date(Date.now() - 600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe('who asked', () => {
  it('names the agent, its session and its tool, percent-encoded', () => {
    expect(initiatorHeaders({ client: 'Claude Desktop', session: 'mcp-1', tool: 'get_queue' })).toEqual({
      'x-vd-initiator': 'mcp',
      'x-vd-client': 'Claude%20Desktop',
      'x-vd-session': 'mcp-1',
      'x-vd-tool': 'get_queue',
    });
    expect(initiatorHeaders({ client: 'Mẹ Claude' })['x-vd-client']).toBe('M%E1%BA%B9%20Claude');
    expect(initiatorHeaders(undefined)).toEqual({ 'x-vd-initiator': 'mcp' });
  });

  it('sends them with every request of a tool call, the client named as in its handshake', async () => {
    routes.set('GET /activity', () => ({ entries: [] }));
    await connect('Claude Desktop');
    await call('get_activity', {});
    await call('get_activity', {});
    const asked = calls.filter((c) => c.path.startsWith('/activity'));
    expect(asked).toHaveLength(2);
    const h = asked[0]!.headers;
    expect(h['x-vd-initiator']).toBe('mcp');
    expect(h['x-vd-client']).toBe('Claude%20Desktop');
    expect(h['x-vd-tool']).toBe('get_activity');
    expect(String(h['x-vd-session'])).toMatch(/^mcp-[0-9a-f]{12}$/);
    expect(String(h['x-request-id'])).toMatch(/^mcp-/);
    // One connection is one session; each call has its own request id.
    expect(asked[1]!.headers['x-vd-session']).toBe(h['x-vd-session']);
    expect(asked[1]!.headers['x-request-id']).not.toBe(h['x-request-id']);
  });
});

describe('activity tools', () => {
  it('get_activity lists the work with who started it and its log reference', async () => {
    routes.set('GET /activity', () => ({
      entries: [
        entry({ logRef: 'mcp-abc123' }),
        entry({ id: 'act_2', kind: 'external', title: 'Joining P3 and P4', external: true, state: 'done', percent: 100, result: 'joined', endedAt: new Date().toISOString(), initiator: { kind: 'mcp', client: 'Mother Claude' } }),
      ],
    }));
    await connect();
    const res = await call('get_activity', { projectId: 'proj_1', active: false });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('act_1 [running 42%] Dubbing “Tập 1” — Translate · by claude-code (MCP)');
    expect(res.text).toContain('log mcp-abc123');
    expect(res.text).toContain('act_2 [done] Joining P3 and P4 — joined · reported by Mother Claude (MCP)');
    expect(calls.find((c) => c.path.startsWith('/activity'))!.path).toBe('/activity?limit=30&projectId=proj_1');
  });

  it('report_activity creates an entry, then updates it by its id', async () => {
    routes.set('POST /activity/report', (body) => {
      const b = body as { id?: string; title?: string; state: string; percent?: number };
      return { entry: entry({ id: 'act_r', kind: 'external', external: true, title: b.title ?? 'Joining', state: b.state, percent: b.percent ?? null, ...(b.state === 'done' ? { endedAt: new Date().toISOString() } : {}) }) };
    });
    await connect();
    const first = await call('report_activity', { title: 'Joining', state: 'running', progress: 10 });
    expect(first.text).toContain('as act_r');
    expect(calls.at(-1)!.body).toEqual({ title: 'Joining', state: 'running', percent: 10 });
    const end = await call('report_activity', { id: 'act_r', state: 'done', detail: 'joined' });
    expect(end.text).toContain('as done');
    expect(calls.at(-1)!.body).toEqual({ id: 'act_r', state: 'done', detail: 'joined' });
    const missing = await call('report_activity', { state: 'running' });
    expect(missing.isError).toBe(true);
  });

  it('get_history and undo_edit: the list, an undo, and a refusal with why', async () => {
    routes.set('GET /projects/proj_1/history', () => ({
      entries: [
        { id: 'edit_2', at: '2026-11-23T10:05:00.000Z', initiator: { kind: 'ui' }, summary: 'Changed the speaker of 1 line(s)', target: 'translation', beforeCount: 1, afterCount: 1 },
        { id: 'edit_1', at: '2026-11-23T10:00:00.000Z', initiator: { kind: 'mcp', client: 'claude-code' }, summary: 'Replaced 14 line(s) with 12 at 24:12:04–24:27:04', target: 'source', range: { fromMs: 0, toMs: 1 }, beforeCount: 14, afterCount: 12, undoneAt: '2026-11-23T10:10:00.000Z' },
      ],
    }));
    routes.set('POST /projects/proj_1/history/edit_2/undo', () => ({
      undone: { id: 'edit_2', summary: 'Changed the speaker of 1 line(s)' },
      entry: { id: 'edit_3', summary: 'Undid: Changed the speaker of 1 line(s)', undoOf: 'edit_2' },
    }));
    routes.set('POST /projects/proj_1/history/edit_1/undo', (_b, _req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_EDIT', message: 'This change cannot be undone. It was already undone.', changes: [{ what: 'already-undone' }] } }));
    });
    await connect();
    const list = await call('get_history', { projectId: 'proj_1' });
    expect(list.text).toContain('edit_2 · 2026-11-23T10:05:00.000Z');
    expect(list.text).toContain('by the user in the app · translation: Changed the speaker of 1 line(s)');
    expect(list.text).toContain('by claude-code (MCP) · transcript: Replaced 14 line(s)');
    expect(list.text).toContain('UNDONE');
    const undone = await call('undo_edit', { projectId: 'proj_1', entryId: 'edit_2' });
    expect(undone.text).toContain('Recorded as edit_3');
    const refused = await call('undo_edit', { projectId: 'proj_1', entryId: 'edit_1' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('It was already undone.');
  });

  it('regenerate_voices says how many lines are left, for the app to show the batch', async () => {
    let stale = ['seg_0001', 'seg_0002'];
    routes.set('GET /projects/proj_1/timeline', () => ({
      aligned: true,
      segments: ['seg_0001', 'seg_0002'].map((id) => ({ id, ttsStale: stale.includes(id) })),
    }));
    for (const id of ['seg_0001', 'seg_0002']) {
      routes.set(`POST /projects/proj_1/segments/${id}/tts`, () => {
        stale = stale.filter((s) => s !== id);
        return {};
      });
    }
    await connect();
    const res = await call('regenerate_voices', { projectId: 'proj_1' });
    expect(res.text).toContain('Re-voiced 2 line(s)');
    const left = calls.filter((c) => c.path.endsWith('/tts')).map((c) => c.headers['x-vd-batch-left']);
    expect(left).toEqual(['2', '1']);
  });
});

import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ActivityEntry, ActivityStreamEvent, EditHistorySummary, TranscriptSegment } from '@videodubber/shared';

import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import { FakeMediaService, createProjectInput, makeSegments, writeDummyVideo } from '../test/fixtures.js';

/**
 * The activity and history routes as the window and the MCP server use them.
 * No worker is reachable: every worker URL points at a port nothing listens
 * on (the app's own ports are in use on the developer's machine).
 */
const DEAD = 'http://127.0.0.1:5277';
const MCP = { 'x-vd-initiator': 'mcp', 'x-vd-client': 'Claude%20Desktop', 'x-vd-session': 'mcp-s1', 'x-request-id': 'mcp-call1', 'x-vd-tool': 'report_activity' };

let tmp: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-activity-routes-'));
  app = await createServer({
    config: loadConfig({
      projectsDir: path.join(tmp, 'projects'),
      configDir: path.join(tmp, 'config'),
      modelsDir: path.join(tmp, 'models'),
      sttWorkerUrl: DEAD,
      translationWorkerUrl: DEAD,
      ttsWorkerUrl: DEAD,
    }),
    media: new FakeMediaService(),
  });
});

afterEach(async () => {
  await app.close();
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function project(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(await writeDummyVideo(tmp), { name: 'Tập 1' }) });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { id: string }).id;
  const sourceJson = path.join(tmp, 'projects', id, 'subtitles', 'source.json');
  await fsp.mkdir(path.dirname(sourceJson), { recursive: true });
  const lines = makeSegments([
    [0, 2000, '你好'],
    [3000, 3900, '再见'],
  ]).map((s, i) => (i === 1 ? { ...s, speakerId: 'SPEAKER_01' } : s));
  await fsp.writeFile(sourceJson, JSON.stringify({ segments: lines }), 'utf8');
  return id;
}

describe('who asked', () => {
  it('lets the window send x-vd-initiator: the preflight allows it, and keeps the answer 10 minutes', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/projects',
      headers: { origin: 'http://tauri.localhost', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-vd-initiator' },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers'])).toContain('x-vd-initiator');
    expect(res.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('records who made an edit, from the request headers', async () => {
    const id = await project();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/projects/${id}/timeline`,
      headers: { 'x-vd-initiator': 'ui' },
      payload: { segments: [{ id: 'seg_0002', speakerId: 'SPEAKER_04' }] },
    });
    expect(patch.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: `/projects/${id}/history` })).json() as { entries: EditHistorySummary[] };
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({ initiator: { kind: 'ui' }, target: 'source', beforeCount: 1, afterCount: 1 });
  });
});

describe('the edit history routes', () => {
  it('lists, shows and undoes an entry; an undone one is refused with why', async () => {
    const id = await project();
    await app.inject({ method: 'PATCH', url: `/projects/${id}/timeline`, headers: MCP, payload: { segments: [{ id: 'seg_0002', speakerId: 'SPEAKER_04' }] } });
    const [entry] = ((await app.inject({ method: 'GET', url: `/projects/${id}/history` })).json() as { entries: EditHistorySummary[] }).entries;
    expect(entry!.initiator).toEqual({ kind: 'mcp', client: 'Claude Desktop', session: 'mcp-s1' });

    const one = (await app.inject({ method: 'GET', url: `/projects/${id}/history/${entry!.id}` })).json() as { entry: { before: TranscriptSegment[] } };
    expect(one.entry.before[0]?.speakerId).toBe('SPEAKER_01');

    const undo = await app.inject({ method: 'POST', url: `/projects/${id}/history/${entry!.id}/undo`, headers: { 'x-vd-initiator': 'ui' } });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ undone: { id: entry!.id }, entry: { undoOf: entry!.id, initiator: { kind: 'ui' } } });
    const source = JSON.parse(await fsp.readFile(path.join(tmp, 'projects', id, 'subtitles', 'source.json'), 'utf8')) as { segments: TranscriptSegment[] };
    expect(source.segments[1]!.speakerId).toBe('SPEAKER_01');

    const again = await app.inject({ method: 'POST', url: `/projects/${id}/history/${entry!.id}/undo` });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'INVALID_EDIT', changes: [{ what: 'already-undone' }] } });
  });

  it('answers 404 for a project or an entry that does not exist', async () => {
    expect((await app.inject({ method: 'GET', url: '/projects/proj_nope/history' })).statusCode).toBe(404);
    const id = await project();
    expect((await app.inject({ method: 'GET', url: `/projects/${id}/history` })).json()).toEqual({ entries: [] });
    expect((await app.inject({ method: 'GET', url: `/projects/${id}/history/edit_0000000000000000` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/projects/${id}/history/edit_0000000000000000/undo` })).statusCode).toBe(404);
  });
});

describe('reported activity and connected agents', () => {
  it('creates a reported entry, updates it by id, and refuses to reopen an ended one', async () => {
    const id = await project();
    const created = await app.inject({ method: 'POST', url: '/activity/report', headers: MCP, payload: { projectId: id, title: 'Joining P3 and P4', progress: 10 } });
    expect(created.statusCode).toBe(201);
    const entry = (created.json() as { entry: ActivityEntry }).entry;
    expect(entry).toMatchObject({ kind: 'external', external: true, state: 'running', percent: 10, projectName: 'Tập 1', logRef: 'mcp-call1', initiator: { kind: 'mcp', client: 'Claude Desktop' } });

    const done = await app.inject({ method: 'POST', url: '/activity/report', headers: MCP, payload: { id: entry.id, state: 'done', detail: 'joined, 9.8 GB' } });
    expect(done.json()).toMatchObject({ entry: { state: 'done', result: 'joined, 9.8 GB' } });
    expect((await app.inject({ method: 'POST', url: '/activity/report', payload: { id: entry.id, state: 'running' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/activity/report', payload: { id: 'act_nope', state: 'done' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/activity/report', payload: { title: 'x', state: 'finished' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/activity/report', payload: { title: 'x', projectId: 'proj_nope' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/activity/report', payload: {} })).statusCode).toBe(400);

    const list = (await app.inject({ method: 'GET', url: `/activity?projectId=${id}` })).json() as { entries: ActivityEntry[] };
    expect(list.entries.map((e) => e.title)).toContain('Joining P3 and P4');
    expect((await app.inject({ method: 'GET', url: `/activity?projectId=${id}&active=1` })).json()).toEqual({ entries: [] });
  });

  it('lists the MCP sessions that called', async () => {
    await app.inject({ method: 'GET', url: '/health', headers: MCP });
    await app.inject({ method: 'GET', url: '/queue', headers: { ...MCP, 'x-request-id': 'mcp-call2', 'x-vd-tool': 'get_queue' } });
    await app.inject({ method: 'GET', url: '/queue', headers: { 'x-vd-initiator': 'ui' } });
    const { sessions } = (await app.inject({ method: 'GET', url: '/activity/agents' })).json() as { sessions: { session: string; client: string; calls: number; tools: string[] }[] };
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ session: 'mcp-s1', client: 'Claude Desktop', calls: 2, tools: ['get_queue', 'report_activity'] });
  });

  it('streams the list: what runs on connect, then every change', async () => {
    const before = await app.inject({ method: 'POST', url: '/activity/report', payload: { title: 'Already running' } });
    const running = (before.json() as { entry: ActivityEntry }).entry;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const events: ActivityStreamEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/activity/events' }, (res) => {
        let buffered = '';
        res.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          for (let i = buffered.indexOf('\n\n'); i >= 0; i = buffered.indexOf('\n\n')) {
            const frame = buffered.slice(0, i);
            buffered = buffered.slice(i + 2);
            if (!frame.startsWith('data: ')) continue;
            // The app's one registry: earlier tests' entries are replayed too.
            const event = JSON.parse(frame.slice(6)) as ActivityStreamEvent;
            if (event.entry.id !== running.id) continue;
            events.push(event);
            if (events.length === 1) void app.inject({ method: 'POST', url: '/activity/report', payload: { id: running.id, state: 'done' } });
          }
          if (events.length >= 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (err) => (events.length >= 2 ? resolve() : reject(err)));
    });
    expect(events[0]).toMatchObject({ type: 'entry', replay: true, entry: { id: running.id, state: 'running' } });
    expect(events[1]).toMatchObject({ type: 'entry', entry: { id: running.id, state: 'done' } });
    expect(events[1]!.replay).toBeUndefined();
  });
});

import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { FakeMediaService, createProjectInput, defaultSettings, writeDummyVideo } from './test/fixtures.js';

/**
 * Route-level cover for the endpoints that report on the RUNNING BUILD.
 *
 * `GET /health` used to return `{status:'ok'}` and nothing else, which is why
 * the "stale sidecar" release bug (docs/RELEASING.md: a build that re-bundles an
 * old orchestrator and ships an installer missing the fix) could only be caught
 * by grepping strings out of a binary before notarizing. A version stamp on the
 * wire makes it checkable at runtime by the shell, a smoke script, or a user.
 */
describe('GET /health', () => {
  let tmp: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-test-'));
    app = await createServer({
      config: loadConfig({
        projectsDir: path.join(tmp, 'projects'),
        configDir: path.join(tmp, 'config'),
        modelsDir: path.join(tmp, 'models'),
      }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('reports the running build, not just ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    // In a source/dev run the version comes off the nearest package.json; in a
    // packaged build the shell or the bundler stamps it. Either way it must be
    // present and answerable without any other endpoint.
    expect(typeof body.version).toBe('string');
    expect(body.version).not.toBe('');
    expect(body.node).toBe(process.version);
    expect(body.pid).toBe(process.pid);
    expect(typeof body.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.startedAt as string))).toBe(false);
  });

  it('keeps startedAt stable across calls (a changed value means the sidecar restarted)', async () => {
    const first = (await app.inject({ method: 'GET', url: '/health' })).json() as { startedAt: string };
    const second = (await app.inject({ method: 'GET', url: '/health' })).json() as { startedAt: string };
    expect(second.startedAt).toBe(first.startedAt);
  });
});

/** New project after Back: PUT /projects/:id gives its project the form as it is now. */
describe('PUT /projects/:id', () => {
  let tmp: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-test-'));
    app = await createServer({
      config: loadConfig({
        projectsDir: path.join(tmp, 'projects'),
        configDir: path.join(tmp, 'config'),
        modelsDir: path.join(tmp, 'models'),
      }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function created(): Promise<{ id: string; settings: Record<string, unknown> }> {
    const video = await writeDummyVideo(tmp);
    const res = await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(video, { name: 'First' }) });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; settings: Record<string, unknown> };
  }

  it('changes the project Continue created instead of making a second one', async () => {
    const project = await created();
    const res = await app.inject({
      method: 'PUT',
      url: `/projects/${project.id}`,
      payload: { name: 'Second try', settings: defaultSettings({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vieneu38-hai-dang' }) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: project.id, name: 'Second try', settings: { ttsVoiceId: 'vieneu38-hai-dang' } });
    const list = (await app.inject({ method: 'GET', url: '/projects' })).json() as unknown[];
    expect(list).toHaveLength(1);
  });

  it('refuses once the dub has started: the editor is where a started project changes', async () => {
    const project = await created();
    const pipelineFile = path.join(tmp, 'projects', project.id, 'pipeline.json');
    const pipeline = JSON.parse(await fsp.readFile(pipelineFile, 'utf8')) as { steps: { status: string }[] };
    pipeline.steps[0]!.status = 'completed';
    await fsp.writeFile(pipelineFile, JSON.stringify(pipeline));

    const res = await app.inject({ method: 'PUT', url: `/projects/${project.id}`, payload: { name: 'Late', settings: defaultSettings() } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'INVALID_EDIT',
      message: expect.stringContaining('already started'),
    });
  });

  it('turns away a body that is not a form', async () => {
    const project = await created();
    const res = await app.inject({ method: 'PUT', url: `/projects/${project.id}`, payload: { name: 'No settings' } });
    expect(res.statusCode).toBe(400);
  });
});

/** Deleting a project, and the projects folder chosen in Settings. */
describe('DELETE /projects/:id and /storage/projects-folder', () => {
  let tmp: string;
  let app: FastifyInstance;
  const config = () =>
    loadConfig({
      projectsDir: path.join(tmp, 'VideoDubber', 'projects'),
      configDir: path.join(tmp, 'VideoDubber'),
      modelsDir: path.join(tmp, 'VideoDubber', 'models'),
    });

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-test-'));
    app = await createServer({ config: config(), media: new FakeMediaService() });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function create(name: string): Promise<{ id: string; workspaceDir: string }> {
    const video = await writeDummyVideo(tmp);
    const res = await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(video, { name }) });
    return res.json() as { id: string; workspaceDir: string };
  }

  it('deletes a project and its folder; the list no longer has it', async () => {
    const keep = await create('Keep');
    const gone = await create('Gone');
    const res = await app.inject({ method: 'DELETE', url: `/projects/${gone.id}` });
    expect(res.statusCode).toBe(200);
    expect(await fsp.stat(gone.workspaceDir).catch(() => null)).toBeNull();
    const list = (await app.inject({ method: 'GET', url: '/projects' })).json() as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([keep.id]);
    expect((await app.inject({ method: 'DELETE', url: `/projects/${gone.id}` })).statusCode).not.toBe(200);
  });

  it('moves the projects to another folder, and a restart keeps using it', async () => {
    const project = await create('Clip');
    const root = path.join(tmp, 'claude-dubber');
    const res = await app.inject({ method: 'PUT', url: '/storage/projects-folder', payload: { root } });
    expect(res.statusCode).toBe(202);
    let info = res.json() as { moving?: unknown; projectsDir: string; lastError?: unknown };
    // Up to 10 s: 2 s was too short on a loaded Windows machine (the full suite
    // beside a running production dub), where the move was still going.
    const deadline = Date.now() + 10_000;
    while (info.moving && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      info = (await app.inject({ method: 'GET', url: '/storage/projects-folder' })).json() as typeof info;
    }
    expect(info).toMatchObject({ projectsDir: path.join(root, 'projects') });
    expect(info.lastError).toBeUndefined();

    await app.close();
    app = await createServer({ config: config(), media: new FakeMediaService() });
    const list = (await app.inject({ method: 'GET', url: '/projects' })).json() as { id: string; workspaceDir: string }[];
    expect(list).toEqual([expect.objectContaining({ id: project.id, workspaceDir: path.join(root, 'projects', project.id) })]);
  });

  it('turns a folder path that is not one into a 400 that says so', async () => {
    const res = await app.inject({ method: 'PUT', url: '/storage/projects-folder', payload: { root: 'relative/folder' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toContain('not a folder path');
  });
});

/** A change asked of a whole series (claude-dubber, 48-part series, 2026-11-24). */
describe('a series asked as a whole', () => {
  let tmp: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-test-'));
    app = await createServer({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects'), configDir: path.join(tmp, 'config'), modelsDir: path.join(tmp, 'models') }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function seriesWithOnePart(): Promise<{ parent: string; part: string; partJson: string }> {
    const video = await writeDummyVideo(tmp);
    const make = async (name: string) =>
      (await app.inject({ method: 'POST', url: '/projects', payload: createProjectInput(video, { name }) })).json() as { id: string; workspaceDir: string };
    const parent = await make('Series');
    const part = await make('Series - Phần 01');
    const parentJson = path.join(parent.workspaceDir, 'project.json');
    const project = JSON.parse(await fsp.readFile(parentJson, 'utf8')) as Record<string, unknown>;
    project.series = { role: 'parent', settings: { minMinutes: 15, maxMinutes: 20, recapSec: 4, autoStart: false, aiProviderId: 'none' }, state: 'parts', partIds: [part.id] };
    await fsp.writeFile(parentJson, JSON.stringify(project));
    return { parent: parent.id, part: part.id, partJson: path.join(part.workspaceDir, 'project.json') };
  }

  it('refuses a costly redo on the series itself, saying how', async () => {
    const { parent } = await seriesWithOnePart();
    const res = await app.inject({ method: 'POST', url: `/projects/${parent}/retry`, payload: { stepId: 'translation' } });
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: { code: string; message: string; remediation?: string } };
    expect(error.code).toBe('INVALID_EDIT');
    expect(error.message).toContain('series of 1 part(s)');
    expect(error.remediation).toContain('start_dubbing on each part');
  });

  it('redoes the mix in every part that made one, and says why it leaves the others', async () => {
    const { parent, part } = await seriesWithOnePart();
    const res = await app.inject({ method: 'POST', url: `/projects/${parent}/retry`, payload: { stepId: 'audio-mix' } });
    expect(res.statusCode).toBe(202);
    // The part was never dubbed: nothing to redo, and nothing started.
    expect((res.json() as { parts: unknown[] }).parts).toEqual([
      { projectId: part, index: 1, left: 'has not made "audio-mix" yet: it uses the change when it gets there' },
    ]);
  });

  it('applies settings to every idle part and says what it did with each', async () => {
    const { parent, part, partJson } = await seriesWithOnePart();
    const blur = [{ x: 0.8, y: 0.02, w: 0.18, h: 0.06, mode: 'blur' }];
    const res = await app.inject({ method: 'PUT', url: `/projects/${parent}/settings?applyToParts=true`, payload: { blurRegions: blur } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { parts: unknown[] }).parts).toEqual([{ projectId: part, index: 1, ok: true }]);
    const saved = JSON.parse(await fsp.readFile(partJson, 'utf8')) as { settings: { blurRegions?: unknown[] } };
    expect(saved.settings.blurRegions).toMatchObject(blur);
    // The same change again: the part already had it, and says so.
    const again = await app.inject({ method: 'PUT', url: `/projects/${parent}/settings?applyToParts=true`, payload: { blurRegions: blur } });
    expect((again.json() as { parts: unknown[] }).parts).toEqual([{ projectId: part, index: 1, ok: true, unchanged: true }]);
  });
});

/** Claude through Mother Claude: the routes Settings drives. */
describe('Mother Claude credential routes', () => {
  let tmp: string;
  let app: FastifyInstance;
  let standIn: http.Server | undefined;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-server-test-'));
    app = await createServer({
      config: loadConfig({
        projectsDir: path.join(tmp, 'projects'),
        configDir: path.join(tmp, 'config'),
        modelsDir: path.join(tmp, 'models'),
      }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
    if (standIn) {
      standIn.closeAllConnections();
      await new Promise<void>((r) => standIn!.close(() => r()));
      standIn = undefined;
    }
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  /** A local server answering GET /v1/models with `status`; returns its base URL. */
  async function listen(status: number): Promise<string> {
    standIn = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end('{}');
    });
    await new Promise<void>((r) => standIn!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
  }

  it('a mistyped address is a 400 that says what to copy, and nothing is saved', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/credentials',
      payload: { service: 'anthropic', via: 'mother-claude', motherClaudeUrl: 'localhost 5612' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toContain('Base URL');
    const creds = (await app.inject({ method: 'GET', url: '/credentials' })).json() as { services: { service: string; via?: string }[] };
    expect(creds.services.find((c) => c.service === 'anthropic')?.via).toBeUndefined();
  });

  it('reports whether its HTTP API is running at the saved address', async () => {
    const url = await listen(200);
    const saved = await app.inject({ method: 'PUT', url: '/credentials', payload: { service: 'anthropic', via: 'mother-claude', motherClaudeUrl: url } });
    expect(saved.statusCode).toBe(200);
    const up = await app.inject({ method: 'GET', url: '/credentials/mother-claude' });
    expect(up.json()).toEqual({ url, reachable: true });

    await new Promise<void>((r) => standIn!.close(() => r()));
    standIn = undefined;
    const down = await app.inject({ method: 'GET', url: '/credentials/mother-claude' });
    expect(down.json()).toEqual({ url, reachable: false });
  });

  it('says when its HTTP API wants a key', async () => {
    const url = await listen(401);
    await app.inject({ method: 'PUT', url: '/credentials', payload: { service: 'anthropic', motherClaudeUrl: url } });
    const res = await app.inject({ method: 'GET', url: '/credentials/mother-claude' });
    expect(res.json()).toEqual({ url, reachable: true, keyRejected: true });
  });
});

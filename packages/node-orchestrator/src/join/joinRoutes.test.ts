import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppErrorException, type SeriesSettings } from '@videodubber/shared';

import { toHttpError } from '../httpErrors.js';
import { registerJoinRoutes } from './joinRoutes.js';
import type { JoinService } from './joinService.js';

const sendError = (reply: FastifyReply, err: unknown): void => {
  const { status, error } = toHttpError(err);
  void reply.status(status).send({ error });
};

/** What the routes ask of the service, recorded. */
function stubJoins() {
  const calls: string[] = [];
  const state = { joining: new Set<string>(), blocked: new Map<string, AppErrorException>() };
  const joins = {
    calls,
    state,
    get busy() {
      return state.joining.size > 0;
    },
    isJoining: (id: string) => state.joining.has(id),
    check: async (paths: unknown, opts: unknown) => {
      calls.push(`check ${JSON.stringify(paths)} ${JSON.stringify(opts)}`);
      return { ok: true };
    },
    create: async (req: Record<string, unknown>) => {
      calls.push(`create ${JSON.stringify(req)}`);
      return { project: { id: 'proj_1' }, join: { state: 'waiting' } };
    },
    status: async (id: string) => (id === 'proj_1' ? { projectId: id, state: 'running' } : undefined),
    cancel: async (id: string) => {
      calls.push(`cancel ${id}`);
      state.joining.delete(id);
      return { projectId: id, state: 'cancelled' };
    },
    restart: async (id: string, opts: unknown) => {
      calls.push(`restart ${id} ${JSON.stringify(opts)}`);
      return { projectId: id, state: 'waiting' };
    },
    blockReason: async (id: string) => state.blocked.get(id),
    stopAll: async () => {
      calls.push('stopAll');
    },
  };
  return joins;
}

describe('join routes', () => {
  let app: FastifyInstance;
  let joins: ReturnType<typeof stubJoins>;
  let reached: string[];

  beforeEach(async () => {
    joins = stubJoins();
    reached = [];
    app = Fastify();
    // The routes the guards stand in front of, as stubs.
    app.post('/projects/:id/run', async (req) => (reached.push(`run ${(req.params as { id: string }).id}`), { started: true }));
    app.post('/projects/:id/probe', async () => (reached.push('probe'), {}));
    app.delete('/projects/:id', async (req) => (reached.push(`delete ${(req.params as { id: string }).id}`), { ok: true }));
    app.put('/projects/:id', async () => (reached.push('revise'), {}));
    app.put('/storage/projects-folder', async () => (reached.push('move'), {}));
    registerJoinRoutes(app, {
      joins: joins as unknown as JoinService,
      sendError,
      resolveSeries: async (s: SeriesSettings) => {
        if (s.aiProviderId === 'nope') throw new AppErrorException('CLOUD_CREDENTIALS_MISSING', 'The AI "nope" is not set up here.');
        return { ...s, aiProviderId: 'anthropic-translate' };
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('checks the files (a valid render quality only)', async () => {
    const res = await app.inject({ method: 'POST', url: '/join/check', payload: { videoPaths: ['/a.mp4', '/b.mp4'], renderQuality: 'bogus' } });
    expect(res.statusCode).toBe(200);
    expect(joins.calls).toEqual(['check ["/a.mp4","/b.mp4"] {}']);
    await app.inject({ method: 'POST', url: '/join/check', payload: { videoPaths: ['/a.mp4', '/b.mp4'], renderQuality: 'fast' } });
    expect(joins.calls[1]).toBe('check ["/a.mp4","/b.mp4"] {"renderQuality":"fast"}');
  });

  it('makes a joined project with the series AI resolved as POST /projects does', async () => {
    const series = { minMinutes: 30, maxMinutes: 40, aiProviderId: '', recapSec: 4, autoStart: true };
    const res = await app.inject({
      method: 'POST',
      url: '/projects/join',
      payload: { videoPaths: ['/a.mp4', '/b.mp4'], name: 'N', settings: { targetLanguage: 'vi-VN' }, series, start: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ project: { id: 'proj_1' }, join: { state: 'waiting' } });
    expect(JSON.parse(joins.calls[0]!.slice('create '.length))).toEqual({
      videoPaths: ['/a.mp4', '/b.mp4'],
      name: 'N',
      settings: { targetLanguage: 'vi-VN' },
      start: true,
      series: { ...series, aiProviderId: 'anthropic-translate' },
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/projects/join',
      payload: { videoPaths: ['/a.mp4', '/b.mp4'], name: 'N', settings: {}, series: { ...series, aiProviderId: 'nope' } },
    });
    expect(refused.statusCode).toBe(424);
    expect(refused.json().error.code).toBe('CLOUD_CREDENTIALS_MISSING');
    expect(joins.calls).toHaveLength(1);
  });

  it('reports, cancels and restarts a join', async () => {
    expect((await app.inject({ method: 'GET', url: '/projects/proj_1/join' })).json()).toEqual({ projectId: 'proj_1', state: 'running' });
    const missing = await app.inject({ method: 'GET', url: '/projects/proj_x/join' });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/projects/proj_1/join/cancel' })).json()).toEqual({ projectId: 'proj_1', state: 'cancelled' });
    const restarted = await app.inject({ method: 'POST', url: '/projects/proj_1/join/restart', payload: { reencode: true } });
    expect(restarted.statusCode).toBe(202);
    expect(joins.calls).toEqual(['cancel proj_1', 'restart proj_1 {"reencode":true}']);
  });

  it('refuses to run or probe a project whose videos are not joined yet, and says why', async () => {
    joins.state.blocked.set('proj_1', new AppErrorException('RUN_IN_PROGRESS', 'The videos are still being joined into this project (37%).'));
    const run = await app.inject({ method: 'POST', url: '/projects/proj_1/run', payload: {} });
    expect(run.statusCode).toBe(409);
    expect(run.json().error.message).toContain('(37%)');
    expect((await app.inject({ method: 'POST', url: '/projects/proj_1/probe', payload: {} })).statusCode).toBe(409);
    // Any other project runs as before.
    expect((await app.inject({ method: 'POST', url: '/projects/proj_2/run', payload: {} })).statusCode).toBe(200);
    expect(reached).toEqual(['run proj_2']);
  });

  it('cancels the join of a project being deleted, then deletes it', async () => {
    joins.state.joining.add('proj_1');
    const res = await app.inject({ method: 'DELETE', url: '/projects/proj_1' });
    expect(res.statusCode).toBe(200);
    expect(joins.calls).toEqual(['cancel proj_1']);
    expect(reached).toEqual(['delete proj_1']);
  });

  it('lets Back + Continue rename a joining project, never replace its video', async () => {
    joins.state.joining.add('proj_1');
    expect((await app.inject({ method: 'PUT', url: '/projects/proj_1', payload: { name: 'New', settings: {} } })).statusCode).toBe(200);
    const replace = await app.inject({ method: 'PUT', url: '/projects/proj_1', payload: { name: 'New', settings: {}, inputVideoPath: '/c.mp4' } });
    expect(replace.statusCode).toBe(409);
    expect(reached).toEqual(['revise']);
  });

  it('keeps the projects folder where it is while a join writes into it', async () => {
    joins.state.joining.add('proj_1');
    const res = await app.inject({ method: 'PUT', url: '/storage/projects-folder', payload: { root: '/elsewhere' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('being joined');
    joins.state.joining.clear();
    expect((await app.inject({ method: 'PUT', url: '/storage/projects-folder', payload: { root: '/elsewhere' } })).statusCode).toBe(200);
  });

  it('stops the joins when the app closes', async () => {
    await app.close();
    expect(joins.calls).toContain('stopAll');
  });
});

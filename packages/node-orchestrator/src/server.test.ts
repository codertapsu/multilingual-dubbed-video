import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { FakeMediaService } from './test/fixtures.js';

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

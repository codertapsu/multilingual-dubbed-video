/**
 * The event streams hijack the reply, so the cors plugin never sees them. They
 * used to answer every origin with `Access-Control-Allow-Origin: *`, letting
 * any web page open in the user's browser read download links, project logs
 * and engine events from 127.0.0.1. Now they follow the API's own origin rule.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { FakeMediaService } from './test/fixtures.js';

describe('event-stream CORS', () => {
  let tmp: string;
  let app: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vd-sse-'));
    app = await createServer({
      config: loadConfig({
        projectsDir: path.join(tmp, 'projects'),
        configDir: path.join(tmp, 'config'),
        modelsDir: path.join(tmp, 'models'),
      }),
      media: new FakeMediaService(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // A hijacked event stream stays open until the server ends it, and close()
    // waits for open connections.
    app.server.closeAllConnections();
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });

  /** Open a stream, read only its headers, hang up. */
  const headersFor = async (route: string, origin: string): Promise<Headers> => {
    const ac = new AbortController();
    const res = await fetch(`${base}${route}`, { headers: { origin }, signal: ac.signal });
    ac.abort();
    return res.headers;
  };

  for (const route of ['/setup/events', '/download/events', '/engines/events']) {
    it(`${route}: a web page cannot read it; the app's own webview can`, async () => {
      const foreign = await headersFor(route, 'https://evil.example');
      expect(foreign.get('access-control-allow-origin')).toBeNull();
      expect(foreign.get('content-type')).toBe('text/event-stream');

      const tauri = await headersFor(route, 'tauri://localhost');
      expect(tauri.get('access-control-allow-origin')).toBe('tauri://localhost');
      expect(tauri.get('vary')).toMatch(/Origin/);
    });
  }
});

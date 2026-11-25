import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { AppNotRunningError, VideoDubberApi } from './api.js';
import { ensureAppRunning, findDesktopApp } from './launcher.js';
import { resolveBaseUrl } from './stdio.js';

describe('findDesktopApp', () => {
  const yes = () => true;

  it('finds the app next to the packaged Windows sidecar', () => {
    const t = findDesktopApp('C:\\Users\\me\\AppData\\Local\\VideoDubber\\videodubber-orchestrator.exe', {}, 'win32', yes);
    expect(t).toEqual({
      command: 'C:\\Users\\me\\AppData\\Local\\VideoDubber\\videodubber-desktop.exe',
      args: [],
      label: 'C:\\Users\\me\\AppData\\Local\\VideoDubber\\videodubber-desktop.exe',
    });
  });

  it('opens the .app bundle around the packaged macOS sidecar', () => {
    const t = findDesktopApp('/Applications/VideoDubber.app/Contents/MacOS/videodubber-orchestrator', {}, 'darwin', yes);
    expect(t).toEqual({ command: 'open', args: ['/Applications/VideoDubber.app'], label: '/Applications/VideoDubber.app' });
  });

  it('knows nothing under plain node (a source checkout starts the app with pnpm dev)', () => {
    expect(findDesktopApp('C:\\Program Files\\nodejs\\node.exe', {}, 'win32', yes)).toBeUndefined();
    expect(findDesktopApp('/usr/local/bin/node', {}, 'darwin', yes)).toBeUndefined();
  });

  it('honours VIDEODUBBER_APP, and never guesses a path that does not exist', () => {
    expect(findDesktopApp('/usr/bin/node', { VIDEODUBBER_APP: '/opt/vd/videodubber-desktop' }, 'linux', yes)?.command).toBe(
      '/opt/vd/videodubber-desktop',
    );
    expect(findDesktopApp('/usr/bin/node', { VIDEODUBBER_APP: '/Apps/VideoDubber.app' }, 'darwin', () => false)).toEqual({
      command: 'open',
      args: ['/Apps/VideoDubber.app'],
      label: '/Apps/VideoDubber.app',
    });
    const missing = findDesktopApp('D:\\VD\\videodubber-orchestrator.exe', {}, 'win32', () => false);
    expect(missing).toBeUndefined();
  });
});

describe('ensureAppRunning', () => {
  it('starts the app, then waits until it answers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    const api = new VideoDubberApi({ baseUrl: 'http://127.0.0.1:1' }); // placeholder, replaced below
    let spawned: { command: string; args: string[] } | undefined;
    // Pick a port, then only listen on it once the "app" is spawned.
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const live = new VideoDubberApi({ baseUrl: `http://127.0.0.1:${port}` });
    void api;
    const state = await ensureAppRunning(live, {
      target: { command: 'C:\\VD\\videodubber-desktop.exe', args: [], label: 'VD' },
      pollMs: 20,
      timeoutMs: 5000,
      spawnImpl: (command, args) => {
        spawned = { command, args };
        server.listen(port, '127.0.0.1');
        return { unref: () => undefined };
      },
    });
    expect(state).toBe('started');
    expect(spawned).toEqual({ command: 'C:\\VD\\videodubber-desktop.exe', args: [] });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('does nothing when the app already answers, and fails clearly when it cannot be started', async () => {
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await ensureAppRunning(new VideoDubberApi({ baseUrl: url }), {})).toBe('running');
    await new Promise<void>((r) => server.close(() => r()));
    await expect(ensureAppRunning(new VideoDubberApi({ baseUrl: url }), {})).rejects.toBeInstanceOf(AppNotRunningError);
  });
});

describe('a slow app is a running app', () => {
  it('never launches the app again when /health answers late (event-loop stalls, 2026-11-24)', async () => {
    // Takes the connection, answers after 300 ms: slower than the 100 ms probe below.
    const server = createServer((_req, res) => setTimeout(() => res.end('{"status":"ok"}'), 300));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = new VideoDubberApi({ baseUrl: url });
    expect(await api.probe(100)).toBe('slow');
    let spawned = false;
    const quick = Object.assign(api, { probe: (ms?: number) => VideoDubberApi.prototype.probe.call(api, ms === undefined ? 100 : ms) });
    const state = await ensureAppRunning(quick, {
      target: { command: 'x', args: [], label: 'x' },
      slowTimeoutMs: 1000,
      spawnImpl: () => {
        spawned = true;
        return { unref: () => undefined };
      },
    });
    expect(state).toBe('running');
    expect(spawned).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await api.probe(500)).toBe('down');
  });
});

describe('resolveBaseUrl', () => {
  it('prefers --url, then VIDEODUBBER_URL, then the app default', () => {
    expect(resolveBaseUrl(['node', 'cli.js', '--url', 'http://127.0.0.1:6100'], { VIDEODUBBER_URL: 'http://x:1' })).toBe('http://127.0.0.1:6100');
    expect(resolveBaseUrl(['node', 'cli.js'], { VIDEODUBBER_URL: ' http://127.0.0.1:7100 ' })).toBe('http://127.0.0.1:7100');
    expect(resolveBaseUrl(['node', 'cli.js'], {})).toBe('http://127.0.0.1:5100');
  });
});

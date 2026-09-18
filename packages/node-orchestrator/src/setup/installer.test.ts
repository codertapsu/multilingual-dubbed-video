import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupEvent } from '@videodubber/shared';
import { loadConfig } from '../config.js';
import { SetupInstaller } from './installer.js';
import { SetupEventBus } from './setupBus.js';
import { SetupStore } from './setupStore.js';
import { setWorkerTransport, type RawWorkerResponse } from '../providers/workerHttp.js';

let tmp: string;
let store: SetupStore;
let bus: SetupEventBus;
let events: SetupEvent[];

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-installer-test-'));
  store = new SetupStore(path.join(tmp, 'config'));
  bus = new SetupEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  setWorkerTransport(null);
  vi.restoreAllMocks();
});

function config() {
  return loadConfig({
    configDir: path.join(tmp, 'config'),
    modelsDir: path.join(tmp, 'models'),
  });
}

/** A small raw worker-response helper (for the workerHttp transport seam). */
function rawJson(body: unknown, status = 200): RawWorkerResponse {
  return { status, ok: status >= 200 && status < 300, text: JSON.stringify(body) };
}

/** A binary Response with a Content-Length so download progress is emitted. */
function fileResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

describe('SetupInstaller', () => {
  it('installs whisper + argos + piper and emits done with the final status', async () => {
    const onnxBytes = new Uint8Array(2048).fill(7);
    const configBytes = new Uint8Array([123, 125]); // "{}"

    // Worker JSON calls (/models/ensure, /packages/ensure) go through workerHttp's
    // transport seam; the Piper file download uses fetchImpl.
    setWorkerTransport(async (_method, url) => {
      if (url.endsWith('/models/ensure')) return rawJson({ ok: true, model: 'base', alreadyCached: false });
      if (url.endsWith('/packages/ensure')) return rawJson({ ok: true, installed: true });
      throw new Error(`unexpected worker call: ${url}`);
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('.onnx')) return fileResponse(onnxBytes);
      if (url.endsWith('.onnx.json')) return fileResponse(configBytes);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await installer.run({
      whisperModel: 'base',
      argosPairs: [{ from: 'en', to: 'vi' }],
      piperVoices: ['vi_VN-vais1000-medium'],
    });

    // The .onnx + .onnx.json were written to <modelsDir>/piper.
    const piperDir = path.join(tmp, 'models', 'piper');
    const onnx = await fsp.readFile(path.join(piperDir, 'vi_VN-vais1000-medium.onnx'));
    expect(onnx.byteLength).toBe(onnxBytes.byteLength);
    await expect(
      fsp.access(path.join(piperDir, 'vi_VN-vais1000-medium.onnx.json')),
    ).resolves.toBeUndefined();

    // setup.json records all three installed items.
    const status = await store.getStatus();
    expect(status.installed.whisperModels).toEqual(['base']);
    expect(status.installed.argosPairs).toEqual([{ from: 'en', to: 'vi' }]);
    expect(status.installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);

    // The terminal event is "done" carrying the final status.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.status.installed.whisperModels).toEqual(['base']);
    }
    // Progress + item-done events were emitted.
    expect(events.some((e) => e.type === 'item-done')).toBe(true);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
  });

  it('does not re-download a Piper voice that is already on disk', async () => {
    // Regression: the wizard downloaded the voice unconditionally, so a build
    // that seed-copies the default voice into <models>/piper still failed the
    // whole install offline ("Failed to reach voice download") for a file that
    // was already there.
    const piperDir = path.join(tmp, 'models', 'piper');
    await fsp.mkdir(piperDir, { recursive: true });
    await fsp.writeFile(path.join(piperDir, 'vi_VN-vais1000-medium.onnx'), Buffer.alloc(2048, 7));
    await fsp.writeFile(path.join(piperDir, 'vi_VN-vais1000-medium.onnx.json'), '{}', 'utf8');

    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error('network unavailable');
    });
    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect((await store.getStatus()).installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);
    expect(
      events.some((e) => e.type === 'progress' && e.message.includes('already present')),
    ).toBe(true);
  });

  it('re-downloads when only one half of the voice pair is present', async () => {
    // A zero-byte / missing .onnx.json is what an interrupted download leaves,
    // and Piper needs BOTH files — "present" must mean the complete pair.
    const piperDir = path.join(tmp, 'models', 'piper');
    await fsp.mkdir(piperDir, { recursive: true });
    await fsp.writeFile(path.join(piperDir, 'vi_VN-vais1000-medium.onnx'), Buffer.alloc(2048, 7));

    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('.onnx')) return fileResponse(new Uint8Array(2048).fill(7));
      if (url.endsWith('.onnx.json')) return fileResponse(new Uint8Array([123, 125]));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    expect(fetchMock).toHaveBeenCalled();
    expect((await store.getStatus()).installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);
  });

  it('resumes a dropped download instead of restarting from byte 0', async () => {
    // A 64 MB voice on a flaky/throttled link (Vietnam, much of Asia — the app's
    // primary audience) used to restart from zero on every drop, and the single
    // failure aborted the whole install run.
    const full = new Uint8Array(1000).map((_, i) => i % 251);
    const requests: (string | undefined)[] = [];
    let onnxAttempt = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const range = new Headers(init?.headers ?? {}).get('range') ?? undefined;
      requests.push(range);
      if (url.endsWith('.onnx.json')) return fileResponse(new Uint8Array([123, 125]));

      onnxAttempt += 1;
      if (onnxAttempt === 1) {
        // First attempt: 400 bytes land on disk, then the connection dies
        // mid-stream (the error is raised on the NEXT pull so the first chunk is
        // really written, as it would be on a real dropped transfer).
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(full.slice(0, 400));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.error(new Error('connection reset'));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-length': String(full.byteLength) } });
      }
      // Second attempt: honor the Range header with the remainder.
      const from = Number.parseInt((range ?? 'bytes=0-').replace('bytes=', ''), 10);
      return new Response(full.slice(from), {
        status: 206,
        headers: { 'content-length': String(full.byteLength - from) },
      });
    });

    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    expect(events.some((e) => e.type === 'error')).toBe(false);
    const written = await fsp.readFile(
      path.join(tmp, 'models', 'piper', 'vi_VN-vais1000-medium.onnx'),
    );
    expect(new Uint8Array(written)).toEqual(full);
    // The retry asked for the REMAINING bytes only.
    expect(requests[1]).toBe('bytes=400-');
    // No partial left behind once the file is complete.
    await expect(
      fsp.stat(path.join(tmp, 'models', 'piper', 'vi_VN-vais1000-medium.onnx.download')),
    ).rejects.toThrow();
  });

  it('rejects a truncated "200 OK" body instead of installing it', async () => {
    // A proxy that answers 200 and then cuts the connection used to leave a short
    // file renamed into place as a valid-looking voice; it only surfaced later as
    // a broken dub.
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('.onnx.json')) return fileResponse(new Uint8Array([123, 125]));
      // Claims 1000 bytes, sends 100.
      return new Response(new Uint8Array(100), {
        status: 200,
        headers: { 'content-length': '1000' },
      });
    });

    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.message).toContain('ended early');
    await expect(
      fsp.stat(path.join(tmp, 'models', 'piper', 'vi_VN-vais1000-medium.onnx')),
    ).rejects.toThrow();
  });

  it('does not retry a moved file, and says what to do about it', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('nope', { status: 404 }));
    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no pointless retries
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.error.message).toContain('no longer at that address');
    expect(error?.type === 'error' && error.error.remediation).toContain('Update VideoDubber');
    // `cause` must carry the real reason (the URL), never an internal
    // "don't retry this" flag — it is shown to the user and logged.
    expect(error?.type === 'error' && error.error.cause).toContain('huggingface');
  });

  it('retries a rate-limited download and reports the rate limit', async () => {
    let calls = 0;
    const payload = new Uint8Array(64).fill(3);
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('.onnx.json')) return fileResponse(new Uint8Array([123, 125]));
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return fileResponse(payload);
    });

    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    await installer.run({ piperVoices: ['vi_VN-vais1000-medium'] });

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect((await store.getStatus()).installed.piperVoices).toEqual(['vi_VN-vais1000-medium']);
  });

  it('emits an error event when the STT worker reports failure', async () => {
    setWorkerTransport(async (_method, url) => {
      if (url.endsWith('/models/ensure')) {
        return rawJson({ error: { code: 'STT_MODEL_MISSING', message: 'boom' } }, 424);
      }
      throw new Error(`unexpected worker call: ${url}`);
    });

    const installer = new SetupInstaller({
      config: config(),
      store,
      bus,
    });

    await installer.run({ whisperModel: 'base' });

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    if (error?.type === 'error') {
      expect(error.error.code).toBe('STT_MODEL_MISSING');
    }
    // No "done" should be emitted on failure.
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(installer.isRunning()).toBe(false);
  });

  it('rejects an unknown piper voice id with a TTS_VOICE_MISSING error event', async () => {
    const installer = new SetupInstaller({ config: config(), store, bus });
    await installer.run({ piperVoices: ['does-not-exist'] });
    const error = events.find((e) => e.type === 'error');
    expect(error?.type).toBe('error');
    if (error?.type === 'error') {
      expect(error.error.code).toBe('TTS_VOICE_MISSING');
    }
  });
});

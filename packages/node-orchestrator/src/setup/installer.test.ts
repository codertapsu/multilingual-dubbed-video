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

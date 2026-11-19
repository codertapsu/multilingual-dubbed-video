import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupEvent } from '@videodubber/shared';
import { loadConfig } from '../config.js';
import { SetupInstaller, WHISPER_REPOS } from './installer.js';
import { SetupEventBus } from './setupBus.js';
import { SetupStore } from './setupStore.js';
import { setWorkerTransport, type RawWorkerResponse } from '../providers/workerHttp.js';

// The voice catalog pins every Piper file to a sha256, which the fake bodies
// below cannot match. Most tests exercise the transfer itself, so by default
// the catalog "does not know" the voice and the unpinned curated entry is used;
// the checksum tests program a pinned voice here.
const catalogVoice = vi.hoisted(() => vi.fn<(id: string) => unknown>(() => undefined));
vi.mock('./voicesCatalog.js', () => ({ resolvePiperVoice: (id: string) => catalogVoice(id) }));

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

  it('takes on what another project asks for while it runs, and ends with one done', async () => {
    // A batch: the second project (another language) asks while the first one's
    // model is still downloading. Its pack used to be ignored.
    let releaseWhisper!: () => void;
    const whisperGate = new Promise<void>((resolve) => (releaseWhisper = resolve));
    const ensured: string[] = [];
    setWorkerTransport(async (_method, url, body) => {
      if (url.endsWith('/models/ensure')) {
        await whisperGate;
        return rawJson({ ok: true, model: 'small', alreadyCached: false });
      }
      if (url.endsWith('/packages/ensure')) {
        const pair = JSON.parse(String(body)) as { from: string; to: string };
        ensured.push(`${pair.from}-${pair.to}`);
        return rawJson({ ok: true, installed: true });
      }
      throw new Error(`unexpected worker call: ${url}`);
    });
    const installer = new SetupInstaller({ config: config(), store, bus, fetchImpl: vi.fn() as unknown as typeof fetch });

    const first = installer.run({ whisperModel: 'small', argosPairs: [{ from: 'zh', to: 'en' }] });
    await vi.waitFor(() => expect(installer.isRunning()).toBe(true));
    // Same model again (nothing twice) plus a new pair.
    await installer.run({ whisperModel: 'small', argosPairs: [{ from: 'zh', to: 'en' }, { from: 'en', to: 'vi' }] });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(0);
    releaseWhisper();
    await first;

    expect(ensured).toEqual(['zh-en', 'en-vi']);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    const pairs = (await store.getStatus()).installed.argosPairs;
    expect(pairs).toEqual(expect.arrayContaining([{ from: 'zh', to: 'en' }, { from: 'en', to: 'vi' }]));
    expect(installer.isRunning()).toBe(false);
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

  describe('a voice pinned by the catalog', () => {
    const onnx = new Uint8Array(4096).fill(9);
    const json = new Uint8Array([123, 125]);
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

    beforeEach(() => {
      catalogVoice.mockImplementation((id) =>
        id === 'xx_XX-pinned-medium'
          ? {
              id,
              language: 'xx-XX',
              label: 'Pinned',
              approxSizeMb: 1,
              url: 'https://example.test/rev/xx.onnx',
              configUrl: 'https://example.test/rev/xx.onnx.json',
              sha256: sha(onnx),
              bytes: onnx.byteLength,
              configSha256: sha(json),
              configBytes: json.byteLength,
            }
          : undefined,
      );
    });
    afterEach(() => catalogVoice.mockReset());

    it('installs it when every byte matches', async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        fileResponse(String(input).endsWith('.json') ? json : onnx),
      );
      const installer = new SetupInstaller({ config: config(), store, bus, fetchImpl: fetchMock as unknown as typeof fetch });
      await installer.run({ piperVoices: ['xx_XX-pinned-medium'] });
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect((await store.getStatus()).installed.piperVoices).toEqual(['xx_XX-pinned-medium']);
    });

    it('discards a download that does not match its sha256, and never records the voice', async () => {
      const tampered = new Uint8Array(4096).fill(1); // right size, wrong bytes
      const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
        fileResponse(String(input).endsWith('.json') ? json : tampered),
      );
      const installer = new SetupInstaller({
        config: config(),
        store,
        bus,
        fetchImpl: fetchMock as unknown as typeof fetch,
        sleepImpl: async () => undefined,
      });
      await installer.run({ piperVoices: ['xx_XX-pinned-medium'] });

      const error = events.find((e) => e.type === 'error');
      expect(error?.type === 'error' && error.error.message).toContain('did not match its checksum');
      // Every attempt started over rather than resuming a bad partial.
      expect(fetchMock.mock.calls.length).toBe(4);
      const piperDir = path.join(tmp, 'models', 'piper');
      const left = await fsp.readdir(piperDir).catch(() => []);
      expect(left).toEqual([]);
      expect((await store.getStatus()).installed.piperVoices).toEqual([]);
    });
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

  it('still installs the items after one that fails, and names the failure', async () => {
    // The 0.11.0 test build: the translation engine could not load, and the
    // first failure ended the run, so the voice queued behind it never came.
    const onnxBytes = new Uint8Array(2048).fill(7);
    setWorkerTransport(async (_method, url) => {
      if (url.endsWith('/models/ensure')) return rawJson({ ok: true, model: 'base', alreadyCached: false });
      if (url.endsWith('/packages/ensure')) {
        return rawJson(
          { error: { code: 'TRANSLATION_PACKAGE_MISSING', message: 'Argos failed to load.', remediation: 'Reinstall.' } },
          503,
        );
      }
      throw new Error(`unexpected worker call: ${url}`);
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      String(input).endsWith('.onnx') ? fileResponse(onnxBytes) : fileResponse(new Uint8Array([123, 125])),
    );
    const installer = new SetupInstaller({ config: config(), store, bus, fetchImpl: fetchMock as unknown as typeof fetch });

    await installer.run({
      whisperModel: 'base',
      argosPairs: [
        { from: 'zh', to: 'en' },
        { from: 'en', to: 'vi' },
      ],
      piperVoices: ['vi_VN-vais1000-medium'],
    });

    const status = await store.getStatus();
    expect(status.installed.whisperModels).toEqual(['base']);
    expect(status.installed.piperVoices).toEqual(['vi_VN-vais1000-medium']); // tried despite the packs failing
    expect(status.installed.argosPairs).toEqual([]);
    const error = events.find((e): e is Extract<SetupEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.error.code).toBe('TRANSLATION_PACKAGE_MISSING');
    expect(error?.error.message).toBe(
      '2 of 4 downloads failed. First: Argos failed to load. The other downloads finished.',
    );
    expect(error?.error.remediation).toBe('Reinstall.');
    // Still an error run: the wizard offers Retry, which skips what is there.
    expect(events.some((e) => e.type === 'done')).toBe(false);
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

describe('WHISPER_REPOS', () => {
  it('mirrors _SYSTRAN_REPOS in the STT worker exactly', async () => {
    // The worker decides which repo is downloaded and loaded; this copy only
    // decides which cache folder the wizard's progress bar watches. They drifted
    // once (PhoWhisper Medium moved repos), so compare against the source.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const py = await fsp.readFile(
      path.join(here, '../../../../workers/stt-worker/app/whisper_service.py'),
      'utf8',
    );
    const block = /_SYSTRAN_REPOS: dict\[str, str\] = \{([\s\S]*?)\n\}/.exec(py)?.[1];
    expect(block, '_SYSTRAN_REPOS not found in whisper_service.py').toBeDefined();
    const worker = Object.fromEntries(
      [...block!.matchAll(/^\s*"([^"]+)":\s*"([^"]+)",/gm)].map((m) => [m[1], m[2]]),
    );
    expect(Object.keys(worker).length).toBeGreaterThan(5);
    expect({ ...WHISPER_REPOS }).toEqual(worker);
  });
});

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import { EnginePackStore } from '../../engines/enginePackStore.js';
import type { EngineManager } from '../../engines/engineManager.js';
import { setWorkerTransport, type WorkerTransport } from '../workerHttp.js';
import {
  NEURAL_TTS_GPU_UNITS_PER_REQUEST,
  NEURAL_TTS_UNITS_PER_REQUEST,
  NeuralTtsProvider,
} from './neuralTtsProvider.js';

const BASE = 'http://127.0.0.1:63083';

let tmp: string;
let store: EnginePackStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-neural-tts-test-'));
  store = new EnginePackStore(tmp);
  const dir = store.packDir('tts-neural');
  await fsp.mkdir(dir, { recursive: true });
  await store.add({ id: 'tts-neural', path: dir, installedAt: '2026-11-07T00:00:00Z' });
});

afterEach(async () => {
  setWorkerTransport(null);
  await fsp.rm(tmp, { recursive: true, force: true });
});

const engineCalls: { packIds: readonly string[]; opts: { exclusive?: boolean } }[] = [];
const engines = {
  ensureRunning: async () => BASE,
  ensureRunningFirstUsable: async (
    packIds: readonly string[],
    opts: { exclusive?: boolean } = {},
  ) => {
    engineCalls.push({ packIds, opts });
    return BASE;
  },
} as unknown as EngineManager;

function provider(timeoutMs = 10_000): NeuralTtsProvider {
  return new NeuralTtsProvider(
    'neural-tts',
    'VieNeu Neural TTS v3 (Vietnamese)',
    'neural-tts',
    engines,
    store,
    timeoutMs,
  );
}

const input = {
  language: 'vi-VN',
  voiceId: 'vieneu-v3-gia-bao',
  outputDir: path.join(os.tmpdir(), 'tts_segments'),
  segments: [
    { id: 'seg_0001', text: 'Đại đế ở đâu?', startMs: 0, endMs: 1500 },
    { id: 'seg_0004', text: 'Tại.', startMs: 4000, endMs: 4800 },
  ],
};

/** Healthy, warm engine; `synth` decides what /synthesize-segments does. */
function transport(
  synth: (signal: AbortSignal) => Promise<{ status: number; ok: boolean; text: string }>,
): WorkerTransport {
  return async (_method, url, _payload, signal) => {
    if (url.endsWith('/health') || url.endsWith('/warmup'))
      return { status: 200, ok: true, text: JSON.stringify({ loaded: true }) };
    return synth(signal);
  };
}

/** Never answers; rejects the way node:http does when the request is aborted. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ),
  );

describe('NeuralTtsProvider', () => {
  it('asks for small batches, so one request can never hold a whole dub', () => {
    expect(provider().maxSegmentsPerRequest).toBe(NEURAL_TTS_UNITS_PER_REQUEST);
    expect(NEURAL_TTS_UNITS_PER_REQUEST).toBeLessThanOrEqual(8);
  });

  it('passes through how many clips the engine reused', async () => {
    setWorkerTransport(
      transport(async () => ({
        status: 200,
        ok: true,
        text: JSON.stringify({
          engine: 'neural-tts',
          fallbackSegments: 0,
          reusedSegments: 2,
          segments: input.segments.map((s, i) => ({
            segmentId: s.id,
            audioPath: path.join(input.outputDir, `segment_000${i + 1}.wav`),
            durationMs: 900,
            startMs: s.startMs,
            endMs: s.endMs,
            speedRatio: 1,
          })),
        }),
      })),
    );
    const result = await provider().synthesizeSegments(input);
    expect(result.reusedSegments).toBe(2);
    expect(result.segments.map((s) => s.text)).toEqual(['Đại đế ở đâu?', 'Tại.']);
  });

  it('explains a timeout in terms of the voice step, not speech-to-text', async () => {
    setWorkerTransport(transport(hang));
    const err = await provider(60)
      .synthesizeSegments(input)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AppErrorException);
    const app = (err as AppErrorException).appError;
    expect(app.code).toBe('WORKER_TIMEOUT');
    expect(app.message).toContain('2 line(s)');
    expect(app.remediation).toContain('Retry the step');
    expect(app.remediation).toContain('reused');
    expect(app.remediation).toContain('Piper');
    expect(app.remediation).not.toMatch(/STT|speech-to-text|Whisper/i);
    expect(app.cause).toBe(`${BASE}/synthesize-segments`);
    expect(app.docsRef).toBe('docs/TROUBLESHOOTING.md#worker-timeout');
  });

  it('leaves a cancel as a cancel', async () => {
    setWorkerTransport(transport(hang));
    const ctl = new AbortController();
    const pending = provider().synthesizeSegments(input, ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
  });

  it('sends GPU-sized requests once the engine reports it runs on CUDA', async () => {
    const calls: string[] = [];
    setWorkerTransport(async (_method, url) => {
      calls.push(new URL(url).pathname);
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          loaded: true,
          device: 'cuda',
          deviceName: 'NVIDIA GeForce RTX 3050',
        }),
      };
    });
    const p = provider();
    expect(p.maxSegmentsPerRequest).toBe(NEURAL_TTS_UNITS_PER_REQUEST); // unknown yet: CPU-sized
    engineCalls.length = 0;
    await p.prepare();
    expect(p.maxSegmentsPerRequest).toBe(NEURAL_TTS_GPU_UNITS_PER_REQUEST);
    expect(p.activeDevice).toEqual({ device: 'cuda', name: 'NVIDIA GeForce RTX 3050' });
    // Warmed through POST /warmup (the GPU build loads only when asked), while
    // holding the exclusive lane, so a resident llama.cpp is evicted first.
    expect(calls[0]).toBe('/warmup');
    expect(engineCalls[0]?.opts.exclusive).toBe(true);
  });

  it('reports why a GPU pack runs on the CPU', async () => {
    setWorkerTransport(async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({
        loaded: true,
        device: 'cpu',
        deviceNote: 'GPU unavailable, using the CPU instead: driver too old',
      }),
    }));
    const p = provider();
    await p.prepare();
    expect(p.maxSegmentsPerRequest).toBe(NEURAL_TTS_UNITS_PER_REQUEST);
    expect(p.activeDevice.note).toContain('driver too old');
  });
});

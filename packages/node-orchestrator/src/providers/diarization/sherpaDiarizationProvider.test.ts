import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { setWorkerTransport, type RawWorkerResponse } from '../workerHttp.js';
import {
  SherpaDiarizationProvider,
  chunkCheckpointKey,
  diarizationTimeoutMs,
  planDiarizationChunks,
  wavDurationMs,
} from './sherpaDiarizationProvider.js';
import { cosineSimilarity } from './voicePrint.js';

describe('diarizationTimeoutMs', () => {
  const base = 30 * 60_000;
  const hours = (h: number): number => h * 3600 * 32_000; // bytes of 16 kHz mono 16-bit

  it('keeps the usual timeout for ordinary videos', () => {
    expect(diarizationTimeoutMs(base, hours(0.5))).toBe(base);
    expect(diarizationTimeoutMs(base, 0)).toBe(base);
  });

  it('grows with a long recording instead of failing a working request', () => {
    // 3 h of audio: 0.6 x 180 min + 5 min = 113 min.
    expect(diarizationTimeoutMs(base, hours(3))).toBe(113 * 60_000);
  });
});

describe('planning the parts of long audio', () => {
  const min = 60_000;

  it('reads the length from the size of the 16 kHz mono WAV', () => {
    expect(wavDurationMs(44 + 32_000 * 90)).toBe(90_000);
    expect(wavDurationMs(10)).toBe(0);
  });

  it('cuts 10-minute parts, a short last one riding with the one before', () => {
    expect(planDiarizationChunks(25 * min)).toEqual([
      { index: 0, startMs: 0, endMs: 10 * min },
      { index: 1, startMs: 10 * min, endMs: 20 * min },
      { index: 2, startMs: 20 * min, endMs: 25 * min },
    ]);
    expect(planDiarizationChunks(21 * min)).toEqual([
      { index: 0, startMs: 0, endMs: 10 * min },
      { index: 1, startMs: 10 * min, endMs: 21 * min },
    ]);
    expect(planDiarizationChunks(600 * min)).toHaveLength(60);
    expect(planDiarizationChunks(0)).toEqual([]);
  });

  it('keys a saved part on the very audio, the model, the window and the request', () => {
    const audio = { sizeBytes: 100, mtimeMs: 5 };
    const chunk = { startMs: 0, endMs: 600_000 };
    const key = chunkCheckpointKey(audio, 'm', chunk, { threshold: 0.7 });
    expect(chunkCheckpointKey({ ...audio }, 'm', { ...chunk }, { threshold: 0.7 })).toBe(key);
    expect(chunkCheckpointKey({ ...audio, mtimeMs: 6 }, 'm', chunk, { threshold: 0.7 })).not.toBe(key);
    expect(chunkCheckpointKey(audio, 'm2', chunk, { threshold: 0.7 })).not.toBe(key);
    expect(chunkCheckpointKey(audio, 'm', { ...chunk, endMs: 600_001 }, { threshold: 0.7 })).not.toBe(key);
    expect(chunkCheckpointKey(audio, 'm', chunk, { threshold: 0.8 })).not.toBe(key);
  });
});

describe('cosineSimilarity', () => {
  it('compares prints, and calls incomparable ones 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96);
    expect(cosineSimilarity([1, 0], [-2, 0])).toBe(-1);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

// ---- the provider, with a fake engine and a fake HTTP layer -----------------

const json = (body: unknown, status = 200): RawWorkerResponse => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(body) });

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** An engine that answers each part with two local speakers, and /link with them all as one. */
function fakeEngine(opts: { failParts?: Map<number, number>; timeoutPart?: number } = {}) {
  const calls: Call[] = [];
  const fails = new Map(opts.failParts ?? []);
  setWorkerTransport(async (_method, url, payload) => {
    const body = JSON.parse(payload ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith('/diarize-chunk')) {
      const startMs = body.startMs as number;
      const part = Math.round(startMs / 600_000);
      if (opts.timeoutPart === part) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const left = fails.get(part) ?? 0;
      if (left > 0) {
        fails.set(part, left - 1);
        return json({ detail: 'Internal Server Error' }, 500);
      }
      return json({
        turns: [
          { startMs: startMs + 1000, endMs: startMs + 5000, speaker: 0 },
          { startMs: startMs + 6000, endMs: startMs + 9000, speaker: 1 },
          { startMs: startMs + 9000, endMs: startMs + 9000, speaker: 1 }, // empty: dropped
        ],
        speakers: [
          { local: 0, sec: 4, printSec: 4, print: [1, 0], f0Hz: 120, lowShare: 0.9 },
          { local: 1, sec: 3, printSec: 3, print: [0, 1], f0Hz: null, lowShare: null },
        ],
        processMs: 1,
      });
    }
    if (url.endsWith('/link')) {
      const items = body.items as { chunk: number; local: number }[];
      return json({
        // Local 0 of every part is speaker 1; local 1 is speaker 0.
        assignments: items.map((it) => ({ chunk: it.chunk, local: it.local, speaker: it.local === 0 ? 1 : 0 })),
        speakers: [
          { speaker: 0, sec: 9, f0Hz: null, gender: 'female', genderConfidence: 0.55, print: [0, 1] },
          { speaker: 1, sec: 12, f0Hz: 120, gender: 'male', genderConfidence: 0.9, print: [1, 0] },
        ],
        thresholds: { link: 0.35, cannotLink: 0.78, derived: false },
      });
    }
    if (url.endsWith('/diarize')) {
      return json({
        turns: [
          { startMs: 0, endMs: 2000, speaker: 0 },
          { startMs: 'x', endMs: 2, speaker: 0 },
        ],
        speakers: 1,
        processMs: 3,
        speakerInfo: [{ speaker: 0, sec: 2, printSec: 2, print: [1, 0], f0Hz: 110, lowShare: 0.8, gender: 'male', genderConfidence: 0.3 }],
      });
    }
    if (url.endsWith('/embed')) {
      return json({ print: [0.6, 0.8], f0Hz: 194, lowShare: 0.1, speechSec: 6.5 });
    }
    return json({ detail: 'Not Found' }, 404);
  });
  return calls;
}

describe('SherpaDiarizationProvider', () => {
  let tmp: string;
  let installed: boolean;
  const engines = { ensureRunning: vi.fn(async () => 'http://engine/') } as unknown as EngineManager;
  const store = { isInstalled: async (id: string) => installed && id === 'diarization-sherpa' } as unknown as EnginePackStore;
  const provider = () => new SherpaDiarizationProvider(engines, store, 30 * 60_000);

  /** A WAV of `minutes` (only its size matters to the provider). */
  async function wav(name: string, minutes: number): Promise<string> {
    const file = path.join(tmp, name);
    await fsp.writeFile(file, '');
    await fsp.truncate(file, 44 + minutes * 60 * 32_000);
    return file;
  }

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-sherpa-'));
    installed = true;
  });
  afterEach(async () => {
    setWorkerTransport(null);
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('detects short audio in one pass, with each speaker\'s voice', async () => {
    const calls = fakeEngine();
    const audio = await wav('short.wav', 5);
    const progress: [number, number][] = [];
    const found = await provider().diarize(audio, { numSpeakers: 3, onProgress: (d, t) => progress.push([d, t]) });
    expect(calls.map((c) => c.url)).toEqual(['http://engine/diarize']);
    expect(calls[0]!.body).toEqual({ audioPath: audio, threshold: 0.7, numSpeakers: 3, withSpeakers: true });
    expect(found).toEqual({
      turns: [{ startMs: 0, endMs: 2000, speaker: 0 }],
      speakers: [{ speaker: 0, sec: 2, f0Hz: 110, gender: 'male', genderConfidence: 0.3, print: [1, 0] }],
    });
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it('detects long audio in parts, saves each, and links them into one set of speakers', async () => {
    const calls = fakeEngine();
    const audio = await wav('long.wav', 25);
    const parts = path.join(tmp, 'parts');
    const progress: [number, number][] = [];
    const found = await provider().diarize(audio, { numSpeakers: 4, checkpointDir: parts, onProgress: (d, t) => progress.push([d, t]) });

    expect(calls.map((c) => c.url)).toEqual([
      'http://engine/diarize-chunk',
      'http://engine/diarize-chunk',
      'http://engine/diarize-chunk',
      'http://engine/link',
    ]);
    expect(calls.slice(0, 3).map((c) => [c.body.startMs, c.body.endMs])).toEqual([
      [0, 600_000],
      [600_000, 1_200_000],
      [1_200_000, 1_500_000],
    ]);
    // A known count caps the linking; a part is never forced to have that many people.
    expect(calls[0]!.body).toEqual({ audioPath: audio, startMs: 0, endMs: 600_000, threshold: 0.7, maxPrintPieces: 8 });
    expect(calls[3]!.body).toMatchObject({ minPrintSec: 3, maxSpeakers: 4 });
    expect((calls[3]!.body.items as unknown[])[2]).toEqual({ chunk: 1, local: 0, sec: 4, printSec: 4, print: [1, 0], f0Hz: 120, lowShare: 0.9 });
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(found!.turns).toHaveLength(6);
    expect(found!.turns.slice(0, 3)).toEqual([
      { startMs: 1000, endMs: 5000, speaker: 1 },
      { startMs: 6000, endMs: 9000, speaker: 0 },
      { startMs: 601_000, endMs: 605_000, speaker: 1 },
    ]);
    expect(found!.speakers.map((s) => [s.speaker, s.gender])).toEqual([
      [0, 'female'],
      [1, 'male'],
    ]);
    expect((await fsp.readdir(parts)).sort()).toEqual(['chunk_0000.json', 'chunk_0001.json', 'chunk_0002.json']);

    // Asked again (another known count): the saved parts are reused, only the linking runs.
    calls.length = 0;
    const again = await provider().diarize(audio, { checkpointDir: parts });
    expect(calls.map((c) => c.url)).toEqual(['http://engine/link']);
    expect(calls[0]!.body).toMatchObject({ maxSpeakers: 100 });
    expect(again!.turns).toEqual(found!.turns);

    // Another audio track in the same place: every part is detected again.
    await fsp.truncate(audio, 44 + 25 * 60 * 32_000 + 2);
    calls.length = 0;
    await provider().diarize(audio, { checkpointDir: parts });
    expect(calls.filter((c) => c.url.endsWith('/diarize-chunk'))).toHaveLength(3);
  });

  it('stops where an advert tail begins, reusing the parts a longer run saved (2026-11-27)', async () => {
    const calls = fakeEngine();
    const audio = await wav('long.wav', 25);
    const parts = path.join(tmp, 'parts');
    await provider().diarize(audio, { checkpointDir: parts });
    expect(calls.filter((c) => c.url.endsWith('/diarize-chunk'))).toHaveLength(3);
    // The dub ends at 12:00: only the parts up to there, the first one saved already.
    calls.length = 0;
    const progress: [number, number][] = [];
    await provider().diarize(audio, { checkpointDir: parts, untilMs: 12 * 60_000, onProgress: (d, t) => progress.push([d, t]) });
    expect(calls.filter((c) => c.url.endsWith('/diarize-chunk')).map((c) => [c.body.startMs, c.body.endMs])).toEqual([[600_000, 720_000]]);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('stops between parts when paused, and resumes at the first part not saved', async () => {
    const calls = fakeEngine();
    const audio = await wav('long.wav', 30);
    const parts = path.join(tmp, 'parts');
    const pause = new AbortController();
    const run = provider().diarize(audio, {
      checkpointDir: parts,
      onProgress: (done) => {
        if (done === 1) pause.abort();
      },
    }, pause.signal);
    await expect(run).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
    expect(calls.map((c) => c.body.startMs)).toEqual([0]);
    expect(await fsp.readdir(parts)).toEqual(['chunk_0000.json']);

    calls.length = 0;
    const found = await provider().diarize(audio, { checkpointDir: parts });
    expect(calls.filter((c) => c.url.endsWith('/diarize-chunk')).map((c) => c.body.startMs)).toEqual([600_000, 1_200_000]);
    expect(found!.turns).toHaveLength(6);
  });

  it('tries a failed part once more, but not one that ran out of time', async () => {
    let calls = fakeEngine({ failParts: new Map([[1, 1]]) });
    const audio = await wav('long.wav', 20);
    await provider().diarize(audio, {});
    expect(calls.filter((c) => c.url.endsWith('/diarize-chunk')).map((c) => c.body.startMs)).toEqual([0, 600_000, 600_000]);

    fakeEngine({ failParts: new Map([[1, 2]]) });
    await expect(provider().diarize(audio, {})).rejects.toMatchObject({ appError: { code: 'UNKNOWN' } });

    calls = fakeEngine({ timeoutPart: 0 });
    await expect(provider().diarize(audio, {})).rejects.toMatchObject({ appError: { code: 'WORKER_TIMEOUT' } });
    expect(calls).toHaveLength(1);
  });

  it('measures the voice of a short recording', async () => {
    const calls = fakeEngine();
    const clip = await wav('preview.wav', 0);
    expect(await provider().embed(clip)).toEqual({ print: [0.6, 0.8], f0Hz: 194, lowShare: 0.1, speechSec: 6.5 });
    await provider().embed(clip, { startMs: 1000, endMs: 4000 });
    expect(calls.map((c) => c.body)).toEqual([{ audioPath: clip }, { audioPath: clip, startMs: 1000, endMs: 4000 }]);
  });

  /** An engine with `pool` model pairs whose parts take a little while, counting how many run at once. */
  function pooledEngine(pool: number, opts: { failPart?: number } = {}) {
    const seen = { calls: [] as Call[], inflight: 0, peak: 0 };
    setWorkerTransport(async (_method, url, payload) => {
      const body = JSON.parse(payload ?? '{}') as Record<string, unknown>;
      seen.calls.push({ url, body });
      if (url.endsWith('/health')) return json({ ok: true, pool });
      if (url.endsWith('/diarize-chunk')) {
        const startMs = body.startMs as number;
        if (Math.round(startMs / 600_000) === opts.failPart) return json({ detail: 'Internal Server Error' }, 500);
        seen.inflight += 1;
        seen.peak = Math.max(seen.peak, seen.inflight);
        await new Promise((r) => setTimeout(r, 15));
        seen.inflight -= 1;
        return json({
          turns: [{ startMs: startMs + 1000, endMs: startMs + 5000, speaker: 0 }],
          speakers: [{ local: 0, sec: 4, printSec: 4, print: [1, 0], f0Hz: 120, lowShare: 0.9 }],
          processMs: 1,
        });
      }
      if (url.endsWith('/link')) {
        const items = body.items as { chunk: number; local: number }[];
        return json({
          assignments: items.map((it) => ({ chunk: it.chunk, local: it.local, speaker: 0 })),
          speakers: [{ speaker: 0, sec: 24, f0Hz: 120, gender: 'male', genderConfidence: 0.9, print: [1, 0] }],
        });
      }
      return json({ detail: 'Not Found' }, 404);
    });
    return seen;
  }

  it('runs parts side by side up to the engine\'s pool while the machine is idle, one at a time otherwise', async () => {
    const seen = pooledEngine(3);
    const audio = await wav('long.wav', 60);
    const p = provider();
    let budget = Number.POSITIVE_INFINITY;
    p.setParallelism(() => budget);
    const progress: [number, number][] = [];
    const found = await p.diarize(audio, { onProgress: (d, t) => progress.push([d, t]) });
    expect(seen.peak).toBe(3);
    expect(seen.calls.filter((c) => c.url.endsWith('/diarize-chunk'))).toHaveLength(6);
    // The answers keep the plan's order, whatever order the parts ended in.
    expect(found!.turns.map((t) => t.startMs)).toEqual([0, 1, 2, 3, 4, 5].map((i) => i * 600_000 + 1000));
    expect(progress[0]).toEqual([0, 6]);
    expect(progress[progress.length - 1]).toEqual([6, 6]);
    // The engine is asked its pool once, not before every part.
    expect(seen.calls.filter((c) => c.url.endsWith('/health'))).toHaveLength(1);

    // A heavy step runs: one part at a time.
    seen.peak = 0;
    budget = 1;
    await p.diarize(audio, {});
    expect(seen.peak).toBe(1);
    // An engine from before 0.18 says nothing of a pool: one at a time.
    const old = pooledEngine(0);
    const before = provider();
    before.setParallelism(() => Number.POSITIVE_INFINITY);
    await before.diarize(audio, {});
    expect(old.peak).toBe(1);
  });

  it('lets the parts in flight finish and saves them when another fails, so a retry resumes', async () => {
    pooledEngine(2, { failPart: 1 });
    const audio = await wav('long.wav', 40);
    const parts = path.join(tmp, 'parts');
    const p = provider();
    p.setParallelism(() => Number.POSITIVE_INFINITY);
    await expect(p.diarize(audio, { checkpointDir: parts })).rejects.toMatchObject({ appError: { code: 'UNKNOWN' } });
    // Part 0 ran beside the failing part 1 and was kept; no part started after the failure.
    expect(await fsp.readdir(parts)).toEqual(['chunk_0000.json']);

    const seen = pooledEngine(2);
    const found = await p.diarize(audio, { checkpointDir: parts });
    expect(seen.calls.filter((c) => c.url.endsWith('/diarize-chunk')).map((c) => c.body.startMs)).toEqual([600_000, 1_200_000, 1_800_000]);
    expect(found!.turns).toHaveLength(4);
  });

  it('detects only the windows of a range, saved, and not linked', async () => {
    const seen = pooledEngine(2);
    const audio = await wav('long.wav', 60);
    const parts = path.join(tmp, 'parts');
    const windows = [
      { index: 2, startMs: 1_200_000, endMs: 1_800_000 },
      { index: 3, startMs: 1_800_000, endMs: 2_400_000 },
    ];
    const found = await provider().diarizeWindows(audio, windows, { checkpointDir: parts });
    expect(seen.calls.map((c) => c.url)).toEqual(['http://engine/diarize-chunk', 'http://engine/diarize-chunk']);
    expect(found!.map((f) => [f.window.index, f.turns[0]!.startMs, f.speakers[0]!.local])).toEqual([
      [2, 1_201_000, 0],
      [3, 1_801_000, 0],
    ]);
    expect((await fsp.readdir(parts)).sort()).toEqual(['chunk_0002.json', 'chunk_0003.json']);
    installed = false;
    expect(await provider().diarizeWindows(audio, windows, {})).toBeNull();
  });

  it('does nothing without the engine', async () => {
    const calls = fakeEngine();
    installed = false;
    const audio = await wav('a.wav', 1);
    expect(await provider().available()).toBe(false);
    expect(await provider().diarize(audio, {})).toBeNull();
    expect(await provider().embed(audio)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

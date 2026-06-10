import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemProfile } from '@videodubber/shared';
import { EnginePackStore } from './enginePackStore.js';
import { availablePacks, findPack, packRunsOn } from './enginePackCatalog.js';
import { packsForProvider, pickInstalledPack, requireInstalledPack } from './packSelection.js';
import { packFitsMachine, recommendEnginePacks } from './engineRecommendation.js';
import { EngineManager, findFile, waitFor } from './engineManager.js';
import { recommendSetup } from '../system/systemProfile.js';

function profile(o: Partial<SystemProfile> = {}): SystemProfile {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M-test',
    cpuCores: 10,
    totalRamMb: 32 * 1024,
    freeRamMb: 16 * 1024,
    gpus: [{ name: 'Apple M-test' }],
    appleSilicon: true,
    ...o,
  };
}

describe('engine pack catalog', () => {
  it('filters packs by platform/arch', () => {
    const macArm = availablePacks('darwin', 'arm64').map((p) => p.id);
    expect(macArm).toContain('whisper-cpp-metal');
    expect(macArm).not.toContain('whisper-cpp-cuda'); // win/linux x64 only

    const winx64 = availablePacks('win32', 'x64').map((p) => p.id);
    expect(winx64).toContain('whisper-cpp-cuda');
    expect(winx64).not.toContain('whisper-cpp-metal');
  });

  it('cross-platform packs (uv-env) run everywhere', () => {
    expect(packRunsOn(findPack('tts-neural')!, 'win32', 'x64')).toBe(true);
    expect(packRunsOn(findPack('tts-neural')!, 'darwin', 'arm64')).toBe(true);
  });
});

describe('pack selection (best accel, installed-aware)', () => {
  let dir: string;
  let store: EnginePackStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-eng-'));
    store = new EnginePackStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('orders candidate packs by acceleration', () => {
    const ids = packsForProvider('whisper-cpp', 'win32', 'x64').map((p) => p.id);
    // cuda (rank 5) before vulkan (rank 3)
    expect(ids.indexOf('whisper-cpp-cuda')).toBeLessThan(ids.indexOf('whisper-cpp-vulkan'));
  });

  it('pickInstalledPack returns undefined until a pack is installed, then the best one', async () => {
    expect(await pickInstalledPack(store, 'whisper-cpp', 'win32', 'x64')).toBeUndefined();
    const dirPath = store.packDir('whisper-cpp-vulkan');
    await mkdir(dirPath, { recursive: true });
    await store.add({ id: 'whisper-cpp-vulkan', path: dirPath, installedAt: '2026-01-01T00:00:00Z' });
    expect(await pickInstalledPack(store, 'whisper-cpp', 'win32', 'x64')).toBe('whisper-cpp-vulkan');
  });

  it('requireInstalledPack throws ENGINE_PACK_MISSING when none installed', async () => {
    await expect(requireInstalledPack(store, 'local-llm')).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_MISSING' },
    });
  });
});

describe('engine pack store', () => {
  let dir: string;
  let store: EnginePackStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vd-eng2-'));
    store = new EnginePackStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('only lists packs whose directory still exists', async () => {
    const p = store.packDir('tts-neural');
    await mkdir(p, { recursive: true });
    await store.add({ id: 'tts-neural', path: p, installedAt: '2026-01-01T00:00:00Z' });
    expect((await store.list()).map((r) => r.id)).toEqual(['tts-neural']);

    await rm(p, { recursive: true, force: true });
    expect(await store.list()).toEqual([]); // dir gone -> dropped
  });

  it('remove deletes the record and the directory', async () => {
    const p = store.packDir('tts-neural');
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'x.txt'), 'hi');
    await store.add({ id: 'tts-neural', path: p, installedAt: '2026-01-01T00:00:00Z' });
    await store.remove('tts-neural');
    expect(await store.isInstalled('tts-neural')).toBe(false);
  });
});

describe('hardware-aware engine recommendations', () => {
  it('respects RAM/VRAM gates', () => {
    const small = profile({ totalRamMb: 8 * 1024, appleSilicon: true });
    expect(packFitsMachine(findPack('llama-cpp-metal')!, small)).toBe(false); // needs 16 GB
    const big = profile({ totalRamMb: 32 * 1024, appleSilicon: true });
    expect(packFitsMachine(findPack('llama-cpp-metal')!, big)).toBe(true);
  });

  it('recommends Metal whisper + local LLM + neural TTS on a 32 GB Mac', () => {
    const p = profile({ totalRamMb: 32 * 1024 });
    const recs = recommendEnginePacks(p, recommendSetup(p), 'darwin', 'arm64').map((r) => r.packId);
    expect(recs).toContain('whisper-cpp-metal');
    expect(recs).toContain('llama-cpp-metal');
    expect(recs).toContain('tts-neural');
    // 32 GB is workstation-class: separation + alignment too.
    expect(recs).toContain('separation-audio');
  });

  it('recommends little on a constrained machine', () => {
    const p = profile({ totalRamMb: 4 * 1024, appleSilicon: false, gpus: [] });
    const recs = recommendEnginePacks(p, recommendSetup(p), 'linux', 'x64');
    expect(recs.find((r) => r.packId === 'local-llm-cuda')).toBeUndefined();
  });
});

describe('EngineManager lifecycle policy', () => {
  it('findFile locates a binary by basename in a nested pack dir', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vd-bin-'));
    const nested = path.join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'whisper-server'), '#!/bin/sh\n');
    expect(await findFile(root, 'whisper-server')).toBe(path.join(nested, 'whisper-server'));
    expect(await findFile(root, 'nope')).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it('ensureRunning starts an engine, exclusive unloads other heavy engines', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-mgr-'));
    const store = new EnginePackStore(dir);
    // Install fake whisper + llama packs with a resolvable binary.
    for (const [id, bin] of [
      ['whisper-cpp-metal', 'whisper-server'],
      ['llama-cpp-metal', 'llama-server'],
    ] as const) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, bin), '#!/bin/sh\n');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }

    const started: string[] = [];
    const killed: string[] = [];
    const manager = new EngineManager({
      store,
      allocatePort: async () => 50000 + started.length,
      healthProbe: async () => true,
      spawnImpl: (cmd) => {
        started.push(cmd);
        // Minimal ChildProcess-like stub.
        return {
          on: () => undefined,
          kill: () => {
            killed.push(cmd);
            return true;
          },
        } as never;
      },
      startTimeoutMs: 1000,
    });

    const whisperUrl = await manager.ensureRunning('whisper-cpp-metal', { exclusive: true });
    expect(whisperUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(manager.isRunning('whisper-cpp-metal')).toBe(true);

    // Starting llama exclusively should stop the heavy whisper engine.
    await manager.ensureRunning('llama-cpp-metal', { exclusive: true });
    expect(manager.isRunning('whisper-cpp-metal')).toBe(false);
    expect(manager.isRunning('llama-cpp-metal')).toBe(true);

    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('waitFor', () => {
  it('resolves true as soon as the predicate passes', async () => {
    let n = 0;
    const ok = await waitFor(async () => ++n >= 2, 2000, 5);
    expect(ok).toBe(true);
  });
  it('resolves false after the deadline', async () => {
    const ok = await waitFor(async () => false, 30, 5);
    expect(ok).toBe(false);
  });
});

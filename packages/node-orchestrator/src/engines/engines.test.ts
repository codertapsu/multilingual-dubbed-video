import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnginePackInfo, SystemProfile } from '@videodubber/shared';
import { EnginePackStore } from './enginePackStore.js';
import { availablePacks, findPack, packRunsOn } from './enginePackCatalog.js';
import {
  packsForProvider,
  pickInstalledLocalLlmModel,
  pickInstalledPack,
  requireInstalledPack,
  resolveLocalLlmModelPath,
} from './packSelection.js';
import { packFitsMachine, recommendEnginePacks } from './engineRecommendation.js';
import { EngineManager, findFile, waitFor } from './engineManager.js';
import { _resetUvCache, resolveUvPath, uvAvailable } from './uv.js';
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
    expect(macArm).toContain('llama-cpp-metal'); // Apple Silicon translation
    expect(macArm).not.toContain('whisper-cpp-cuda'); // win/linux x64 only

    const winx64 = availablePacks('win32', 'x64').map((p) => p.id);
    expect(winx64).toContain('whisper-cpp-cuda');
    expect(winx64).not.toContain('llama-cpp-metal');
  });

  it('cross-platform packs (uv-env) run everywhere', () => {
    // VieNeu v3-Turbo is torch-free ONNX, so it runs on every platform/arch,
    // Intel macOS included.
    expect(packRunsOn(findPack('tts-neural')!, 'win32', 'x64')).toBe(true);
    expect(packRunsOn(findPack('tts-neural')!, 'linux', 'x64')).toBe(true);
    expect(packRunsOn(findPack('tts-neural')!, 'darwin', 'arm64')).toBe(true);
    expect(packRunsOn(findPack('tts-neural')!, 'darwin', 'x64')).toBe(true);
    expect(availablePacks('darwin', 'x64').map((p) => p.id)).toContain('tts-neural');
  });

  it('excludePlatformArch excludes a specific platform+arch combo', () => {
    const pack = { excludePlatformArch: [{ platform: 'darwin', arch: 'x64' }] } as EnginePackInfo;
    expect(packRunsOn(pack, 'darwin', 'x64')).toBe(false);
    expect(packRunsOn(pack, 'darwin', 'arm64')).toBe(true);
    expect(packRunsOn(pack, 'linux', 'x64')).toBe(true);
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
    // local-llm on Windows has both a CUDA and a Vulkan pack.
    const ids = packsForProvider('local-llm', 'win32', 'x64').map((p) => p.id);
    // cuda (rank 5) before vulkan (rank 3)
    expect(ids.indexOf('llama-cpp-cuda')).toBeLessThan(ids.indexOf('llama-cpp-vulkan'));
  });

  it('pickInstalledPack returns undefined until a pack is installed, then the best one', async () => {
    expect(await pickInstalledPack(store, 'local-llm', 'win32', 'x64')).toBeUndefined();
    // Install only the Vulkan pack; CUDA (higher rank) is not installed, so the
    // best INSTALLED pack is the Vulkan one.
    const dirPath = store.packDir('llama-cpp-vulkan');
    await mkdir(dirPath, { recursive: true });
    await store.add({ id: 'llama-cpp-vulkan', path: dirPath, installedAt: '2026-01-01T00:00:00Z' });
    expect(await pickInstalledPack(store, 'local-llm', 'win32', 'x64')).toBe('llama-cpp-vulkan');
  });

  it('requireInstalledPack throws ENGINE_PACK_MISSING when none installed', async () => {
    await expect(requireInstalledPack(store, 'local-llm')).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_MISSING' },
    });
  });
});

describe('TranslateGemma model packs', () => {
  it('exposes the three model packs on every platform', () => {
    for (const plat of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']] as const) {
      const ids = availablePacks(plat[0], plat[1]).map((p) => p.id);
      expect(ids).toContain('translategemma-4b');
      expect(ids).toContain('translategemma-12b');
      expect(ids).toContain('translategemma-27b');
    }
  });

  it('model packs are flagged commercial-restricted (Gemma terms) with a pinned, verified GGUF', () => {
    const p = findPack('translategemma-4b')!;
    expect(p.packKind).toBe('model');
    expect(p.providerId).toBe('local-llm-model');
    expect(p.licenseCategory).toBe('commercial-restricted');
    expect(p.licenseNote).toMatch(/Gemma Terms of Use/);
    expect(p.artifacts[0]!.url).toMatch(/\.gguf$/);
    expect(p.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifacts[0]!.destPath).toBe('model.gguf');
  });

  it('resolves the best installed model GGUF, preferring the largest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-tgm-'));
    const store = new EnginePackStore(dir);

    // Nothing installed → resolve throws ENGINE_PACK_MISSING.
    await expect(resolveLocalLlmModelPath(store)).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_MISSING' },
    });

    // Install 4B (with its gguf) → resolves to it.
    const p4 = store.packDir('translategemma-4b');
    await mkdir(p4, { recursive: true });
    await writeFile(path.join(p4, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-4b', path: p4, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmModel(store))?.packId).toBe('translategemma-4b');

    // Also install 12B → the larger one wins.
    const p12 = store.packDir('translategemma-12b');
    await mkdir(p12, { recursive: true });
    await writeFile(path.join(p12, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-12b', path: p12, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmModel(store))?.packId).toBe('translategemma-12b');

    // A recorded pack whose gguf never downloaded is skipped (not green-lit).
    const p27 = store.packDir('translategemma-27b');
    await mkdir(p27, { recursive: true });
    await store.add({ id: 'translategemma-27b', path: p27, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmModel(store))?.packId).toBe('translategemma-12b'); // 27b skipped (no gguf)

    await rm(dir, { recursive: true, force: true });
  });

  it('threads the resolved GGUF into llama-server as `-m` (with -ngl)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-tgm-run-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('llama-cpp-metal');
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server'), '#!/bin/sh\n');
    await store.add({ id: 'llama-cpp-metal', path: p, installedAt: '2026-01-01T00:00:00Z' });

    let capturedArgs: string[] = [];
    const manager = new EngineManager({
      store,
      allocatePort: async () => 52345,
      healthProbe: async () => true,
      spawnImpl: (_cmd, args) => {
        capturedArgs = args;
        return { on: () => undefined, stderr: { on: () => undefined }, kill: () => true } as never;
      },
      startTimeoutMs: 1000,
    });

    await manager.ensureRunning('llama-cpp-metal', { exclusive: true, model: '/models/tg.gguf' });
    expect(capturedArgs).toContain('-m');
    expect(capturedArgs[capturedArgs.indexOf('-m') + 1]).toBe('/models/tg.gguf');
    expect(capturedArgs).toContain('-ngl');
    // TranslateGemma's Jinja chat template aborts llama-server at load, so we
    // must disable Jinja (we drive /completion ourselves).
    expect(capturedArgs).toContain('--no-jinja');
    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
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
    // The RAM gate now lives on the MODEL pack, not the runtime binary: the 4B
    // model fits 8 GB, the 12B does not, and the tiny runtime binary always fits.
    expect(packFitsMachine(findPack('translategemma-4b')!, small)).toBe(true);
    expect(packFitsMachine(findPack('translategemma-12b')!, small)).toBe(false); // needs 16 GB
    expect(packFitsMachine(findPack('llama-cpp-metal')!, small)).toBe(true); // runtime no longer gated
    const big = profile({ totalRamMb: 32 * 1024, appleSilicon: true });
    expect(packFitsMachine(findPack('translategemma-12b')!, big)).toBe(true);
    expect(packFitsMachine(findPack('translategemma-27b')!, big)).toBe(true); // 27B needs 32 GB
  });

  it('recommends local LLM (runtime + tier-sized model) + neural TTS on a 32 GB Mac', () => {
    const p = profile({ totalRamMb: 32 * 1024 });
    const recs = recommendEnginePacks(p, recommendSetup(p), 'darwin', 'arm64').map((r) => r.packId);
    expect(recs).toContain('llama-cpp-metal');
    // 32 GB Apple Silicon is accelerated + workstation-class → the 27B model.
    expect(recs).toContain('translategemma-27b');
    expect(recs).toContain('tts-neural');
    // 32 GB is workstation-class: separation + alignment too.
    expect(recs).toContain('separation-audio');
  });

  it('recommends the 4B TranslateGemma on an 8 GB CPU-only machine (no 16 GB gate)', () => {
    const p = profile({ totalRamMb: 8 * 1024, appleSilicon: false, gpus: [] });
    const recs = recommendEnginePacks(p, recommendSetup(p), 'linux', 'x64').map((r) => r.packId);
    // The runtime + the CPU-friendly 4B are recommended even without a GPU.
    expect(recs).toContain('llama-cpp-linux');
    expect(recs).toContain('translategemma-4b');
    // Not the 12B/27B (need more RAM and an accelerator).
    expect(recs).not.toContain('translategemma-12b');
    expect(recs).not.toContain('translategemma-27b');
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

  it('launches a uv-env pack as `python -m <module>` with the server flags', async () => {
    // Regression: the launch spec carries `pythonModule`, but the argv must be
    // `python -m vd_tts_engine --port <n>`. A prior version spawned the venv
    // python with only `['--port', n]`, so Python rejected `--port` as an unknown
    // option and exited instantly -> "engine did not become healthy in time".
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-mgr-py-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('tts-neural');
    const pyRel =
      process.platform === 'win32'
        ? path.join('venv', 'Scripts', 'python.exe')
        : path.join('venv', 'bin', 'python');
    const pyAbs = path.join(p, pyRel);
    await mkdir(path.dirname(pyAbs), { recursive: true });
    await writeFile(pyAbs, '');
    await store.add({ id: 'tts-neural', path: p, installedAt: '2026-01-01T00:00:00Z' });

    let capturedArgs: string[] = [];
    const manager = new EngineManager({
      store,
      allocatePort: async () => 51234,
      healthProbe: async () => true,
      spawnImpl: (_cmd, args) => {
        capturedArgs = args;
        return { on: () => undefined, stderr: { on: () => undefined }, kill: () => true } as never;
      },
      startTimeoutMs: 1000,
    });

    await manager.ensureRunning('tts-neural');
    expect(capturedArgs).toEqual(['-m', 'vd_tts_engine', '--port', '51234']);

    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('surfaces the worker stderr when an engine never becomes healthy', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-mgr-crash-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('tts-neural');
    const pyRel =
      process.platform === 'win32'
        ? path.join('venv', 'Scripts', 'python.exe')
        : path.join('venv', 'bin', 'python');
    const pyAbs = path.join(p, pyRel);
    await mkdir(path.dirname(pyAbs), { recursive: true });
    await writeFile(pyAbs, '');
    await store.add({ id: 'tts-neural', path: p, installedAt: '2026-01-01T00:00:00Z' });

    const manager = new EngineManager({
      store,
      allocatePort: async () => 51235,
      healthProbe: async () => false, // never healthy
      spawnImpl: () =>
        ({
          on: () => undefined,
          // Emit a crash trace synchronously; it must reach the timeout error.
          stderr: { on: (_e: string, cb: (d: Buffer) => void) => cb(Buffer.from('ModuleNotFoundError: No module named "fastapi"\n')) },
          kill: () => true,
        }) as never,
      startTimeoutMs: 50,
    });

    await expect(manager.ensureRunning('tts-neural')).rejects.toThrow(/ModuleNotFoundError/);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('uv resolution (bundled vs PATH)', () => {
  afterEach(() => {
    delete process.env.VIDEODUBBER_UV_PATH;
    _resetUvCache();
  });

  it('prefers the bundled uv path when the file exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-uv-'));
    const uv = path.join(dir, 'vd-uv');
    await writeFile(uv, '#!/bin/sh\n');
    process.env.VIDEODUBBER_UV_PATH = uv;
    _resetUvCache();
    expect(await resolveUvPath()).toBe(uv);
    expect(await uvAvailable()).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a bundled path that does not exist and falls through', async () => {
    process.env.VIDEODUBBER_UV_PATH = '/no/such/vd-uv';
    _resetUvCache();
    // Result depends on whether uv is on PATH in this env; just assert it does
    // not return the bogus bundled path.
    expect(await resolveUvPath()).not.toBe('/no/such/vd-uv');
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

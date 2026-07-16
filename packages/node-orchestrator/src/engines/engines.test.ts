import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnginePackInfo, SystemProfile } from '@videodubber/shared';
import { EnginePackStore } from './enginePackStore.js';
import { ENGINE_PACKS, availablePacks, findPack, packRunsOn } from './enginePackCatalog.js';
import {
  packsForProvider,
  pickInstalledLocalLlmChatModel,
  pickInstalledLocalLlmModel,
  pickInstalledPack,
  requireInstalledPack,
  resolveLocalLlmChatModelPath,
  resolveLocalLlmModelPath,
} from './packSelection.js';
import { packFitsMachine, packHardwareSupported, recommendEnginePacks } from './engineRecommendation.js';
import { ENGINE_LAUNCH_SPECS, EngineManager, findFile, waitFor } from './engineManager.js';
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

  it('every launchable pack resolves to a launch spec (guards providerOf drift)', () => {
    // Regression for "No launch spec for engine pack <id>": every SERVER pack's
    // provider must have an ENGINE_LAUNCH_SPECS entry (model packs are consumed by
    // a runtime, not launched, so they're exempt). EngineManager.providerOf() maps
    // a pack id to its providerId, so a mismatch here = a launch failure at run.
    for (const p of ENGINE_PACKS) {
      if (p.packKind === 'model') continue;
      expect(ENGINE_LAUNCH_SPECS[p.providerId], `${p.id} -> ${p.providerId}`).toBeDefined();
    }
  });

  it('OmniVoice TTS pack is Apple-Silicon-only (metal) with the omnivoice provider', () => {
    const p = findPack('tts-omnivoice')!;
    expect(p.providerId).toBe('omnivoice');
    expect(p.platforms).toEqual(['darwin']);
    expect(p.arch).toEqual(['arm64']);
    expect(p.accel).toBe('metal');
    // Gated out of releases while output quality stabilizes (DISABLED_PACK_IDS;
    // see docs/OMNIVOICE.md) — not offered ANYWHERE, including Apple Silicon.
    expect(availablePacks('darwin', 'arm64').map((x) => x.id)).not.toContain('tts-omnivoice');
    expect(availablePacks('win32', 'x64').map((x) => x.id)).not.toContain('tts-omnivoice');
    expect(availablePacks('darwin', 'x64').map((x) => x.id)).not.toContain('tts-omnivoice');
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

describe('Gemma 3 instruct chat-model packs (context-aware translation)', () => {
  it('exposes both chat packs on every platform, pinned + license-flagged', () => {
    for (const plat of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']] as const) {
      const ids = availablePacks(plat[0], plat[1]).map((p) => p.id);
      expect(ids).toContain('chat-gemma3-4b');
      expect(ids).toContain('chat-gemma3-12b');
    }
    const p = findPack('chat-gemma3-4b')!;
    expect(p.packKind).toBe('model');
    expect(p.providerId).toBe('local-llm-chat-model');
    expect(p.licenseCategory).toBe('commercial-restricted');
    expect(p.version).toBeTruthy();
    expect(p.artifacts[0]!.url).toMatch(/\.gguf$/);
    expect(p.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifacts[0]!.destPath).toBe('model.gguf');
  });

  it('resolves the best installed chat GGUF, preferring the largest; never a TranslateGemma', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-g3-'));
    const store = new EnginePackStore(dir);

    await expect(resolveLocalLlmChatModelPath(store)).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_MISSING' },
    });

    // An installed TranslateGemma must NOT satisfy the chat-model requirement
    // (it cannot follow instructions, so the context tiers would silently break).
    const tg = store.packDir('translategemma-4b');
    await mkdir(tg, { recursive: true });
    await writeFile(path.join(tg, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-4b', path: tg, installedAt: '2026-01-01T00:00:00Z' });
    expect(await pickInstalledLocalLlmChatModel(store)).toBeUndefined();

    const p4 = store.packDir('chat-gemma3-4b');
    await mkdir(p4, { recursive: true });
    await writeFile(path.join(p4, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma3-4b', path: p4, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store))?.packId).toBe('chat-gemma3-4b');

    const p12 = store.packDir('chat-gemma3-12b');
    await mkdir(p12, { recursive: true });
    await writeFile(path.join(p12, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma3-12b', path: p12, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store))?.packId).toBe('chat-gemma3-12b');

    await rm(dir, { recursive: true, force: true });
  });

  it('ensureRunning restarts the shared runtime when a different GGUF is requested', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-swap-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('llama-cpp-metal');
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server'), '#!/bin/sh\n');
    await store.add({ id: 'llama-cpp-metal', path: p, installedAt: '2026-01-01T00:00:00Z' });

    const spawns: string[][] = [];
    let killed = 0;
    let port = 52000;
    const manager = new EngineManager({
      store,
      allocatePort: async () => port++,
      healthProbe: async () => true,
      spawnImpl: (_cmd, args) => {
        spawns.push(args);
        return {
          on: () => undefined,
          stderr: { on: () => undefined },
          kill: () => {
            killed++;
            return true;
          },
        } as never;
      },
      startTimeoutMs: 1000,
    });

    const url1 = await manager.ensureRunning('llama-cpp-metal', { model: '/models/translategemma.gguf' });
    // Same model -> reuse (no new spawn, same URL).
    const url1b = await manager.ensureRunning('llama-cpp-metal', { model: '/models/translategemma.gguf' });
    expect(url1b).toBe(url1);
    expect(spawns).toHaveLength(1);

    // Different model (the chat provider) -> restart with the new GGUF.
    const url2 = await manager.ensureRunning('llama-cpp-metal', { model: '/models/gemma3-it.gguf' });
    expect(killed).toBe(1);
    expect(spawns).toHaveLength(2);
    expect(url2).not.toBe(url1);
    const last = spawns[1]!;
    expect(last[last.indexOf('-m') + 1]).toBe('/models/gemma3-it.gguf');

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

  it('packHardwareSupported gates on the accelerator, not just RAM/VRAM', () => {
    const cuda = findPack('whisper-cpp-cuda')!;
    // Windows box WITH an NVIDIA GPU and enough VRAM → runnable.
    const withNvidia = profile({
      platform: 'win32', arch: 'x64', appleSilicon: false,
      totalRamMb: 32 * 1024, gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramMb: 12 * 1024 }],
    });
    expect(packHardwareSupported(cuda, withNvidia)).toBe(true);
    // Windows laptop with integrated/AMD graphics (no NVIDIA) → HIDDEN, even
    // though packFitsMachine alone might pass. This is the requirement-2 fix.
    const noNvidia = profile({
      platform: 'win32', arch: 'x64', appleSilicon: false,
      totalRamMb: 32 * 1024, gpus: [{ name: 'AMD Radeon 780M', vramMb: 8 * 1024 }],
    });
    expect(packHardwareSupported(cuda, noNvidia)).toBe(false);
    // No GPU at all → also hidden.
    expect(packHardwareSupported(cuda, profile({ platform: 'win32', arch: 'x64', appleSilicon: false, gpus: [] }))).toBe(false);
  });

  it('packHardwareSupported gates on the accelerator ONLY; RAM stays a soft (packFitsMachine) hint', () => {
    const metal = findPack('llama-cpp-metal')!;
    expect(packHardwareSupported(metal, profile({ appleSilicon: true }))).toBe(true);
    expect(packHardwareSupported(metal, profile({ appleSilicon: false, gpus: [{ name: 'Intel Iris' }] }))).toBe(false);
    // Vulkan build deliberately not GPU-gated (AMD/Intel GPUs report as gpus:[]).
    const vulkan = findPack('llama-cpp-vulkan')!;
    expect(packHardwareSupported(vulkan, profile({ platform: 'win32', arch: 'x64', appleSilicon: false, gpus: [] }))).toBe(true);
    // A cpu MODEL pack (27B) is NOT hidden by RAM — it stays offered so the user can
    // choose; RAM adequacy is a soft badge via packFitsMachine, not a hard gate.
    const g27 = findPack('translategemma-27b')!;
    expect(packHardwareSupported(g27, profile({ totalRamMb: 16 * 1024 }))).toBe(true);
    expect(packFitsMachine(g27, profile({ totalRamMb: 16 * 1024 }))).toBe(false); // "⚠ needs 32 GB"
    expect(packFitsMachine(g27, profile({ totalRamMb: 32 * 1024 }))).toBe(true);
  });

  it('gates tts-neural-v2 out of the catalog (unvalidated / non-commercial); keeps v3', () => {
    expect(availablePacks('win32', 'x64').map((p) => p.id)).not.toContain('tts-neural-v2');
    expect(availablePacks('darwin', 'arm64').map((p) => p.id)).not.toContain('tts-neural-v2');
    expect(availablePacks('win32', 'x64').map((p) => p.id)).toContain('tts-neural');
  });

  it('installable packs declare a version (so an update can be detected)', () => {
    for (const id of [
      'whisper-cpp-cuda', 'llama-cpp-metal', 'llama-cpp-cuda', 'llama-cpp-vulkan',
      'translategemma-4b', 'translategemma-12b', 'translategemma-27b',
      'tts-neural', 'translation-libretranslate',
    ]) {
      expect(findPack(id)?.version, id).toBeTruthy();
    }
  });

  it('recommends local LLM (runtime + tier-sized model) + neural TTS on a 32 GB Mac', () => {
    const p = profile({ totalRamMb: 32 * 1024 });
    const recs = recommendEnginePacks(p, recommendSetup(p), 'darwin', 'arm64').map((r) => r.packId);
    expect(recs).toContain('llama-cpp-metal');
    // 32 GB Apple Silicon is accelerated + workstation-class → the 27B model.
    expect(recs).toContain('translategemma-27b');
    expect(recs).toContain('tts-neural');
    // separation-audio + alignment-whisperx are unimplemented stubs (gated in
    // DISABLED_PACK_IDS), so they are NEVER recommended — even on a 32 GB Mac.
    expect(recs).not.toContain('separation-audio');
    expect(recs).not.toContain('alignment-whisperx');
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

  it('launches the OmniVoice pack as `python -m vd_omnivoice` (regression: providerOf -> launch spec)', async () => {
    // Regression for "No launch spec for engine pack tts-omnivoice": providerOf()
    // must resolve the pack id to its providerId ('omnivoice'); it previously fell
    // through to the pack id (no spec). Mirrors the VieNeu launch test above.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-mgr-ov-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('tts-omnivoice');
    const pyRel =
      process.platform === 'win32'
        ? path.join('venv', 'Scripts', 'python.exe')
        : path.join('venv', 'bin', 'python');
    const pyAbs = path.join(p, pyRel);
    await mkdir(path.dirname(pyAbs), { recursive: true });
    await writeFile(pyAbs, '');
    await store.add({ id: 'tts-omnivoice', path: p, installedAt: '2026-01-01T00:00:00Z' });

    let capturedArgs: string[] = [];
    const manager = new EngineManager({
      store,
      allocatePort: async () => 51299,
      healthProbe: async () => true,
      spawnImpl: (_cmd, args) => {
        capturedArgs = args;
        return { on: () => undefined, stderr: { on: () => undefined }, kill: () => true } as never;
      },
      startTimeoutMs: 1000,
    });

    await expect(manager.ensureRunning('tts-omnivoice')).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capturedArgs).toEqual(['-m', 'vd_omnivoice', '--port', '51299']);

    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a pack id absent from the catalog with ENGINE_UNAVAILABLE (providerOf fallback)', async () => {
    // providerOf() maps a pack id to its provider via `findPack(packId)?.providerId
    // ?? packId`; a pack NOT in ENGINE_PACKS yields the raw id, which has no launch
    // spec -> ENGINE_UNAVAILABLE "No launch spec". Pins the fallback + the error path.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-ghost-'));
    const store = new EnginePackStore(dir);
    const manager = new EngineManager({ store, startTimeoutMs: 100 });
    await expect(manager.ensureRunning('tts-ghost')).rejects.toMatchObject({
      appError: { code: 'ENGINE_UNAVAILABLE' },
    });
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
    delete process.env.VIDEODUBBER_BUNDLED;
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

  it('in a packaged build, a broken bundled uv fails loud (no system-uv fallback)', async () => {
    process.env.VIDEODUBBER_UV_PATH = '/no/such/vd-uv';
    process.env.VIDEODUBBER_BUNDLED = '1';
    _resetUvCache();
    // The packaged app owns its toolchain — never silently use a system uv.
    expect(await resolveUvPath()).toBeNull();
    expect(await uvAvailable()).toBe(false);
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

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_GPU_RESIDENT_FRACTION,
  gpuResidentFraction,
  gpuWeightBudgetMb,
  type EnginePackInfo,
  type SystemProfile,
} from '@videodubber/shared';
import { EnginePackStore } from './enginePackStore.js';
import { ENGINE_PACKS, availablePacks, findPack, packRunsOn } from './enginePackCatalog.js';
import {
  packsForProvider,
  pickInstalledLocalLlmChatModel,
  pickInstalledLocalLlmModel,
  pickInstalledPack,
  installedPacksForProvider,
  requireInstalledPack,
  resolveActivePackSelections,
  resolveLocalLlmChatModel,
  resolveLocalLlmModelPath,
} from './packSelection.js';
import {
  nvidiaDriverSupportsPack,
  packFitsMachine,
  packHardwareSupported,
  recommendEnginePacks,
} from './engineRecommendation.js';
import { ENGINE_LAUNCH_SPECS, EngineManager, findFile, waitFor } from './engineManager.js';
import { _resetUvCache, resolveUvPath, uvAvailable } from './uv.js';
import { recommendSetup } from '../system/systemProfile.js';

/** A machine big enough that every pack fits — ranking tests must not depend
 * on the developer's RAM (they did, and failed below 24 GB). */
const BIG_MACHINE = (): SystemProfile => profile({ totalRamMb: 64 * 1024, freeRamMb: 32 * 1024 });

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
    expect((await pickInstalledLocalLlmModel(store, BIG_MACHINE()))?.packId).toBe('translategemma-4b');

    // Also install 12B → the larger one wins.
    const p12 = store.packDir('translategemma-12b');
    await mkdir(p12, { recursive: true });
    await writeFile(path.join(p12, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-12b', path: p12, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmModel(store, BIG_MACHINE()))?.packId).toBe('translategemma-12b');

    // A recorded pack whose gguf never downloaded is skipped (not green-lit).
    const p27 = store.packDir('translategemma-27b');
    await mkdir(p27, { recursive: true });
    await store.add({ id: 'translategemma-27b', path: p27, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmModel(store, BIG_MACHINE()))?.packId).toBe('translategemma-12b'); // 27b skipped (no gguf)

    await rm(dir, { recursive: true, force: true });
  });

  it('threads the resolved GGUF into llama-server as `-m`, letting it auto-fit the GPU', async () => {
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
    // GPU offload must be LEFT UNSET so llama.cpp fits it to free VRAM. Forcing
    // `-ngl 999` aborts the fitter and the server dies at load on any card too
    // small for the model (a 4 GB GTX 1650 + a 12B Q4 reported exactly that).
    expect(capturedArgs).not.toContain('-ngl');
    // …and the context must be set EXPLICITLY, because that is what stops the
    // fitter shrinking it: llama.cpp only reduces n_ctx when the user left it at
    // 0. Drop `-c` and the fitter is free to pick any context it likes, silently
    // truncating batches — so this assertion, not a `-fitc` flag (which is inert
    // whenever `-c` is set), is the real guarantee.
    expect(capturedArgs).toContain('-c');
    expect(capturedArgs[capturedArgs.indexOf('-c') + 1]).toBe('8192');
    // The fitter's 1 GiB default margin would demote layers on GPUs that fit the
    // model with less to spare, so it is capped.
    expect(capturedArgs).toContain('-fitt');
    // --no-jinja alone leaves llama-server on a legacy template path that cannot
    // parse Gemma 4's grammar, and it aborts at init. We never use the chat
    // endpoint, so pin any template that parses.
    expect(capturedArgs).toContain('--no-jinja');
    expect(capturedArgs).toContain('--chat-template');
    expect(capturedArgs[capturedArgs.indexOf('--chat-template') + 1]).toBe('chatml');
    // TranslateGemma's Jinja chat template aborts llama-server at load, so we
    // must disable Jinja (we drive /completion ourselves).
    expect(capturedArgs).toContain('--no-jinja');
    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('launches llama-server in diagnose-llama-engine.ps1 with the orchestrator\u2019s exact arguments', async () => {
    // The whole value of that script is that a user's report reflects what the
    // APP does, not what the script's author remembered it doing. It mirrors the
    // argv by hand (PowerShell cannot import a TS module), so this is the seam
    // that stops the two drifting: change the spec without changing the script
    // and the next bug report quietly describes a launch that never happens.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = await readFile(path.join(here, '../../../../scripts/diagnose-llama-engine.ps1'), 'utf8');

    const lines = script.split('\n');
    const marker = lines.findIndex((l) => l.includes('ENGINE_LAUNCH_SPECS-MIRROR'));
    expect(marker, 'mirror marker missing from diagnose-llama-engine.ps1').toBeGreaterThanOrEqual(0);

    // Pull the quoted tokens out of the single `$appArgs = @(...)` line beneath it.
    const mirrored = [...lines[marker + 1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    const PORT = 5199;
    const MODEL = 'C:\\gguf\\model.gguf';
    const substituted = mirrored.map(
      (t) => ({ $Port: String(PORT), $Fitt: '512', $Gguf: MODEL })[t] ?? t,
    );

    expect(substituted).toEqual(
      ENGINE_LAUNCH_SPECS['local-llm'].args({
        exe: 'llama-server.exe',
        port: PORT,
        packDir: 'C:\\packs\\llama-cpp-cuda',
        model: MODEL,
      }),
    );
  });
});

describe('Gemma instruct chat-model packs (context-aware translation)', () => {
  it('exposes the Gemma 3 chat packs on every platform, pinned + license-flagged', () => {
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

  it('exposes the Gemma 4 chat packs everywhere — pinned, and PERMISSIVE (Apache 2.0, unlike Gemma 3)', () => {
    for (const plat of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']] as const) {
      const ids = availablePacks(plat[0], plat[1]).map((p) => p.id);
      expect(ids).toContain('chat-gemma4-12b');
      expect(ids).toContain('chat-gemma4-26b-a4b');
    }
    for (const id of ['chat-gemma4-12b', 'chat-gemma4-26b-a4b']) {
      const p = findPack(id)!;
      expect(p.packKind).toBe('model');
      expect(p.providerId).toBe('local-llm-chat-model');
      // Gemma 4 dropped the Gemma Terms of Use — a plain Apache 2.0 release.
      // 'commercial-restricted' here would wrongly scare users off the newer
      // packs; 'permissive' on a Gemma 3 pack would be a license violation.
      expect(p.licenseCategory).toBe('permissive');
      expect(p.licenseNote).toContain('Apache');
      expect(p.artifacts[0]!.url).toContain('ggml-org/gemma-4');
      expect(p.artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.artifacts[0]!.destPath).toBe('model.gguf');
    }
    // The MoE runs 26B-class weights: keep it gated to workstation-tier RAM.
    expect(findPack('chat-gemma4-26b-a4b')!.minRamMb).toBeGreaterThan(findPack('chat-gemma4-12b')!.minRamMb!);
  });

  it('resolves the best installed chat GGUF, preferring the largest; never a TranslateGemma', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-g3-'));
    const store = new EnginePackStore(dir);

    await expect(resolveLocalLlmChatModel(store)).rejects.toMatchObject({
      appError: { code: 'ENGINE_PACK_MISSING' },
    });

    // An installed TranslateGemma must NOT satisfy the chat-model requirement
    // (it cannot follow instructions, so the context tiers would silently break).
    const tg = store.packDir('translategemma-4b');
    await mkdir(tg, { recursive: true });
    await writeFile(path.join(tg, 'model.gguf'), 'x');
    await store.add({ id: 'translategemma-4b', path: tg, installedAt: '2026-01-01T00:00:00Z' });
    expect(await pickInstalledLocalLlmChatModel(store, BIG_MACHINE())).toBeUndefined();

    const p4 = store.packDir('chat-gemma3-4b');
    await mkdir(p4, { recursive: true });
    await writeFile(path.join(p4, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma3-4b', path: p4, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store, BIG_MACHINE()))?.packId).toBe('chat-gemma3-4b');

    const p12 = store.packDir('chat-gemma3-12b');
    await mkdir(p12, { recursive: true });
    await writeFile(path.join(p12, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma3-12b', path: p12, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store, BIG_MACHINE()))?.packId).toBe('chat-gemma3-12b');

    // Gemma 4 12B outranks Gemma 3 12B (newer generation at the same size)…
    const g4 = store.packDir('chat-gemma4-12b');
    await mkdir(g4, { recursive: true });
    await writeFile(path.join(g4, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma4-12b', path: g4, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store, BIG_MACHINE()))?.packId).toBe('chat-gemma4-12b');

    // …and the 26B-A4B MoE outranks everything.
    const moe = store.packDir('chat-gemma4-26b-a4b');
    await mkdir(moe, { recursive: true });
    await writeFile(path.join(moe, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma4-26b-a4b', path: moe, installedAt: '2026-01-01T00:00:00Z' });
    expect((await pickInstalledLocalLlmChatModel(store, BIG_MACHINE()))?.packId).toBe('chat-gemma4-26b-a4b');

    await rm(dir, { recursive: true, force: true });
  });

  it('picks the best model the MACHINE can run, not blindly the biggest installed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-fit-'));
    const store = new EnginePackStore(dir);
    for (const id of ['chat-gemma3-4b', 'chat-gemma3-12b', 'chat-gemma4-12b', 'chat-gemma4-26b-a4b']) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'model.gguf'), 'x');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }
    const machine = (ramMb: number): SystemProfile => profile({ totalRamMb: ramMb, freeRamMb: Math.round(ramMb / 2) });

    // 32 GB: everything fits, so the most capable (the MoE) wins outright.
    const big = (await pickInstalledLocalLlmChatModel(store, machine(32768)))!;
    expect(big.packId).toBe('chat-gemma4-26b-a4b');
    expect(big.skipped).toBeUndefined();

    // 16 GB: the 26B (needs 24 GB) would thrash — fall to the best that fits,
    // and say WHY, so Settings can explain the idle install.
    const mid = (await pickInstalledLocalLlmChatModel(store, machine(16384)))!;
    expect(mid.packId).toBe('chat-gemma4-12b');
    expect(mid.promptFormat).toBe('gemma4');
    expect(mid.skipped?.packId).toBe('chat-gemma4-26b-a4b');
    expect(mid.skipped?.reason).toMatch(/24 GB/);

    // 8 GB: only the 4B fits.
    expect((await pickInstalledLocalLlmChatModel(store, machine(8192)))!.packId).toBe('chat-gemma3-4b');

    await rm(dir, { recursive: true, force: true });
  });

  it('honours a machine that reports slightly under its nominal RAM (Windows/Linux under-report)', async () => {
    // os.totalmem() excludes firmware/kernel reservations on Windows
    // (ullTotalPhys) and Linux (MemTotal), so a real 32 GB box reports ~31.8 GB
    // while every catalog gate is an exact GiB power of two. A strict compare
    // made EVERY tier boundary unreachable there: the user's deliberately
    // installed 27B would be silently replaced by the 12B, explained by the
    // self-contradicting "needs about 32 GB; this computer has 32 GB".
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-slack-'));
    const store = new EnginePackStore(dir);
    for (const id of ['translategemma-12b', 'translategemma-27b']) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'model.gguf'), 'x');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }
    const win32gb = profile({ platform: 'win32', arch: 'x64', totalRamMb: 32614, gpus: [], appleSilicon: false });
    const picked = (await pickInstalledLocalLlmModel(store, win32gb))!;
    expect(picked.packId).toBe('translategemma-27b');
    expect(picked.skipped).toBeUndefined();

    // The tolerance is narrow, not a blank cheque: a genuine 16 GB machine
    // still must not be handed the 32 GB-gated model.
    const win16gb = profile({ platform: 'win32', arch: 'x64', totalRamMb: 16244, gpus: [], appleSilicon: false });
    expect((await pickInstalledLocalLlmModel(store, win16gb))!.packId).toBe('translategemma-12b');

    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to the least demanding install when NOTHING fits (run something, not nothing)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-nofit-'));
    const store = new EnginePackStore(dir);
    for (const id of ['chat-gemma3-12b', 'chat-gemma4-26b-a4b']) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'model.gguf'), 'x');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }
    const tiny = profile({ platform: 'win32', arch: 'x64', cpuCores: 4, totalRamMb: 8192, freeRamMb: 3000, gpus: [], appleSilicon: false });
    const picked = (await pickInstalledLocalLlmChatModel(store, tiny))!;
    expect(picked.packId).toBe('chat-gemma3-12b'); // 16 GB ask beats the 24 GB one
    expect(picked.skipped?.packId).toBe('chat-gemma4-26b-a4b');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports the ACTIVE pack per function only when packs actually compete', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-active-'));
    const store = new EnginePackStore(dir);
    const install = async (id: string) => {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'model.gguf'), 'x');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    };

    // One chat model installed → nothing to disambiguate, so nothing reported.
    await install('chat-gemma3-4b');
    expect(await resolveActivePackSelections(store, BIG_MACHINE())).toEqual([]);

    // A second one → report which wins, so Settings can label the idle install.
    await install('chat-gemma4-12b');
    const selections = await resolveActivePackSelections(store, BIG_MACHINE());
    expect(selections).toHaveLength(1);
    expect(selections[0]!.providerId).toBe('local-llm-chat-model');
    expect(selections[0]!.packId).toBe('chat-gemma4-12b');

    // A DIFFERENT family (TranslateGemma) is tracked separately, not merged.
    await install('translategemma-4b');
    await install('translategemma-12b');
    const families = (await resolveActivePackSelections(store, BIG_MACHINE())).map((s) => s.providerId).sort();
    expect(families).toEqual(['local-llm-chat-model', 'local-llm-model']);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports the prompt grammar of the SELECTED pack (gemma4 turns differ from gemma)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-g4fmt-'));
    const store = new EnginePackStore(dir);

    const p12 = store.packDir('chat-gemma3-12b');
    await mkdir(p12, { recursive: true });
    await writeFile(path.join(p12, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma3-12b', path: p12, installedAt: '2026-01-01T00:00:00Z' });
    expect((await resolveLocalLlmChatModel(store, BIG_MACHINE())).promptFormat).toBe('gemma');

    // Installing a Gemma 4 pack flips BOTH the selection and the grammar the
    // provider must render — if these ever came from different packs, the
    // engine would load one model and the prompts would target the other.
    const g4 = store.packDir('chat-gemma4-12b');
    await mkdir(g4, { recursive: true });
    await writeFile(path.join(g4, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma4-12b', path: g4, installedAt: '2026-01-01T00:00:00Z' });
    const selected = await resolveLocalLlmChatModel(store, BIG_MACHINE());
    expect(selected.packId).toBe('chat-gemma4-12b');
    expect(selected.promptFormat).toBe('gemma4');
    expect(selected.modelPath).toContain('chat-gemma4-12b');

    // The top-ranked MoE pack is Gemma 4 too — pin its grammar as well so a
    // future pack-list edit can't silently pair it with the wrong wrapper.
    const moe = store.packDir('chat-gemma4-26b-a4b');
    await mkdir(moe, { recursive: true });
    await writeFile(path.join(moe, 'model.gguf'), 'x');
    await store.add({ id: 'chat-gemma4-26b-a4b', path: moe, installedAt: '2026-01-01T00:00:00Z' });
    const top = await resolveLocalLlmChatModel(store, BIG_MACHINE());
    expect(top.packId).toBe('chat-gemma4-26b-a4b');
    expect(top.promptFormat).toBe('gemma4');

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

/**
 * A CUDA build needs a driver at least as new as the toolkit it was compiled
 * against. NVIDIA's "minor version compatibility" says otherwise; on a GTX 1650
 * with driver 546.29 (CUDA 12.3) it did not hold, and the b9592 CUDA build
 * enumerated the GPU, loaded the model, allocated every buffer and THEN aborted
 * inside CUDA_CHECK on the first real graph — for a 26B MoE and a dense 12B
 * alike, at 4/5/20 offloaded layers alike, with 1.8 GB of VRAM to spare. Driver
 * 610.88 ran the identical allocation. Nothing about that symptom points at a
 * driver, so the catalog has to.
 */
describe('NVIDIA driver gate on CUDA packs', () => {
  const nvidia = (driverVersion?: string): SystemProfile =>
    profile({
      platform: 'win32',
      arch: 'x64',
      appleSilicon: false,
      gpus: [{ name: 'NVIDIA GeForce GTX 1650', vramMb: 4096, ...(driverVersion ? { driverVersion } : {}) }],
    });

  const cudaPack = (id: string): EnginePackInfo => {
    const p = findPack(id);
    expect(p, `${id} missing from the catalog`).toBeDefined();
    return p as EnginePackInfo;
  };

  it('declares a driver floor on every CUDA pack, pinned to the toolkit in its own artifact URLs', () => {
    const cuda = ENGINE_PACKS.filter((p) => p.accel === 'cuda');
    expect(cuda.length).toBeGreaterThan(0);
    for (const pack of cuda) {
      // The floor must exist...
      expect(pack.minNvidiaDriver, `${pack.id} has no minNvidiaDriver`).toBeDefined();
      // ...and must match the toolkit the artifacts actually ship. Rebuilding a
      // pack against a newer CUDA without moving its floor would re-open this
      // exact bug silently, so tie the two together here rather than trusting a
      // comment. (CUDA 12.4 -> 551.61; extend the table when a pack moves.)
      const TOOLKIT_TO_DRIVER: Record<string, string> = { '12.4': '551.61' };
      // Upstream names the toolkit either way: llama.cpp ships "…-cuda-12.4-…",
      // whisper.cpp "…-cublas-12.4.0-…".
      const toolkit = pack.artifacts
        .map((a) => /(?:cuda|cublas)[-.]?(\d+\.\d+)/i.exec(a.url)?.[1])
        .find((v): v is string => typeof v === 'string');
      expect(toolkit, `${pack.id}: no CUDA toolkit version in its artifact URLs`).toBeDefined();
      expect(TOOLKIT_TO_DRIVER[toolkit as string], `unmapped CUDA toolkit ${toolkit}`).toBeDefined();
      expect(pack.minNvidiaDriver).toBe(TOOLKIT_TO_DRIVER[toolkit as string]);
    }
  });

  it('rejects a driver below the floor and accepts one at or above it', () => {
    const pack = cudaPack('llama-cpp-cuda');
    expect(nvidiaDriverSupportsPack(pack, nvidia('546.29'))).toBe(false); // the reported failure
    expect(nvidiaDriverSupportsPack(pack, nvidia('551.60'))).toBe(false); // just under
    expect(nvidiaDriverSupportsPack(pack, nvidia('551.61'))).toBe(true); // exactly the floor
    expect(nvidiaDriverSupportsPack(pack, nvidia('610.88'))).toBe(true); // the reported fix
    // Numeric, not lexicographic: "9.99" must not beat "551.61", and a 3-part
    // Linux version must compare segment-wise.
    expect(nvidiaDriverSupportsPack(pack, nvidia('9.99'))).toBe(false);
    expect(nvidiaDriverSupportsPack(pack, nvidia('551.61.02'))).toBe(true);
  });

  it('FAILS OPEN when the driver cannot be established', () => {
    // Detection is best-effort: nvidia-smi may be absent or report something we
    // do not parse. Hiding a working CUDA build from the user who most wants it
    // is a worse error than one failed start the fallback already survives.
    const pack = cudaPack('llama-cpp-cuda');
    expect(nvidiaDriverSupportsPack(pack, nvidia(undefined))).toBe(true);
    expect(nvidiaDriverSupportsPack(pack, nvidia(''))).toBe(true);
    expect(nvidiaDriverSupportsPack(pack, profile({ gpus: [] }))).toBe(true);
    // Non-CUDA packs are never judged by it.
    expect(nvidiaDriverSupportsPack(cudaPack('llama-cpp-vulkan'), nvidia('546.29'))).toBe(true);
  });

  it('stops recommending and badging the pack below the floor, but keeps it VISIBLE', () => {
    const pack = cudaPack('llama-cpp-cuda');
    const old = nvidia('546.29');
    const current = nvidia('610.88');
    // "✓ can run" / recommendation gate follows the driver...
    expect(packFitsMachine(pack, current)).toBe(true);
    expect(packFitsMachine(pack, old)).toBe(false);
    // ...but the hard gate does NOT: the row must stay in Settings → Engines so
    // the user can see the pack (and fix their driver) rather than have it
    // silently vanish. That is what separates this from "no NVIDIA GPU".
    expect(packHardwareSupported(pack, old)).toBe(true);
  });

  it('demotes an installed under-driver CUDA runtime behind Vulkan instead of dropping it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-drvgate-'));
    const store = new EnginePackStore(dir);
    for (const id of ['llama-cpp-cuda', 'llama-cpp-vulkan']) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'llama-server.exe'), '');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }

    // No profile: unchanged behaviour — CUDA outranks Vulkan.
    expect(await installedPacksForProvider(store, 'local-llm', 'win32', 'x64')).toEqual([
      'llama-cpp-cuda',
      'llama-cpp-vulkan',
    ]);
    // Current driver: still CUDA first.
    expect(await installedPacksForProvider(store, 'local-llm', 'win32', 'x64', nvidia('610.88'))).toEqual([
      'llama-cpp-cuda',
      'llama-cpp-vulkan',
    ]);
    // Old driver: Vulkan first, so the step never pays CUDA's ~12-17s load-then-
    // abort. CUDA is DEMOTED, not removed — the fallback still tries it if
    // Vulkan is gone, and a wrong detection costs ordering, not capability.
    expect(await installedPacksForProvider(store, 'local-llm', 'win32', 'x64', nvidia('546.29'))).toEqual([
      'llama-cpp-vulkan',
      'llama-cpp-cuda',
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('recommends the Vulkan runtime instead of CUDA when the driver is too old', () => {
    // The payoff of the gate: an under-driver machine is steered to a runtime
    // that works, rather than to the one that will abort. Vulkan is slower on
    // NVIDIA, which is exactly why it is second choice and not first.
    const p = nvidia('546.29');
    const recs = recommendEnginePacks(p, recommendSetup(p), 'win32', 'x64').map((r) => r.packId);
    expect(recs).toContain('llama-cpp-vulkan');
    expect(recs).not.toContain('llama-cpp-cuda');
    // ...and the current driver gets the fast one back.
    const q = nvidia('610.88');
    expect(recommendEnginePacks(q, recommendSetup(q), 'win32', 'x64').map((r) => r.packId)).toContain(
      'llama-cpp-cuda',
    );
  });

  it('still returns the CUDA pack when it is the only runtime installed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-drvgate-solo-'));
    const store = new EnginePackStore(dir);
    const p = store.packDir('llama-cpp-cuda');
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server.exe'), '');
    await store.add({ id: 'llama-cpp-cuda', path: p, installedAt: '2026-01-01T00:00:00Z' });
    // Trying a build that may fail beats refusing to try anything at all.
    expect(await installedPacksForProvider(store, 'local-llm', 'win32', 'x64', nvidia('546.29'))).toEqual([
      'llama-cpp-cuda',
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Choosing the MT model from "is there a GPU" (a boolean) recommended the SAME
 * 16.5 GB model to a 4 GB GTX 1650, a 12 GB RTX 3060 and a 24 GB RTX 4090 — and
 * made a machine worse off for having a weak card, since a GPU-less box with the
 * same RAM was offered the 2.5 GB 4B instead. Measured consequence on the 1650:
 * 13.9 GB of a 14.6 GB model sat in CPU_Mapped, so the GPU did 11% of the work.
 */
describe('VRAM-aware model recommendation', () => {
  const nv = (vramMb: number, ramGb: number): SystemProfile =>
    profile({
      platform: 'win32',
      arch: 'x64',
      appleSilicon: false,
      totalRamMb: ramGb * 1024,
      gpus: [{ name: 'NVIDIA GeForce', vramMb, driverVersion: '610.88' }],
    });
  const mac = (ramGb: number): SystemProfile =>
    profile({ appleSilicon: true, totalRamMb: ramGb * 1024, gpus: [{ name: 'Apple M3 Pro' }] });
  const mtModel = (p: SystemProfile, plat: NodeJS.Platform, arch: string): string | undefined =>
    recommendEnginePacks(p, recommendSetup(p), plat, arch)
      .map((r) => r.packId)
      .find((id) => id.startsWith('translategemma'));

  it('scales the model with VRAM instead of treating any GPU as equal', () => {
    expect(mtModel(nv(4096, 32), 'win32', 'x64')).toBe('translategemma-4b');
    expect(mtModel(nv(12288, 32), 'win32', 'x64')).toBe('translategemma-12b');
    expect(mtModel(nv(24576, 64), 'win32', 'x64')).toBe('translategemma-27b');
  });

  it('never makes a machine worse off for having a weak GPU', () => {
    // The regression that motivated this: adding a 4 GB card to a 32 GB box used
    // to jump the recommendation from the 2.5 GB 4B to the 16.5 GB 27B.
    const noGpu = profile({ platform: 'win32', arch: 'x64', appleSilicon: false, totalRamMb: 32 * 1024, gpus: [] });
    const weakGpu = nv(4096, 32);
    const sizeOf = (id: string | undefined): number => (id ? (findPack(id)?.approxSizeMb ?? 0) : 0);
    expect(sizeOf(mtModel(weakGpu, 'win32', 'x64'))).toBeLessThanOrEqual(
      sizeOf(mtModel(noGpu, 'win32', 'x64')) * 1.05,
    );
  });

  it('leaves Apple Silicon on its unified-memory tiers', () => {
    expect(mtModel(mac(18), 'darwin', 'arm64')).toBe('translategemma-12b');
    expect(mtModel(mac(64), 'darwin', 'arm64')).toBe('translategemma-27b');
  });

  it('falls back to the CPU tier when no GPU memory can be established', () => {
    // Best-effort detection again: an unknown VRAM must not invent a budget.
    const unknownVram = profile({
      platform: 'win32', arch: 'x64', appleSilicon: false, totalRamMb: 32 * 1024,
      gpus: [{ name: 'NVIDIA GeForce' }],
    });
    expect(gpuWeightBudgetMb(unknownVram)).toBe(0);
    expect(mtModel(unknownVram, 'win32', 'x64')).toBe('translategemma-4b');
  });

  it('RECOMMENDS a smaller model without restricting the larger ones', () => {
    // The point the whole design turns on: a 4 GB machine is steered to the 4B,
    // but the 12B/27B stay visible and installable for anyone who wants quality
    // over speed. Same philosophy as the CUDA driver gate.
    const p = nv(4096, 32);
    for (const id of ['translategemma-12b', 'translategemma-27b']) {
      const pack = findPack(id) as EnginePackInfo;
      expect(packHardwareSupported(pack, p), `${id} must stay visible`).toBe(true);
    }
    expect(mtModel(p, 'win32', 'x64')).toBe('translategemma-4b');
  });

  it('explains the choice in hardware terms, with a real percentage', () => {
    const p = nv(4096, 32);
    const rec = recommendEnginePacks(p, recommendSetup(p), 'win32', 'x64')
      .find((r) => r.packId === 'translategemma-4b');
    expect(rec?.reason).toMatch(/% on your GPU/);
    // The old copy asserted a capability the app never checked.
    expect(rec?.reason).not.toMatch(/Your GPU\/Apple-Silicon can drive/);
  });

  it('gpuResidentFraction reflects the measured split, not the raw VRAM', () => {
    const p = nv(4096, 32);
    // 14.6 GB MoE on a 4 GB card: a small minority resident, matching the
    // 1.75 GB-on-device / 13.9 GB-in-CPU_Mapped split we measured.
    const moe = findPack('chat-gemma4-26b-a4b') as EnginePackInfo;
    expect(gpuResidentFraction(moe.approxSizeMb, p)).toBeLessThan(0.2);
    // ...and the 4B is mostly resident, which is why it is the faster choice.
    const small = findPack('translategemma-4b') as EnginePackInfo;
    expect(gpuResidentFraction(small.approxSizeMb, p)).toBeGreaterThanOrEqual(MIN_GPU_RESIDENT_FRACTION);
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

describe('runtime fallback when the preferred engine cannot start', () => {
  it('falls back to the next installed runtime, and remembers the bad one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vd-fallback-'));
    const store = new EnginePackStore(dir);
    for (const id of ['llama-cpp-cuda', 'llama-cpp-vulkan']) {
      const p = store.packDir(id);
      await mkdir(p, { recursive: true });
      await writeFile(path.join(p, 'llama-server.exe'), '');
      await writeFile(path.join(p, 'llama-server'), '');
      await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
    }

    const attempts: string[] = [];
    let port = 51000;
    const mgr = new EngineManager({
      store,
      allocatePort: async () => port++,
      // The CUDA build "starts" but never answers health — exactly how a wrong
      // driver or an unusable GPU presents.
      healthProbe: async (url: string) => !url.includes(`:51000`),
      spawnImpl: (cmd) => {
        attempts.push(cmd.includes('cuda') ? 'cuda' : 'vulkan');
        return { on: () => undefined, stderr: { on: () => undefined }, kill: () => true } as never;
      },
      startTimeoutMs: 50,
    });

    const ids = await installedPacksForProvider(store, 'local-llm', 'win32', 'x64');
    expect(ids[0]).toBe('llama-cpp-cuda'); // preferred by accel rank

    // Installing CUDA must not break a machine where only Vulkan works.
    const url = await mgr.ensureRunningFirstUsable(ids, { model: '/m.gguf' });
    expect(url).toContain('51001');
    expect(attempts).toEqual(['cuda', 'vulkan']);

    // The failure is remembered: the next call skips CUDA entirely.
    attempts.length = 0;
    await mgr.stopAll();
    await mgr.ensureRunningFirstUsable(ids, { model: '/m.gguf' });
    expect(attempts).toEqual(['vulkan']);

    await mgr.stopAll();
    await rm(dir, { recursive: true, force: true });
  });
});

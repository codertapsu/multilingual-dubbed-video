/**
 * The GPU voice pack and the engine manager's heavy lane.
 *
 * VieNeu's GPU build holds VRAM, so it must evict a resident llama.cpp before
 * its model loads (two models on an 8 GB card: one of them crashes mid-run).
 * Three ways that could silently not happen are pinned here.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import { EngineManager, looksLikeGpuOutOfMemory } from './engineManager.js';
import { fallbackWarning } from './fallbackWarning.js';
import { EnginePackStore } from './enginePackStore.js';

let dir: string;
let store: EnginePackStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vd-gpu-lane-'));
  store = new EnginePackStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Record a pack with whatever its launcher looks for (a venv python or a binary). */
async function install(id: string, kind: 'uv' | 'binary'): Promise<void> {
  const p = store.packDir(id);
  const file =
    kind === 'uv'
      ? path.join(
          p,
          'venv',
          ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']),
        )
      : path.join(p, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '');
  await store.add({ id, path: p, installedAt: '2026-11-07T00:00:00Z' });
}

function managerWithLog() {
  const launches: { env: Record<string, string>; killed: boolean }[] = [];
  let port = 52000;
  const manager = new EngineManager({
    store,
    allocatePort: async () => port++,
    healthProbe: async () => true,
    spawnImpl: (_cmd, _args, env) => {
      const entry = { env, killed: false };
      launches.push(entry);
      return {
        on: () => undefined,
        stderr: { on: () => undefined },
        kill: () => {
          entry.killed = true;
          return true;
        },
      } as never;
    },
    startTimeoutMs: 1000,
  });
  return { manager, launches };
}

describe('GPU voice pack launch', () => {
  it('tells the engine which device its pack is for', async () => {
    await install('tts-neural-cuda', 'uv');
    await install('tts-neural', 'uv');
    const { manager, launches } = managerWithLog();
    await manager.ensureRunning('tts-neural-cuda');
    await manager.ensureRunning('tts-neural');
    expect(launches.map((l) => l.env['VIENEU_DEVICE'])).toEqual(['cuda', 'cpu']);
    await manager.stopAll();
  });

  it('evicts a resident llama.cpp when an ALREADY-RUNNING GPU voice turns exclusive', async () => {
    // The voice picker starts the engine without the lane (it must not evict
    // anything just to list voices). Synthesis then reuses that process; the
    // reuse path used to return early, before the eviction.
    await install('tts-neural-cuda', 'uv');
    await install('llama-cpp-cuda', 'binary');
    const { manager, launches } = managerWithLog();
    await manager.ensureRunning('tts-neural-cuda'); // voice picker
    await manager.ensureRunning('llama-cpp-cuda'); // a translation engine still up
    await manager.ensureRunning('tts-neural-cuda', { exclusive: true, ownerId: 'dub-1' }); // synthesis
    expect(launches[1]?.killed).toBe(true); // llama.cpp gone
    expect(launches[0]?.killed).toBe(false); // the voice engine was reused, not restarted
    await manager.stopAll();
  });

  it('a GPU voice busy for another dub is skipped, not written off', async () => {
    await install('tts-neural-cuda', 'uv');
    await install('tts-neural', 'uv');
    const { manager, launches } = managerWithLog();
    await manager.ensureRunning('tts-neural-cuda', { exclusive: true, ownerId: 'dub-1' });

    // dub-2 asks while dub-1 holds the lane: it gets the CPU pack for now...
    const busy = await manager.ensureRunningFirstUsable(['tts-neural-cuda', 'tts-neural'], {
      exclusive: true,
      ownerId: 'dub-2',
    });
    expect(busy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(
      manager.ensureRunning('tts-neural-cuda', { exclusive: true, ownerId: 'dub-2' }),
    ).rejects.toBeInstanceOf(AppErrorException);

    // ...and once the lane is free, the GPU pack is used again (not blacklisted).
    await manager.stopAll();
    const again = await manager.ensureRunningFirstUsable(['tts-neural-cuda', 'tts-neural'], {
      exclusive: true,
      ownerId: 'dub-2',
    });
    expect(again).toBeDefined();
    expect(launches.at(-1)?.env['VIENEU_DEVICE']).toBe('cuda');
    await manager.stop('tts-neural');
    await manager.stopAll();
  });
});

describe('a graphics card too full to start an engine (claude-dubber, 2026-11-27)', () => {
  // What llama.cpp printed on an 8 GB RTX 3050 loading TranslateGemma 27B.
  const OOM =
    'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 220.83 MiB on device 0: cudaMalloc failed: out of memory\n' +
    'graph_reserve: failed to allocate compute pp buffers\nllama_init_from_model: failed to initialize the context\n';

  /** Launches whose pack and `-fitt` are recorded; `full(pack, headroom)` decides which run out of memory. */
  function managerWithCard(full: (packId: string, headroom: string | undefined) => boolean) {
    const launches: { packId: string; headroom: string | undefined }[] = [];
    const fallbacks: { packId: string; reason: string }[] = [];
    const healthy = new Set<number>();
    let port = 53000;
    const manager = new EngineManager({
      store,
      allocatePort: async () => port++,
      healthProbe: async (url) => healthy.has(Number(new URL(url).port)),
      spawnImpl: (cmd, args) => {
        const packId = path.basename(path.dirname(cmd));
        const at = args.indexOf('-fitt');
        const headroom = at >= 0 ? args[at + 1] : undefined;
        launches.push({ packId, headroom });
        const listeners: { data?: (d: Buffer) => void; exit?: (code: number | null, signal: string | null) => void } = {};
        const ownPort = Number(args[args.indexOf('--port') + 1]);
        if (full(packId, headroom)) {
          setTimeout(() => {
            listeners.data?.(Buffer.from(OOM));
            listeners.exit?.(1, null);
          }, 5);
        } else {
          healthy.add(ownPort);
        }
        return {
          on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
            if (event === 'exit') listeners.exit = cb;
          },
          stderr: { on: (_: string, cb: (d: Buffer) => void) => (listeners.data = cb) },
          kill: () => true,
        } as never;
      },
      onFallback: (f) => fallbacks.push({ packId: f.packId, reason: f.reason }),
      startTimeoutMs: 3000,
    });
    return { manager, launches, fallbacks };
  }

  it('tries llama.cpp once more with more memory left free, keeps that room, and says nothing went wrong', async () => {
    await install('llama-cpp-cuda', 'binary');
    await install('llama-cpp-vulkan', 'binary');
    // 512 MiB free was 220 MiB short; 1.5 GiB is enough.
    const { manager, launches, fallbacks } = managerWithCard((pack, headroom) => pack === 'llama-cpp-cuda' && headroom === '512');
    await manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-1' });
    expect(launches).toEqual([
      { packId: 'llama-cpp-cuda', headroom: '512' },
      { packId: 'llama-cpp-cuda', headroom: '1536' },
    ]);
    expect(fallbacks).toEqual([]);
    // The next start this session (another model, another step) begins with that room.
    await manager.stopAll();
    await manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-1' });
    expect(launches.at(-1)).toEqual({ packId: 'llama-cpp-cuda', headroom: '1536' });
    await manager.stopAll();
  });

  it('keeps its turn on the card through the retry: the dub waiting behind gets the card after, not between', async () => {
    await install('llama-cpp-cuda', 'binary');
    await install('llama-cpp-vulkan', 'binary');
    const { manager, launches } = managerWithCard((pack, headroom) => pack === 'llama-cpp-cuda' && headroom === '512');
    manager.setLaneWaiting((owner) => owner.startsWith('dub-'));
    const first = manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-1' });
    // dub-2 reaches its GPU step while dub-1's first start is failing.
    const second = manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-2' });
    await first;
    expect(launches).toEqual([
      { packId: 'llama-cpp-cuda', headroom: '512' },
      { packId: 'llama-cpp-cuda', headroom: '1536' },
    ]);
    expect(manager.heavyLaneOwner()).toBe('dub-1');
    expect(manager.laneWaiters().map((w) => w.owner)).toEqual(['dub-2']);
    manager.releaseHeavyLane('dub-1');
    await second;
    expect(manager.heavyLaneOwner()).toBe('dub-2');
    await manager.stopAll();
  });

  it('falls back when the card stays too full, says it was memory (not "reinstall"), and tries the GPU build again next time', async () => {
    await install('llama-cpp-cuda', 'binary');
    await install('llama-cpp-vulkan', 'binary');
    const { manager, launches, fallbacks } = managerWithCard((pack) => pack === 'llama-cpp-cuda');
    await manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-1' });
    expect(launches.map((l) => `${l.packId}@${l.headroom}`)).toEqual(['llama-cpp-cuda@512', 'llama-cpp-cuda@1536', 'llama-cpp-vulkan@512']);
    expect(fallbacks).toEqual([{ packId: 'llama-cpp-cuda', reason: 'memory' }]);
    // Not written off for the session: the next step tries it again, with more room still.
    await manager.stopAll();
    await manager.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'dub-1' });
    expect(launches.slice(3).map((l) => `${l.packId}@${l.headroom}`)).toEqual(['llama-cpp-cuda@1536', 'llama-cpp-cuda@2560', 'llama-cpp-vulkan@512']);
    await manager.stopAll();
  });

  it('knows the graphics card running out of memory from the computer running out of it', () => {
    expect(looksLikeGpuOutOfMemory(OOM)).toBe(true);
    expect(looksLikeGpuOutOfMemory('ggml_vulkan: Device memory allocation of size 1058781184 failed.')).toBe(true);
    expect(looksLikeGpuOutOfMemory('vk::Device::allocateMemory: ErrorOutOfDeviceMemory')).toBe(true);
    expect(looksLikeGpuOutOfMemory('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 20.00 MiB')).toBe(true);
    // The computer's own memory, or a missing library: other causes, other advice.
    expect(looksLikeGpuOutOfMemory('ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 17179869184')).toBe(false);
    expect(looksLikeGpuOutOfMemory("terminate called after throwing an instance of 'std::bad_alloc'")).toBe(false);
    expect(looksLikeGpuOutOfMemory('ImportError: DLL load failed while importing onnxruntime_pybind11_state')).toBe(false);
  });

  it("warns with each cause's own advice: only an engine that would not start is worth reinstalling", () => {
    const memory = fallbackWarning({ packId: 'llama-cpp-cuda', ownerId: 'proj_a5cdaf6e', reason: 'memory' });
    expect(memory.key).toBe('warning.gpu-fallback-memory');
    expect(memory.message).toContain('Nothing needs reinstalling');
    expect(memory.message).not.toMatch(/reinstall it/);
    expect(fallbackWarning({ packId: 'llama-cpp-cuda', reason: 'busy', busyWith: 'proj_1' })).toMatchObject({
      key: 'warning.gpu-fallback-busy',
      message: expect.stringContaining('The GPU was busy (proj_1)'),
    });
    expect(fallbackWarning({ packId: 'llama-cpp-cuda', reason: 'failed' }).message).toContain('reinstall it in Settings → Engines');
  });
});

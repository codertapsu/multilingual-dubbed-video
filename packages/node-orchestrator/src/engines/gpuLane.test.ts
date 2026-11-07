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
import { EngineManager } from './engineManager.js';
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

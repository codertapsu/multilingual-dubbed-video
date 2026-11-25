/**
 * The engine manager's lane gate: while another app holds the graphics card
 * (scheduler/gpuHolds.ts), a FREE heavy lane is not taken by new work — the
 * same ENGINE_BUSY a dub holding it gives, so callers that fall back to the
 * next installed runtime do — and the owner already on the lane keeps it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EngineManager } from './engineManager.js';
import { EnginePackStore } from './enginePackStore.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function manager(packs: string[], onFallback?: ConstructorParameters<typeof EngineManager>[0]['onFallback']) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vd-lane-gate-'));
  const store = new EnginePackStore(dir);
  for (const id of packs) {
    const p = store.packDir(id);
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server'), '#!/bin/sh\n');
    await writeFile(path.join(p, 'llama-server.exe'), '');
    await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
  }
  let port = 52400;
  return new EngineManager({
    store,
    allocatePort: async () => port++,
    healthProbe: async () => true,
    spawnImpl: () => ({ on: () => undefined, stderr: { on: () => undefined }, kill: () => true }) as never,
    startTimeoutMs: 1000,
    ...(onFallback ? { onFallback } : {}),
  });
}

describe('the heavy lane while another app holds the graphics card', () => {
  it('a free lane is refused to new work, saying who holds the card', async () => {
    const m = await manager(['llama-cpp-metal']);
    const asked: string[] = [];
    m.setLaneGate((owner) => {
      asked.push(owner);
      return { by: 'Voice Mask' };
    });
    await expect(m.ensureRunning('llama-cpp-metal', { exclusive: true, ownerId: 'editor:proj_a' })).rejects.toMatchObject({
      code: 'ENGINE_BUSY',
      message: expect.stringContaining('Voice Mask is using the graphics card'),
    });
    await expect(m.claimForJob('Music & voice separation', 'proj_b')).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    expect(asked).toEqual(['editor:proj_a', 'proj_b']);
    expect(m.heavyLaneOwner()).toBeUndefined();
    await m.stopAll();
  });

  it('the owner already on the lane keeps it for its next steps; the gate is not asked', async () => {
    const m = await manager(['llama-cpp-metal']);
    await m.ensureRunning('llama-cpp-metal', { exclusive: true, ownerId: 'proj_a' });
    m.setLaneGate(() => ({ by: 'Voice Mask' }));
    await expect(m.ensureRunning('llama-cpp-metal', { exclusive: true, ownerId: 'proj_a' })).resolves.toContain('http');
    await expect(m.claimForJob('separation', 'proj_a')).resolves.toBeUndefined();
    expect(m.heavyLaneOwner()).toBe('proj_a');
    await m.stopAll();
  });

  it('work the gate lets through (a dub admitted on the lane) takes the free lane as before', async () => {
    const m = await manager(['llama-cpp-metal']);
    m.setLaneGate((owner) => (owner === 'proj_admitted' ? undefined : { by: 'Voice Mask' }));
    await m.ensureRunning('llama-cpp-metal', { exclusive: true, ownerId: 'proj_admitted' });
    expect(m.heavyLaneOwner()).toBe('proj_admitted');
    await m.stopAll();
  });

  it('a step that falls back to the next runtime says the card was busy with Voice Mask, never that it is broken', async () => {
    const fallbacks: { packId: string; reason: string; busyWith?: string }[] = [];
    const m = await manager(['llama-cpp-cuda', 'llama-cpp-vulkan'], (f) => fallbacks.push(f));
    m.setLaneGate(() => ({ by: 'Voice Mask' }));
    // Both builds are heavy here, so both wait; what matters is what is said, and that nothing is written off.
    await expect(m.ensureRunningFirstUsable(['llama-cpp-cuda', 'llama-cpp-vulkan'], { exclusive: true, ownerId: 'editor:p' })).rejects.toMatchObject({
      code: 'ENGINE_BUSY',
    });
    expect(fallbacks).toEqual([
      { packId: 'llama-cpp-cuda', ownerId: 'editor:p', reason: 'busy', busyWith: 'Voice Mask' },
      { packId: 'llama-cpp-vulkan', ownerId: 'editor:p', reason: 'busy', busyWith: 'Voice Mask' },
    ]);
    expect(m.unusablePackIds()).toEqual([]);
    await m.stopAll();
  });
});

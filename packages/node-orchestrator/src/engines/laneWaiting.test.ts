/**
 * Dubs taking turns on the graphics card (EngineManager.waitForLane): a dub
 * that finds the heavy lane busy waits for its turn instead of running the
 * step on the CPU build of the same model. In turn, oldest first, a warm
 * engine's waiter ahead at most twice; never while another app holds the
 * card unless the gate lets it through; and a paused dub stops waiting and
 * starts nothing. Editor actions and previews are still refused, as before.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EngineManager, MAX_LANE_SKIPS } from './engineManager.js';
import { EnginePackStore } from './enginePackStore.js';
import { setLaneWaitReporter, withEngineOwner, type LaneWait } from './engineOwner.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function manager(packs: string[] = ['llama-cpp-metal']) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vd-lane-wait-'));
  const store = new EnginePackStore(dir);
  for (const id of packs) {
    const p = store.packDir(id);
    await mkdir(p, { recursive: true });
    await writeFile(path.join(p, 'llama-server'), '#!/bin/sh\n');
    await writeFile(path.join(p, 'llama-server.exe'), '');
    await store.add({ id, path: p, installedAt: '2026-01-01T00:00:00Z' });
  }
  let port = 52600;
  const m = new EngineManager({
    store,
    allocatePort: async () => port++,
    healthProbe: async () => true,
    spawnImpl: () => ({ on: () => undefined, stderr: { on: () => undefined }, kill: () => true }) as never,
    startTimeoutMs: 1000,
  });
  // Dubs wait (the orchestrator's rule: its runs); anything else is refused.
  m.setLaneWaiting((owner) => owner.startsWith('proj_'));
  return m;
}

const heavy = (ownerId: string, model?: string) => ({ exclusive: true, ownerId, ...(model ? { model } : {}) });
/** Let the granted waiters' continuations run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('dubs taking turns on the graphics card', () => {
  it('a dub waits for the lane another dub holds, and gets it when that one lets go', async () => {
    const m = await manager();
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    let started = false;
    const b = m.ensureRunning('llama-cpp-metal', heavy('proj_b')).then((url) => {
      started = true;
      return url;
    });
    await settle();
    expect(started).toBe(false);
    expect(m.laneWaiters().map((w) => w.owner)).toEqual(['proj_b']);
    expect(m.heavyLaneOwner()).toBe('proj_a');

    m.releaseHeavyLane('proj_a');
    await expect(b).resolves.toContain('http');
    expect(m.heavyLaneOwner()).toBe('proj_b');
    expect(m.laneWaiters()).toEqual([]);
    await m.stopAll();
  });

  it('the dubs waiting go in turn, oldest first', async () => {
    const m = await manager();
    await m.claimForJob('separation', 'proj_a');
    const order: string[] = [];
    const b = m.ensureRunning('llama-cpp-metal', heavy('proj_b')).then(() => order.push('proj_b'));
    const c = m.claimForJob('separation', 'proj_c').then(() => order.push('proj_c'));
    await settle();
    m.releaseHeavyLane('proj_a');
    await b;
    expect(m.heavyLaneOwner()).toBe('proj_b');
    m.releaseHeavyLane('proj_b');
    await c;
    expect(order).toEqual(['proj_b', 'proj_c']);
    expect(m.heavyLaneOwner()).toBe('proj_c');
    await m.stopAll();
  });

  it('the dub that started first goes first, though another began to wait before it (a series in part order)', async () => {
    const m = await manager();
    const started = new Map([
      ['proj_part1', 1],
      ['proj_part2', 2],
    ]);
    m.setLaneWaiting(
      (owner) => owner.startsWith('proj_'),
      (owner) => started.get(owner),
    );
    await m.claimForJob('separation', 'proj_other');
    const order: string[] = [];
    // Part 2 got to its translation first (its window was shorter to extract).
    const two = m.ensureRunning('llama-cpp-metal', heavy('proj_part2')).then(() => order.push('proj_part2'));
    await settle();
    const one = m.ensureRunning('llama-cpp-metal', heavy('proj_part1')).then(() => order.push('proj_part1'));
    await settle();
    m.releaseHeavyLane('proj_other');
    await one;
    m.releaseHeavyLane('proj_part1');
    await two;
    expect(order).toEqual(['proj_part1', 'proj_part2']);
    await m.stopAll();
  });

  it('an edit or a preview is still refused the busy lane (ENGINE_BUSY), never made to wait', async () => {
    const m = await manager();
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    await expect(m.ensureRunning('llama-cpp-metal', heavy('editor:proj_x'))).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    await expect(m.claimForJob('separation', 'preview:vieneu-1')).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    expect(m.laneWaiters()).toEqual([]);
    await m.stopAll();
  });

  it('a dub paused while it waits stops waiting, starts nothing else and writes no engine off', async () => {
    const m = await manager(['llama-cpp-metal', 'llama-cpp-vulkan']);
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const controller = new AbortController();
    const b = withEngineOwner(
      'proj_b',
      () => m.ensureRunningFirstUsable(['llama-cpp-metal', 'llama-cpp-vulkan'], { exclusive: true }),
      { signal: controller.signal },
    );
    await settle();
    expect(m.laneWaiters().map((w) => w.owner)).toEqual(['proj_b']);
    controller.abort();
    await expect(b).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(m.laneWaiters()).toEqual([]);
    expect(m.heavyLaneOwner()).toBe('proj_a');
    expect(m.runningPackIds()).toEqual(['llama-cpp-metal']);
    expect(m.unusablePackIds()).toEqual([]);
    await m.stopAll();
  });

  it('a dub already paused does not join the line', async () => {
    const m = await manager();
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      withEngineOwner('proj_b', () => m.ensureRunning('llama-cpp-metal', { exclusive: true }), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(m.laneWaiters()).toEqual([]);
    await m.stopAll();
  });

  it('a waiter whose engine is still loaded goes first, but passes the same waiter at most twice', async () => {
    expect(MAX_LANE_SKIPS).toBe(2);
    const m = await manager();
    // proj_a translates with model A; then B (another model) waits, then three more for A.
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a', 'A'));
    const order: string[] = [];
    const wait = (owner: string, model: string) =>
      m.ensureRunning('llama-cpp-metal', heavy(owner, model)).then(() => order.push(owner));
    const b = wait('proj_b', 'B');
    const c = wait('proj_c', 'A');
    const d = wait('proj_d', 'A');
    const e = wait('proj_e', 'A');
    await settle();

    m.releaseHeavyLane('proj_a');
    await c; // A is loaded: no unload and reload of the model between two dubs at the same step.
    m.releaseHeavyLane('proj_c');
    await d;
    m.releaseHeavyLane('proj_d');
    await b; // Passed twice: its turn now, though proj_e could have used the loaded A.
    m.releaseHeavyLane('proj_b');
    await e;
    expect(order).toEqual(['proj_c', 'proj_d', 'proj_b', 'proj_e']);
    await m.stopAll();
  });

  it('waits while another app holds the card unless the gate lets it through, and goes when the hold ends', async () => {
    const m = await manager();
    let held = true;
    m.setLaneGate((owner) => (held && owner !== 'proj_on_card' ? { by: 'Voice Mask' } : undefined));
    const reports: (LaneWait | undefined)[] = [];
    const b = withEngineOwner('proj_b', async () => {
      setLaneWaitReporter((w) => reports.push(w));
      return m.ensureRunning('llama-cpp-metal', { exclusive: true });
    });
    await settle();
    // A free lane, but the card is Voice Mask's: the dub waits (no CPU fallback), and says why.
    expect(m.heavyLaneOwner()).toBeUndefined();
    expect(m.laneWaiters().map((w) => w.owner)).toEqual(['proj_b']);
    expect(reports).toEqual([{ app: 'Voice Mask' }]);
    // A dub the gate lets through (already on the card) takes the free lane past it.
    await m.claimForJob('separation', 'proj_on_card');
    expect(m.heavyLaneOwner()).toBe('proj_on_card');
    m.releaseHeavyLane('proj_on_card');
    await settle();
    expect(m.heavyLaneOwner()).toBeUndefined();

    held = false;
    m.retryLane();
    await expect(b).resolves.toContain('http');
    expect(m.heavyLaneOwner()).toBe('proj_b');
    expect(reports.at(-1)).toBeUndefined();
    await m.stopAll();
  });

  it('shows the step what it waits for, and takes the wait off once it has the card', async () => {
    const m = await manager();
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const reports: (LaneWait | undefined)[] = [];
    const b = withEngineOwner('proj_b', async () => {
      setLaneWaitReporter((w) => reports.push(w));
      return m.ensureRunning('llama-cpp-metal', { exclusive: true });
    });
    await settle();
    expect(reports).toEqual([{ owner: 'proj_a' }]);
    m.releaseHeavyLane('proj_a');
    await b;
    expect(reports).toEqual([{ owner: 'proj_a' }, undefined]);

    // A lane that was free: nothing to show, nothing to take off.
    const quiet: (LaneWait | undefined)[] = [];
    m.releaseHeavyLane('proj_b');
    await withEngineOwner('proj_c', async () => {
      setLaneWaitReporter((w) => quiet.push(w));
      await m.ensureRunning('llama-cpp-metal', { exclusive: true });
    });
    expect(quiet).toEqual([]);
    await m.stopAll();
  });

  it('a holder that is gone gives the lane to the next waiter when the manager looks again', async () => {
    const m = await manager();
    const alive = new Set(['proj_a', 'proj_b']);
    m.setOwnerLiveness((owner) => alive.has(owner));
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const b = m.ensureRunning('llama-cpp-metal', heavy('proj_b'));
    await settle();
    alive.delete('proj_a'); // Its run ended without letting go.
    m.retryLane();
    await expect(b).resolves.toContain('http');
    expect(m.heavyLaneOwner()).toBe('proj_b');
    await m.stopAll();
  });

  it('a start that fails hands the lane to the next waiter', async () => {
    const m = await manager(['llama-cpp-metal']);
    await m.claimForJob('separation', 'proj_a');
    // proj_b waits for a build that is not installed; proj_c for one that is.
    const b = m.ensureRunning('llama-cpp-cuda', heavy('proj_b'));
    const c = m.ensureRunning('llama-cpp-metal', heavy('proj_c'));
    await settle();
    m.releaseHeavyLane('proj_a');
    await expect(b).rejects.toMatchObject({ code: 'ENGINE_PACK_MISSING' });
    await expect(c).resolves.toContain('http');
    expect(m.heavyLaneOwner()).toBe('proj_c');
    await m.stopAll();
  });

  it('remembers who has used the card until the run is forgotten, and a forgotten owner lets go', async () => {
    const m = await manager();
    expect(m.hasHeldLane('proj_a')).toBe(false);
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    m.releaseHeavyLane('proj_a');
    // Lent for speaker detection: it has still used the card in this run.
    expect(m.hasHeldLane('proj_a')).toBe(true);
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const b = m.ensureRunning('llama-cpp-metal', heavy('proj_b'));
    await settle();
    m.forgetOwner('proj_a');
    expect(m.hasHeldLane('proj_a')).toBe(false);
    await expect(b).resolves.toContain('http');
    expect(m.heavyLaneOwner()).toBe('proj_b');
    await m.stopAll();
  });

  it('the dubs still waiting when the engines stop are told, not left hanging', async () => {
    const m = await manager();
    await m.ensureRunning('llama-cpp-metal', heavy('proj_a'));
    const b = m.ensureRunning('llama-cpp-metal', heavy('proj_b'));
    await settle();
    await m.stopAll();
    await expect(b).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(m.laneWaiters()).toEqual([]);
  });
});

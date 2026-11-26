/**
 * Another app's hold on the graphics card, through the real scheduler: a dub
 * that needs the heavy lane waits while Voice Mask holds the card, the queue
 * says so, and it starts by itself when the hold is released (or expires).
 * Light dubs are not held; a dub admitted before the hold keeps its lane.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationProvider } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { GpuHolds } from './scheduler/gpuHolds.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from './test/fixtures.js';
import { ProjectStore } from './workspace/projectStore.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-holds-orch-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A translator on the local LLM engine: a run with it needs the heavy lane. */
function heavyTranslator(): TranslationProvider {
  const fake = new FakeTranslationProvider();
  return Object.assign(fake, { requiresEnginePack: 'local-llm' }) as TranslationProvider;
}

function orchestratorWith(holds: GpuHolds, translator: TranslationProvider): LocalJobOrchestrator {
  return new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), translator, new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
    holds,
  });
}

describe('a GPU hold in the queue (Voice Mask, 2026-11-25)', () => {
  it('a heavy dub waits while the card is held, and starts by itself when the hold is released', async () => {
    const holds = new GpuHolds();
    const orchestrator = orchestratorWith(holds, heavyTranslator());
    const hold = holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: 'live session', ttlSec: 30 }) as { holdId: string };
    const p = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp), { name: 'Tập 7' }));

    const scheduled = await orchestrator.runPipeline(p.id);
    expect(scheduled).toMatchObject({ started: false, queued: true });
    const q = await orchestrator.queueState();
    expect(q.entries).toEqual([
      expect.objectContaining({ projectId: p.id, reason: 'gpu-hold', message: 'Waiting: Voice Mask is using the graphics card.', heldBy: 'Voice Mask' }),
    ]);
    expect(q.holds).toEqual([expect.objectContaining({ holdId: hold.holdId, holder: 'voice-mask', name: 'Voice Mask', lanes: ['gpu'], reason: 'live session' })]);
    // The lane owner stays what it is (a project, an editor action...): nobody holds it in the engine manager.
    expect(q.laneOwner).toBeUndefined();

    holds.release(hold.holdId);
    await vi.waitFor(async () => expect((await store.getProject(p.id)).status).toBe('completed'), { timeout: 15_000 });
    expect((await orchestrator.queueState()).holds).toEqual([]);
  });

  it('a dub that needs no heavy engine is not held', async () => {
    const holds = new GpuHolds();
    const orchestrator = orchestratorWith(holds, new FakeTranslationProvider());
    holds.create({ holder: 'voice-mask', lanes: ['gpu'], reason: 'live session', ttlSec: 30 });
    const p = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp), { name: 'Light' }));
    expect(await orchestrator.runPipeline(p.id)).toMatchObject({ started: true });
    await vi.waitFor(async () => expect((await store.getProject(p.id)).status).toBe('completed'), { timeout: 15_000 });
  });
});

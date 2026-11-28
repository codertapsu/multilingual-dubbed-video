/**
 * "Pause the dubs and install" (Orchestrator.requeueRunningForUpdate): with
 * the queue paused, every running dub is paused and put back at the head of
 * the queue in the order the dubs started, so nothing starts during the
 * install and they go on once the app is back. On 2026-11-27, pausing the
 * dubs one at a time let the queue start the next each time.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import { LocalJobOrchestrator } from './orchestrator.js';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { ProjectStore } from './workspace/projectStore.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeRegistry,
  writeDummyVideo,
} from './test/fixtures.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-update-pause-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Speech-to-text that goes on until its run is paused. */
class EndlessStt extends FakeSttProvider {
  constructor() {
    super([]);
  }
  override async transcribe(_input: unknown, signal?: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new AppErrorException('CANCELLED', 'Paused.')), { once: true });
    });
  }
}

describe('pausing every dub for an app update', () => {
  it('puts the running dubs back at the head of the paused queue, in the order they started, held by no one', async () => {
    const concurrency: { mode: 'manual'; maxProjects: number; paused?: boolean } = { mode: 'manual', maxProjects: 3 };
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(new EndlessStt(), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      setup: { getPreferences: async () => ({ autoUpdate: true, concurrency }) },
    });
    const video = await writeDummyVideo(tmp);
    const first = await s.createProject(createProjectInput(video, { name: 'Tập 1' }));
    const second = await s.createProject(createProjectInput(video, { name: 'Tập 2' }));
    const waiting = await s.createProject(createProjectInput(video, { name: 'Tập 3' }));
    await s.runPipeline(first.id);
    await s.runPipeline(second.id);
    await vi.waitFor(async () => {
      const q = await s.queueState();
      expect(q.running.map((r) => r.step)).toEqual(['stt', 'stt']);
    }, { timeout: 15_000 });
    // A third waits behind them (the limit is two at once now).
    concurrency.maxProjects = 2;
    await s.runPipeline(waiting.id);
    expect((await s.queueState()).entries.map((e) => e.projectId)).toEqual([waiting.id]);

    // The server pauses the queue first, then this.
    concurrency.paused = true;
    expect(await s.requeueRunningForUpdate()).toEqual([first.id, second.id]);

    const q = await s.queueState();
    expect(q.running).toEqual([]);
    expect(q.entries.map((e) => e.projectId)).toEqual([first.id, second.id, waiting.id]);
    expect(q.entries.every((e) => e.reason === 'paused')).toBe(true);
    for (const id of [first.id, second.id]) {
      const project = await store.getProject(id);
      expect(project.status).toBe('queued');
      expect(project.pausedByUser).toBeUndefined();
      // Saved paused at its step: it continues there, nothing redone.
      expect((await store.getPipeline(id)).pausedStep).toBe('stt');
    }
    // Once the app is back and the queue goes on, the first one starts first.
    concurrency.paused = false;
    concurrency.maxProjects = 1;
    await s.pumpQueue();
    await vi.waitFor(async () => expect((await s.queueState()).running.map((r) => r.projectId)).toEqual([first.id]), { timeout: 15_000 });
    await s.pauseAll(2000);
  });
});

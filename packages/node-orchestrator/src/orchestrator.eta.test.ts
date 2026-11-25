/**
 * GET /projects/:id carries the time left while the project dubs: the estimate
 * from the run's own pace (activity/dubRuns.ts), the one GET /queue shows. So
 * get_project no longer works one out from the first step's start, which a
 * render redo keeps from the dub days earlier (claude-dubber, 2026-11-25:
 * "running, 89%, at render, about 2 h 25 min left" for a render of minutes).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dubRuns } from './activity/dubRuns.js';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
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
let orchestrator: LocalJobOrchestrator;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-eta-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("a project's time left comes from its run", () => {
  it("carries the run's estimate while it dubs, and none before it can tell or when it does not run", async () => {
    const p = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp), { name: 'Tập 7' }));
    const eta = vi.spyOn(dubRuns, 'etaOf').mockReturnValue(240);
    expect(await orchestrator.getProjectWithPipeline(p.id)).not.toHaveProperty('etaSec');

    // A render redo: every step before it done days ago, the render running.
    const pipeline = await store.getPipeline(p.id);
    await store.savePipeline({ ...pipeline, status: 'running', currentStep: 'render', progressPercent: 89 });
    expect(await orchestrator.getProjectWithPipeline(p.id)).toMatchObject({ etaSec: 240 });
    expect(eta).toHaveBeenCalledWith(p.id);

    eta.mockReturnValue(undefined); // too early to tell
    expect(await orchestrator.getProjectWithPipeline(p.id)).not.toHaveProperty('etaSec');
  });
});

/**
 * Dubs sharing the graphics card (Orchestrator.gpuBreak, the runner's
 * GpuBreak calls): where a run lends the card to the next dub, where it keeps
 * it, and where it hands it on for good. The engine manager is a fake that
 * records the lane; the run is the real runner over fake providers whose
 * engine families make speech-to-text and the voices GPU steps.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineStepId } from '@videodubber/shared';
import { LocalJobOrchestrator } from './orchestrator.js';
import { loadConfig } from './config.js';
import { currentLaneWaitReporter } from './engines/engineOwner.js';
import { EventBusRegistry } from './events.js';
import { ProjectStore } from './workspace/projectStore.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  defaultSettings,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from './test/fixtures.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-gpu-share-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Speech-to-text on whisper.cpp and the voices on a heavy engine: both GPU steps; translation is not. */
function gpuRegistry() {
  return fakeRegistry(
    Object.assign(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), { requiresEnginePack: 'whisper-cpp' }),
    new FakeTranslationProvider(),
    Object.assign(new FakeTtsProvider(() => 900), { requiresEnginePack: 'local-llm' }),
  );
}

/**
 * Run one dub and record, in order, its steps starting and ending and every
 * time it let go of the card. The fake lane is the run's from the start of
 * each GPU step (as the engine manager's would be once it starts the engine).
 */
async function runAndRecord(opts: { shareGpu: boolean; settings?: Parameters<typeof defaultSettings>[0]; series?: boolean }) {
  const video = await writeDummyVideo(tmp);
  const buses = new EventBusRegistry();
  const events: string[] = [];
  let holder: string | undefined;
  const gpuSteps = new Set<PipelineStepId>(['stt', 'tts', 'alignment']);
  const s = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry: gpuRegistry(),
    bus: buses,
    setup: {
      getPreferences: async () => ({ autoUpdate: true, concurrency: { mode: 'auto' as const, shareGpu: opts.shareGpu } }),
    },
    engines: {
      heavyLaneOwner: () => holder,
      releaseHeavyLane: (owner: string) => {
        if (holder !== owner) return;
        holder = undefined;
        events.push('let go');
      },
    } as never,
  });
  const p = await s.createProject({
    ...createProjectInput(video, { name: 'GPU', settings: defaultSettings(opts.settings ?? {}) }),
    ...(opts.series ? { series: { minMinutes: 15, maxMinutes: 25, recapSec: 4, autoStart: false } } : {}),
  });
  const seen = new Set<string>();
  buses.get(p.id).subscribe((e) => {
    if (e.type !== 'step' || (e.step.status !== 'running' && e.step.status !== 'completed')) return;
    const key = `${e.step.id}:${e.step.status}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(key);
    if (e.step.status === 'running' && gpuSteps.has(e.step.id)) holder = p.id;
  });
  await s.runPipeline(p.id);
  await vi.waitFor(async () => expect(['completed', 'failed']).toContain((await store.getProject(p.id)).status), { timeout: 15_000 });
  expect((await store.getProject(p.id)).status).toBe('completed');
  return { events, project: p, orchestrator: s };
}

describe('sharing the graphics card between dubs', () => {
  it('lends the card for a step that does not use it, keeps it through GPU steps, and lets go when none is left', async () => {
    const { events } = await runAndRecord({ shareGpu: true });
    // Lent for the translation (not on the card here), taken again by the voices,
    // kept from the voices through alignment, let go before the mix and the render.
    expect(events).toEqual([
      'probe-video:running',
      'probe-video:completed',
      'extract-audio:running',
      'extract-audio:completed',
      'stt:running',
      'stt:completed',
      'let go',
      'translation:running',
      'translation:completed',
      'refine:running',
      'refine:completed',
      'tts:running',
      'tts:completed',
      'alignment:running',
      'alignment:completed',
      'let go',
      'audio-mix:running',
      'audio-mix:completed',
      'render:running',
      'render:completed',
    ]);
  });

  it('one GPU dub at a time (sharing off): the card is kept until no step uses it, as before', async () => {
    const { events } = await runAndRecord({ shareGpu: false });
    expect(events.filter((e) => e === 'let go')).toHaveLength(1);
    expect(events.indexOf('let go')).toBe(events.indexOf('alignment:completed') + 1);
  });

  it('lends the card for speaker detection, inside speech-to-text', async () => {
    const { events } = await runAndRecord({ shareGpu: true, settings: { diarize: true } });
    const lent = events.indexOf('let go');
    expect(lent).toBeGreaterThan(events.indexOf('stt:running'));
    expect(lent).toBeLessThan(events.indexOf('stt:completed'));
    // Not held again before the voices, so not let go again before the translation.
    expect(events.slice(lent + 1, events.indexOf('tts:running'))).not.toContain('let go');
  });

  it('a series analysis hands the card on once the transcript is done, sharing or not', async () => {
    for (const shareGpu of [true, false]) {
      const { events } = await runAndRecord({ shareGpu, settings: { diarize: true }, series: true });
      const handed = events.indexOf('let go');
      expect(handed).toBeGreaterThan(events.indexOf('stt:running'));
      expect(handed).toBeLessThan(events.indexOf('stt:completed'));
    }
  });

  it('a step waiting for the card says so, naming the dub that has it, and says it no more once it has it', async () => {
    const video = await writeDummyVideo(tmp);
    const other = await store.createProject(createProjectInput(video, { name: 'Tập 7' }));
    // The translation engine's start waits for the card (what EngineManager.waitForLane reports).
    const translation = Object.assign(new FakeTranslationProvider(), {
      translateSegments: async (input: Parameters<FakeTranslationProvider['translateSegments']>[0]) => {
        const report = currentLaneWaitReporter();
        report?.({ owner: other.id });
        await new Promise((resolve) => setTimeout(resolve, 50));
        report?.(undefined);
        return { segments: input.segments.map((seg) => ({ id: seg.id, translatedText: `[vi] ${seg.sourceText}` })) };
      },
    });
    const buses = new EventBusRegistry();
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), translation, new FakeTtsProvider(() => 900)),
      bus: buses,
    });
    const p = await s.createProject(createProjectInput(video, { name: 'Tập 8' }));
    const details: string[] = [];
    buses.get(p.id).subscribe((e) => {
      if (e.type === 'step' && e.step.id === 'translation' && e.step.status === 'running') {
        const d = e.step.detail;
        const said = d ? `${d.key}${d.params?.['name'] ? `:${d.params['name']}` : ''}` : 'none';
        if (details.at(-1) !== said) details.push(said);
      }
    });
    await s.runPipeline(p.id);
    await vi.waitFor(async () => expect((await store.getProject(p.id)).status).toBe('completed'), { timeout: 15_000 });
    expect(details).toEqual(['none', 'step-detail.gpu-wait-dub:Tập 7', 'none']);
  });

  it('through a GPU hold, a dub already on the card keeps it; sharing, one that has not used it yet waits', async () => {
    let gate: ((owner: string) => { by: string } | undefined) | undefined;
    let onHoldChange: (() => void) | undefined;
    const held = new Set<string>();
    let retried = 0;
    let prefs = { mode: 'auto' as const, shareGpu: true };
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: gpuRegistry(),
      bus: new EventBusRegistry(),
      setup: { getPreferences: async () => ({ autoUpdate: true, concurrency: prefs }) },
      engines: {
        heavyLaneOwner: () => undefined,
        releaseHeavyLane: () => undefined,
        setLaneGate: (g: typeof gate) => (gate = g),
        hasHeldLane: (owner: string) => held.has(owner),
        retryLane: () => (retried += 1),
      } as never,
      holds: {
        holding: () => ({ holder: 'voice-mask' }),
        live: () => [],
        setOnChange: (cb: () => void) => (onHoldChange = cb),
      } as never,
    });
    const inner = s as unknown as { running: Map<string, unknown>; workloads: Map<string, { needsHeavyEngine: boolean }> };
    for (const id of ['proj_used', 'proj_new']) {
      inner.running.set(id, { projectId: id });
      inner.workloads.set(id, { needsHeavyEngine: true });
    }
    held.add('proj_used');
    await s.queueState(); // reads the preferences: sharing on

    expect(gate?.('proj_used')).toBeUndefined();
    expect(gate?.('proj_new')).toEqual({ by: 'Voice Mask' });
    expect(gate?.('editor:proj_used')).toEqual({ by: 'Voice Mask' });

    // One GPU dub at a time: the dub the scheduler admitted keeps its right, as before.
    prefs = { mode: 'auto', shareGpu: false };
    await s.queueState();
    expect(gate?.('proj_new')).toBeUndefined();

    // A hold that comes or goes looks again at the dubs waiting for the card.
    onHoldChange?.();
    expect(retried).toBe(1);
    inner.running.clear();
  });

  it('the queue says which dub uses the card and which waits for its turn', async () => {
    const video = await writeDummyVideo(tmp);
    const p = await store.createProject(createProjectInput(video, { name: 'Tập 7' }));
    const q = await store.createProject(createProjectInput(video, { name: 'Tập 8' }));
    const since = Date.now() - 60_000;
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: gpuRegistry(),
      bus: new EventBusRegistry(),
      engines: {
        heavyLaneOwner: () => p.id,
        releaseHeavyLane: () => undefined,
        laneWaiters: () => [{ owner: q.id, packId: 'llama-cpp-cuda', since }],
      } as never,
    });
    // Two runs registered as running (as the scheduler would): their steps do not matter here.
    const running = (s as unknown as { running: Map<string, unknown> }).running;
    running.set(p.id, { projectId: p.id });
    running.set(q.id, { projectId: q.id });
    const state = await s.queueState();
    expect(state.shareGpu).toBe(true);
    expect(state.running.find((r) => r.projectId === p.id)).toMatchObject({ gpu: 'using' });
    expect(state.running.find((r) => r.projectId === q.id)).toMatchObject({
      gpu: 'waiting',
      gpuWaitSince: new Date(since).toISOString(),
      gpuWaitFor: 'Tập 7',
    });
    running.clear();
  });
});

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';

let tmp: string;
let store: ProjectStore;
let buses: EventBusRegistry;

async function buildProject(): Promise<{ project: Project; deps: RunnerDeps; media: FakeMediaService }> {
  const video = await writeDummyVideo(tmp);
  const project = await store.createProject(createProjectInput(video));

  const segments = makeSegments([
    [0, 1000, 'Hello'],
    [1000, 2000, 'World'],
  ]);

  // Configure per-segment WAV durations so probe() in the alignment step works.
  const paths = store.paths(project.id);
  const segmentDurations = new Map<string, number>([
    [paths.ttsSegment(1), 800],
    [paths.ttsSegment(2), 1100],
  ]);

  const media = new FakeMediaService({ segmentDurations });
  const registry = fakeRegistry(
    new FakeSttProvider(segments),
    new FakeTranslationProvider(),
    new FakeTtsProvider((id) => (id === 'seg_0001' ? 800 : 1100)),
  );
  const bus = buses.get(project.id);
  const logger = new ProjectLogger(paths.pipelineLog, bus);

  return { project, deps: { store, media, registry, bus, logger }, media };
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-runner-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('PipelineRunner end-to-end (mocked)', () => {
  it('runs all 8 steps and produces every artifact', async () => {
    const { project, deps } = await buildProject();
    const runner = new PipelineRunner(deps);
    const controller = new AbortController();

    await runner.run(project, { signal: controller.signal });

    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.status).toBe('completed');
    expect(pipeline.steps.every((s) => s.status === 'completed' || s.status === 'skipped')).toBe(true);
    expect(pipeline.progressPercent).toBe(100);

    const paths = store.paths(project.id);
    // Artifacts created by the run.
    for (const artifact of [
      paths.originalWav,
      paths.original16kMonoWav,
      paths.sourceJson,
      paths.sourceSrt,
      paths.translatedJson,
      paths.translatedSrt,
      paths.translatedVtt,
      paths.translatedAlignedJson,
      paths.ttsFullWav,
      paths.finalMixWav,
      paths.outputMp4,
    ]) {
      await expect(fsp.stat(artifact)).resolves.toBeTruthy();
    }

    // mediaInfo persisted on the project.
    const reloaded = await store.getProject(project.id);
    expect(reloaded.mediaInfo).toBeDefined();
    expect(reloaded.status).toBe('completed');

    // Alignment file content sane.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8'));
    expect(aligned).toHaveLength(2);
    expect(aligned[0].segmentId).toBe('seg_0001');
  });

  it('skips already-completed steps with existing artifacts on a second run', async () => {
    const { project, deps } = await buildProject();
    const runner = new PipelineRunner(deps);

    await runner.run(project, { signal: new AbortController().signal });

    // Second run: counts should not increase because steps are skipped.
    const sttBefore = (deps.registry.getStt() as FakeSttProvider).calls;
    const trBefore = (deps.registry.getTranslation() as FakeTranslationProvider).calls;
    const ttsBefore = (deps.registry.getTts() as FakeTtsProvider).calls;
    const mediaCallsBefore = (deps.media as FakeMediaService).calls.length;

    await runner.run(project, { signal: new AbortController().signal });

    expect((deps.registry.getStt() as FakeSttProvider).calls).toBe(sttBefore);
    expect((deps.registry.getTranslation() as FakeTranslationProvider).calls).toBe(trBefore);
    expect((deps.registry.getTts() as FakeTtsProvider).calls).toBe(ttsBefore);
    // The media service should not be invoked again (everything skipped).
    expect((deps.media as FakeMediaService).calls.length).toBe(mediaCallsBefore);

    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(pipeline.status).toBe('completed');
  });

  it('retryFromStep re-runs that step and downstream, re-skipping upstream', async () => {
    const { project, deps } = await buildProject();
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: new AbortController().signal });

    const sttBefore = (deps.registry.getStt() as FakeSttProvider).calls;
    const trBefore = (deps.registry.getTranslation() as FakeTranslationProvider).calls;

    // Retry from translation: STT must NOT run again, translation MUST.
    await runner.run(project, { retryFromStep: 'translation', signal: new AbortController().signal });

    expect((deps.registry.getStt() as FakeSttProvider).calls).toBe(sttBefore);
    expect((deps.registry.getTranslation() as FakeTranslationProvider).calls).toBe(trBefore + 1);

    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.status).toBe('completed');
    // Upstream steps were skipped this run; translation onward completed.
    const stt = pipeline.steps.find((s) => s.id === 'stt');
    const translation = pipeline.steps.find((s) => s.id === 'translation');
    expect(stt?.status).toBe('skipped');
    expect(translation?.status).toBe('completed');
  });

  it('fails the pipeline with NO_AUDIO_STREAM when the input has no audio', async () => {
    const video = await writeDummyVideo(tmp, 'noaudio.mp4');
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({ hasAudio: false }),
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    };
    const runner = new PipelineRunner(deps);

    let errorEvent: { code?: string } | undefined;
    bus.subscribe((e) => {
      if (e.type === 'error') errorEvent = e.error;
    });

    await runner.run(project, { signal: new AbortController().signal });

    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.status).toBe('failed');
    const probe = pipeline.steps.find((s) => s.id === 'probe-video');
    expect(probe?.status).toBe('failed');
    expect(errorEvent?.code).toBe('NO_AUDIO_STREAM');
  });

  it('emits state + step + done SSE events during a run', async () => {
    const { project, deps } = await buildProject();
    const runner = new PipelineRunner(deps);

    const types: string[] = [];
    deps.bus.subscribe((e) => types.push(e.type));

    await runner.run(project, { signal: new AbortController().signal });

    expect(types).toContain('state');
    expect(types).toContain('step');
    expect(types).toContain('done');
  });
});

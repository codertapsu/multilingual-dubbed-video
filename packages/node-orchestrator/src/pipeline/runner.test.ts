import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@videodubber/shared';
import { PipelineRunner, planSttChunks, type RunnerDeps } from './runner.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeMediaInfo,
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

describe('planSttChunks', () => {
  it('returns a single whole-file chunk at or below the threshold', () => {
    expect(planSttChunks(600_000, 600_000, 900_000)).toEqual([{ index: 0, startMs: 0, endMs: 600_000 }]);
    expect(planSttChunks(0, 600_000, 900_000)).toEqual([{ index: 0, startMs: 0, endMs: 0 }]);
  });

  it('splits long audio into fixed windows with no overlap', () => {
    expect(planSttChunks(150_000, 60_000, 60_000)).toEqual([
      { index: 0, startMs: 0, endMs: 60_000 },
      { index: 1, startMs: 60_000, endMs: 120_000 },
      { index: 2, startMs: 120_000, endMs: 150_000 },
    ]);
  });

  it('handles an exact multiple of the window cleanly', () => {
    expect(planSttChunks(120_000, 60_000, 60_000).map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 60_000],
      [60_000, 120_000],
    ]);
  });
});

describe('PipelineRunner — chunked STT (long audio)', () => {
  /** Build a runner over a long (100s) media with small chunk windows. */
  async function buildChunkingProject() {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(100_000) }); // 100s
    const registry = fakeRegistry(
      // One chunk-relative segment per call; offsets are applied per window.
      new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
      new FakeTranslationProvider(),
      new FakeTtsProvider(),
    );
    const bus = buses.get(project.id);
    const logger = new ProjectLogger(paths.pipelineLog, bus);
    const deps: RunnerDeps = { store, media, registry, bus, logger, sttChunkWindowMs: 30_000, sttChunkThresholdMs: 20_000 };
    return { project, paths, media, deps, bus };
  }

  it('clips into windows, transcribes each, and merges with absolute offsets', async () => {
    const { project, paths, media, deps, bus } = await buildChunkingProject();

    const progress: number[] = [];
    bus.subscribe((e) => {
      if (e.type === 'step' && e.step.id === 'stt' && typeof e.step.progressPercent === 'number') {
        progress.push(e.step.progressPercent);
      }
    });

    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });

    // 100s / 30s windows => 4 chunks: 4 clips + 4 transcribe calls.
    expect(media.calls.filter((c) => c.startsWith('clip16kMono:'))).toHaveLength(4);
    expect((deps.registry.getStt() as FakeSttProvider).calls).toBe(4);

    const source = JSON.parse(await fsp.readFile(paths.sourceJson, 'utf8')) as {
      segments: { id: string; index: number; startMs: number }[];
    };
    expect(source.segments).toHaveLength(4);
    expect(source.segments.map((s) => s.startMs)).toEqual([0, 30_000, 60_000, 90_000]);
    expect(source.segments.map((s) => s.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003', 'seg_0004']);
    expect(source.segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);

    // Progress was reported per chunk and reached 100.
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress.at(-1)).toBe(100);

    // Scratch chunk dir is reclaimed after success.
    await expect(fsp.stat(paths.sttChunksDir)).rejects.toBeTruthy();
  });

  it('resumes from an existing chunk checkpoint (skips already-done windows)', async () => {
    const { project, paths, media, deps } = await buildChunkingProject();

    // Pre-seed chunk 0's checkpoint so it is reused, not re-clipped/transcribed.
    await fsp.mkdir(paths.sttChunksDir, { recursive: true });
    await fsp.writeFile(
      paths.sttChunkJson(0),
      JSON.stringify({
        detectedLanguage: 'en',
        segments: [{ id: 'seg_0001', index: 0, startMs: 5, endMs: 900, sourceText: 'cached' }],
      }),
      'utf8',
    );

    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });

    // Chunk 0 reused => only 3 clips + 3 transcribe calls.
    expect(media.calls.filter((c) => c.startsWith('clip16kMono:'))).toHaveLength(3);
    expect((deps.registry.getStt() as FakeSttProvider).calls).toBe(3);

    const source = JSON.parse(await fsp.readFile(paths.sourceJson, 'utf8')) as {
      segments: { sourceText: string }[];
    };
    expect(source.segments).toHaveLength(4);
    expect(source.segments[0]!.sourceText).toBe('cached');
  });
});

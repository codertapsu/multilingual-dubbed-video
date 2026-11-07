/**
 * TTS goes out in bounded batches, with progress, and reports reused clips.
 *
 * The incident: a 21-minute dub sent all 120 utterances to the CPU neural
 * engine in ONE request under the 30-minute worker timeout. The engine needed
 * ~48 minutes, so step 6 failed twice at exactly 30:00, showing no progress
 * for any of it, and each retry started over. These drive the REAL runner.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineEvent, Project, TtsInput, TtsProvider, TtsResult } from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  createProjectInput,
  fakeMediaInfo,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';

let tmp: string;
let store: ProjectStore;
let buses: EventBusRegistry;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-tts-batch-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A TTS with a per-request limit that records each call; durations fit their windows. */
function batchingTts(
  limit: number | undefined,
  reusedPerCall = 0,
): TtsProvider & { inputs: TtsInput[] } {
  const inputs: TtsInput[] = [];
  return {
    id: 'piper-local',
    displayName: 'batching-tts',
    isLocal: true,
    ...(limit !== undefined ? { maxSegmentsPerRequest: limit } : {}),
    inputs,
    async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
      inputs.push(input);
      const segments = await Promise.all(
        input.segments.map(async (s) => {
          const num = Number.parseInt(s.id.replace(/\D/g, ''), 10);
          const audioPath = path.join(
            input.outputDir,
            `segment_${String(num).padStart(4, '0')}.wav`,
          );
          const durationMs = Math.max(300, s.endMs - s.startMs - 100);
          await fsp.mkdir(input.outputDir, { recursive: true });
          await fsp.writeFile(audioPath, String(durationMs), 'utf8');
          return {
            segmentId: s.id,
            text: s.text,
            audioPath,
            durationMs,
            startMs: s.startMs,
            endMs: s.endMs,
            speedRatio: 1,
          };
        }),
      );
      return {
        segments,
        engine: 'piper',
        ...(reusedPerCall ? { reusedSegments: reusedPerCall } : {}),
      };
    },
  };
}

/** Seven cues far enough apart that grouping keeps each its own utterance. */
const SEVEN_CUES = makeSegments(
  Array.from(
    { length: 7 },
    (_, i) => [i * 4000, i * 4000 + 1500, `line ${i + 1}`] as [number, number, string],
  ),
);

function deps(project: Project, tts: TtsProvider): RunnerDeps {
  const paths = store.paths(project.id);
  const bus = buses.get(project.id);
  return {
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(30_000) }),
    registry: fakeRegistry(new FakeSttProvider(SEVEN_CUES), new FakeTranslationProvider(), tts),
    bus,
    logger: new ProjectLogger(paths.pipelineLog, bus),
  };
}

describe('TTS batching', () => {
  it('splits a long run into requests no larger than the provider allows', async () => {
    const project = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
    const tts = batchingTts(3);
    const progress: number[] = [];
    buses.get(project.id).subscribe((e: PipelineEvent) => {
      if (e.type === 'step' && e.step.id === 'tts' && e.step.status === 'running')
        progress.push(e.step.progressPercent ?? 0);
    });

    await new PipelineRunner(deps(project, tts)).run(project, {
      signal: new AbortController().signal,
    });

    expect(tts.inputs.map((i) => i.segments.map((s) => s.id))).toEqual([
      ['seg_0001', 'seg_0002', 'seg_0003'],
      ['seg_0004', 'seg_0005', 'seg_0006'],
      ['seg_0007'],
    ]);
    // The bar moves between batches (not 0 -> 100 at the end), never backwards.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.filter((p) => p > 0 && p < 100).length).toBeGreaterThanOrEqual(2);
    const log = await fsp.readFile(store.paths(project.id).pipelineLog, 'utf8');
    expect(log).toContain('Synthesized 3/7 utterance(s)...');
    expect(log).toContain('Synthesized 6/7 utterance(s)...');
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.steps.find((s) => s.id === 'tts')?.status).toBe('completed');
  });

  it('keeps short runs in one request for providers that set no limit', async () => {
    const project = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
    const tts = batchingTts(undefined);
    await new PipelineRunner(deps(project, tts)).run(project, {
      signal: new AbortController().signal,
    });
    expect(tts.inputs).toHaveLength(1);
    expect(tts.inputs[0]!.segments).toHaveLength(7);
    const log = await fsp.readFile(store.paths(project.id).pipelineLog, 'utf8');
    expect(log).not.toContain('Synthesized 7/7'); // no progress chatter for a one-shot run
  });

  it('says so when a retry reused clips instead of synthesizing them again', async () => {
    const project = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
    await new PipelineRunner(deps(project, batchingTts(4, 4))).run(project, {
      signal: new AbortController().signal,
    });
    const log = await fsp.readFile(store.paths(project.id).pipelineLog, 'utf8');
    expect(log).toContain('Reused 8 clip(s) finished by an earlier run');
  });

  it('shows progress through the drift pass too, which can be as big as the first', async () => {
    // Two adjacent cues merge into one utterance; the engine speaks it far
    // shorter than its span, so the drift guard re-speaks each cue on its own.
    const stt = new FakeSttProvider(
      makeSegments([
        [0, 4000, 'long line one'],
        [4400, 8000, 'long line two'],
        [15_000, 16_000, 'far away line'],
      ]),
    );
    const inputs: TtsInput[] = [];
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'drifting-tts',
      isLocal: true,
      maxSegmentsPerRequest: 1,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        inputs.push(input);
        const segments = await Promise.all(
          input.segments.map(async (s) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10);
            const audioPath = path.join(
              input.outputDir,
              `segment_${String(num).padStart(4, '0')}.wav`,
            );
            const durationMs = s.endMs - s.startMs > 5000 ? 2000 : 800;
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return {
              segmentId: s.id,
              text: s.text,
              audioPath,
              durationMs,
              startMs: s.startMs,
              endMs: s.endMs,
              speedRatio: 1,
            };
          }),
        );
        return { segments, engine: 'piper' };
      },
    };
    const project = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
    const progress: number[] = [];
    buses.get(project.id).subscribe((e: PipelineEvent) => {
      if (e.type === 'step' && e.step.id === 'tts' && e.step.status === 'running')
        progress.push(e.step.progressPercent ?? 0);
    });
    const d = deps(project, tts);
    await new PipelineRunner({
      ...d,
      registry: fakeRegistry(stt, new FakeTranslationProvider(), tts),
    }).run(project, {
      signal: new AbortController().signal,
    });

    const log = await fsp.readFile(store.paths(project.id).pipelineLog, 'utf8');
    expect(log).toContain('Re-synthesizing 2 cue(s) individually');
    expect(log).toContain('Re-synthesized 1/2 cue(s)...');
    // The first pass ends at 80%, the drift pass fills the rest, in order.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toContain(80);
    expect(progress.some((p) => p > 80 && p < 100)).toBe(true);
  });
});

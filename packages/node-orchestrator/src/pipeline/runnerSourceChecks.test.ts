/**
 * The runner's checks of the source and of its own transcript
 * (docs/plans/production-requests-2026-11-23.md 1.1 and 1.6), with fakes:
 * no ffmpeg, no speech-to-text engine.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERIES_SETTINGS, type Project, type ProjectSettings, type SttProvider, type SttResult } from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import type { SpeechMapService } from './speechMap.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  defaultSettings,
  fakeMediaInfo,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';

let tmp: string;
let store: ProjectStore;
let buses: EventBusRegistry;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-source-checks-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

interface Built {
  project: Project;
  deps: RunnerDeps;
  media: FakeMediaService;
  paths: ReturnType<ProjectStore['paths']>;
}

async function build(opts: {
  durationMs?: number;
  settings?: Partial<ProjectSettings>;
  stt?: SttProvider;
  speechMap?: SpeechMapService;
  sttChunkWindowMs?: number;
  sttChunkThresholdMs?: number;
}): Promise<Built> {
  const video = await writeDummyVideo(tmp);
  const project = await store.createProject(createProjectInput(video, { settings: defaultSettings(opts.settings ?? {}) }));
  const paths = store.paths(project.id);
  const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(opts.durationMs ?? 10_000) });
  const stt: SttProvider =
    opts.stt ??
    ({
      id: 'faster-whisper',
      displayName: 'fixed',
      isLocal: true,
      async transcribe(): Promise<SttResult> {
        return { segments: makeSegments([[0, 1000, 'Hello']]), detectedLanguage: 'en', durationMs: 10_000 };
      },
    } satisfies SttProvider);
  const bus = buses.get(project.id);
  const deps: RunnerDeps = {
    store,
    media,
    registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 800)),
    bus,
    logger: new ProjectLogger(paths.pipelineLog, bus),
    ...(opts.speechMap ? { speechMap: opts.speechMap } : {}),
    ...(opts.sttChunkWindowMs ? { sttChunkWindowMs: opts.sttChunkWindowMs } : {}),
    ...(opts.sttChunkThresholdMs ? { sttChunkThresholdMs: opts.sttChunkThresholdMs } : {}),
  };
  return { project, deps, media, paths };
}

/** Run the pipeline up to the end of speech-to-text (the parent of a series stops there too). */
async function runToStt(b: Built): Promise<void> {
  const parent = { role: 'parent' as const, settings: { ...DEFAULT_SERIES_SETTINGS, aiProviderId: 'anthropic' }, state: 'analysing' as const };
  await store.saveProject({ ...(await store.getProject(b.project.id)), series: parent });
  await new PipelineRunner(b.deps).run(await store.getProject(b.project.id), { signal: new AbortController().signal });
}

async function warningsOf(projectId: string) {
  return (await store.getPipeline(projectId)).warnings ?? [];
}

async function log(b: Built): Promise<string> {
  return fsp.readFile(b.paths.pipelineLog, 'utf8');
}

describe('extract-audio: the audio against the picture (1.1)', () => {
  it('records the drift in the media info and the log, and warns from 0.5 s', async () => {
    const b = await build({});
    b.media.audioDrift = {
      driftMs: 4810,
      audioMs: 14_810,
      pictureMs: 10_000,
      method: 'packets',
      claimedAudioMs: 10_000,
      count: { codec: 'aac', sampleRate: 48000, packets: 695, frameSize: 1024, primingSamples: 1024 },
    };
    await runToStt(b);

    const info = (await store.getProject(b.project.id)).mediaInfo;
    expect(info?.audioDrift).toMatchObject({ driftMs: 4810, method: 'packets', claimedAudioMs: 10_000 });
    expect(info?.audioDrift?.measuredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const drift = (await warningsOf(b.project.id)).find((w) => w.code === 'audio-drift');
    expect(drift).toMatchObject({ step: 'extract-audio', key: 'warning.audio-drift', params: { seconds: 4.8 } });
    expect(await log(b)).toContain('Audio vs picture: the audio holds 14.81 s, the picture lasts 10.00 s: +4.81 s');
  });

  it('a small drift is recorded and logged, never a warning', async () => {
    const b = await build({});
    b.media.audioDrift = { driftMs: 20, audioMs: 10_020, pictureMs: 10_000, method: 'decode', count: { codec: 'opus', sampleRate: 48000, samples: 480_960 } };
    await runToStt(b);
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift?.driftMs).toBe(20);
    expect((await warningsOf(b.project.id)).map((w) => w.code)).not.toContain('audio-drift');
    expect(await log(b)).toContain('+0.02 s (480960 samples decoded, opus 48000 Hz)');
  });

  it("a series part measures its own window, replacing the parent's whole-video value", async () => {
    const b = await build({ durationMs: 60_000 });
    const fresh = await store.getProject(b.project.id);
    await store.saveProject({
      ...fresh,
      sourceRange: { startMs: 600_000, endMs: 660_000 },
      mediaInfo: { ...fakeMediaInfo(60_000), audioDrift: { driftMs: 4810, audioMs: 1, pictureMs: 1, method: 'packets', measuredAt: 'then' } },
    });
    b.media.audioDrift = { driftMs: 30, audioMs: 60_030, pictureMs: 60_000, method: 'packets', range: { startMs: 600_000, endMs: 660_000 } };
    await runToStt(b);
    expect(b.media.driftRanges).toEqual([{ startMs: 600_000, endMs: 660_000 }]);
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift).toMatchObject({ driftMs: 30, range: { startMs: 600_000 } });
  });

  it('a measurement that fails never fails the step, and leaves no stale value', async () => {
    const b = await build({});
    const fresh = await store.getProject(b.project.id);
    await store.saveProject({
      ...fresh,
      mediaInfo: { ...fakeMediaInfo(10_000), audioDrift: { driftMs: 999, audioMs: 1, pictureMs: 1, method: 'packets', measuredAt: 'then' } },
    });
    b.media.measureAudioDrift = async () => {
      throw new Error('ffprobe crashed');
    };
    await runToStt(b);
    const pipeline = await store.getPipeline(b.project.id);
    expect(pipeline.steps.find((s) => s.id === 'extract-audio')?.status).toBe('completed');
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift).toBeUndefined();
    expect(await log(b)).toContain('Could not measure the audio against the picture (ffprobe crashed)');
  });
});

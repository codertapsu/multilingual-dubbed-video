import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ActivityEntry, SttInput, SttProvider, SttResult, TranscriptSegment } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { saveSpeakerJob, speakerJobFile } from './pipeline/speakerJob.js';
import type { DiarizationService } from './providers/diarization/sherpaDiarizationProvider.js';
import { createServer } from './server.js';
import { FakeMediaService, FakeTranslationProvider, FakeTtsProvider, createProjectInput, fakeMediaInfo, fakeRegistry, writeDummyVideo } from './test/fixtures.js';
import { diarizationBudget, projectJobViews } from './transcriptJobs.js';
import { ProjectStore } from './workspace/projectStore.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const entry = (id: string, kind: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  kind,
  title: kind,
  projectId: 'p1',
  initiator: { kind: 'mcp', client: 'claude-code' },
  state: 'running',
  percent: 40,
  startedAt: iso(NOW - 10 * MIN),
  updatedAt: iso(NOW - MIN),
  ...extra,
});

describe("a project's jobs", () => {
  it('lists what works now and what ended in the last half hour, newest first', () => {
    const views = projectJobViews(
      [
        entry('a', 'series.rebuild', { state: 'done', endedAt: iso(NOW - 40 * MIN), updatedAt: iso(NOW - 40 * MIN) }),
        entry('b', 'lines.retranscribe', { state: 'done', percent: 100, endedAt: iso(NOW - 5 * MIN), updatedAt: iso(NOW - 5 * MIN), result: '14 lines' }),
        entry('c', 'speakers.detect', { etaSec: 600 }),
      ],
      { live: new Set(['c']), now: NOW },
    );
    expect(views.map((v) => [v.id, v.state])).toEqual([
      ['c', 'running'],
      ['b', 'done'],
    ]);
    expect(views[0]).toMatchObject({ etaSec: 600, initiator: { kind: 'mcp', client: 'claude-code' } });
  });

  it('shows a detection or re-transcription no live job holds as interrupted, and one saved in the project folder', () => {
    const kept = projectJobViews([entry('old', 'speakers.detect'), entry('other', 'series.plan')], { live: new Set(), now: NOW });
    expect(kept.map((v) => [v.id, v.state])).toEqual([
      ['old', 'interrupted'],
      ['other', 'running'],
    ]);
    const saved = projectJobViews([], {
      live: new Set(),
      now: NOW,
      savedSpeakerJob: { state: 'interrupted', done: 3, total: 12, startedAt: iso(NOW - 2 * 3_600_000), range: { fromMs: 0, toMs: 60 * MIN } },
    });
    expect(saved).toEqual([
      expect.objectContaining({ kind: 'speakers.detect', state: 'interrupted', percent: 25, message: 'Part 3/12', title: 'Detecting speakers at 0:00–1:00:00' }),
    ]);
  });

  it('lets speaker detection widen only while nothing heavy runs', () => {
    expect(diarizationBudget({ heavyLane: false, runs: [], pressure: false })).toBe(Number.POSITIVE_INFINITY);
    expect(diarizationBudget({ heavyLane: false, runs: [{ step: 'translation', heavy: false }], pressure: false })).toBe(Number.POSITIVE_INFINITY);
    expect(diarizationBudget({ heavyLane: true, runs: [], pressure: false })).toBe(1);
    expect(diarizationBudget({ heavyLane: false, runs: [{ step: 'tts', heavy: true }], pressure: false })).toBe(1);
    expect(diarizationBudget({ heavyLane: false, runs: [{ step: 'render', heavy: false }], pressure: false })).toBe(1);
    expect(diarizationBudget({ heavyLane: false, runs: [], pressure: true })).toBe(1);
  });
});

/** Speech-to-text that answers by the clip it is cut (range_<from>_<to>.wav): one line, 1 s in. */
class ClipStt implements SttProvider {
  readonly id = 'faster-whisper';
  readonly displayName = 'Clip STT';
  readonly isLocal = true;

  async transcribe(input: SttInput): Promise<SttResult> {
    const [, from, to] = /range_(\d+)_(\d+)\.wav$/.exec(input.audioPath)!.map(Number) as [number, number, number];
    return { segments: [{ id: 's', index: 0, startMs: 1000, endMs: 3000, sourceText: `heard at ${from}` }], detectedLanguage: 'zh', durationMs: to - from };
  }
}

describe('the routes', () => {
  let tmp: string;
  let app: FastifyInstance;
  let store: ProjectStore;
  let id: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-jobs-routes-'));
    // Workers on ports nothing listens on: nothing here may reach a running app's (5100-5103).
    const config = loadConfig({
      projectsDir: path.join(tmp, 'projects'),
      configDir: path.join(tmp, 'config'),
      modelsDir: path.join(tmp, 'models'),
      sttWorkerUrl: 'http://127.0.0.1:5221',
      translationWorkerUrl: 'http://127.0.0.1:5222',
      ttsWorkerUrl: 'http://127.0.0.1:5223',
    });
    store = new ProjectStore(config.projectsDir);
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(40 * MIN) });
    const registry = fakeRegistry(new ClipStt(), new FakeTranslationProvider(), new FakeTtsProvider(() => 900));
    const diarization: DiarizationService = { diarize: async () => null, available: async () => true, modelKey: 'fake' };
    const orchestrator = new LocalJobOrchestrator({ config, store, media, registry, bus: new EventBusRegistry(), diarization });
    app = await createServer({ config, media, registry, store, orchestrator });

    const created = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
    id = created.id;
    await store.saveProject({ ...created, mediaInfo: fakeMediaInfo(40 * MIN), settings: { ...created.settings, sourceLanguage: 'zh', diarize: true } });
    const paths = store.paths(id);
    await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
    await fsp.mkdir(path.dirname(paths.original16kMonoWav), { recursive: true });
    await fsp.writeFile(paths.original16kMonoWav, Buffer.alloc(64));
    const source: TranscriptSegment[] = [
      { id: 'seg_0001', index: 0, startMs: 1000, endMs: 3000, sourceText: 'heard at 0', speakerId: 'SPEAKER_00' },
      { id: 'seg_0002', index: 1, startMs: 20 * MIN, endMs: 20 * MIN + 2000, sourceText: 'x', speakerId: 'SPEAKER_00' },
    ];
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: source }), 'utf8');
    const stat = await fsp.stat(paths.original16kMonoWav);
    await fsp.writeFile(
      paths.diarizationJson,
      JSON.stringify({
        format: 2,
        audio: { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
        model: 'fake',
        turns: [{ startMs: 0, endMs: 40 * MIN, speaker: 0 }],
        speakers: [{ speaker: 0, sec: 60, f0Hz: 110, gender: 'male', genderConfidence: 0.9, print: [1, 0], speakerId: 'SPEAKER_00' }],
      }),
    );
  });

  afterEach(async () => {
    await app.close();
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('answers a short range at once, and a long one with a job to follow', async () => {
    const short = await app.inject({ method: 'POST', url: `/projects/${id}/lines/retranscribe`, payload: { fromMs: 0, toMs: 5 * MIN } });
    expect(short.statusCode).toBe(200);
    expect(short.json()).toMatchObject({ lines: [{ text: 'heard at 0', speakerId: 'SPEAKER_00' }], speakers: { carried: 1, unassigned: 0 } });

    const long = await app.inject({ method: 'POST', url: `/projects/${id}/lines/retranscribe`, payload: { fromMs: 0, toMs: 40 * MIN, apply: true } });
    expect(long.statusCode).toBe(202);
    const { job } = long.json() as { job: { id: string; windows: number } };
    expect(job.windows).toBe(3);
    await vi.waitFor(async () => {
      const res = await app.inject({ method: 'GET', url: `/projects/${id}/lines/retranscribe/${job.id}` });
      expect(res.json()).toMatchObject({ state: 'done', done: 3, result: { lines: 3, replaced: 2 } });
    });
    expect((await app.inject({ method: 'GET', url: `/projects/${id}/lines/retranscribe/nope` })).statusCode).toBe(404);

    const jobs = (await app.inject({ method: 'GET', url: `/projects/${id}/jobs` })).json() as { jobs: { kind: string; state: string }[] };
    expect(jobs.jobs.map((j) => [j.kind, j.state])).toEqual([
      ['lines.retranscribe', 'done'],
      ['lines.retranscribe', 'done'],
    ]);
    expect((await app.inject({ method: 'GET', url: '/projects/proj_missing/jobs' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('detects the speakers of a range, and shows a detection the app died on as interrupted', async () => {
    // A re-transcribed line with no speaker yet.
    await app.inject({ method: 'POST', url: `/projects/${id}/lines/replace`, payload: { fromMs: 20 * MIN, toMs: 21 * MIN, lines: [{ startMs: 20 * MIN, endMs: 20 * MIN + 2000, text: 'y' }] } });
    const started = await app.inject({ method: 'POST', url: `/projects/${id}/speakers/detect`, payload: { fromMs: 20 * MIN, toMs: 21 * MIN } });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const doc = (await app.inject({ method: 'GET', url: `/projects/${id}/speakers` })).json() as { job?: { state: string; range?: unknown; relabelled?: number } };
      expect(doc.job).toMatchObject({ state: 'done', range: { fromMs: 20 * MIN, toMs: 21 * MIN }, relabelled: 1 });
    });
    const half = await app.inject({ method: 'POST', url: `/projects/${id}/speakers/detect`, payload: { fromMs: 20 * MIN } });
    expect(half.statusCode).toBe(400);

    // As a restarted app finds it: saved running, run by nobody.
    await saveSpeakerJob(speakerJobFile(store.paths(id)), { state: 'running', done: 2, total: 6, startedAt: new Date().toISOString() });
    const config = loadConfig({
      projectsDir: path.join(tmp, 'projects'),
      configDir: path.join(tmp, 'config2'),
      modelsDir: path.join(tmp, 'models'),
      sttWorkerUrl: 'http://127.0.0.1:5221',
      translationWorkerUrl: 'http://127.0.0.1:5222',
      ttsWorkerUrl: 'http://127.0.0.1:5223',
    });
    const media = new FakeMediaService();
    const registry = fakeRegistry(new ClipStt(), new FakeTranslationProvider(), new FakeTtsProvider(() => 900));
    const again = await createServer({ config, media, registry, store, orchestrator: new LocalJobOrchestrator({ config, store, media, registry, bus: new EventBusRegistry() }) });
    try {
      const doc = (await again.inject({ method: 'GET', url: `/projects/${id}/speakers` })).json() as { job?: { state: string } };
      expect(doc.job).toMatchObject({ state: 'interrupted', done: 2, total: 6 });
      const jobs = (await again.inject({ method: 'GET', url: `/projects/${id}/jobs` })).json() as { jobs: { kind: string; state: string }[] };
      // (This test process keeps one activity list: the ranged detection that ended is in it too.)
      expect(jobs.jobs.map((j) => [j.kind, j.state])).toEqual([
        ['speakers.detect', 'interrupted'],
        ['speakers.detect', 'done'],
      ]);
    } finally {
      await again.close();
    }
  });
});

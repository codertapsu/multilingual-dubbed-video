import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { listEdits } from './activity/history.js';
import { activity } from './activity/registry.js';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { readSpeakerJob, saveSpeakerJob, speakerJobFile } from './pipeline/speakerJob.js';
import type { Diarization, DiarizationService } from './providers/diarization/sherpaDiarizationProvider.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeMediaInfo,
  fakeRegistry,
  writeDummyVideo,
} from './test/fixtures.js';
import { ProjectStore } from './workspace/projectStore.js';

function lines(spec: [number, number, string?][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, speakerId], i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    index: i,
    startMs,
    endMs,
    sourceText: `line ${i + 1}`,
    ...(speakerId ? { speakerId } : {}),
  }));
}

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-spkjob-orch-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setup(service: DiarizationService, source: TranscriptSegment[]): Promise<{ orchestrator: LocalJobOrchestrator; id: string }> {
  const orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
    registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
    diarization: service,
  });
  const created = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
  await store.saveProject({
    ...created,
    settings: { ...created.settings, diarize: true, speakerVoices: [{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }] },
  });
  const paths = store.paths(created.id);
  await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
  await fsp.mkdir(path.dirname(paths.original16kMonoWav), { recursive: true });
  await fsp.writeFile(paths.original16kMonoWav, Buffer.alloc(64));
  await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: source }), 'utf8');
  return { orchestrator, id: created.id };
}

const read = async (file: string): Promise<TranscriptSegment[]> => (JSON.parse(await fsp.readFile(file, 'utf8')) as { segments: TranscriptSegment[] }).segments;

describe('detecting the speakers of a range, as a job', () => {
  it('labels only that range, linked to the known speakers, and reports it everywhere', async () => {
    const service: DiarizationService = { diarize: async () => null, available: async () => true, modelKey: 'fake' };
    // A re-transcription left the middle line without a speaker.
    const source = lines([[0, 4000, 'SPEAKER_00'], [5500, 8000], [9000, 9500, 'SPEAKER_00']]);
    const { orchestrator, id } = await setup(service, source);
    const paths = store.paths(id);
    const stat = await fsp.stat(paths.original16kMonoWav);
    await fsp.writeFile(
      paths.diarizationJson,
      JSON.stringify({
        format: 2,
        audio: { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
        model: 'fake',
        turns: [
          { startMs: 0, endMs: 5000, speaker: 0 },
          { startMs: 5000, endMs: 9000, speaker: 1 },
          { startMs: 9000, endMs: 9500, speaker: 0 },
        ],
        speakers: [
          { speaker: 0, sec: 5, f0Hz: 110, gender: 'male', genderConfidence: 0.9, print: [1, 0], speakerId: 'SPEAKER_00' },
          { speaker: 1, sec: 4, f0Hz: 230, gender: 'female', genderConfidence: 0.8, print: [0, 1] },
        ],
      }),
    );
    // The warning the re-transcription left.
    await orchestrator.replaceSourceLines(id, 5000, 8500, [{ startMs: 5500, endMs: 8000, text: 'line 2' }]);
    expect((await store.getPipeline(id)).warnings?.map((w) => w.code)).toEqual(['speakers-unassigned']);

    expect(await orchestrator.startSpeakerDetection(id, { fromMs: 5000, toMs: 8500 })).toEqual({ started: true });
    await vi.waitFor(() => expect(orchestrator.speakerJob(id)?.state).toBe('done'), { timeout: 5000 });
    expect(orchestrator.speakerJob(id)).toMatchObject({ range: { fromMs: 5000, toMs: 8500 }, relabelled: 1, added: 1, detectedParts: 0 });

    expect((await read(paths.sourceJson)).map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    const project = await store.getProject(id);
    // Known speakers keep their ids, so their voices; the new one has a gender for the default voices.
    expect(project.settings.speakerVoices).toEqual([{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }]);
    expect(project.settings.speakerGenders).toEqual({ SPEAKER_01: 'female' });
    expect((await store.getPipeline(id)).warnings ?? []).toEqual([]);
    expect((await listEdits(id))[0]!.summary).toBe('Detected speakers at 0:05–0:09: 1 of 1 line(s) changed speaker, 1 new speaker(s)');
    const entry = activity.get(orchestrator.speakerJob(id)!.activityId!);
    expect(entry).toMatchObject({ kind: 'speakers.detect', state: 'done', title: 'Detecting speakers at 0:05–0:09', projectId: id });
    // Saved as it ended, for after a restart.
    await vi.waitFor(async () => expect((await readSpeakerJob(speakerJobFile(paths)))?.state).toBe('done'));
  });

  it('refuses a range with one end only', async () => {
    const service: DiarizationService = { diarize: async () => null, available: async () => true, modelKey: 'fake' };
    const { orchestrator, id } = await setup(service, lines([[0, 1000]]));
    await expect(orchestrator.startSpeakerDetection(id, { fromMs: 1000 })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
  });
});

describe('a detection job outlives the app', () => {
  it('is saved while it runs, keeps the lines from changing under it, and shows as interrupted after a restart', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const result: Diarization = { turns: [{ startMs: 0, endMs: 2000, speaker: 0 }], speakers: [{ speaker: 0, sec: 2, f0Hz: 110, gender: 'male', genderConfidence: 0.9, print: [1, 0] }] };
    const service: DiarizationService = {
      diarize: async (_audio, opts) => {
        opts.onProgress?.(0, 1);
        await gate;
        return result;
      },
      available: async () => true,
      modelKey: 'fake',
    };
    const { orchestrator, id } = await setup(service, lines([[0, 1900]]));
    const paths = store.paths(id);
    await orchestrator.startSpeakerDetection(id);
    await vi.waitFor(async () => expect((await readSpeakerJob(speakerJobFile(paths)))?.state).toBe('running'));
    expect((await orchestrator.speakerJobState(id))?.state).toBe('running');
    await expect(orchestrator.replaceSourceLines(id, 0, 1000, [])).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    await expect(orchestrator.retranscribeRange(id, 0, 1000)).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    release();
    await vi.waitFor(() => expect(orchestrator.speakerJob(id)?.state).toBe('done'), { timeout: 5000 });

    // Another process (the app started again) finds a job saved as running that nobody runs.
    await saveSpeakerJob(speakerJobFile(paths), { state: 'running', done: 3, total: 12, startedAt: '2026-11-23T10:00:00.000Z' });
    const restarted = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      diarization: service,
    });
    expect(restarted.speakerJob(id)).toBeUndefined();
    expect(await restarted.speakerJobState(id)).toMatchObject({ state: 'interrupted', done: 3, total: 12 });
    // Retry starts it again (the saved parts make it resume).
    expect(await restarted.startSpeakerDetection(id)).toEqual({ started: true });
    await vi.waitFor(() => expect(restarted.speakerJob(id)?.state).toBe('done'), { timeout: 5000 });
    expect(restarted.liveLineJobIds().size).toBe(0);
  });
});

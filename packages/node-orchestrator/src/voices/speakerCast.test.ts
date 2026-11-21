import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSettings, TranscriptSegment } from '@videodubber/shared';

import { loadConfig } from '../config.js';
import { EventBusRegistry } from '../events.js';
import { LocalJobOrchestrator } from '../orchestrator.js';
import type { Diarization, DiarizationService } from '../providers/diarization/sherpaDiarizationProvider.js';
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
import { ProjectStore } from '../workspace/projectStore.js';
import { castSettings, proposeCast, speakerRows, withSwaps } from './speakerCast.js';

const lines = (spec: [number, number, string, string?][]): TranscriptSegment[] =>
  makeSegments(spec.map(([a, b, t]) => [a, b, t])).map((s, i) => (spec[i]![3] ? { ...s, speakerId: spec[i]![3] } : s));

describe('speakerRows', () => {
  it('lists the speakers the lines carry, most-heard first, with what detection knows and their voice', () => {
    const settings = { ttsVoiceId: 'project', speakerVoices: [{ speakerId: 'SPEAKER_01', voiceId: 'vp_vy' }], speakerGenders: { SPEAKER_00: 'male' as const }, defaultMaleVoiceId: 'm-default' } as ProjectSettings;
    const rows = speakerRows(
      lines([
        [0, 1000, 'a', 'SPEAKER_00'],
        [1000, 9000, 'long line by B', 'SPEAKER_01'],
        [9000, 10_000, 'nobody'],
      ]),
      [{ speakerId: 'SPEAKER_01', speaker: 1, sec: 600, f0Hz: 230, gender: 'female', genderConfidence: 0.8, print: [1, 0] }],
      settings,
    );
    expect(rows.map((r) => r.speakerId)).toEqual(['SPEAKER_01', 'SPEAKER_00']);
    expect(rows[0]).toMatchObject({ minutes: 10, f0Hz: 230, gender: 'female', genderConfidence: 0.8, voiceId: 'vp_vy', lines: 1 });
    // No detection record: the lines' length, the gender from the settings, the default voice of it.
    expect(rows[1]).toMatchObject({ gender: 'male', voiceId: 'm-default' });
    expect(rows[1]!.minutes).toBeCloseTo(1000 / 60_000);
  });
});

describe('castSettings / withSwaps', () => {
  it('writes only the distinct voices, the genders and a default per gender', () => {
    const speakers = [
      { speakerId: 'SPEAKER_00', minutes: 50, gender: 'male' as const, f0Hz: 110 },
      { speakerId: 'SPEAKER_01', minutes: 10, gender: 'male' as const, f0Hz: 130 },
      { speakerId: 'SPEAKER_02', minutes: 5, gender: 'unknown' as const },
    ];
    const voices = [{ voiceId: 'vp_thien', name: 'Thiện', kind: 'profile' as const, gender: 'male' as const, genderConfirmed: true, f0Hz: 116 }];
    const proposal = proposeCast(speakers, voices);
    const patch = castSettings(proposal, speakers);
    expect(patch).toEqual({
      speakerVoices: [{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }],
      speakerGenders: { SPEAKER_00: 'male', SPEAKER_01: 'male' },
      defaultMaleVoiceId: 'vp_thien',
    });
    // The user swaps a speaker to another castable voice; unknown voices are ignored.
    const swapped = withSwaps(proposal, [{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }, { speakerId: 'SPEAKER_01', voiceId: 'nope' }], voices);
    expect(swapped.assignments.find((a) => a.speakerId === 'SPEAKER_01')!.voiceId).toBe('vp_thien');
  });
});

describe('detecting speakers again, as a job', () => {
  let tmp: string;
  let store: ProjectStore;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-spk-'));
    store = new ProjectStore(path.join(tmp, 'projects'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('labels the lines in the background, moves speaker voices to the new ids, and records genders', async () => {
    const result: Diarization = {
      turns: [
        { startMs: 0, endMs: 2000, speaker: 0 },
        { startMs: 2000, endMs: 4000, speaker: 1 },
      ],
      speakers: [
        { speaker: 0, sec: 2, f0Hz: 220, gender: 'female', genderConfidence: 0.8, print: [1, 0] },
        { speaker: 1, sec: 2, f0Hz: 110, gender: 'male', genderConfidence: 0.9, print: [0, 1] },
      ],
    };
    const service: DiarizationService = { diarize: async () => result, available: async () => true, modelKey: 'fake' };
    const orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(4000) }),
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      diarization: service,
    });
    const project = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
    const paths = store.paths(project.id);
    await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
    await fsp.mkdir(path.dirname(paths.original16kMonoWav), { recursive: true });
    await fsp.writeFile(paths.original16kMonoWav, Buffer.alloc(64));
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: lines([[0, 1900, 'chào'], [2100, 3900, 'ừ']]) }), 'utf8');

    expect(await orchestrator.startSpeakerDetection(project.id)).toEqual({ started: true });
    expect(orchestrator.busyProjects()).toContain(project.id);
    await vi.waitFor(() => expect(orchestrator.speakerJob(project.id)?.state).toBe('done'), { timeout: 5000 });
    expect(orchestrator.speakerJob(project.id)).toMatchObject({ speakers: 2 });

    const doc = JSON.parse(await fsp.readFile(paths.sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(doc.segments.map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    const saved = await store.getProject(project.id);
    expect(saved.settings.diarize).toBe(true);
    expect(saved.settings.speakerGenders).toEqual({ SPEAKER_00: 'female', SPEAKER_01: 'male' });
  });
});

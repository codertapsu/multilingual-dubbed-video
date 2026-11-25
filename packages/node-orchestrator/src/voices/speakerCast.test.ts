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
  it('never leaves a clone as the default the crowd falls back to (F4)', () => {
    const speakers = [
      { speakerId: 'SPEAKER_00', minutes: 50, gender: 'male' as const, f0Hz: 110 },
      { speakerId: 'SPEAKER_01', minutes: 10, gender: 'male' as const, f0Hz: 130 },
      { speakerId: 'SPEAKER_02', minutes: 5, gender: 'unknown' as const },
    ];
    const voices = [{ voiceId: 'vp_thien', name: 'Thiện', kind: 'profile' as const, gender: 'male' as const, genderConfirmed: true, f0Hz: 116 }];
    const proposal = proposeCast(speakers, voices);
    const patch = castSettings(proposal, speakers);
    // The one male voice is a clone of the main speaker's: the minor one gets
    // none, and the default (the user's clone, before) is cleared.
    expect(patch).toEqual({
      speakerVoices: [{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }],
      speakerGenders: { SPEAKER_00: 'male', SPEAKER_01: 'male' },
      defaultMaleVoiceId: '',
    });
    // The user swaps a speaker to another castable voice (a clone, their
    // choice); unknown voices are ignored.
    const swapped = withSwaps(proposal, [{ speakerId: 'SPEAKER_00', voiceId: 'vp_thien' }, { speakerId: 'SPEAKER_01', voiceId: 'nope' }], voices);
    expect(swapped.assignments.find((a) => a.speakerId === 'SPEAKER_01')).toBeUndefined();
    const picked = withSwaps(proposal, [{ speakerId: 'SPEAKER_01', voiceId: 'vp_thien' }], voices);
    expect(picked.assignments.find((a) => a.speakerId === 'SPEAKER_01')).toMatchObject({ voiceId: 'vp_thien', by: 'order' });
  });

  it('writes a voice for every minor speaker (a pool is not one default), most heard first; the default is the pool\'s', () => {
    const speakers = [
      { speakerId: 'SPEAKER_00', minutes: 50, gender: 'male' as const, f0Hz: 110 },
      { speakerId: 'SPEAKER_01', minutes: 3, gender: 'male' as const, f0Hz: 130 },
      { speakerId: 'SPEAKER_02', minutes: 2, gender: 'male' as const, f0Hz: 140 },
      { speakerId: 'SPEAKER_03', minutes: 1, gender: 'unknown' as const },
    ];
    const voices = [
      { voiceId: 'vp_thien', name: 'Thiện', kind: 'profile' as const, gender: 'male' as const, genderConfirmed: true, f0Hz: 116 },
      { voiceId: 'builtin-a', name: 'A', kind: 'preset' as const, gender: 'male' as const, f0Hz: 120 },
    ];
    const proposal = proposeCast(speakers, voices);
    // The user had given the unknown speaker a voice by hand: it stays.
    const patch = castSettings(proposal, speakers, [
      { speakerId: 'SPEAKER_03', voiceId: 'hand-picked' },
      { speakerId: 'SPEAKER_09', voiceId: 'gone-speaker' },
    ]);
    expect(patch.speakerVoices).toEqual([
      { speakerId: 'SPEAKER_00', voiceId: 'vp_thien' },
      { speakerId: 'SPEAKER_01', voiceId: 'builtin-a' },
      { speakerId: 'SPEAKER_02', voiceId: 'builtin-a' },
      { speakerId: 'SPEAKER_03', voiceId: 'hand-picked' },
    ]);
    expect(patch.defaultMaleVoiceId).toBe('builtin-a');
    expect(patch.defaultFemaleVoiceId).toBeUndefined();
    // SPEAKER_02 is the minor one, on the built-in SPEAKER_01 has too; swapped,
    // it leaves the pool voice's list.
    expect(proposal.pools.male!.voices).toMatchObject([{ voiceId: 'builtin-a', from: 'reused', sharedWith: 'SPEAKER_01', speakers: ['SPEAKER_02'] }]);
    const swapped = withSwaps(proposal, [{ speakerId: 'SPEAKER_02', voiceId: 'vp_thien' }], voices);
    expect(swapped.pools.male!.voices[0]!.speakers).toEqual([]);
    expect(proposal.pools.male!.voices[0]!.speakers).toEqual(['SPEAKER_02']);
  });

  it('gives a voice kept for one main character to one speaker: a swap to a second one is left out, and said', () => {
    const speakers = [
      { speakerId: 'SPEAKER_00', minutes: 50, gender: 'male' as const, f0Hz: 110 },
      { speakerId: 'SPEAKER_01', minutes: 10, gender: 'male' as const, f0Hz: 130 },
    ];
    const voices = [
      { voiceId: 'vp_mine', name: 'Giọng của tôi', kind: 'profile' as const, gender: 'male' as const, genderConfirmed: true, f0Hz: 116, mainOnly: true },
      { voiceId: 'builtin-a', name: 'A', kind: 'preset' as const, gender: 'male' as const, f0Hz: 120 },
    ];
    const proposal = proposeCast(speakers, voices);
    expect(proposal.assignments.find((a) => a.speakerId === 'SPEAKER_00')).toMatchObject({ voiceId: 'vp_mine' });
    const refused = withSwaps(proposal, [{ speakerId: 'SPEAKER_01', voiceId: 'vp_mine' }], voices);
    expect(refused.assignments.find((a) => a.speakerId === 'SPEAKER_01')).toMatchObject({ voiceId: 'builtin-a' });
    expect(refused.notes).toContain('"Giọng của tôi" is kept for one main character (SPEAKER_00 has it): not given to SPEAKER_01 too.');
    // Moved in one call: the first speaker off it, the second onto it.
    const moved = withSwaps(
      proposal,
      [
        { speakerId: 'SPEAKER_00', voiceId: 'builtin-a' },
        { speakerId: 'SPEAKER_01', voiceId: 'vp_mine' },
      ],
      voices,
    );
    expect(moved.assignments.map((a) => [a.speakerId, a.voiceId])).toEqual([
      ['SPEAKER_00', 'builtin-a'],
      ['SPEAKER_01', 'vp_mine'],
    ]);
  });

  it('no longer lists a speaker of unknown gender a swap gave a voice', () => {
    const speakers = [
      { speakerId: 'SPEAKER_00', minutes: 50, gender: 'male' as const, f0Hz: 110 },
      { speakerId: 'SPEAKER_05', minutes: 2, gender: 'unknown' as const },
      { speakerId: 'SPEAKER_06', minutes: 1, gender: 'unknown' as const },
    ];
    const voices = [{ voiceId: 'builtin-a', name: 'A', kind: 'preset' as const, gender: 'male' as const, f0Hz: 120 }];
    const proposal = proposeCast(speakers, voices);
    expect(proposal.unassigned).toEqual(['SPEAKER_05', 'SPEAKER_06']);
    const swapped = withSwaps(proposal, [{ speakerId: 'SPEAKER_05', voiceId: 'builtin-a' }], voices);
    expect(swapped.unassigned).toEqual(['SPEAKER_06']);
    expect(swapped.notes).toContain('1 speaker(s) of unknown gender keep the project voice (set them in the editor).');
    const all = withSwaps(proposal, [{ speakerId: 'SPEAKER_05', voiceId: 'builtin-a' }, { speakerId: 'SPEAKER_06', voiceId: 'builtin-a' }], voices);
    expect(all.unassigned).toEqual([]);
    expect(all.notes.some((n) => n.includes('of unknown gender'))).toBe(false);
  });

  it('lists the speakers of unknown gender with their three longest lines and talk time', async () => {
    const { unknownSpeakers } = await import('./speakerCast.js');
    const rows = speakerRows(
      lines([
        [0, 1000, 'a', 'SPEAKER_05'],
        [1000, 5000, 'the longest', 'SPEAKER_05'],
        [5000, 7000, 'second', 'SPEAKER_05'],
        [7000, 8500, 'third', 'SPEAKER_05'],
        [9000, 9500, 'known', 'SPEAKER_06'],
      ]),
      [],
      { speakerGenders: { SPEAKER_06: 'male' } } as unknown as ProjectSettings,
    );
    expect(unknownSpeakers(rows, { unassigned: ['SPEAKER_05'] })).toEqual([
      {
        speakerId: 'SPEAKER_05',
        minutes: 0.14,
        lines: 4,
        samples: [
          { id: 'seg_0002', text: 'the longest', startMs: 1000, endMs: 5000 },
          { id: 'seg_0003', text: 'second', startMs: 5000, endMs: 7000 },
          { id: 'seg_0004', text: 'third', startMs: 7000, endMs: 8500 },
        ],
      },
    ]);
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

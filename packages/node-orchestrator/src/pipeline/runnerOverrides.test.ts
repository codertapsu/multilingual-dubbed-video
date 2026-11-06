/**
 * Editor overrides survive a full pipeline run.
 *
 * The editor persists a per-line voice and speaking rate, and locks lines the
 * user wrote by hand. Before these existed, a re-dub quietly undid all three:
 * every line was synthesized with the project voice at 1×, and auto-fit /
 * refine rewrote whatever text they liked. These tests drive the REAL runner.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Project,
  TranscriptSegment,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-overrides-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** A TTS that records every call and writes a WAV whose "duration" = f(text). */
function recordingTts(durationFor: (s: { text: string; startMs: number; endMs: number }) => number): TtsProvider & {
  inputs: TtsInput[];
} {
  const inputs: TtsInput[] = [];
  return {
    id: 'piper-local',
    displayName: 'recording-tts',
    isLocal: true,
    inputs,
    async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
      inputs.push(input);
      const segments = await Promise.all(
        input.segments.map(async (s, i) => {
          const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
          const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
          const durationMs = durationFor(s);
          await fsp.mkdir(input.outputDir, { recursive: true });
          await fsp.writeFile(audioPath, String(durationMs), 'utf8');
          return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
        }),
      );
      return { segments, engine: 'piper' };
    },
  };
}

async function readSegments(file: string): Promise<TranscriptSegment[]> {
  return (JSON.parse(await fsp.readFile(file, 'utf8')) as { segments: TranscriptSegment[] }).segments;
}

async function editSegments(file: string, edit: (s: TranscriptSegment) => TranscriptSegment): Promise<void> {
  const segments = await readSegments(file);
  await fsp.writeFile(file, JSON.stringify({ segments: segments.map(edit) }), 'utf8');
}

function deps(project: Project, translation: TranslationProvider, tts: TtsProvider, stt: FakeSttProvider): RunnerDeps {
  const paths = store.paths(project.id);
  const bus = buses.get(project.id);
  return {
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
    registry: fakeRegistry(stt, translation, tts),
    bus,
    logger: new ProjectLogger(paths.pipelineLog, bus),
  };
}

describe('per-line voice and speaking rate', () => {
  it('reach the engine, split synthesis groups, and clear the stale flags', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ ttsVoiceId: 'project-voice' }) }),
    );
    const paths = store.paths(project.id);
    // Three adjacent cues: with no overrides they are ONE synthesis group.
    const stt = new FakeSttProvider(makeSegments([[0, 1000, 'a'], [1000, 2000, 'b'], [2100, 3000, 'c']]));
    const fits = (s: { startMs: number; endMs: number }): number => Math.max(300, s.endMs - s.startMs - 150);
    const first = recordingTts(fits);
    await new PipelineRunner(deps(project, new FakeTranslationProvider(), first, stt)).run(project, {
      signal: new AbortController().signal,
    });
    const firstGroups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    expect(firstGroups.groups).toHaveLength(1);

    // The editor sets a voice on line 2 and a rate on line 3.
    await editSegments(paths.translatedJson, (s) =>
      s.id === 'seg_0002'
        ? { ...s, voiceId: 'line-voice', ttsStale: true }
        : s.id === 'seg_0003'
          ? { ...s, speakingRate: 1.25, ttsStale: true }
          : s,
    );
    const second = recordingTts(fits);
    await new PipelineRunner(deps(project, new FakeTranslationProvider(), second, stt)).run(project, {
      retryFromStep: 'tts',
      signal: new AbortController().signal,
    });

    const calls = second.inputs.map((i) => ({ voice: i.voiceId, speed: i.speed, ids: i.segments.map((s) => s.id) }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { voice: 'project-voice', speed: 1, ids: ['seg_0001'] },
        { voice: 'line-voice', speed: 1, ids: ['seg_0002'] },
        { voice: 'project-voice', speed: 1.25, ids: ['seg_0003'] },
      ]),
    );
    const groups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    expect(groups.groups.map((g: { segmentIds: string[] }) => g.segmentIds)).toEqual([
      ['seg_0001'],
      ['seg_0002'],
      ['seg_0003'],
    ]);
    const after = await readSegments(paths.translatedJson);
    expect(after.some((s) => s.ttsStale)).toBe(false);
    // The overrides themselves are kept for the next run.
    expect(after[1]!.voiceId).toBe('line-voice');
    expect(after[2]!.speakingRate).toBe(1.25);
  });
});

describe('locked lines', () => {
  it('are never machine-shortened by auto-fit', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, {
        settings: defaultSettings({ maxSpeedRatio: 1.6, allowedOverflowMs: 300, autoFitOverflow: false }),
      }),
    );
    const paths = store.paths(project.id);
    const stt = new FakeSttProvider(makeSegments([[0, 1000, 'zh0'], [1000, 2000, 'zh1'], [2900, 3900, 'zh2']]));
    const counts = new Map<string, number>();
    const shrinking: TranslationProvider = {
      id: 'argos',
      displayName: 'shrinking-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return {
          segments: input.segments.map((s) => {
            const n = counts.get(s.id) ?? 0;
            counts.set(s.id, n + 1);
            return { id: s.id, translatedText: 'x'.repeat(Math.max(10, 90 - n * 60)) };
          }),
        };
      },
    };
    const byLength = recordingTts((s) => s.text.length * 30);
    // First run without auto-fit: the 1+2 group is a timing conflict.
    await new PipelineRunner(deps(project, shrinking, byLength, stt)).run(project, {
      signal: new AbortController().signal,
    });

    // The user approves both lines as written, then turns auto-fit on and re-aligns.
    await editSegments(paths.translatedJson, (s) => (s.id === 'seg_0003' ? s : { ...s, locked: true }));
    await store.saveProject({
      ...(await store.getProject(project.id)),
      settings: { ...project.settings, autoFitOverflow: true },
    });
    await new PipelineRunner(deps(await store.getProject(project.id), shrinking, byLength, stt)).run(
      await store.getProject(project.id),
      { retryFromStep: 'alignment', signal: new AbortController().signal },
    );

    // Translated exactly once each (the original run) — never re-translated.
    expect(counts.get('seg_0001')).toBe(1);
    expect(counts.get('seg_0002')).toBe(1);
    const after = await readSegments(paths.translatedJson);
    expect(after[0]!.translatedText).toHaveLength(90);
    // It stays flagged so the user can see it and decide.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as { segmentId: string; status: string }[];
    expect(aligned.find((a) => a.segmentId === 'seg_0001')?.status).toBe('timing-conflict');
  });

  it('are kept verbatim by review-and-refine, while still read as context', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const stt = new FakeSttProvider(makeSegments([[0, 1000, 'Hello'], [2000, 3000, 'World']]));
    const fits = (s: { startMs: number; endMs: number }): number => Math.max(300, s.endMs - s.startMs - 150);
    await new PipelineRunner(deps(project, new FakeTranslationProvider(), recordingTts(fits), stt)).run(project, {
      signal: new AbortController().signal,
    });

    await editSegments(paths.translatedJson, (s) =>
      s.id === 'seg_0001' ? { ...s, translatedText: 'Câu do tôi viết', locked: true } : s,
    );
    let reviewedPrompt = '';
    const refiner: TranslationProvider & {
      supportsRefinement: boolean;
      chatComplete: (s: string | undefined, u: string) => Promise<string>;
    } = {
      id: 'refiner-x',
      displayName: 'Refiner X',
      isLocal: true,
      supportsRefinement: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: `[direct] ${s.sourceText}` })) };
      },
      async chatComplete(_system: string | undefined, user: string): Promise<string> {
        if (user.includes('Analyze the following transcript')) return '{"synopsis":"a test"}';
        reviewedPrompt += user;
        return '{"segments":[{"id":"seg_0001","text":"máy sửa 1"},{"id":"seg_0002","text":"máy sửa 2"}]}';
      },
    };
    await store.saveProject({
      ...(await store.getProject(project.id)),
      settings: { ...project.settings, refineProviderId: 'refiner-x' },
    });
    const d = deps(await store.getProject(project.id), new FakeTranslationProvider(), recordingTts(fits), stt);
    d.registry.registerTranslation(refiner as never);
    await new PipelineRunner(d).run(await store.getProject(project.id), {
      retryFromStep: 'refine',
      signal: new AbortController().signal,
    });

    const after = await readSegments(paths.translatedJson);
    expect(after[0]!.translatedText).toBe('Câu do tôi viết');
    expect(after[1]!.translatedText).toBe('máy sửa 2');
    // The locked line was still part of what the reviewer read.
    expect(reviewedPrompt).toContain('Câu do tôi viết');
    const report = JSON.parse(await fsp.readFile(paths.refineReportJson, 'utf8'));
    expect(report).toMatchObject({ changed: 1, changedIds: ['seg_0002'], lockedKept: 1 });
  });
});

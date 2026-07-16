import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Project,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from '@videodubber/shared';
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
  defaultSettings,
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

    // Alignment file content sane: the two adjacent cues (gap 0ms) were merged
    // into ONE synthesis group (id = first member), so alignment has one unit.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8'));
    expect(aligned).toHaveLength(1);
    expect(aligned[0].segmentId).toBe('seg_0001');

    // The group plan artifact records the merge.
    const groups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0].segmentIds).toEqual(['seg_0001', 'seg_0002']);
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

describe('PipelineRunner — auto-fit overflowing translations', () => {
  it('re-translates + re-synthesizes timing-conflict segments so they fit', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, {
        settings: defaultSettings({ maxSpeedRatio: 1.6, allowedOverflowMs: 300, autoFitOverflow: true }),
      }),
    );
    const paths = store.paths(project.id);

    // Segments 1+2 are adjacent (gap 0 -> merged into one synthesis group);
    // segment 3 starts 900 ms later (>= the 750 ms grouping gap), so it stays
    // its own group AND bounds the first group's gap-aware window to 2900 ms.
    const stt = new FakeSttProvider(
      makeSegments([
        [0, 1000, 'zh0'],
        [1000, 2000, 'zh1'],
        [2900, 3900, 'zh2'],
      ]),
    );

    // Translation shortens a segment's text each time it is (re)translated.
    const counts = new Map<string, number>();
    const translation: TranslationProvider = {
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

    // TTS writes duration (= textLen * 30 ms) as the WAV content; FakeMediaService
    // probe reads it back, so re-synthesis after shortening changes the duration.
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'len-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        const segments = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            const durationMs = s.text.length * 30;
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments };
      },
    };

    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(stt, translation, tts),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    };

    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });

    // The group (seg 1+2: 2x90 chars -> 5430 ms in a 2900 ms window; needs
    // 1.87x > 1.6x max) began as a timing-conflict and was auto-fit: BOTH
    // members re-translated to 30 chars -> 61 chars joined -> 1830 ms -> fits.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as {
      segmentId: string;
      status: string;
    }[];
    expect(aligned.find((a) => a.segmentId === 'seg_0001')?.status).not.toBe('timing-conflict');

    // Members were re-translated once (initial + one refit) and the persisted text shrank.
    expect(counts.get('seg_0001')).toBe(2);
    expect(counts.get('seg_0002')).toBe(2);
    const translated = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as {
      segments: { id: string; translatedText: string }[];
    };
    expect(translated.segments.find((s) => s.id === 'seg_0001')!.translatedText.length).toBe(30);
    expect(translated.segments.find((s) => s.id === 'seg_0002')!.translatedText.length).toBe(30);
  });

  it('does not refit when autoFitOverflow is false', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, {
        settings: defaultSettings({ maxSpeedRatio: 1.6, allowedOverflowMs: 300, autoFitOverflow: false }),
      }),
    );
    const paths = store.paths(project.id);
    const counts = new Map<string, number>();
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return {
          segments: input.segments.map((s) => {
            counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
            return { id: s.id, translatedText: 'x'.repeat(90) };
          }),
        };
      },
    };
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'len-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        const segments = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(s.text.length * 30), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs: s.text.length * 30, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments };
      },
    };
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'zh0'], [1000, 2000, 'zh1']])),
        translation,
        tts,
      ),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    // Only the initial translation ran — no refit.
    expect(counts.get('seg_0001')).toBe(1);
  });
});

describe('PipelineRunner — native-rate re-synthesis', () => {
  it('re-synthesizes over-long lines at native speed when the engine supports it', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video)); // maxSpeedRatio 1.15
    const paths = store.paths(project.id);

    // seg 1's gap-aware slot is 2000 ms (next line starts at 2000); its text
    // synthesizes to 2220 ms -> ratio 1.11 (within max, so no auto-fit) —
    // exactly the "needs time-stretch" case the native-rate pass should absorb.
    // The 1000 ms gap keeps the two cues in separate synthesis groups.
    const stt = new FakeSttProvider(
      makeSegments([
        [0, 1000, 'zh0'],
        [2000, 3000, 'zh1'],
      ]),
    );
    const texts = new Map([
      ['seg_0001', 'x'.repeat(74)], // 74 * 30 = 2220 ms
      ['seg_0002', 'y'.repeat(10)], // 300 ms, fits
    ]);
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'fixed-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: texts.get(s.id) ?? s.sourceText })) };
      },
    };

    // Speed-capable TTS: duration = len * 30 / speed, WAV content = duration.
    const speeds: number[] = [];
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'speed-tts',
      isLocal: true,
      supportsSpeedControl: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        const speed = input.speed ?? 1.0;
        if (Math.abs(speed - 1) > 1e-3) speeds.push(speed);
        const segments = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            const durationMs = Math.round((s.text.length * 30) / speed);
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: speed };
          }),
        );
        return { segments };
      },
    };

    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(stt, translation, tts),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    // The over-long line was re-synthesized at ~1.11x native rate...
    expect(speeds).toHaveLength(1);
    expect(speeds[0]).toBeCloseTo(1.11, 2);

    // ...so the final alignment carries NO time-stretch and flags the rate.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as {
      segmentId: string;
      status: string;
      speedRatio: number;
      note?: string;
    }[];
    const first = aligned.find((a) => a.segmentId === 'seg_0001')!;
    expect(first.status).toBe('ok');
    expect(first.speedRatio).toBe(1);
    expect(first.note).toContain('native rate');
  });
});

describe('PipelineRunner — per-speaker voices', () => {
  it('synthesizes each diarized speaker with its assigned voice', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, {
        settings: defaultSettings({
          ttsVoiceId: 'default-voice',
          speakerVoices: [
            { speakerId: 'SPEAKER_00', voiceId: 'voice-a' },
            { speakerId: 'SPEAKER_01', voiceId: 'voice-b' },
          ],
        }),
      }),
    );
    const paths = store.paths(project.id);

    // Two adjacent same-speaker cues (group together) + a speaker change.
    const segments = makeSegments([
      [0, 1000, 'a1'],
      [1100, 2000, 'a2'],
      [2100, 3000, 'b1'],
    ]).map((s, i) => ({ ...s, speakerId: i < 2 ? 'SPEAKER_00' : 'SPEAKER_01' }));

    const voiceCalls: (string | undefined)[] = [];
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'voice-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        voiceCalls.push(input.voiceId);
        const segs = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, '500', 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs: 500, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments: segs, engine: 'piper' };
      },
    };

    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(new FakeSttProvider(segments), new FakeTranslationProvider(), tts),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    // One call per voice; the same-speaker cues grouped, the change split them.
    expect(voiceCalls.sort()).toEqual(['voice-a', 'voice-b']);
    const groups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    expect(groups.groups.map((g: { segmentIds: string[] }) => g.segmentIds)).toEqual([
      ['seg_0001', 'seg_0002'],
      ['seg_0003'],
    ]);
  });
});

describe('PipelineRunner — untranslated-line visibility', () => {
  it('warns when translations come back identical to the source', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video)); // en-US -> vi-VN
    const paths = store.paths(project.id);

    // The provider "translates" line 1 but echoes line 2 back untouched —
    // exactly what a skipping model produces after the source-text fallback.
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'echo-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return {
          segments: input.segments.map((s, i) => ({
            id: s.id,
            translatedText: i === 0 ? `[vi] ${s.sourceText}` : s.sourceText,
          })),
        };
      },
    };

    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(
        new FakeSttProvider(
          makeSegments([
            [0, 1000, 'hello there'],
            // Long enough (>=15 normalized chars) that an echo is damning —
            // short identical lines ("OK", numbers) are deliberately tolerated.
            [2000, 3000, 'this entire sentence stayed in english'],
          ]),
        ),
        translation,
        new FakeTtsProvider(),
      ),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toContain('look UNTRANSLATED');
    expect(log).toContain('seg_0002');
  });
});

describe('PipelineRunner — translation character sheet', () => {
  it('persists a generated sheet and reuses it verbatim on re-translation', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    const receivedContexts: (unknown | undefined)[] = [];
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'sheet-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        receivedContexts.push(input.documentContext);
        return {
          segments: input.segments.map((s) => ({ id: s.id, translatedText: `[vi] ${s.sourceText}` })),
          // Emitted only when the caller provided no sheet (mirrors real providers).
          ...(input.documentContext ? {} : { analysis: { pronounGuide: 'học sinh -> giáo viên: thầy/em' } }),
        };
      },
    };

    const stt = new FakeSttProvider(makeSegments([[0, 1000, 'hello'], [2000, 3000, 'bye']]));
    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(stt, translation, new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    };
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: new AbortController().signal });

    // First run: no sheet passed in, the generated one was persisted.
    expect(receivedContexts[0]).toBeUndefined();
    const persisted = JSON.parse(await fsp.readFile(paths.translationContextJson, 'utf8'));
    expect(persisted.pronounGuide).toContain('thầy/em');

    // Re-translate: the persisted (user-editable) sheet is now authoritative.
    await runner.run(project, { retryFromStep: 'translation', signal: new AbortController().signal });
    expect(receivedContexts[1]).toEqual(persisted);
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

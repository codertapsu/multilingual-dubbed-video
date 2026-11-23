import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  type AlignedSegment,
  type CreateProjectInput,
  type Project,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TranscriptSegment,
  type TranslationInput,
  type TranslationProvider,
  type TranslationResult,
  type TtsInput,
  type TtsProvider,
  type TtsResult,
} from '@videodubber/shared';
import { PipelineRunner, planSttChunks, translationProgress, type RunnerDeps } from './runner.js';
import type { DubbingTranslationInput } from '../providers/translation/llmTranslationProvider.js';
import type { PipelineEvent } from '../events.js';
import type { SpeechMapService } from './speechMap.js';
import type { DiarizationService } from '../providers/diarization/sherpaDiarizationProvider.js';
import type { PipelineMediaService } from '../media.js';
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

async function buildProject(
  input: Partial<CreateProjectInput> = {},
): Promise<{ project: Project; deps: RunnerDeps; media: FakeMediaService }> {
  const video = await writeDummyVideo(tmp);
  const project = await store.createProject(createProjectInput(video, input));

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

  it('hands the run signal to every media call, so a cancel reaches ffmpeg', async () => {
    // Regression: POST /cancel aborted only the orchestrator's own await. The
    // ffmpeg child kept running — a full render is minutes of pinned CPU — and
    // kept writing the output file long after the UI said the run had stopped.
    const { project, deps } = await buildProject();
    const controller = new AbortController();
    const base = deps.media as FakeMediaService;
    const seen: (AbortSignal | undefined)[] = [];
    const record = <T>(signal: AbortSignal | undefined, value: T): T => {
      seen.push(signal);
      return value;
    };
    const media: PipelineMediaService = {
      probe: (p, signal) => record(signal, base.probe(p)),
      extractAudio: (i, o, signal) => record(signal, base.extractAudio(i, o)),
      extract16kMono: (i, o, signal) => record(signal, base.extract16kMono(i, o)),
      clip16kMono: (i, o, st, en, signal) => record(signal, base.clip16kMono(i, o, st, en)),
      buildTtsTimeline: (input, signal) => record(signal, base.buildTtsTimeline(input)),
      duckAndMix: (input, signal) => record(signal, base.duckAndMix(input)),
      renderFinalVideo: (input, signal) => record(signal, base.renderFinalVideo(input)),
    };

    await new PipelineRunner({ ...deps, media }).run(project, { signal: controller.signal });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });

  it('re-runs a step recorded as failed even when its artifact is on disk', async () => {
    // Regression: a cancel/crash mid-step leaves the step `failed` AND a
    // truncated artifact on disk. The resume branch only asked "does an output
    // exist?", so the next run marked the step `skipped` and reported SUCCESS —
    // the user got a dub that stops halfway with no error anywhere. Only a
    // `completed` status plus an artifact is a safe skip.
    const { project, deps } = await buildProject();
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: new AbortController().signal });

    // Simulate the interrupted run: extract-audio failed, its WAVs still exist.
    const pipeline = await store.getPipeline(project.id);
    await store.savePipeline({
      ...pipeline,
      status: 'failed',
      steps: pipeline.steps.map((step) =>
        step.id === 'extract-audio' ? { ...step, status: 'failed' as const, error: 'Cancelled' } : step,
      ),
    });

    const media = deps.media as FakeMediaService;
    media.calls.length = 0;
    await runner.run(project, { signal: new AbortController().signal });

    expect(media.calls.some((c) => c.startsWith('extract16kMono:'))).toBe(true);
    const after = await store.getPipeline(project.id);
    expect(after.steps.find((s) => s.id === 'extract-audio')?.status).toBe('completed');
    expect(after.status).toBe('completed');
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
  /** Nine Vietnamese syllables: the "too long" line every member starts as. */
  const LONG = 'một hai ba bốn năm sáu bảy tám chín';

  /** TTS whose clip length is 300 ms per syllable (FakeMediaService probes it back). */
  function syllableTts(events: string[]): TtsProvider {
    return {
      id: 'piper-local',
      displayName: 'syllable-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        events.push(`tts:${input.segments.map((s) => s.id).join(',')}`);
        const segments = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            const durationMs = s.text.trim().split(/\s+/).length * 300;
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments };
      },
    };
  }

  /** A context-capable model registered as the built-in chat engine; answers every rewrite with `reply`. */
  function chatEngine(events: string[], prompts: string[], reply: (id: string) => string): TranslationProvider {
    return {
      id: 'llama-cpp-chat',
      displayName: 'Fake Gemma chat',
      isLocal: true,
      supportsRefinement: true,
      async translateSegments(): Promise<TranslationResult> {
        throw new Error('auto-fit must not re-translate');
      },
      async chatComplete(_system: string | undefined, user: string): Promise<string> {
        events.push('chat');
        prompts.push(user);
        const ids = [...user.matchAll(/^(seg_\d{4})/gm)].map((m) => m[1]!);
        return JSON.stringify({ segments: ids.map((id) => ({ id, text: reply(id) })) });
      },
    } as TranslationProvider;
  }

  async function runOverflowing(
    reply: (id: string) => string,
  ): Promise<{ paths: ReturnType<ProjectStore['paths']>; events: string[]; prompts: string[]; counts: Map<string, number> }> {
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
    const counts = new Map<string, number>();
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'context-free-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return {
          segments: input.segments.map((s) => {
            counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
            return { id: s.id, translatedText: s.id === 'seg_0003' ? 'xin chào' : LONG };
          }),
        };
      },
    };
    const events: string[] = [];
    const prompts: string[] = [];
    const registry = fakeRegistry(stt, translation, syllableTts(events));
    registry.registerTranslation(chatEngine(events, prompts, reply) as never);
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });
    return { paths, events, prompts, counts };
  }

  it('shortens the CURRENT lines with the context model, then re-synthesizes once', async () => {
    // The group (seg 1+2: 18 syllables -> 5400 ms in a 2900 ms window; needs
    // 1.86x > 1.6x max) begins as a timing-conflict. Each member may keep at
    // most 5 syllables (2900 ms × 1.15 ÷ 300 ms per syllable = 11 for the unit).
    const { paths, events, prompts, counts } = await runOverflowing(() => 'một hai ba bốn năm');

    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as {
      segmentId: string;
      status: string;
      speedRatio: number;
    }[];
    const unit = aligned.find((a) => a.segmentId === 'seg_0001')!;
    expect(unit.status).not.toBe('timing-conflict');
    expect(unit.speedRatio).toBeLessThanOrEqual(1.25);

    // The translator ran once per line: auto-fit never re-translates from the source.
    expect(counts.get('seg_0001')).toBe(1);
    const translated = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as {
      segments: { id: string; translatedText: string }[];
    };
    expect(translated.segments.find((s) => s.id === 'seg_0001')!.translatedText).toBe('một hai ba bốn năm');
    expect(translated.segments.find((s) => s.id === 'seg_0003')!.translatedText).toBe('xin chào');

    // The model saw the current line and its range, and was told not to re-translate.
    expect(prompts[0]).toContain(`current: ${LONG}`);
    expect(prompts[0]).toMatch(/seg_0001 — length: (about \d+ syllables \(âm tiết\), )?at most 5/);
    expect(prompts[0]).toContain('do NOT translate the source again');

    // Every model call came before the auto-fit re-synthesis: one load each.
    const firstTtsAfterChat = events.indexOf('tts:seg_0001', events.indexOf('chat'));
    expect(firstTtsAfterChat).toBeGreaterThan(-1);
    expect(events.slice(firstTtsAfterChat).includes('chat')).toBe(false);

    // Audit trail for the editor/MCP.
    const report = JSON.parse(await fsp.readFile(path.join(paths.subtitlesDir, 'translation_report.json'), 'utf8'));
    expect(report.autoFit.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'seg_0001', before: LONG, after: 'một hai ba bốn năm', unitsBefore: 9, unitsAfter: 5 }),
      ]),
    );
  });

  it('keeps the text and lets time-stretch fit it when no proposal is shorter and clean', async () => {
    // Untranslated source, or the same length: both refused by the acceptance rule.
    const { paths, events } = await runOverflowing((id) => (id === 'seg_0001' ? 'zh0' : LONG));
    const translated = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as {
      segments: { id: string; translatedText: string }[];
    };
    expect(translated.segments.find((s) => s.id === 'seg_0001')!.translatedText).toBe(LONG);
    expect(translated.segments.find((s) => s.id === 'seg_0002')!.translatedText).toBe(LONG);
    // Nothing changed, so nothing was re-synthesized after the model ran.
    expect(events.slice(events.indexOf('chat')).some((e) => e.startsWith('tts:'))).toBe(false);
    const report = JSON.parse(await fsp.readFile(path.join(paths.subtitlesDir, 'translation_report.json'), 'utf8'));
    expect(report.autoFit.changes).toEqual([]);
    expect(report.autoFit.rejected.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['seg_0001', 'seg_0002']));
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
      // Clips that are speech from end to end: the whole 2220 ms must be fitted.
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000), clipEdges: { leadMs: 0, tailMs: 0 } }),
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
            // Duration close to the window so the group passes the drift check.
            const durationMs = Math.max(500, s.endMs - s.startMs - 100);
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
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

describe('PipelineRunner — lines with nothing to say', () => {
  it('never sends a "…" or "♪" line to the voice engine: it is silence, and the project says so', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video, { settings: defaultSettings({ ttsVoiceId: 'v' }) }));
    const paths = store.paths(project.id);
    const segments = makeSegments([
      [0, 1000, 'one'],
      [1100, 2000, '…'],
      [2100, 3000, '♪'],
      [3100, 4000, 'two'],
    ]);
    // The translation keeps the text as it is ("…" stays "…").
    const identity: TranslationProvider = {
      id: 'argos',
      displayName: 'identity',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: s.sourceText })) };
      },
    };
    const spoken: string[] = [];
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'voice-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        const segs = await Promise.all(
          input.segments.map(async (s, i) => {
            spoken.push(s.text);
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, '800', 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs: 800, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments: segs, engine: 'piper' };
      },
    };
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(new FakeSttProvider(segments), identity, tts),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    expect(spoken.join(' ')).not.toMatch(/…|♪/);
    // The silent lines have a clip (alignment and the mix find one), and are no group's members.
    expect((await fsp.stat(paths.ttsSegment(2))).size).toBeGreaterThan(44);
    expect((await fsp.stat(paths.ttsSegment(3))).size).toBeGreaterThan(44);
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.warnings?.map((w) => w.code)).toContain('no-speech-lines');
  });
});

describe('PipelineRunner — transcription loops', () => {
  it('decodes a loop again without context, replaces it, and says so; what cannot be repaired is marked', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video, { settings: defaultSettings({}) }));
    const paths = store.paths(project.id);
    const loop = makeSegments([
      [0, 2000, 'Before'],
      ...Array.from({ length: 25 }, (_, i) => [3000 + i * 1000, 3900 + i * 1000, 'over and over'] as [number, number, string]),
      [40_000, 42_000, 'After'],
    ]);
    const asked: { audioPath: string; noContext?: boolean }[] = [];
    const stt: SttProvider = {
      id: 'faster-whisper',
      displayName: 'loopy',
      isLocal: true,
      async transcribe(input: SttInput): Promise<SttResult> {
        asked.push({ audioPath: input.audioPath, ...(input.noContext ? { noContext: true } : {}) });
        if (!input.noContext) return { segments: loop, detectedLanguage: 'en', durationMs: 45_000 };
        // The range decoded again: varied speech, in the clip's own time.
        return {
          segments: makeSegments([
            [500, 4000, 'You know me'],
            [4500, 9000, 'I saw you once'],
          ]),
          detectedLanguage: 'en',
          durationMs: 25_000,
        };
      },
    };
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(45_000) }),
      registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 800)),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    expect(asked.filter((a) => a.noContext)).toHaveLength(1);
    const source = JSON.parse(await fsp.readFile(paths.sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    const texts = source.segments.map((s) => s.sourceText);
    expect(texts).toContain('You know me');
    expect(texts.filter((t) => t === 'over and over')).toHaveLength(0);
    const report = JSON.parse(await fsp.readFile(paths.loopRangesJson, 'utf8')) as { ranges: { status: string }[] };
    expect(report.ranges.map((r) => r.status)).toEqual(['replaced']);
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.warnings?.map((w) => w.code)).toContain('loops-repaired');
  });
});

describe('PipelineRunner — review & refine step', () => {
  it('skips instantly (with a report) when no refine provider is configured', async () => {
    const { project, deps } = await buildProject();
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    const paths = store.paths(project.id);
    const report = JSON.parse(await fsp.readFile(paths.refineReportJson, 'utf8'));
    expect(report.skipped).toBe(true);
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.steps.find((s) => s.id === 'refine')?.status).toBe('completed');
  });

  it('refines translations with a refinement-capable provider and persists the changes', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ refineProviderId: 'refiner-x' }) }),
    );
    const paths = store.paths(project.id);

    // A refinement-capable provider: translateSegments unused by the step;
    // chatComplete answers the review batches (improving seg_0001 only).
    const refiner: TranslationProvider & { supportsRefinement: boolean; chatComplete: (s: string | undefined, u: string) => Promise<string> } = {
      id: 'refiner-x',
      displayName: 'Refiner X',
      isLocal: true,
      supportsRefinement: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: `[direct] ${s.sourceText}` })) };
      },
      async chatComplete(_system: string | undefined, user: string): Promise<string> {
        if (user.includes('Analyze the following transcript')) return '{"synopsis":"a test"}';
        return '{"segments":[{"id":"seg_0001","text":"[vi-polished] Hello"}]}';
      },
    };

    const stt = new FakeSttProvider(makeSegments([[0, 1000, 'Hello'], [2000, 3000, 'World']]));
    const registry = fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider());
    registry.registerTranslation(refiner as never);

    // Real per-segment durations so alignment fits cleanly — otherwise the
    // auto-fit loop re-translates (with the base provider) OVER the refinement.
    const segmentDurations = new Map<string, number>([
      [paths.ttsSegment(1), 800],
      [paths.ttsSegment(2), 800],
    ]);
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000), segmentDurations }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    const translated = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as {
      segments: { id: string; translatedText: string }[];
    };
    expect(translated.segments.find((s) => s.id === 'seg_0001')!.translatedText).toBe('[vi-polished] Hello');
    // Unchanged (or rejected) lines keep the translation-step text.
    expect(translated.segments.find((s) => s.id === 'seg_0002')!.translatedText).toBe('[vi] World');
    const report = JSON.parse(await fsp.readFile(paths.refineReportJson, 'utf8'));
    expect(report.changed).toBe(1);
    expect(report.changedIds).toEqual(['seg_0001']);
    // TTS then spoke the REFINED text (groups are planned after refinement).
    const groups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    const texts = groups.groups.map((g: { text: string }) => g.text).join(' ');
    expect(texts).toContain('[vi-polished] Hello');
  });

  it('skips with a warning when the configured provider cannot refine', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ refineProviderId: 'argos' }) }),
    );
    const paths = store.paths(project.id);
    const { deps } = { deps: undefined as unknown };
    void deps;
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'Hello']])),
        new FakeTranslationProvider(), // id 'argos', no refinement capability
        new FakeTtsProvider(),
      ),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    const report = JSON.parse(await fsp.readFile(paths.refineReportJson, 'utf8'));
    expect(report.skipped).toBe(true);
    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toContain('cannot run the review pass');
    // The pipeline still completed.
    expect((await store.getPipeline(project.id)).status).toBe('completed');
  });
});

describe('PipelineRunner — transcript-review checkpoint', () => {
  it('pauses after the text is ready, then a plain re-run continues to completion', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ reviewBeforeSynthesis: true }) }),
    );
    const paths = store.paths(project.id);
    const tts = new FakeTtsProvider();
    const registry = fakeRegistry(
      new FakeSttProvider(makeSegments([[0, 1000, 'Hello']])),
      new FakeTranslationProvider(),
      tts,
    );
    const segmentDurations = new Map<string, number>([[paths.ttsSegment(1), 800]]);
    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000), segmentDurations }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    };
    const runner = new PipelineRunner(deps);

    // First run: stops at the checkpoint — transcript ready, NO speech yet.
    await runner.run(project, { signal: new AbortController().signal });
    let pipeline = await store.getPipeline(project.id);
    expect(pipeline.awaitingReview).toBe(true);
    expect(pipeline.steps.find((s) => s.id === 'refine')?.status).toBe('completed');
    expect(pipeline.steps.find((s) => s.id === 'tts')?.status).toBe('pending');
    expect(tts.calls).toBe(0);
    expect((await store.getProject(project.id)).status).toBe('paused');
    await expect(fsp.stat(paths.translatedJson)).resolves.toBeTruthy();

    // Plain re-run = "done reviewing": clears the flag, skips the done steps,
    // and finishes the dub.
    await runner.run(await store.getProject(project.id), { signal: new AbortController().signal });
    pipeline = await store.getPipeline(project.id);
    expect(pipeline.awaitingReview).toBeFalsy();
    expect(pipeline.status).toBe('completed');
    expect(tts.calls).toBeGreaterThan(0);
  });

  it('a retry from translation pauses again (the text changed)', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ reviewBeforeSynthesis: true }) }),
    );
    const paths = store.paths(project.id);
    const registry = fakeRegistry(
      new FakeSttProvider(makeSegments([[0, 1000, 'Hello']])),
      new FakeTranslationProvider(),
      new FakeTtsProvider(),
    );
    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({
        mediaInfo: fakeMediaInfo(10_000),
        segmentDurations: new Map([[paths.ttsSegment(1), 800]]),
      }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    };
    const runner = new PipelineRunner(deps);

    await runner.run(project, { signal: new AbortController().signal }); // pause #1
    await runner.run(await store.getProject(project.id), { signal: new AbortController().signal }); // finish
    await runner.run(await store.getProject(project.id), {
      retryFromStep: 'translation',
      signal: new AbortController().signal,
    }); // re-translate -> refine re-executes -> pause #2
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.awaitingReview).toBe(true);
    expect(pipeline.steps.find((s) => s.id === 'tts')?.status).toBe('pending');
  });
});

describe('PipelineRunner — drift-bounded grouping', () => {
  it('degroups + re-synthesizes cue-by-cue when the voice would drift from the subtitles', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    // Two adjacent cues merged into one group spanning 0-8000ms, but the
    // synthesized speech is only ~2s: cue 2's words would play ~6s before its
    // subtitle -> the drift guard must split the group and synthesize per cue.
    const stt = new FakeSttProvider(
      makeSegments([
        [0, 4000, 'long chinese line one'],
        [4400, 8000, 'long chinese line two'],
        [15_000, 16_000, 'far away line'],
      ]),
    );
    const ttsCalls: string[][] = [];
    const tts: TtsProvider = {
      id: 'piper-local',
      displayName: 'short-tts',
      isLocal: true,
      async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
        ttsCalls.push(input.segments.map((s) => s.id));
        const segs = await Promise.all(
          input.segments.map(async (s, i) => {
            const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
            const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
            // Vietnamese much shorter than the original span: 2s for the big
            // group, 800ms for singles.
            const durationMs = input.segments.length === 1 && s.id !== 'seg_0001' ? 800 : 2000;
            await fsp.mkdir(input.outputDir, { recursive: true });
            await fsp.writeFile(audioPath, String(durationMs), 'utf8');
            return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
          }),
        );
        return { segments: segs, engine: 'piper' };
      },
    };

    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(20_000) }),
      registry: fakeRegistry(stt, new FakeTranslationProvider(), tts),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    // The persisted plan ends up fully degrouped for the drifting pair.
    const groups = JSON.parse(await fsp.readFile(paths.synthesisGroupsJson, 'utf8'));
    expect(groups.groups.map((g: { segmentIds: string[] }) => g.segmentIds)).toEqual([
      ['seg_0001'],
      ['seg_0002'],
      ['seg_0003'],
    ]);
    // A second synthesis pass covered the degrouped members individually.
    expect(ttsCalls.some((ids) => ids.includes('seg_0001') && ids.includes('seg_0002') && ids.length === 2)).toBe(true);

    // Alignment now has one entry per cue, placed at each cue's own start.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as {
      segmentId: string;
      startMs: number;
    }[];
    expect(aligned.map((a) => a.segmentId)).toEqual(['seg_0001', 'seg_0002', 'seg_0003']);
    expect(aligned[1]!.startMs).toBe(4400);

    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toContain('keep the voice in sync with the subtitles');
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

describe('PipelineRunner — speech-to-text timing and fallback', () => {
  /** A whisper.cpp-like engine: lines without word timings, or a failure to start. */
  function sttEngine(id: string, result: TranscriptSegment[] | Error) {
    const calls: string[] = [];
    const provider: SttProvider = {
      id,
      displayName: id,
      isLocal: true,
      async transcribe() {
        calls.push(id);
        if (result instanceof Error) throw result;
        return { segments: result, detectedLanguage: 'zh', durationMs: 60_000 };
      },
    };
    return { provider, calls };
  }

  async function build(opts: {
    settings?: Partial<Project['settings']>;
    engines: SttProvider[];
    speechMap?: SpeechMapService;
    diarization?: DiarizationService;
  }) {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(
      createProjectInput(video, { settings: defaultSettings({ sourceLanguage: 'zh-CN', ...opts.settings }) }),
    );
    const paths = store.paths(project.id);
    const registry = fakeRegistry(opts.engines[0]!, new FakeTranslationProvider(), new FakeTtsProvider());
    for (const e of opts.engines.slice(1)) registry.registerStt(e);
    const bus = buses.get(project.id);
    const deps: RunnerDeps = {
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(60_000) }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
      ...(opts.speechMap ? { speechMap: opts.speechMap } : {}),
      ...(opts.diarization ? { diarization: opts.diarization } : {}),
    };
    return { project, paths, deps };
  }

  it('gives each line its speaker when speaker detection is on, and detects once per audio', async () => {
    const lines = makeSegments([
      [1000, 3000, '你好'],
      [3500, 6000, '我很好'],
      [7000, 9000, '再见'],
    ]);
    const { provider } = sttEngine('faster-whisper', lines);
    const diarize = vi.fn(async () => [
      { startMs: 900, endMs: 3100, speaker: 5 },
      { startMs: 3400, endMs: 6100, speaker: 2 },
      { startMs: 6900, endMs: 9100, speaker: 5 },
    ]);
    const { project, paths, deps } = await build({
      engines: [provider],
      settings: { diarize: true },
      diarization: { diarize, available: async () => true, modelKey: 'test-model' },
    });
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: new AbortController().signal });
    expect((await readSource(paths.sourceJson)).map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Found 2 speaker(s)');
    await runner.run(project, { retryFromStep: 'stt', signal: new AbortController().signal });
    expect(diarize).toHaveBeenCalledTimes(1);
  });

  it('dubs on without speakers, and says why, when speaker detection is not installed', async () => {
    const { provider } = sttEngine('faster-whisper', makeSegments([[1000, 3000, '你好']]));
    const { project, paths, deps } = await build({
      engines: [provider],
      settings: { diarize: true },
      diarization: { diarize: async () => null, available: async () => false, modelKey: 'none' },
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect((await readSource(paths.sourceJson))[0]!.speakerId).toBeUndefined();
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Speaker detection is on, but its engine is not installed');
  });

  it('dubs on in one voice when speaker detection fails, and keeps that as a warning', async () => {
    const { provider } = sttEngine('faster-whisper', makeSegments([[1000, 3000, '你好']]));
    const { project, paths, deps } = await build({
      engines: [provider],
      settings: { diarize: true },
      diarization: {
        diarize: async () => {
          throw new AppErrorException('UNKNOWN', 'Speaker detection engine returned HTTP 500.');
        },
        available: async () => true,
        modelKey: 'test-model',
      },
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect((await readSource(paths.sourceJson))[0]!.speakerId).toBeUndefined();
    const state = await store.getPipeline(project.id);
    expect(state.steps.find((s) => s.id === 'stt')!.status).toBe('completed');
    expect(state.warnings).toEqual([
      expect.objectContaining({
        code: 'speakers-failed',
        step: 'stt',
        key: 'warning.speakers-failed',
        params: { cause: 'Speaker detection engine returned HTTP 500.' },
        message: expect.stringContaining('the dub uses one voice'),
      }),
    ]);
  });

  it('shows which part of the audio speaker detection is on, and warns of lines it only guessed', async () => {
    const lines = makeSegments([
      [1000, 3000, '你好'],
      [20_000, 21_000, '音乐'], // no turn near it: a guess
    ]);
    const { provider } = sttEngine('faster-whisper', lines);
    const { project, deps } = await build({
      engines: [provider],
      settings: { diarize: true },
      diarization: {
        diarize: async (_audio, opts) => {
          opts.onProgress?.(0, 2);
          opts.onProgress?.(1, 2);
          opts.onProgress?.(2, 2);
          return { turns: [{ startMs: 900, endMs: 3100, speaker: 0 }], speakers: [] };
        },
        available: async () => true,
        modelKey: 'test-model',
      },
    });
    const details: string[] = [];
    deps.bus.subscribe((e) => {
      if (e.type === 'step' && e.step.id === 'stt' && e.step.detail) details.push(e.step.detail.text);
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect(details).toEqual(['Detecting speakers 0/2', 'Detecting speakers 1/2', 'Detecting speakers 2/2']);
    const state = await store.getPipeline(project.id);
    expect(state.warnings).toEqual([
      expect.objectContaining({ code: 'speakers-low-confidence', step: 'stt', key: 'warning.speakers-low-confidence', params: { count: 1 } }),
    ]);
  });

  const readSource = async (p: string) =>
    (JSON.parse(await fsp.readFile(p, 'utf8')) as { segments: TranscriptSegment[] }).segments;

  it('anchors lines without word timings to the speech map, and caches the map for a retry', async () => {
    const lines = makeSegments([
      [30_000, 46_960, '虎哥 这啥地方啊'], // whisper.cpp: the window opened on music
      [47_000, 49_000, '走吧'],
    ]);
    const { provider } = sttEngine('whisper-cpp', lines);
    const measured: string[] = [];
    const speechMap: SpeechMapService = {
      async regions(audioPath) {
        measured.push(audioPath);
        return [
          { startMs: 44_500, endMs: 46_900 },
          { startMs: 47_100, endMs: 48_800 },
        ];
      },
    };
    const { project, paths, deps } = await build({
      settings: { sttProviderId: 'whisper-cpp' },
      engines: [provider],
      speechMap,
    });
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: new AbortController().signal });

    const source = await readSource(paths.sourceJson);
    expect(source.map((s) => [s.startMs, s.endMs])).toEqual([
      [44_400, 46_960],
      [47_000, 49_000], // 100 ms of difference is noise: left alone
    ]);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Re-timed 1 of 2 lines');

    // A retried speech-to-text step reuses the map measured on the same audio.
    await runner.run(project, { retryFromStep: 'stt', signal: new AbortController().signal });
    expect(measured).toEqual([paths.original16kMonoWav]);
  });

  it('keeps the engine timing when the speech map cannot be measured', async () => {
    const lines = makeSegments([[30_000, 46_960, '虎哥 这啥地方啊']]);
    const { provider } = sttEngine('whisper-cpp', lines);
    const speechMap: SpeechMapService = {
      async regions() {
        throw new Error('worker down');
      },
    };
    const { project, paths, deps } = await build({ settings: { sttProviderId: 'whisper-cpp' }, engines: [provider], speechMap });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect((await readSource(paths.sourceJson)).map((s) => [s.startMs, s.endMs])).toEqual([[30_000, 46_960]]);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Could not map where speech is');
  });

  it('an engine the APP picked that cannot start falls back to the built-in one, and the project says so', async () => {
    const broken = sttEngine(
      'whisper-cpp',
      new AppErrorException('ENGINE_UNAVAILABLE', 'Engine "whisper-cpp-cuda" stopped while starting.'),
    );
    const builtIn = sttEngine('faster-whisper', makeSegments([[0, 1000, '你好']]));
    const { project, paths, deps } = await build({
      settings: { sttProviderId: 'whisper-cpp', autoSelectedPhases: ['stt', 'tts'] },
      engines: [broken.provider, builtIn.provider],
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });

    expect(broken.calls).toHaveLength(1);
    expect(builtIn.calls).toHaveLength(1);
    expect((await readSource(paths.sourceJson))[0]!.sourceText).toBe('你好');
    const saved = await store.getProject(project.id);
    expect(saved.settings.sttProviderId).toBe('faster-whisper');
    expect(saved.settings.autoSelectedPhases).toEqual(['tts']);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('The app picked it for this project');
  });

  it('an engine the USER picked fails loudly, as before', async () => {
    const broken = sttEngine('whisper-cpp', new AppErrorException('ENGINE_UNAVAILABLE', 'stopped while starting'));
    const builtIn = sttEngine('faster-whisper', makeSegments([[0, 1000, '你好']]));
    const { project, deps } = await build({
      settings: { sttProviderId: 'whisper-cpp' },
      engines: [broken.provider, builtIn.provider],
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect(builtIn.calls).toHaveLength(0);
    const stt = (await store.getPipeline(project.id)).steps.find((s) => s.id === 'stt');
    expect(stt?.status).toBe('failed');
    expect(stt?.error).toContain('stopped while starting');
    expect((await store.getProject(project.id)).settings.sttProviderId).toBe('whisper-cpp');
  });
});

describe('translation progress', () => {
  it('maps lines done to the step (up to 90%), only on whole percents that moved, in order', async () => {
    const fractions: number[] = [];
    const logged: string[] = [];
    const report = translationProgress(
      async (f) => {
        fractions.push(f);
      },
      (done, total) => logged.push(`${done}/${total}`),
    );
    for (const done of [1, 1, 2, 50, 51, 100, 200]) report(done, 200);
    await new Promise((r) => setTimeout(r, 0));
    expect(fractions).toEqual([0, 0.22, 0.45, 0.9]);
    // A log line per tenth of the lines; none for the last (the step says it is done).
    expect(logged).toEqual(['50/200', '100/200']);
  });

  it('reaches the pipeline: the translation step moves, and the log says so', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const segments = makeSegments(Array.from({ length: 10 }, (_, i) => [i * 1000, i * 1000 + 900, `line ${i}`] as [number, number, string]));
    const seen: number[] = [];
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'progressive-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        const report = (input as { onProgress?: (done: number, total: number) => void }).onProgress;
        report?.(5, 10);
        report?.(10, 10);
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: `[vi] ${s.sourceText}` })) };
      },
    };
    const bus = buses.get(project.id);
    bus.subscribe((e) => {
      if (e.type === 'step' && e.step.id === 'translation' && e.step.status === 'running') seen.push(e.step.progressPercent);
    });
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(20_000) }),
      registry: fakeRegistry(new FakeSttProvider(segments), translation, new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });
    expect(seen).toEqual(expect.arrayContaining([45, 90]));
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Translated 5/10 lines...');
  });
});

describe('PipelineRunner — translation engine fallback', () => {
  async function runWith(settings: Partial<Project['settings']>) {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video, { settings: defaultSettings(settings) }));
    const paths = store.paths(project.id);
    const registry = fakeRegistry(
      new FakeSttProvider(makeSegments([[0, 1000, 'Hello']])),
      new FakeTranslationProvider(),
      new FakeTtsProvider(),
    );
    let brokenCalls = 0;
    registry.registerTranslation({
      id: 'llama-cpp',
      displayName: 'TranslateGemma',
      isLocal: true,
      async translateSegments() {
        brokenCalls += 1;
        throw new AppErrorException('ENGINE_UNAVAILABLE', 'Engine "llama-cpp-cuda" stopped while starting.');
      },
    });
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry,
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });
    return { project, paths, brokenCalls: () => brokenCalls };
  }

  it('an engine the APP picked that cannot start falls back to the built-in translator', async () => {
    const { project, paths, brokenCalls } = await runWith({
      translationProviderId: 'llama-cpp',
      autoSelectedPhases: ['translation'],
    });
    expect(brokenCalls()).toBe(1);
    const doc = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(doc.segments[0]!.translatedText).toBe('[vi] Hello');
    const saved = await store.getProject(project.id);
    expect(saved.settings.translationProviderId).toBe('argos');
    expect(saved.settings.autoSelectedPhases).toBeUndefined();
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('the built-in "argos" translates instead');
  });

  it('an engine the USER picked fails loudly, as before', async () => {
    const { project, brokenCalls } = await runWith({ translationProviderId: 'llama-cpp' });
    expect(brokenCalls()).toBe(1);
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.steps.find((s) => s.id === 'translation')?.status).toBe('failed');
  });
});

describe('PipelineRunner — lines whose voice is out of date', () => {
  it('re-voices them before alignment measures their clips', async () => {
    const { project, deps } = await buildProject();
    const tts = deps.registry.getTts(project.settings.ttsProviderId) as FakeTtsProvider;
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    const paths = store.paths(project.id);

    // An auto-fit cut short by a cancel (or an editor edit) leaves a new text
    // whose clip still says the old one.
    const doc = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as { segments: TranscriptSegment[] };
    doc.segments[1] = { ...doc.segments[1]!, translatedText: 'Câu mới', ttsStale: true };
    await fsp.writeFile(paths.translatedJson, JSON.stringify(doc), 'utf8');
    const callsBefore = tts.inputs.length;

    await new PipelineRunner(deps).run(await store.getProject(project.id), {
      retryFromStep: 'alignment',
      signal: new AbortController().signal,
    });

    // The two lines share one unit (one clip): it is voiced again with both texts.
    const revoiced = tts.inputs.slice(callsBefore).flatMap((i) => i.segments);
    expect(revoiced.map((s) => [s.id, s.text])).toEqual([['seg_0001', '[vi] Hello Câu mới']]);
    const after = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(after.segments.some((s) => s.ttsStale === true)).toBe(false);
  });
});

describe('PipelineRunner — the speech in each clip', () => {
  it('fits and mixes only the speech, and cuts the noise a botched clip carries', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) });
    // "Thua" as VieNeu once returned it: 12.3 s, the word in its first half
    // second, a burst of noise at 6.4 s.
    media.speech.set(paths.ttsSegment(1), {
      durationMs: 12_300,
      silences: [
        { startMs: 0, endMs: 85 },
        { startMs: 566, endMs: 6398 },
        { startMs: 6600, endMs: 12_300 },
      ],
      speechStartMs: 85,
      speechEndMs: 6600,
      speechMs: 683,
      noiseDb: -40,
      minSilenceMs: 50,
    });
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media,
      registry: fakeRegistry(
        new FakeSttProvider(
          makeSegments([
            [0, 1000, '输了'],
            [3000, 4000, '走吧'],
          ]),
        ),
        new FakeTranslationProvider(),
        new FakeTtsProvider((id) => (id === 'seg_0001' ? 12_300 : 900)),
      ),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });

    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8')) as AlignedSegment[];
    // Whole, the 12.3 s clip could not fit before the next line (a conflict,
    // its noise over the next lines); its speech fits at natural speed.
    expect(aligned[0]).toMatchObject({ trimStartMs: 35, trimEndMs: 646, generatedDurationMs: 611, status: 'ok' });
    // A clean clip loses its edge silence: 80/220 ms down to 50/80 ms pads.
    expect(aligned[1]).toMatchObject({ trimStartMs: 30, trimEndMs: 760, generatedDurationMs: 730 });

    const mix = media.timelineInputs.at(-1)!.segments;
    expect(mix[0]).toMatchObject({ trimStartMs: 35, trimEndMs: 646, durationMs: 611, speedRatio: 1 });
    expect(mix[1]).toMatchObject({ trimStartMs: 30, trimEndMs: 760, durationMs: 730 });

    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toContain('trimmed the silence around the speech in 2 of 2 clip(s)');
    expect(log).toMatch(/1 voice clip\(s\) ran on long after their line .*: seg_0001\./);
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

describe('PipelineRunner — a folder chosen for the finished video', () => {
  it('renders into the chosen folder under the project name, and finds it there next time', async () => {
    const dubs = path.join(tmp, 'My Dubs');
    const { project, deps, media } = await buildProject({ name: 'Trip: day 1', outputDir: dubs });
    expect(project.outputFileName).toBe('Trip day 1.vi');

    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    const video = path.join(dubs, 'Trip day 1.vi.mp4');
    expect(media.calls).toContain(`renderFinalVideo:${video}`);
    await expect(fsp.stat(video)).resolves.toBeTruthy();
    // Nothing in the workspace's render/ folder.
    await expect(fsp.stat(store.paths(project.id).outputMp4)).rejects.toThrow();

    const renders = (): number => media.calls.filter((c) => c.startsWith('renderFinalVideo:')).length;
    const before = renders();
    await new PipelineRunner(deps).run(await store.getProject(project.id), { signal: new AbortController().signal });
    expect(renders()).toBe(before);

    // Deleted from the folder: the next run renders it again (the artifact is the proof).
    await fsp.rm(video);
    await new PipelineRunner(deps).run(await store.getProject(project.id), { signal: new AbortController().signal });
    expect(renders()).toBe(before + 1);
  });

  it('makes the chosen folder again if it was removed after it was chosen', async () => {
    const dubs = path.join(tmp, 'Dubs');
    const { project, deps } = await buildProject({ name: 'Clip', outputDir: dubs });
    await fsp.rm(dubs, { recursive: true });

    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    await expect(fsp.stat(path.join(dubs, 'Clip.vi.mp4'))).resolves.toBeTruthy();
  });
});

describe('PipelineRunner — pausing and continuing', () => {
  /**
   * A translator that works in batches of two lines like the LLM ones: it
   * skips batches the resume map covers, reports each finished batch, and can
   * stop (as an aborted request does) once the run is paused.
   */
  function batchingTranslator(onSent: (ids: string[]) => void): TranslationProvider {
    return {
      id: 'argos',
      displayName: 'batching-mt',
      isLocal: true,
      async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
        const x = input as DubbingTranslationInput;
        const out: { id: string; translatedText: string }[] = [];
        for (let i = 0; i < x.segments.length; i += 2) {
          const batch = x.segments.slice(i, i + 2);
          if (batch.every((seg) => x.resume?.has(seg.id))) {
            out.push(...batch.map((seg) => ({ id: seg.id, translatedText: x.resume!.get(seg.id)! })));
            continue;
          }
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          onSent(batch.map((seg) => seg.id));
          const lines = batch.map((seg) => ({ id: seg.id, translatedText: `[vi] ${seg.sourceText}` }));
          out.push(...lines);
          x.onBatch?.(lines);
          x.onProgress?.(out.length, x.segments.length);
          // A real batch takes seconds: the progress report lands before the next.
          await new Promise((r) => setTimeout(r, 5));
        }
        return { segments: out };
      },
    };
  }

  async function sixLineProject() {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const stt = new FakeSttProvider(
      makeSegments(Array.from({ length: 6 }, (_, i) => [i * 1000, i * 1000 + 900, `line ${i + 1}`] as [number, number, string])),
    );
    const sent: string[][] = [];
    let pauseAfter = Infinity;
    const controllers: AbortController[] = [];
    const translation = batchingTranslator((ids) => {
      sent.push(ids);
      if (sent.length === pauseAfter) controllers.at(-1)!.abort();
    });
    const bus = buses.get(project.id);
    const events: PipelineEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const runner = new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(stt, translation, new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    });
    const run = async (opts: { pauseAfterBatch?: number } = {}) => {
      pauseAfter = opts.pauseAfterBatch ?? Infinity;
      const controller = new AbortController();
      controllers.push(controller);
      await runner.run(await store.getProject(project.id), { signal: controller.signal });
    };
    return { project, paths, stt, sent, events, run };
  }

  it('pauses mid-translation without failing, then continues with the batches it had saved', async () => {
    const { project, paths, stt, sent, events, run } = await sixLineProject();

    await run({ pauseAfterBatch: 2 });
    const paused = await store.getPipeline(project.id);
    expect(paused.status).toBe('paused');
    expect(paused.pausedStep).toBe('translation');
    const step = paused.steps.find((x) => x.id === 'translation')!;
    expect(step.status).toBe('pending');
    expect(step.progressPercent).toBeGreaterThan(0);
    expect(paused.steps.find((x) => x.id === 'stt')!.status).toBe('completed');
    expect((await store.getProject(project.id)).status).toBe('paused');
    // A pause is not an error: nothing red on screen.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const saved = JSON.parse(await fsp.readFile(paths.translationCheckpointJson, 'utf8')) as { data: Record<string, string> };
    expect(Object.keys(saved.data)).toHaveLength(4);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toContain('Paused at "Translate"');

    await run();
    // Only the third batch was translated again; speech-to-text was not redone.
    expect(sent).toEqual([
      ['seg_0001', 'seg_0002'],
      ['seg_0003', 'seg_0004'],
      ['seg_0005', 'seg_0006'],
    ]);
    expect(stt.calls).toBe(1);
    const done = await store.getPipeline(project.id);
    expect(done.status).toBe('completed');
    expect(done.pausedAt).toBeUndefined();
    const doc = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(doc.segments.map((x) => x.translatedText)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `[vi] line ${n}`));
    // The checkpoint served: a later re-translation starts fresh.
    await expect(fsp.stat(paths.translationCheckpointJson)).rejects.toThrow();
    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toContain('Continuing the paused dub at "Translate"');
    expect(log).toContain('Continuing the translation: 4 of 6 lines');
  });

  it('starts the translation over when what it depends on changed during the pause', async () => {
    const { project, paths, sent, run } = await sixLineProject();
    await run({ pauseAfterBatch: 1 });
    // The user corrected a transcribed line while paused.
    const doc = JSON.parse(await fsp.readFile(paths.sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    doc.segments[0]!.sourceText = 'line one, corrected';
    await fsp.writeFile(paths.sourceJson, JSON.stringify(doc), 'utf8');
    await run();
    expect(sent[0]).toEqual(['seg_0001', 'seg_0002']);
    expect(sent.slice(1)).toEqual([
      ['seg_0001', 'seg_0002'],
      ['seg_0003', 'seg_0004'],
      ['seg_0005', 'seg_0006'],
    ]);
    expect((await store.getPipeline(project.id)).status).toBe('completed');
  });

  it('keeps the batches of a translator that never reads the character sheet when one appears', async () => {
    // A line-by-line translator (TranslateGemma) gets its sheet after
    // translating: one appearing during the pause changes nothing it made.
    const { paths, sent, run } = await sixLineProject();
    await run({ pauseAfterBatch: 1 });
    await fsp.writeFile(
      paths.translationContextJson,
      JSON.stringify({ synopsis: 'A trip.', pronounGuide: '', cast: [], glossary: [] }),
      'utf8',
    );
    await run();
    expect(sent).toEqual([
      ['seg_0001', 'seg_0002'],
      ['seg_0003', 'seg_0004'],
      ['seg_0005', 'seg_0006'],
    ]);
  });

  it('paused between steps, it continues at the next one', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const controller = new AbortController();
    const stt: SttProvider = {
      id: 'faster-whisper',
      displayName: 'stops-after',
      isLocal: true,
      async transcribe() {
        // The pause lands as the step finishes: the step completes, the next never starts.
        controller.abort();
        return { segments: makeSegments([[0, 1000, 'Hello']]) };
      },
    };
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: controller.signal });

    const paused = await store.getPipeline(project.id);
    expect(paused.status).toBe('paused');
    expect(paused.steps.find((x) => x.id === 'stt')!.status).toBe('completed');
    expect(paused.pausedStep).toBe('translation');
    expect(paused.steps.every((x) => x.status !== 'running')).toBe(true);
  });

  it('does not take what the paused step left on disk as done', async () => {
    // An artifact that exists is complete (atomic writes), but the step it
    // belongs to was cut off: it runs again rather than being skipped.
    const { project, deps, media } = await buildProject();
    const controller = new AbortController();
    const renderFinalVideo = media.renderFinalVideo.bind(media);
    let renders = 0;
    media.renderFinalVideo = async (input) => {
      renders += 1;
      const result = await renderFinalVideo(input);
      if (renders === 1) {
        controller.abort();
        throw Object.assign(new Error('ffmpeg was stopped'), { name: 'AbortError' });
      }
      return result;
    };
    const runner = new PipelineRunner(deps);
    await runner.run(project, { signal: controller.signal });
    expect((await store.getPipeline(project.id)).pausedStep).toBe('render');

    await runner.run(await store.getProject(project.id), { signal: new AbortController().signal });
    expect(renders).toBe(2);
    expect((await store.getPipeline(project.id)).status).toBe('completed');
  });
});

describe('PipelineRunner — alignment progress', () => {
  it('measuring the clips fills half the bar, not all of it, and the bar only moves forward', async () => {
    // It filled the whole bar, so a long dub sat at "alignment 100%" through
    // the minutes of auto-fit and re-voicing that followed.
    const { project, deps } = await buildProject();
    const seen: number[] = [];
    deps.bus.subscribe((e) => {
      if (e.type === 'step' && e.step.id === 'alignment' && e.step.status === 'running') seen.push(e.step.progressPercent);
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect(seen).toContain(50);
    expect(seen.every((p) => p < 100)).toBe(true);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe('PipelineRunner — continuing after a pause (review findings)', () => {
  it('a re-dub paused mid-voice redoes alignment, mix and render on Continue, not just the paused step', async () => {
    // The old run's aligned.json, mix and video are still on disk: they must
    // not pass for this dub's ("outputs already present").
    const { project, deps, media } = await buildProject();
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });

    const controller = new AbortController();
    const tts = deps.registry.getTts() as FakeTtsProvider;
    const synthesize = tts.synthesizeSegments.bind(tts);
    tts.synthesizeSegments = async (input, signal) => {
      controller.abort();
      return synthesize(input, signal);
    };
    await new PipelineRunner(deps).run(await store.getProject(project.id), { retryFromStep: 'tts', signal: controller.signal });
    tts.synthesizeSegments = synthesize;
    const paused = await store.getPipeline(project.id);
    expect(paused.status).toBe('paused');

    media.calls.length = 0;
    await new PipelineRunner(deps).run(await store.getProject(project.id), { signal: new AbortController().signal });
    const after = await store.getPipeline(project.id);
    expect(after.status).toBe('completed');
    for (const id of ['alignment', 'audio-mix', 'render'] as const) {
      expect(after.steps.find((s) => s.id === id)?.status, id).toBe('completed');
    }
    expect(media.calls.some((c) => c.startsWith('renderFinalVideo:'))).toBe(true);
  });

  it('a burst of progress reported just before a step returns never puts the finished step back to running', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await store.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const translation: TranslationProvider = {
      id: 'argos',
      displayName: 'bursty',
      isLocal: true,
      async translateSegments(input: TranslationInput): Promise<TranslationResult> {
        // What a resumed translation does: every saved batch reported at once.
        const report = (input as DubbingTranslationInput).onProgress;
        for (let i = 1; i <= 40; i++) report?.(i, 40);
        return { segments: input.segments.map((s) => ({ id: s.id, translatedText: `[vi] ${s.sourceText}` })) };
      },
    };
    const bus = buses.get(project.id);
    await new PipelineRunner({
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
      registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'Hello']])), translation, new FakeTtsProvider()),
      bus,
      logger: new ProjectLogger(paths.pipelineLog, bus),
    }).run(project, { signal: new AbortController().signal });
    // Let any straggler land, then look.
    await new Promise((r) => setTimeout(r, 50));
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.status).toBe('completed');
    expect(pipeline.steps.every((s) => s.status === 'completed' || s.status === 'skipped')).toBe(true);
  });
});

describe('PipelineRunner — picture options in the render', () => {
  it("hands the project's watermark regions and its blurred band to the render, in the input video's time", async () => {
    const regions = [{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur' as const, startMs: 1_000, endMs: 3_600_000 }];
    const { project, deps, media } = await buildProject({
      settings: { ...defaultSettings(), blurRegions: regions, burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: 0.755, h: 0.06 } } },
    });
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    const input = media.renderInputs.at(-1)!;
    // As saved: the media worker moves them to a part's window (range).
    expect(input.blurRegions).toEqual(regions);
    expect(input.burnSubtitleStyle).toEqual({ coverOriginal: 'blur', coverBand: { y: 0.755, h: 0.06 } });
  });

  it('a project without regions renders exactly as before', async () => {
    const { project, deps, media } = await buildProject();
    await new PipelineRunner(deps).run(project, { signal: new AbortController().signal });
    expect(media.renderInputs.at(-1)).not.toHaveProperty('blurRegions');
  });
});

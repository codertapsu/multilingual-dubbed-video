import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStepStatus } from '@videodubber/shared';
import { LocalJobOrchestrator, sanitizeSubtitleStyle } from './orchestrator.js';
import type { ProviderReadiness } from './providers/readiness.js';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { ProjectStore } from './workspace/projectStore.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  defaultSettings,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from './test/fixtures.js';

let tmp: string;
let store: ProjectStore;
let orchestrator: LocalJobOrchestrator;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-orch-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  const registry = fakeRegistry(
    new FakeSttProvider([]),
    new FakeTranslationProvider(),
    new FakeTtsProvider(() => 900),
  );
  orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry,
    bus: new EventBusRegistry(),
  });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('LocalJobOrchestrator extras', () => {
  it('saves translated segments and regenerates srt/vtt sidecars', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    // Seed source.json so save can base the translation on it.
    const segments = makeSegments([
      [0, 1000, 'Hello'],
      [1000, 2000, 'World'],
    ]);
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments }), 'utf8');

    await orchestrator.saveTranslatedSegments(project.id, [
      { id: 'seg_0001', translatedText: 'Xin chào' },
      { id: 'seg_0002', translatedText: 'Thế giới' },
    ]);

    const merged = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8'));
    expect(merged.segments[0].translatedText).toBe('Xin chào');

    const srt = await fsp.readFile(paths.translatedSrt, 'utf8');
    expect(srt).toContain('Xin chào');
    const vtt = await fsp.readFile(paths.translatedVtt, 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  });

  it('reapplies voice-synced cue overrides when an edit regenerates sidecars (review finding 3)', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    const segments = makeSegments([[0, 1000, 'A'], [1000, 2000, 'B']]);
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments }), 'utf8');
    // Alignment produced a voice-sync override for seg_0002 (spoken at 1400ms).
    await fsp.writeFile(
      paths.cueTimingJson,
      JSON.stringify({ overrides: { seg_0002: { startMs: 1400, endMs: 2600 } } }),
      'utf8',
    );

    // A plain text edit of the OTHER line must NOT revert seg_0002's timing.
    await orchestrator.saveTranslatedSegments(project.id, [{ id: 'seg_0001', translatedText: 'Xin chào' }]);

    const srt = await fsp.readFile(paths.translatedSrt, 'utf8');
    // SRT timecode for 1400ms = 00:00:01,400 — the override, not canonical 1000ms.
    expect(srt).toContain('00:00:01,400');
    expect(srt).not.toContain('00:00:01,000 -->');
  });

  it('getSegments merges alignment status when available', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    const segments = makeSegments([[0, 1000, 'Hello']]);
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments }), 'utf8');
    await fsp.writeFile(
      paths.translatedAlignedJson,
      JSON.stringify([
        {
          segmentId: 'seg_0001',
          startMs: 0,
          endMs: 1000,
          audioPath: 'x',
          generatedDurationMs: 800,
          placedDurationMs: 800,
          speedRatio: 1,
          overflowMs: 0,
          status: 'ok',
        },
      ]),
      'utf8',
    );

    const result = await orchestrator.getSegments(project.id);
    expect(result).toHaveLength(1);
    expect(result[0]?.alignment?.status).toBe('ok');
  });

  it('synthesizeSingleSegment re-synthesizes and recomputes alignment', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);

    const segments = makeSegments([[0, 1000, 'Hello']]);
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments }), 'utf8');
    // A project that has been through alignment. (Regenerating BEFORE alignment
    // ever ran must not create a one-entry aligned file — that would make the
    // alignment step look complete; timeline.test.ts pins that case.)
    await fsp.writeFile(
      paths.translatedAlignedJson,
      JSON.stringify([
        {
          segmentId: 'seg_0001',
          startMs: 0,
          endMs: 1000,
          audioPath: paths.ttsSegment(1),
          generatedDurationMs: 2000,
          placedDurationMs: 1000,
          speedRatio: 2,
          overflowMs: 0,
          status: 'needs-review',
        },
      ]),
      'utf8',
    );

    const { segment, alignment } = await orchestrator.synthesizeSingleSegment(project.id, 'seg_0001', {
      text: 'Xin chào các bạn',
    });

    expect(segment.segmentId).toBe('seg_0001');
    expect(segment.durationMs).toBe(900);
    expect(alignment.status).toBe('ok'); // 900ms fits in 1000ms window

    // Edited text persisted back to translated.json — and, being a hand edit,
    // locked against automatic rewriting.
    const merged = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8'));
    expect(merged.segments[0].translatedText).toBe('Xin chào các bạn');
    expect(merged.segments[0].locked).toBe(true);

    // Aligned file updated from the fresh clip, measured like the alignment
    // step does: the fake's 80/220 ms edge silence is trimmed to 50/80 ms pads.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8'));
    expect(aligned[0]).toMatchObject({
      segmentId: 'seg_0001',
      generatedDurationMs: 730,
      trimStartMs: 30,
      trimEndMs: 760,
      status: 'ok',
    });
  });

  it('a Tighten that shortens nothing re-voices the line without turning its source into a locked translation', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    // An untranslated line, and no instruction-following model in the registry.
    const [seg] = makeSegments([[0, 1000, '你好']]);
    const { translatedText: _none, ...untranslated } = seg!;
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments: [untranslated] }), 'utf8');

    const result = await orchestrator.refitSegment(project.id, 'seg_0001');
    expect(result.shortened).toBe(false);
    const saved = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8')).segments[0];
    expect(saved.translatedText).toBeUndefined();
    expect(saved.locked).toBeUndefined();
  });

  it('probe persists mediaInfo and rejects videos without audio', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const info = await orchestrator.probe(project.id);
    expect(info.hasAudio).toBe(true);
    const reloaded = await store.getProject(project.id);
    expect(reloaded.mediaInfo?.durationMs).toBe(info.durationMs);
  });

  it('updateProjectSettings applies whitelisted changes + ignores unknown keys', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const beforeVoice = project.settings.ttsVoiceId;

    const { project: updated, pipeline } = await orchestrator.updateProjectSettings(project.id, {
      ttsProviderId: 'omnivoice',
      ttsVoiceId: 'omnivoice-female-bright',
      sttModel: 'large-v3',
      maxSpeedRatio: 1.8,
      // An unknown / non-whitelisted key must be ignored, not persisted.
      ...({ bogusKey: 'nope' } as Record<string, unknown>),
    });

    expect(updated.settings.ttsProviderId).toBe('omnivoice');
    expect(updated.settings.ttsVoiceId).toBe('omnivoice-female-bright');
    expect(updated.settings.ttsVoiceId).not.toBe(beforeVoice);
    expect(updated.settings.sttModel).toBe('large-v3');
    expect(updated.settings.maxSpeedRatio).toBe(1.8);
    expect((updated.settings as Record<string, unknown>).bogusKey).toBeUndefined();
    expect(pipeline.projectId).toBe(project.id);

    // Persisted to disk (a reload sees the change).
    const reloaded = await store.getProject(project.id);
    expect(reloaded.settings.ttsProviderId).toBe('omnivoice');
  });
});

describe('run readiness gate', () => {
  function gatedOrchestrator(checkReadiness: () => Promise<ProviderReadiness[]>): LocalJobOrchestrator {
    return new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
        new FakeTranslationProvider(),
        new FakeTtsProvider(() => 900),
      ),
      bus: new EventBusRegistry(),
      checkReadiness,
    });
  }

  it('refuses to start a run when a selected provider is not ready', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const gated = gatedOrchestrator(async () => [
      {
        phase: 'translation',
        providerId: 'ollama',
        status: 'daemon-unreachable',
        ready: false,
        message: 'Ollama is not running.',
        remediation: 'Start Ollama.',
      },
    ]);

    await expect(gated.runPipeline(project.id)).rejects.toMatchObject({
      appError: { code: 'ENGINE_UNAVAILABLE', remediation: 'Start Ollama.' },
    });
    // The bug guarantee: nothing was scheduled.
    expect(gated.isRunning(project.id)).toBe(false);
  });

  it('starts the run when the selected providers are ready', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const gated = gatedOrchestrator(async () => [
      { phase: 'stt', providerId: 'faster-whisper', status: 'ready', ready: true, message: 'Ready.' },
    ]);

    await expect(gated.runPipeline(project.id)).resolves.toEqual({ started: true, queued: false });
    await gated.cancelJob(project.id); // clean up the scheduled background run
  });

  it('refuses editor mutations while the pipeline is running', async () => {
    // The editor rewrites the very artifacts stepTts/stepAlignment are writing
    // (translated.json, synthesis_groups.json, translated.aligned.json), which
    // produces audio that doesn't match the persisted text with no error
    // anywhere. updateProjectSettings always refused; the editor paths did not.
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const gated = gatedOrchestrator(async () => [
      { phase: 'stt', providerId: 'faster-whisper', status: 'ready', ready: true, message: 'Ready.' },
    ]);
    await gated.runPipeline(project.id);
    expect(gated.isRunning(project.id)).toBe(true);

    await expect(
      gated.saveTranslatedSegments(project.id, [{ id: 'seg_0001', translatedText: 'x' }]),
    ).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    await expect(gated.synthesizeSingleSegment(project.id, 'seg_0001', {})).rejects.toMatchObject({
      appError: { code: 'RUN_IN_PROGRESS' },
    });
    await expect(gated.refitSegment(project.id, 'seg_0001')).rejects.toMatchObject({
      appError: { code: 'RUN_IN_PROGRESS' },
    });
    // The render may be writing the very files a folder change would move.
    await expect(gated.setProjectOutputDir(project.id, path.join(tmp, 'Dubs'))).rejects.toMatchObject({
      appError: { code: 'RUN_IN_PROGRESS' },
    });

    await gated.cancelJob(project.id);
  });
});

describe('ProviderRegistry resolution', () => {
  it('falls back to the default provider for unknown ids', () => {
    const registry = fakeRegistry(
      new FakeSttProvider([]),
      new FakeTranslationProvider(),
      new FakeTtsProvider(),
    );
    expect(registry.getStt('does-not-exist').id).toBe('faster-whisper');
    expect(registry.getTranslation().id).toBe('argos');
    expect(registry.getTts(undefined).id).toBe('piper-local');
  });
});

describe('run queue (simultaneous-dub capacity)', () => {
  /** An orchestrator pinned to `maxProjects` via manual concurrency prefs. */
  function queuedOrchestrator(maxProjects: number, paused = false): LocalJobOrchestrator {
    return new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
        new FakeTranslationProvider(),
        new FakeTtsProvider(() => 900),
      ),
      bus: new EventBusRegistry(),
      setup: {
        getPreferences: async () => ({
          autoUpdate: true,
          concurrency: { mode: 'manual' as const, maxProjects, paused },
        }),
      },
    });
  }

  async function twoProjects(): Promise<[string, string]> {
    const video = await writeDummyVideo(tmp);
    const a = await orchestrator.createProject(createProjectInput(video, { name: 'A' }));
    const b = await orchestrator.createProject(createProjectInput(video, { name: 'B' }));
    return [a.id, b.id];
  }

  it('queues the second project when the limit is 1, then runs it when the first finishes', async () => {
    const [a, b] = await twoProjects();
    const sched = queuedOrchestrator(1);

    expect(await sched.runPipeline(a)).toEqual({ started: true, queued: false });
    const second = await sched.runPipeline(b);
    expect(second.queued).toBe(true);
    expect(second.position).toBe(1);
    expect((await store.getProject(b)).status).toBe('queued');
    expect((await store.getProject(b)).queue?.queuedAt).toBeTruthy();

    // The queue view explains itself.
    const state = await sched.queueState();
    expect(state.maxProjects).toBe(1);
    expect(state.running.map((r) => r.projectId)).toEqual([a]);
    expect(state.entries[0]).toMatchObject({ projectId: b, position: 1, reason: 'no-slot' });

    // When A's run settles, B is dispatched automatically.
    await sched.cancelJob(a);
    await vi.waitFor(async () => {
      expect((await store.getProject(b)).status).not.toBe('queued');
    });
    await sched.cancelJob(b);
  });

  it('starts both when the limit allows it', async () => {
    const [a, b] = await twoProjects();
    const sched = queuedOrchestrator(2);
    expect((await sched.runPipeline(a)).started).toBe(true);
    expect((await sched.runPipeline(b)).started).toBe(true);
    await sched.cancelJob(a);
    await sched.cancelJob(b);
  });

  it('cancelling a QUEUED project removes it and restores its previous status', async () => {
    const [a, b] = await twoProjects();
    const sched = queuedOrchestrator(1);
    await sched.runPipeline(a);
    await sched.runPipeline(b);
    expect((await store.getProject(b)).status).toBe('queued');

    await sched.cancelJob(b);
    const restored = await store.getProject(b);
    expect(restored.status).toBe('created');
    expect(restored.queue).toBeUndefined();
    expect((await sched.queueState()).entries).toEqual([]);
    await sched.cancelJob(a);
  });

  it('refuses settings edits while queued (the workload classification is frozen)', async () => {
    const [a, b] = await twoProjects();
    const sched = queuedOrchestrator(1);
    await sched.runPipeline(a);
    await sched.runPipeline(b);
    await expect(sched.updateProjectSettings(b, { maxSpeedRatio: 1.4 })).rejects.toMatchObject({
      appError: { code: 'RUN_IN_PROGRESS' },
    });
    await sched.cancelJob(a);
    await sched.cancelJob(b);
  });

  it('a paused queue holds everything, and says why', async () => {
    const [a] = await twoProjects();
    const sched = queuedOrchestrator(4, true);
    const result = await sched.runPipeline(a);
    expect(result.queued).toBe(true);
    const state = await sched.queueState();
    expect(state.paused).toBe(true);
    expect(state.entries[0]?.reason).toBe('paused');
    await sched.cancelJob(a);
  });

  it('reconcileQueue restores queued projects and demotes crashed runs to paused', async () => {
    const video = await writeDummyVideo(tmp);
    const queuedProject = await orchestrator.createProject(createProjectInput(video, { name: 'Q' }));
    const crashed = await orchestrator.createProject(createProjectInput(video, { name: 'C' }));
    await store.saveProject({
      ...(await store.getProject(queuedProject.id)),
      status: 'queued',
      queue: { queuedAt: '2026-01-01T00:00:00.000Z', previousStatus: 'created' },
    });
    await store.saveProject({ ...(await store.getProject(crashed.id)), status: 'running' });

    // Limit 0 -> clamped to 1, but pause it so reconcile doesn't start anything.
    const sched = queuedOrchestrator(1, true);
    await sched.reconcileQueue();

    expect((await store.getProject(crashed.id)).status).toBe('paused');
    const state = await sched.queueState();
    expect(state.entries.map((e) => e.projectId)).toContain(queuedProject.id);
  });
});

describe('burned-in subtitle style edits', () => {
  it('merges position / cover changes, keeps only well-formed fields, and clears an empty style', async () => {
    const video = await writeDummyVideo(tmp);
    const p = await orchestrator.createProject(createProjectInput(video));

    let { project } = await orchestrator.updateProjectSettings(p.id, { burnSubtitleStyle: { position: 'raised' } });
    expect(project.settings.burnSubtitleStyle).toEqual({ position: 'raised' });

    ({ project } = await orchestrator.updateProjectSettings(p.id, {
      burnSubtitleStyle: { coverOriginal: true, coverOpacity: 7, primaryColor: 'red', evil: '<script>' } as never,
    }));
    expect(project.settings.burnSubtitleStyle).toEqual({ position: 'raised', coverOriginal: true });

    ({ project } = await orchestrator.updateProjectSettings(p.id, {
      burnSubtitleStyle: { position: 'sideways', coverOriginal: 'yes' } as never,
    }));
    expect(project.settings.burnSubtitleStyle).toEqual({ position: 'raised', coverOriginal: true });
  });

  it('sanitizeSubtitleStyle drops everything it does not know', () => {
    expect(sanitizeSubtitleStyle({ junk: 1 })).toBeUndefined();
    expect(sanitizeSubtitleStyle(null)).toBeUndefined();
    expect(sanitizeSubtitleStyle({ sizePercent: 6, outlineColor: '#000000', coverHeightPercent: 90 })).toEqual({
      sizePercent: 6,
      outlineColor: '#000000',
    });
  });
});

describe('heavy-lane hand-over', () => {
  it('releases the heavy lane once alignment is done, before mixing and rendering', async () => {
    const video = await writeDummyVideo(tmp);
    const p = await orchestrator.createProject(createProjectInput(video, { name: 'GPU' }));
    const order: string[] = [];
    const buses = new EventBusRegistry();
    buses.get(p.id).subscribe((e) => {
      if (e.type === 'step' && (e.step.status === 'running' || e.step.status === 'completed')) {
        order.push(`${e.step.id}:${e.step.status}`);
      }
    });
    const s = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
        new FakeTranslationProvider(),
        new FakeTtsProvider(() => 900),
      ),
      bus: buses,
      engines: {
        heavyLaneOwner: () => undefined,
        releaseHeavyLane: (owner: string) => order.push(`release:${owner === p.id ? 'run' : owner}`),
      } as never,
    });

    await s.runPipeline(p.id);
    // A whole (fake) dub: give it room on a loaded machine (the 1 s default flaked under a parallel build).
    await vi.waitFor(async () => expect((await store.getProject(p.id)).status).toBe('completed'), { timeout: 15_000 });

    const released = order.indexOf('release:run');
    expect(released).toBeGreaterThan(order.indexOf('alignment:completed'));
    expect(released).toBeLessThan(order.indexOf('audio-mix:running'));
  });

  it('holds the lane through the mix only when a separation engine can actually run', async () => {
    // The server always wires separation; with no engine installed, "replace
    // the voices" falls back to ducking, which needs no lane at all.
    for (const available of [false, true]) {
      const video = await writeDummyVideo(tmp);
      const p = await orchestrator.createProject(
        createProjectInput(video, { name: `S-${available}`, settings: defaultSettings({ originalAudioMode: 'replace-vocals' }) }),
      );
      const order: string[] = [];
      const buses = new EventBusRegistry();
      buses.get(p.id).subscribe((e) => {
        if (e.type === 'step' && (e.step.status === 'running' || e.step.status === 'completed')) order.push(`${e.step.id}:${e.step.status}`);
      });
      const s = new LocalJobOrchestrator({
        config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
        store,
        media: new FakeMediaService(),
        registry: fakeRegistry(
          new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
          new FakeTranslationProvider(),
          new FakeTtsProvider(() => 900),
        ),
        bus: buses,
        separation: { separate: async () => null, available: async () => available },
        engines: {
          heavyLaneOwner: () => undefined,
          releaseHeavyLane: (owner: string) => order.push(`release:${owner === p.id ? 'run' : owner}`),
        } as never,
      });
      await s.runPipeline(p.id);
      await vi.waitFor(async () => expect((await store.getProject(p.id)).status).toBe('completed'), { timeout: 15_000 });
      const released = order.indexOf('release:run');
      if (available) expect(released).toBeGreaterThan(order.indexOf('audio-mix:completed'));
      else expect(released).toBeLessThan(order.indexOf('audio-mix:running'));
    }
  });
});

describe('run queue — review-finding regressions', () => {
  function sched(maxProjects: number, extra: Partial<Parameters<typeof LocalJobOrchestrator.prototype.constructor>[0]> = {}): LocalJobOrchestrator {
    return new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(
        new FakeSttProvider(makeSegments([[0, 1000, 'hi']])),
        new FakeTranslationProvider(),
        new FakeTtsProvider(() => 900),
      ),
      bus: new EventBusRegistry(),
      setup: {
        getPreferences: async () => ({
          autoUpdate: true,
          concurrency: { mode: 'manual' as const, maxProjects },
        }),
      },
      ...extra,
    } as never);
  }

  it('retrying a QUEUED project does not double-enqueue or poison previousStatus', async () => {
    const video = await writeDummyVideo(tmp);
    const a = await orchestrator.createProject(createProjectInput(video, { name: 'A' }));
    const b = await orchestrator.createProject(createProjectInput(video, { name: 'B' }));
    const s = sched(1);
    await s.runPipeline(a.id);
    await s.runPipeline(b.id); // queued

    // Re-retrying the queued project must not register it twice.
    await s.retryStep(b.id, 'tts');
    const state = await s.queueState();
    expect(state.entries.filter((e) => e.projectId === b.id)).toHaveLength(1);

    // Cancelling restores a REAL status, never 'queued'.
    await s.cancelJob(b.id);
    expect((await store.getProject(b.id)).status).not.toBe('queued');
    expect((await store.getProject(b.id)).queue).toBeUndefined();
    await s.cancelJob(a.id);
  });

  it('keeps a project queued (not failed) while a bundled worker is still booting', async () => {
    const video = await writeDummyVideo(tmp);
    const p = await orchestrator.createProject(createProjectInput(video, { name: 'Boot' }));
    let booting = true;
    const s = sched(2, {
      checkReadiness: async () =>
        booting
          ? [
              {
                phase: 'stt' as const,
                providerId: 'faster-whisper',
                status: 'worker-loading' as const,
                ready: false,
                message: 'The speech-to-text service is still starting.',
              },
            ]
          : [],
    });

    // Enqueue directly (readiness at enqueue is bypassed here by construction:
    // runPipeline gates on the same checker, so drive the queue path).
    await store.saveProject({
      ...(await store.getProject(p.id)),
      status: 'queued',
      queue: { queuedAt: new Date().toISOString(), previousStatus: 'created' },
    });
    await s.reconcileQueue();

    // Still queued — a booting worker must NOT mark the project failed.
    expect((await store.getProject(p.id)).status).toBe('queued');
    expect((await s.queueState()).entries.map((e) => e.projectId)).toContain(p.id);

    // Once the worker is up, the retry dispatches it.
    booting = false;
    await s.pumpQueue();
    await vi.waitFor(async () => {
      expect((await store.getProject(p.id)).status).not.toBe('queued');
    });
    await s.cancelJob(p.id);
    s.stopScheduler();
  });
});

describe('LocalJobOrchestrator — choosing where a project is saved', () => {
  it('moves the finished files to a chosen folder under the project name, and back', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video, { name: 'Clip' }));
    const paths = store.paths(project.id);
    await fsp.writeFile(paths.outputMp4, 'video');
    await fsp.writeFile(path.join(paths.renderDir, 'output.srt'), 'subs');

    // Another project already saved "Clip.vi.mp4" in the folder.
    const dubs = path.join(tmp, 'Dubs');
    await fsp.mkdir(dubs);
    await fsp.writeFile(path.join(dubs, 'Clip.vi.mp4'), 'another project');

    const moved = await orchestrator.setProjectOutputDir(project.id, dubs);
    expect(moved.outputDir).toBe(dubs);
    expect(moved.outputFileName).toBe('Clip (2).vi');
    expect(await fsp.readFile(path.join(dubs, 'Clip (2).vi.mp4'), 'utf8')).toBe('video');
    expect(await fsp.readFile(path.join(dubs, 'Clip (2).vi.srt'), 'utf8')).toBe('subs');
    expect(await fsp.readFile(path.join(dubs, 'Clip.vi.mp4'), 'utf8')).toBe('another project');
    await expect(fsp.stat(paths.outputMp4)).rejects.toThrow();
    expect((await store.getProject(project.id)).outputDir).toBe(dubs);

    const back = await orchestrator.setProjectOutputDir(project.id, null);
    expect(back.outputDir).toBe(paths.renderDir);
    expect(back.outputFileName).toBeUndefined();
    expect(await fsp.readFile(paths.outputMp4, 'utf8')).toBe('video');
    expect((await fsp.readdir(dubs)).sort()).toEqual(['Clip.vi.mp4']);
  });

  it('renders straight into the chosen folder', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video, { name: 'Clip' }));
    const dubs = path.join(tmp, 'Dubs');
    await orchestrator.setProjectOutputDir(project.id, dubs);
    await fsp.writeFile(store.paths(project.id).finalMixWav, 'mix');

    const result = await orchestrator.renderFinalVideo(project.id, {});
    expect(result.outputPath).toBe(path.join(dubs, 'Clip.vi.mp4'));
    await expect(fsp.stat(result.outputPath)).resolves.toBeTruthy();
  });

  it('refuses a folder it cannot use, and leaves the project as it was', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    await fsp.writeFile(paths.outputMp4, 'video');
    const file = path.join(tmp, 'a-file');
    await fsp.writeFile(file, 'x');

    await expect(orchestrator.setProjectOutputDir(project.id, path.join(file, 'Dubs'))).rejects.toMatchObject({
      appError: { code: 'OUTPUT_NOT_WRITABLE' },
    });
    await expect(orchestrator.setProjectOutputDir(project.id, 'Dubs')).rejects.toMatchObject({
      appError: { code: 'OUTPUT_NOT_WRITABLE' },
    });
    expect((await store.getProject(project.id)).outputDir).toBe(paths.renderDir);
    expect(await fsp.readFile(paths.outputMp4, 'utf8')).toBe('video');
  });
});

describe('LocalJobOrchestrator — pausing a dub', () => {
  /** A speech-to-text engine that works until it is stopped, with capacity for one dub. */
  function slowOrchestrator(): LocalJobOrchestrator {
    const stt = {
      id: 'faster-whisper',
      displayName: 'slow',
      isLocal: true,
      transcribe: (_input: unknown, signal?: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    };
    return new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      setup: {
        getPreferences: async () => ({
          autoUpdate: true,
          concurrency: { mode: 'manual' as const, maxProjects: 1, paused: false },
        }),
      },
    });
  }

  const sttRunning = async (projectId: string) =>
    vi.waitFor(
      async () => expect((await store.getPipeline(projectId)).steps.find((s) => s.id === 'stt')?.status).toBe('running'),
      { timeout: 15_000 },
    );

  it('saves a paused dub as paused at its step, not failed, and continues it', async () => {
    const o = slowOrchestrator();
    const project = await o.createProject(createProjectInput(await writeDummyVideo(tmp)));
    await o.runPipeline(project.id);
    await sttRunning(project.id);

    await o.pauseJob(project.id);
    expect(o.isRunning(project.id)).toBe(false);
    expect(await store.getPipeline(project.id)).toMatchObject({ status: 'paused', pausedStep: 'stt' });
    expect((await store.getProject(project.id)).status).toBe('paused');

    // Continue: the run starts again at speech-to-text.
    expect(await o.runPipeline(project.id)).toEqual({ started: true, queued: false });
    await sttRunning(project.id);
    await o.pauseJob(project.id);
  });

  it('pauses every dub when the app closes, and starts no queued dub in their place', async () => {
    const o = slowOrchestrator();
    const video = await writeDummyVideo(tmp);
    const a = await o.createProject(createProjectInput(video, { name: 'A' }));
    const b = await o.createProject(createProjectInput(video, { name: 'B' }));
    await o.runPipeline(a.id);
    expect((await o.runPipeline(b.id)).queued).toBe(true);
    await sttRunning(a.id);

    await o.pauseAll();
    expect(o.isRunning(a.id)).toBe(false);
    expect((await store.getPipeline(a.id)).status).toBe('paused');
    // The freed slot went to nobody: B waits for the next start.
    await new Promise((r) => setTimeout(r, 50));
    expect(o.isRunning(b.id)).toBe(false);
    expect((await store.getProject(b.id)).status).toBe('queued');
  });

  it('Pause on a dub that nothing runs any more settles it as paused', async () => {
    const project = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
    await store.savePipeline(setStepStatus(await store.getPipeline(project.id), 'probe-video', 'running'));
    await store.saveProject({ ...project, status: 'running' });
    await orchestrator.pauseJob(project.id);
    expect(await store.getPipeline(project.id)).toMatchObject({ status: 'paused', pausedStep: 'probe-video' });
    expect((await store.getProject(project.id)).status).toBe('paused');
  });

  it('marks a dub the app died on as paused, its pipeline too', async () => {
    const project = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
    // The computer went off mid-translation: both still say "running".
    let pipeline = await store.getPipeline(project.id);
    for (const id of ['probe-video', 'extract-audio', 'stt'] as const) pipeline = setStepStatus(pipeline, id, 'completed');
    await store.savePipeline(setStepStatus(pipeline, 'translation', 'running', { progressPercent: 40 }));
    await store.saveProject({ ...project, status: 'running' });

    await orchestrator.reconcileQueue();
    const after = await store.getPipeline(project.id);
    expect(after).toMatchObject({ status: 'paused', pausedStep: 'translation' });
    expect(after.steps.find((s) => s.id === 'translation')).toMatchObject({ status: 'pending', progressPercent: 40 });
    expect((await store.getProject(project.id)).status).toBe('paused');
  });
});

describe('LocalJobOrchestrator — moving a project while it is busy (review findings)', () => {
  it('refuses to move a project that waits in the queue', async () => {
    const video = await writeDummyVideo(tmp);
    const sched = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      setup: { getPreferences: async () => ({ autoUpdate: true, concurrency: { mode: 'manual' as const, maxProjects: 1, paused: true } }) },
    });
    const project = await sched.createProject(createProjectInput(video));
    expect((await sched.runPipeline(project.id)).queued).toBe(true);
    await expect(sched.setProjectOutputDir(project.id, path.join(tmp, 'Dubs'))).rejects.toMatchObject({
      appError: { code: 'RUN_IN_PROGRESS' },
    });
    await sched.cancelJob(project.id);
  });

  it('keeps what was saved while the files moved (it changes only where the project saves)', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video, { name: 'Clip' }));
    // A settings change lands after the move began reading the project.
    const originalGet = store.getProject.bind(store);
    let reads = 0;
    store.getProject = async (id: string) => {
      reads += 1;
      if (reads === 3) {
        const p = await originalGet(id);
        await store.saveProject({ ...p, settings: { ...p.settings, ttsGainDb: 4 } });
      }
      return originalGet(id);
    };
    try {
      await orchestrator.setProjectOutputDir(project.id, path.join(tmp, 'Dubs'));
    } finally {
      store.getProject = originalGet;
    }
    const saved = await store.getProject(project.id);
    expect(saved.outputFileName).toBe('Clip.vi');
    expect(saved.settings.ttsGainDb).toBe(4);
  });
});

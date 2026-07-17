import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalJobOrchestrator } from './orchestrator.js';
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

    const { segment, alignment } = await orchestrator.synthesizeSingleSegment(project.id, 'seg_0001', {
      text: 'Xin chào các bạn',
    });

    expect(segment.segmentId).toBe('seg_0001');
    expect(segment.durationMs).toBe(900);
    expect(alignment.status).toBe('ok'); // 900ms fits in 1000ms window

    // Edited text persisted back to translated.json.
    const merged = JSON.parse(await fsp.readFile(paths.translatedJson, 'utf8'));
    expect(merged.segments[0].translatedText).toBe('Xin chào các bạn');

    // Aligned file updated.
    const aligned = JSON.parse(await fsp.readFile(paths.translatedAlignedJson, 'utf8'));
    expect(aligned[0].segmentId).toBe('seg_0001');
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

    await expect(gated.runPipeline(project.id)).resolves.toBeUndefined();
    await gated.cancelJob(project.id); // clean up the scheduled background run
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

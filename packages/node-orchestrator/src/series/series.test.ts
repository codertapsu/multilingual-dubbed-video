import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectOutputThumbnailPath, type PictureDetection, type TranscriptSegment } from '@videodubber/shared';

import { loadConfig } from '../config.js';
import { EventBusRegistry } from '../events.js';
import { LocalJobOrchestrator } from '../orchestrator.js';
import {
  FakeMediaService,
  FakeSttProvider,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeMediaInfo,
  fakeRegistry,
  writeDummyVideo,
} from '../test/fixtures.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { SeriesService } from './seriesService.js';

const MIN = 60_000;

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-series-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 40 minutes of lines every 5 s, with a long pause every 3 minutes. */
function talk(): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let t = 1000;
  for (let i = 0; t < 40 * MIN - 6000; i++) {
    out.push({ id: `seg_${String(i + 1).padStart(4, '0')}`, index: i, startMs: t, endMs: t + 4000, sourceText: `câu ${i}` });
    t += i % 36 === 35 ? 9000 : 5000;
  }
  return out;
}

describe('a long video dubbed as a series', { timeout: 60_000 }, () => {
  it('analyses once, plans with the AI, and dubs each part over its window with its opening and closing', async () => {
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(40 * MIN) });
    const stt = new FakeSttProvider(talk());
    const asked: string[] = [];
    const chat = {
      chatComplete: vi.fn(async (_system: string | undefined, user: string) => {
        asked.push(user);
        if (user.includes('"candidate"')) return '{"candidate":"C2"}';
        if (user.includes('"title"')) return '```json\n{"title":"Hồi một","summary":"Mọi chuyện bắt đầu."}\n```';
        return '{}';
      }),
    };
    const orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      seriesAnalysed: (id) => series.analysed(id),
    });
    const series = new SeriesService({
      store,
      projects: orchestrator,
      start: (id) => orchestrator.runPipeline(id),
      chatFor: (id) => (id === 'fake-ai' ? (chat as never) : undefined),
    });

    const video = await writeDummyVideo(tmp);
    const parent = await orchestrator.createProject({
      ...createProjectInput(video, { name: 'Tây Du Ký' }),
      series: { minMinutes: 15, maxMinutes: 25, aiProviderId: 'fake-ai', recapSec: 4, autoStart: false },
    });
    expect(parent.series).toMatchObject({ role: 'parent', state: 'analysing' });

    await orchestrator.runPipeline(parent.id);
    await vi.waitFor(async () => expect((await store.getProject(parent.id)).series).toMatchObject({ state: 'review' }), { timeout: 15_000 });
    // Speech-to-text ran (in 10-minute chunks); nothing was dubbed for the parent.
    const sttCalls = stt.calls;
    expect(sttCalls).toBeGreaterThan(0);
    expect(media.calls.some((c) => c.startsWith('buildTtsTimeline'))).toBe(false);

    const view = await series.view(parent.id);
    expect(view.parts).toHaveLength(2);
    expect(view.plan!.parts[1]!.cutBy).toBe('ai');
    expect(view.plan!.parts[0]!.title).toBe('Hồi một');

    // The user moves the cut a little before making the parts.
    const cut = view.plan!.parts[1]!.startMs;
    const revised = await series.revisePlan(parent.id, { cuts: [cut - 60_000] });
    expect(revised.parts[1]!.startMs).toBe(cut - 60_000);
    expect(revised.parts[1]!.cutBy).toBe('manual');

    const started = await series.startParts(parent.id);
    expect(started).toHaveLength(2);
    const [p1, p2] = started.map((s) => s.projectId);
    await vi.waitFor(
      async () => {
        expect((await store.getProject(p1!)).status).toBe('completed');
        expect((await store.getProject(p2!)).status).toBe('completed');
      },
      { timeout: 20_000 },
    );

    const second = await store.getProject(p2!);
    expect(second.series).toMatchObject({ role: 'part', index: 2, count: 2, seriesName: 'Tây Du Ký' });
    expect(second.sourceRange!.endMs).toBe(40 * MIN);
    expect(second.mediaInfo!.durationMs).toBe(40 * MIN - second.sourceRange!.startMs);
    // Its transcript came from the parent: speech-to-text did not run again.
    expect(stt.calls).toBe(sttCalls);
    const lines = JSON.parse(await fsp.readFile(store.paths(p2!).sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(lines.segments[0]!.startMs).toBeGreaterThanOrEqual(0);
    expect(lines.segments[0]!.id).toBe('seg_0001');

    const render = media.renderInputs.find((r) => r.outputPath.includes(p2!))!;
    expect(render.range).toEqual(second.sourceRange);
    expect(render.effects!.darkenUntilMs).toBe(second.series!.role === 'part' ? second.series!.recapEndMs : -1);
    expect(render.effects!.cards!.map((c) => c.kind)).toEqual(['title', 'label', 'end']);
    expect(render.effects!.cards![2]!.text).toBe('Hết');
    const first = media.renderInputs.find((r) => r.outputPath.includes(p1!))!;
    expect(first.effects!.cards!.at(-1)!.text).toBe('Còn tiếp · Phần 2');
    // Each finished part has its thumbnail for the post, beside the video.
    expect(media.thumbnails.some((t) => t.startsWith(`${projectOutputThumbnailPath(second)}@`))).toBe(true);
    expect((await series.view(p2!)).parts.every((p) => p.status === 'completed')).toBe(true);
  });

  it('plans with the best pauses when the AI is not there, and says so', async () => {
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(40 * MIN) });
    const orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(new FakeSttProvider(talk()), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      seriesAnalysed: (id) => series.analysed(id),
    });
    const series = new SeriesService({ store, projects: orchestrator, start: (id) => orchestrator.runPipeline(id), chatFor: () => undefined });
    const video = await writeDummyVideo(tmp);
    const parent = await orchestrator.createProject({
      ...createProjectInput(video, { name: 'X' }),
      series: { minMinutes: 15, maxMinutes: 25, aiProviderId: 'gone', recapSec: 4, autoStart: true },
    });
    await orchestrator.runPipeline(parent.id);
    await vi.waitFor(async () => expect((await store.getProject(parent.id)).series).toMatchObject({ state: 'parts' }), { timeout: 15_000 });
    const view = await series.view(parent.id);
    expect(view.plan!.parts[1]!.cutBy).toBe('pause');
    // The long pause nearest the 20-minute target (the transcript is put together from 10-minute chunks).
    expect(view.plan!.parts[1]!.startMs).toBe(1_149_500);
    expect(view.plan!.notes[0]).toMatch(/not available/);
    // autoStart: the parts were made and started.
    await vi.waitFor(async () => expect((await series.view(parent.id)).parts.every((p) => p.status === 'completed')).toBe(true), {
      timeout: 20_000,
    });
  });

  it('cuts on a change of shot next to a good pause, decoding only seconds around the candidates', async () => {
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(40 * MIN) });
    // A change of shot 0.7 s before the long pause at 18:23.5; the one at 30:00 is near no candidate.
    media.sceneTimes = [1_102_800, 30 * MIN];
    const orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(new FakeSttProvider(talk()), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
      seriesAnalysed: (id) => series.analysed(id),
    });
    const series = new SeriesService({
      store,
      projects: orchestrator,
      start: (id) => orchestrator.runPipeline(id),
      chatFor: () => undefined,
      sceneChanges: (video, spans) => media.detectSceneChanges(video, spans),
    });
    const video = await writeDummyVideo(tmp);
    const parent = await orchestrator.createProject({
      ...createProjectInput(video, { name: 'Y' }),
      series: { minMinutes: 15, maxMinutes: 25, aiProviderId: 'gone', recapSec: 4, autoStart: false },
    });
    await orchestrator.runPipeline(parent.id);
    await vi.waitFor(async () => expect((await store.getProject(parent.id)).series).toMatchObject({ state: 'review' }), { timeout: 15_000 });
    const view = await series.view(parent.id);
    // Without it the nearer long pause (19:09.5, the test above) wins; with it, 18:23.5 does.
    expect(view.plan!.parts[1]!.startMs).toBe(1_103_500);
    expect(media.sceneSpans.length).toBeGreaterThan(0);
    expect(media.sceneSpans.every((s) => s.endMs - s.startMs <= 3000)).toBe(true);
    // The parent's own run ends after the plan: let it, before its folder goes.
    await vi.waitFor(async () => expect(['completed', 'failed', 'paused']).toContain((await store.getProject(parent.id)).status), {
      timeout: 15_000,
    });
  });
});

describe('a series that should not start by itself, and parts made again', { timeout: 30_000 }, () => {
  async function analysedParent(opts: {
    autoStart: boolean;
    minMinutes?: number;
    maxMinutes?: number;
    warnings?: string[];
    diarize?: boolean;
    watermarkAuto?: boolean;
    detectWatermark?: (id: string) => Promise<PictureDetection>;
    /** Joined from files starting at these times (ms), with one part per file. */
    perFileAt?: number[];
  }) {
    const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(40 * MIN) });
    const orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(new FakeSttProvider(talk()), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
    });
    const started: string[] = [];
    const series = new SeriesService({
      store,
      projects: orchestrator,
      start: async (id) => {
        started.push(id);
        return { started: true, queued: false };
      },
      chatFor: () => undefined,
      ...(opts.detectWatermark ? { detectWatermark: opts.detectWatermark } : {}),
    });
    const video = await writeDummyVideo(tmp);
    const parent = await orchestrator.createProject({
      ...createProjectInput(video, { name: 'Z' }),
      series: {
        minMinutes: opts.minMinutes ?? 15,
        maxMinutes: opts.maxMinutes ?? 20,
        aiProviderId: 'gone',
        recapSec: 4,
        autoStart: opts.autoStart,
        ...(opts.perFileAt ? { perFile: true } : {}),
      },
    });
    await store.saveProject({
      ...(await store.getProject(parent.id)),
      settings: { ...parent.settings, diarize: opts.diarize ?? true, ...(opts.watermarkAuto ? { watermarkAuto: { mode: 'pixelate' as const } } : {}) },
      mediaInfo: fakeMediaInfo(40 * MIN),
      ...(opts.perFileAt
        ? {
            inputFiles: opts.perFileAt.map((startMs, i, all) => ({
              name: `P${i + 1}.mp4`,
              path: `D:/v/P${i + 1}.mp4`,
              startMs,
              durationMs: (all[i + 1] ?? 40 * MIN) - startMs,
            })),
          }
        : {}),
    });
    await fsp.mkdir(path.dirname(store.paths(parent.id).sourceJson), { recursive: true });
    await fsp.writeFile(store.paths(parent.id).sourceJson, JSON.stringify({ segments: talk() }), 'utf8');
    const pipeline = await store.getPipeline(parent.id);
    await store.savePipeline({
      ...pipeline,
      warnings: (opts.warnings ?? []).map((code) => ({ code: code as never, step: 'stt' as const, at: new Date().toISOString(), key: `warning.${code}`, message: code })),
    });
    await series.analysed(parent.id);
    return { series, parent, started };
  }

  it('stops at review, and says why, when speaker detection failed or loops were left', async () => {
    const { series, parent, started } = await analysedParent({ autoStart: true, warnings: ['speakers-failed', 'loops-left'] });
    const view = await series.view(parent.id);
    expect(view.state).toBe('review');
    expect(view.reviewReasons).toHaveLength(2);
    expect(started).toEqual([]);
  });

  it('starts by itself from a clean analysis, and keeps every part within the bounds or says why', async () => {
    const { series, parent, started } = await analysedParent({ autoStart: true });
    const view = await series.view(parent.id);
    expect(view.state).toBe('parts');
    expect(view.reviewReasons).toBeUndefined();
    expect(started).toHaveLength(view.parts.length);
    // 40 minutes in parts of 15-20: two parts of about 20 minutes, never 19 and 21.
    for (const p of view.plan!.parts) {
      const minutes = (p.endMs - p.startMs) / MIN;
      const inside = minutes >= 14.99 && minutes <= 20.01; // cuts land on pauses, not on the millisecond
      expect(inside || view.plan!.notes.some((n) => n.startsWith(`Part ${p.index} is`))).toBe(true);
      expect(Math.abs(minutes - 20)).toBeLessThan(1);
    }
  });

  it('finds the watermark once in the whole video while planning, and makes every part with the box', async () => {
    const looked: string[] = [];
    const detectWatermark = async (id: string): Promise<PictureDetection> => {
      looked.push(id);
      return {
        at: '2026-11-25T00:00:00Z',
        videoWidth: 1280,
        videoHeight: 720,
        regions: [{ x: 0.7, y: 0.02, w: 0.28, h: 0.06, mode: 'blur', corner: 'top-right', confidence: 0.83 }],
        frameAtMs: 60_000,
        frames: 100,
        notes: [],
      };
    };
    const { series, parent, started } = await analysedParent({ autoStart: true, watermarkAuto: true, detectWatermark });
    const box = { x: 0.7, y: 0.02, w: 0.28, h: 0.06, mode: 'pixelate' };
    expect(looked).toEqual([parent.id]);
    const view = await series.view(parent.id);
    expect(view.plan!.notes.some((n) => n.startsWith('Found a watermark at the top right (clear: 83 %) in the whole video: every part is made with it blurred'))).toBe(true);
    expect((await store.getProject(parent.id)).settings.blurRegions).toEqual([box]);
    // Every part got the box: none of them looks again when it renders.
    expect(started.length).toBeGreaterThan(1);
    for (const id of started) expect((await store.getProject(id)).settings).toMatchObject({ blurRegions: [box], watermarkAuto: { mode: 'pixelate' } });
  });

  it('leaves the parts to look for their own mark when the whole video shows none, and never fails the plan for it', async () => {
    const { series, parent } = await analysedParent({
      autoStart: false,
      watermarkAuto: true,
      detectWatermark: async () => {
        throw new Error('no frames');
      },
    });
    const view = await series.view(parent.id);
    expect(view.state).toBe('review');
    expect(view.plan!.notes).toContain('The watermark could not be looked for (no frames): each part looks for its own when it renders.');
    expect((await store.getProject(parent.id)).settings.blurRegions).toBeUndefined();
  });

  it('one part per joined file: cut exactly where each file begins, whatever the length', async () => {
    const { series, parent } = await analysedParent({ autoStart: false, perFileAt: [0, 26 * MIN + 2_500] });
    const view = await series.view(parent.id);
    expect(view.plan!.parts.map((p) => [p.startMs, p.cutBy])).toEqual([
      [0, 'start'],
      [26 * MIN + 2_500, 'file'],
    ]);
    expect(view.plan!.notes).toContain('One part per file: 2 parts, cut where each file begins.');
  });

  it('remakes the parts from the fixed series transcript, leaving translated ones alone unless forced', async () => {
    const { series, parent } = await analysedParent({ autoStart: false });
    const ids = await series.createParts(parent.id);
    // The series transcript is fixed: every line now has a speaker.
    const fixed = talk().map((l, i) => ({ ...l, speakerId: `SPEAKER_0${i % 2}` }));
    await fsp.writeFile(store.paths(parent.id).sourceJson, JSON.stringify({ segments: fixed }), 'utf8');
    // Part 2 is already translated.
    await fsp.writeFile(store.paths(ids[1]!).translatedJson, JSON.stringify({ segments: [{ id: 'seg_0001' }] }), 'utf8');
    await fsp.writeFile(store.paths(ids[0]!).translationCheckpointJson, '{}', 'utf8');

    const report = await series.rebuildParts(parent.id);
    expect(report[0]).toMatchObject({ rebuilt: true, speakers: 2 });
    expect(report[1]).toMatchObject({ rebuilt: false, skipped: 'translated' });
    const part1 = JSON.parse(await fsp.readFile(store.paths(ids[0]!).sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(part1.segments.every((l) => l.speakerId)).toBe(true);
    // The stale checkpoint was moved aside, not left to be found.
    await expect(fsp.stat(store.paths(ids[0]!).translationCheckpointJson)).rejects.toThrow();

    const forced = await series.rebuildParts(parent.id, { force: true });
    expect(forced[1]).toMatchObject({ rebuilt: true });
    await expect(fsp.stat(store.paths(ids[1]!).translatedJson)).rejects.toThrow();
  });
});

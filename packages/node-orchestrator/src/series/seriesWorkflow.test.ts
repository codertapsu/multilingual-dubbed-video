/**
 * The series workflow of 0.18.0 (docs/plans/production-requests-2026-11-23.md)
 * against a real store and orchestrator: titles never empty (1.5), part names
 * from a template (2.1), a part edited after it was made (2.2), a replan that
 * keeps the user's titles (2.3), a subset rebuilt without stopping the queue
 * (2.4), a joined project's file boundaries as cuts (5.1) and a series that
 * continues another (5.2).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialPipelineState,
  projectOutputVideoPath,
  setStepStatus,
  type Project,
  type ProjectInputFile,
  type SeriesSettings,
  type TranscriptSegment,
} from '@videodubber/shared';

import { listEdits } from '../activity/history.js';
import { activity } from '../activity/registry.js';
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
import { pictureDirOf } from '../picture/pictureDetection.js';
import { reuseRecapTranslations } from './recap.js';
import { SeriesService, type ProjectWork } from './seriesService.js';

const MIN = 60_000;

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-series-flow-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Lines every 5 s for `minutes`, a 9 s pause every 3 minutes; `speaker` labels them. */
function talk(minutes: number, speaker?: (i: number) => string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let t = 1000;
  for (let i = 0; t < minutes * MIN - 6000; i++) {
    out.push({
      id: `seg_${String(i + 1).padStart(4, '0')}`,
      index: i,
      startMs: t,
      endMs: t + 4000,
      sourceText: `câu ${i}`,
      ...(speaker ? { speakerId: speaker(i) } : {}),
    });
    t += i % 36 === 35 ? 9000 : 5000;
  }
  return out;
}

type Chat = { chatComplete: (system: string | undefined, user: string) => Promise<string> };

/** An AI that picks the first pause offered and titles part n with `title(n, attempt)`. */
function chatTitling(title: (n: number, attempt: number) => string): Chat & { asked: string[]; attempts: Map<number, number> } {
  const asked: string[] = [];
  const attempts = new Map<number, number>();
  return {
    asked,
    attempts,
    chatComplete: vi.fn(async (_system: string | undefined, user: string) => {
      asked.push(user);
      if (user.includes('"candidate"')) return '{"candidate":"C1"}';
      const n = Number(/part (\d+) of/.exec(user)?.[1]);
      if (!Number.isFinite(n)) return '{}';
      const a = (attempts.get(n) ?? 0) + 1;
      attempts.set(n, a);
      return title(n, a);
    }),
  };
}

interface Rig {
  orchestrator: LocalJobOrchestrator;
  series: SeriesService;
  /** The queue starts nothing while true (Settings: pause the queue). */
  prefs: { paused: boolean };
}

function rig(opts: { chat?: Chat; workOn?: (id: string) => ProjectWork | undefined } = {}): Rig {
  const prefs = { paused: true };
  const orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) }),
    registry: fakeRegistry(new FakeSttProvider(talk(1)), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
    setup: {
      getPreferences: async () => ({ autoUpdate: true, concurrency: { mode: 'manual' as const, maxProjects: 1, paused: prefs.paused } }),
    },
  });
  const series = new SeriesService({
    store,
    projects: orchestrator,
    start: (id) => orchestrator.runPipeline(id),
    chatFor: (id) => (id === 'fake-ai' && opts.chat ? (opts.chat as never) : undefined),
    isBusy: (id) => orchestrator.busyProjects().includes(id),
    workOn: (id) => opts.workOn?.(id) ?? orchestrator.workOn(id),
    holdQueue: (fn) => orchestrator.whileQueueHeld(fn),
    renameProject: (id, name) => orchestrator.renameProject(id, name),
    pause: (id) => orchestrator.pauseJob(id),
  });
  return { orchestrator, series, prefs };
}

/** A series parent that has transcribed its video, planned by `analysed()`. */
async function analysedParent(
  r: Rig,
  opts: {
    name?: string;
    minutes?: number;
    lines?: TranscriptSegment[];
    settings?: Partial<SeriesSettings>;
    outputDir?: string;
    inputFiles?: ProjectInputFile[];
    projectSettings?: Partial<Project['settings']>;
    speakers?: { speakerId: string; print: number[] }[];
  } = {},
): Promise<Project> {
  const minutes = opts.minutes ?? 60;
  const video = await writeDummyVideo(tmp);
  const input = createProjectInput(video, { name: opts.name ?? 'Tây Du Ký' });
  const parent = await r.orchestrator.createProject({
    ...input,
    settings: { ...input.settings, ...opts.projectSettings },
    ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
    series: { minMinutes: 15, maxMinutes: 20, aiProviderId: 'fake-ai', recapSec: 4, autoStart: false, ...opts.settings },
  });
  await store.saveProject({
    ...(await store.getProject(parent.id)),
    mediaInfo: fakeMediaInfo(minutes * MIN),
    ...(opts.inputFiles ? { inputFiles: opts.inputFiles } : {}),
  });
  const paths = store.paths(parent.id);
  await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
  await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: opts.lines ?? talk(minutes) }), 'utf8');
  if (opts.speakers) await writeSpeakers(parent.id, opts.speakers);
  await r.series.analysed(parent.id);
  return store.getProject(parent.id);
}

/** audio/diarization.json with these speakers' voice prints. */
async function writeSpeakers(projectId: string, speakers: { speakerId: string; print: number[] }[]): Promise<void> {
  const file = store.paths(projectId).diarizationJson;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({
      format: 2,
      audio: { sizeBytes: 1, mtimeMs: 1 },
      model: 'test',
      turns: [],
      speakers: speakers.map((s, i) => ({ speaker: i, sec: 60, f0Hz: null, gender: 'unknown', genderConfidence: 0, ...s })),
    }),
    'utf8',
  );
}

/** A part as if dubbed to the end: every step done, its video in its folder. */
async function markRendered(projectId: string): Promise<void> {
  let state = createInitialPipelineState(projectId);
  for (const s of state.steps) state = setStepStatus(state, s.id, 'completed');
  await store.savePipeline(state);
  const project = await store.saveProject({ ...(await store.getProject(projectId)), status: 'completed' });
  await fsp.mkdir(project.outputDir, { recursive: true });
  await fsp.writeFile(projectOutputVideoPath(project), 'video', 'utf8');
}

const lines = async (projectId: string): Promise<TranscriptSegment[]> =>
  (JSON.parse(await fsp.readFile(store.paths(projectId).sourceJson, 'utf8')) as { segments: TranscriptSegment[] }).segments;

describe('titles and names of the parts (1.5, 2.1)', { timeout: 60_000 }, () => {
  it('asks the AI again once, then names a part "Phần n" with a note; names the parts from the template', async () => {
    const chat = chatTitling((n, attempt) => {
      if (n === 1) return '{"title":"Mở đầu","summary":"Mọi chuyện bắt đầu."}';
      if (n === 2) return attempt === 1 ? '{"summary":"thiếu tên"}' : '{"title":"Ngã rẽ","summary":"Một lựa chọn."}';
      return 'Xin lỗi, tôi không giúp được.';
    });
    const r = rig({ chat });
    const dubs = path.join(tmp, 'Dubs');
    const parent = await analysedParent(r, { outputDir: dubs, settings: { nameTemplate: '{series} - Tập {nn}: {title}' } });
    const view = await r.series.view(parent.id);
    expect(view.state).toBe('review');
    expect(view.plan!.parts.map((p) => p.title)).toEqual(['Mở đầu', 'Ngã rẽ', 'Phần 3']);
    expect(chat.attempts.get(2)).toBe(2);
    expect(chat.attempts.get(3)).toBe(2);
    expect(view.plan!.notes).toContain("Part 3: no title from the AI (no usable answer), named 'Phần 3'.");
    // Planning is in the activity list, by its kind.
    expect(activity.list({ projectId: parent.id }).some((e) => e.kind === 'series.plan' && e.state === 'done')).toBe(true);

    const ids = await r.series.createParts(parent.id);
    const parts = await Promise.all(ids.map((id) => store.getProject(id)));
    expect(parts.map((p) => p.name)).toEqual(['Tây Du Ký - Tập 01: Mở đầu', 'Tây Du Ký - Tập 02: Ngã rẽ', 'Tây Du Ký - Tập 03']);
    // In a chosen folder their files are named after them.
    expect(parts.map((p) => p.outputFileName)).toEqual(['Tây Du Ký - Tập 01 Mở đầu.vi', 'Tây Du Ký - Tập 02 Ngã rẽ.vi', 'Tây Du Ký - Tập 03.vi']);
    expect(parts[2]!.series).toMatchObject({ role: 'part', index: 3, count: 3, title: 'Phần 3', seriesName: 'Tây Du Ký' });
  });

  it('names the parts as before without a template', async () => {
    const r = rig();
    const parent = await analysedParent(r, { minutes: 40 });
    const ids = await r.series.createParts(parent.id);
    expect((await Promise.all(ids.map((id) => store.getProject(id)))).map((p) => p.name)).toEqual(['Tây Du Ký - Phần 01', 'Tây Du Ký - Phần 02']);
    // No AI here: still never an empty title, and one note says why.
    const view = await r.series.view(parent.id);
    expect(view.parts.map((p) => p.title)).toEqual(['Phần 1', 'Phần 2']);
    expect(view.plan!.notes.some((n) => n.startsWith('No AI named the parts'))).toBe(true);
  });
});

describe('New project after Back: the series options as the form now holds them', { timeout: 60_000 }, () => {
  it('replaces them, or makes a single video again, and never touches a part', async () => {
    const r = rig();
    const video = await writeDummyVideo(tmp);
    const input = createProjectInput(video, { name: 'Tây Du Ký' });
    const base = { minMinutes: 15, maxMinutes: 20, aiProviderId: 'fake-ai', recapSec: 4, autoStart: false };
    const made = await r.orchestrator.createProject({ ...input, series: base });
    // A client older than 0.18.0 sends no series: unchanged.
    expect((await r.orchestrator.reviseProject(made.id, { name: 'A', settings: input.settings })).series).toMatchObject({ role: 'parent' });
    const named = await r.orchestrator.reviseProject(made.id, { name: 'A', settings: input.settings, series: { ...base, nameTemplate: '{series} - Tập {nn}' } });
    expect(named.series).toMatchObject({ role: 'parent', state: 'analysing', settings: { nameTemplate: '{series} - Tập {nn}' } });
    const single = await r.orchestrator.reviseProject(made.id, { name: 'A', settings: input.settings, series: null });
    expect(single.series).toBeUndefined();

    const parent = await analysedParent(r, { minutes: 40 });
    const [part] = await r.series.createParts(parent.id);
    const revised = await r.orchestrator.reviseProject(part!, { name: 'P', settings: input.settings, series: null });
    expect(revised.series).toMatchObject({ role: 'part', parentId: parent.id });
  });
});

describe('a part edited after it was made (2.2)', { timeout: 60_000 }, () => {
  it('renames, retitles and summarises a part without a reset; a rendered one renders again', async () => {
    const chat = chatTitling((n) => `{"title":"Tên ${n}","summary":"Tóm tắt ${n}."}`);
    const dubbing: { id?: string } = {};
    const r = rig({ chat, workOn: (id) => (id === dubbing.id ? 'running' : undefined) });
    const dubs = path.join(tmp, 'Dubs');
    const parent = await analysedParent(r, { outputDir: dubs, settings: { nameTemplate: '{series} - Tập {nn}: {title}' } });
    const [p1, p2, p3] = await r.series.createParts(parent.id);
    await markRendered(p1!);
    const oldVideo = projectOutputVideoPath(await store.getProject(p1!));

    // A new title on a rendered part: the name the template made follows it,
    // the finished files are renamed along, and only the render is redone.
    const edited = await r.series.editPart(p1!, { title: 'Khởi đầu' });
    expect(edited.renderAgain).toBe(true);
    expect(edited.project.name).toBe('Tây Du Ký - Tập 01: Khởi đầu');
    expect(edited.project.outputFileName).toBe('Tây Du Ký - Tập 01 Khởi đầu.vi');
    expect(edited.project.status).toBe('paused');
    await expect(fsp.stat(oldVideo)).rejects.toThrow();
    expect(await fsp.readFile(projectOutputVideoPath(edited.project), 'utf8')).toBe('video');
    const pipeline = await store.getPipeline(p1!);
    expect(pipeline).toMatchObject({ status: 'paused', pausedStep: 'render' });
    expect(pipeline.steps.find((s) => s.id === 'audio-mix')!.status).toBe('completed');

    // A name the user chose stays when the title changes.
    expect((await r.series.editPart(p2!, { name: 'Tập hai của tôi' })).project.outputFileName).toBe('Tập hai của tôi.vi');
    const retitled = await r.series.editPart(p2!, { title: 'Ngã rẽ' });
    expect(retitled.project.name).toBe('Tập hai của tôi');
    expect(retitled.renderAgain).toBe(false);
    expect(retitled.project.series).toMatchObject({ title: 'Ngã rẽ', summary: 'Tóm tắt 2.' });

    // A summary is not on the card: nothing to render again.
    const summarised = await r.series.editPart(p3!, { summary: 'Hồi kết.' });
    expect(summarised.renderAgain).toBe(false);
    const view = await r.series.view(parent.id);
    expect(view.parts.map((p) => [p.title, p.name, p.summary])).toEqual([
      ['Khởi đầu', 'Tây Du Ký - Tập 01: Khởi đầu', 'Tóm tắt 1.'],
      ['Ngã rẽ', 'Tập hai của tôi', 'Tóm tắt 2.'],
      ['Tên 3', 'Tây Du Ký - Tập 03: Tên 3', 'Hồi kết.'],
    ]);

    // Never while it is being dubbed, and only parts.
    dubbing.id = p3;
    await expect(r.series.editPart(p3!, { title: 'X' })).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    await expect(r.series.editPart(parent.id, { title: 'X' })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    await expect(r.series.editPart(p2!, { name: '  ' })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
  });
});

describe('planning again, keeping what the user wrote (2.3)', { timeout: 60_000 }, () => {
  it('keeps the titles edited in review only when asked', async () => {
    let round = 1;
    const chat = chatTitling((n) => `{"title":"AI ${round}.${n}","summary":"S ${round}.${n}"}`);
    const r = rig({ chat });
    const parent = await analysedParent(r);
    const plan = (await r.series.view(parent.id)).plan!;
    await r.series.revisePlan(parent.id, {
      titles: plan.parts.map((p) => (p.index === 2 ? { title: 'Của tôi', summary: p.summary } : { title: p.title, summary: p.summary })),
    });
    expect((await r.series.view(parent.id)).plan!.parts[1]!.edited).toEqual({ title: true });

    round = 2;
    await r.series.analysed(parent.id, { again: true, keepTitles: true });
    const kept = (await r.series.view(parent.id)).plan!;
    expect(kept.parts.map((p) => p.title)).toEqual(['AI 2.1', 'Của tôi', 'AI 2.3']);
    expect(kept.notes.some((n) => n.includes('kept for 1 part'))).toBe(true);

    round = 3;
    await r.series.analysed(parent.id, { again: true });
    expect((await r.series.view(parent.id)).plan!.parts.map((p) => p.title)).toEqual(['AI 3.1', 'AI 3.2', 'AI 3.3']);
    expect(activity.list({ projectId: parent.id }).some((e) => e.kind === 'series.plan' && e.title.startsWith('Planning again'))).toBe(true);
  });
});

describe('a series of a video with an advert tail (claude-dubber, 2026-11-27)', { timeout: 60_000 }, () => {
  it('ends where the banner begins, says so, and keeps that end when the cuts move', async () => {
    const r = rig();
    // An hour, the advert from minute 40 (speech-to-text stopped there).
    const parent = await analysedParent(r, { minutes: 60, lines: talk(40) });
    const dir = pictureDirOf(parent);
    await fsp.mkdir(dir, { recursive: true });
    const detection = {
      at: '2026-11-27T10:00:00.000Z',
      videoWidth: 1920,
      videoHeight: 1080,
      regions: [],
      frameAtMs: 0,
      frames: 100,
      notes: [],
      tailChecked: true,
      adTail: { fromMs: 40 * MIN, box: { x: 0.1, y: 0.6, w: 0.8, h: 0.35 }, confidence: 0.9 },
    };
    await fsp.writeFile(path.join(dir, 'detection.json'), JSON.stringify(detection), 'utf8');
    await r.series.analysed(parent.id, { again: true });

    const view = await r.series.view(parent.id);
    expect(view.plan!.endMs).toBe(40 * MIN);
    expect(view.plan!.parts.at(-1)!.endMs).toBe(40 * MIN);
    expect(view.plan!.notes[0]).toMatch(/^The series ends at 40:00: from there to the end \(1:00:00\) the same banner stays on the picture/);
    // Two parts of 15-20 minutes, none of the advert.
    expect(view.plan!.parts).toHaveLength(2);
    // Moving the cut keeps the end.
    const moved = await r.series.revisePlan(parent.id, { cuts: [22 * MIN] });
    expect(moved.parts.map((p) => [p.startMs, p.endMs])).toEqual([
      [0, 22 * MIN],
      [22 * MIN, 40 * MIN],
    ]);

    // The whole video when told to: planned again to its end.
    await store.saveProject({ ...(await store.getProject(parent.id)), settings: { ...(await store.getProject(parent.id)).settings, stopAtAdTail: false } });
    await r.series.analysed(parent.id, { again: true });
    const whole = await r.series.view(parent.id);
    expect(whole.plan!.endMs).toBeUndefined();
    expect(whole.plan!.parts.at(-1)!.endMs).toBe(60 * MIN);
  });

  it("leaves the advert's voice before its banner out of the parts of a series planned on 0.21.0 (Săn Yêu, 2026-11-27)", async () => {
    const r = rig();
    const parent = await analysedParent(r, { minutes: 60, lines: talk(40) });
    const dir = pictureDirOf(parent);
    await fsp.mkdir(dir, { recursive: true });
    const tail = { fromMs: 40 * MIN, box: { x: 0, y: 0.83, w: 1, h: 0.07 }, confidence: 0.9 };
    await fsp.writeFile(
      path.join(dir, 'detection.json'),
      JSON.stringify({ at: '2026-11-27T10:00:00.000Z', videoWidth: 1920, videoHeight: 1080, regions: [], frameAtMs: 0, frames: 100, notes: [], tailChecked: true, adTail: tail }),
      'utf8',
    );
    // Planned by 0.21.0: to the banner, the advert's voice not known yet.
    await r.series.analysed(parent.id, { again: true });
    expect((await r.series.view(parent.id)).plan!.endMs).toBe(40 * MIN);
    // Its transcript holds the advert's voice, 4 s before the banner.
    const sourceJson = store.paths(parent.id).sourceJson;
    const segments = (JSON.parse(await fsp.readFile(sourceJson, 'utf8')) as { segments: TranscriptSegment[] }).segments;
    const advert = { id: 'seg_9999', index: segments.length, startMs: 40 * MIN - 4000, endMs: 40 * MIN - 500, sourceText: '个个个点击评论区蓝色链接' };
    await fsp.writeFile(sourceJson, JSON.stringify({ segments: [...segments, advert] }), 'utf8');

    const lastLines = async (id: string) => (JSON.parse(await fsp.readFile(store.paths(id).sourceJson, 'utf8')) as { segments: TranscriptSegment[] }).segments;
    const ids = await r.series.createParts(parent.id);
    const last = await lastLines(ids.at(-1)!);
    expect(last.length).toBeGreaterThan(100);
    expect(last.some((l) => l.sourceText.includes('点击评论区'))).toBe(false);
    // A part made before (with the line) loses it when rebuilt.
    await fsp.writeFile(store.paths(ids.at(-1)!).sourceJson, JSON.stringify({ segments: [...last, { ...advert, startMs: last.at(-1)!.endMs + 500 }] }), 'utf8');
    const n = (await r.series.view(parent.id)).plan!.parts.at(-1)!.index;
    expect((await r.series.rebuildParts(parent.id, { parts: [n] }))[0]).toMatchObject({ rebuilt: true });
    expect((await lastLines(ids.at(-1)!)).some((l) => l.sourceText.includes('点击评论区'))).toBe(false);
    for (const id of ids) await r.orchestrator.cancelJob(id);
  });
});

describe('a part paused on its own (claude-dubber, 2026-11-27)', { timeout: 60_000 }, () => {
  it('stays out of every start of its series until it is started itself; the series still pauses and continues as a whole', async () => {
    const r = rig();
    const parent = await analysedParent(r);
    const ids = await r.series.createParts(parent.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const second = ids[1]!;
    const answer = async () => (await r.series.startParts(parent.id)).map((p) => (p.held ? 'held' : p.queued ? 'queued' : JSON.stringify(p)));
    const others = (what: string) => ids.map((id) => (id === second ? 'held' : what));
    // The series starts (the paused queue holds every part), then part 2 is
    // paused on its own. An hour later it was back in the queue.
    expect(await answer()).toEqual(ids.map(() => 'queued'));
    await r.orchestrator.pauseJob(second, { byUser: true });
    expect(await answer()).toEqual(others('queued'));
    expect((await store.getProject(second)).status).toBe('created');
    expect((await r.series.view(parent.id)).parts.map((p) => p.pausedByUser === true)).toEqual(ids.map((id) => id === second));

    // The whole series paused and continued: it continues as a whole, part 2 still out.
    expect(await r.series.pauseParts(parent.id)).toEqual(ids.filter((id) => id !== second));
    expect(await answer()).toEqual(others('queued'));

    // Started itself, part 2 waits its turn again, and the series counts it again.
    expect(await r.orchestrator.runPipeline(second)).toMatchObject({ queued: true });
    expect(await answer()).toEqual(ids.map(() => 'queued'));
    for (const id of ids) await r.orchestrator.cancelJob(id);
  });
});

describe('rebuilding some parts while the queue goes on (2.4)', { timeout: 60_000 }, () => {
  it('rebuilds a queued part where it waits, refuses a running one, and redoes a forced one from the translation', async () => {
    let running: string | undefined;
    const r = rig({ workOn: (id) => (id === running ? 'running' : undefined) });
    const parent = await analysedParent(r);
    const [p1, p2, p3] = await r.series.createParts(parent.id);
    // Parts 2 and 3 wait in the queue (the queue is paused, so they stay there).
    expect(await r.orchestrator.runPipeline(p2!)).toMatchObject({ queued: true, position: 1 });
    expect(await r.orchestrator.runPipeline(p3!)).toMatchObject({ queued: true, position: 2 });
    // The series transcript is fixed: every line now has a speaker.
    await fsp.writeFile(store.paths(parent.id).sourceJson, JSON.stringify({ segments: talk(60, (i) => `SPEAKER_0${i % 2}`) }), 'utf8');

    const [only] = await r.series.rebuildParts(parent.id, { parts: [2] });
    expect(only).toMatchObject({ projectId: p2, index: 2, rebuilt: true, queued: true, speakers: 2 });
    expect((await lines(p2!)).every((l) => l.speakerId)).toBe(true);
    expect((await lines(p3!)).some((l) => l.speakerId)).toBe(false);
    // Still waiting, at the same place.
    expect((await store.getProject(p2!)).status).toBe('queued');
    expect(await r.orchestrator.runPipeline(p2!)).toMatchObject({ queued: true, position: 1 });
    expect(await r.orchestrator.runPipeline(p3!)).toMatchObject({ queued: true, position: 2 });
    // The part's history says what happened; the activity list shows the job.
    expect((await listEdits(p2!))[0]!.summary).toMatch(/^Rebuilt from the series transcript/);
    expect(activity.list({ projectId: parent.id }).find((e) => e.kind === 'series.rebuild')).toMatchObject({ state: 'done' });

    // Being dubbed: left alone, and the answer says why.
    running = p1;
    expect((await r.series.rebuildParts(parent.id, { parts: [1] }))[0]).toMatchObject({
      rebuilt: false,
      skipped: 'running',
      reason: 'is being dubbed now',
    });
    running = undefined;
    await expect(r.series.rebuildParts(parent.id, { parts: [9] })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });

    // Dubbed to the end, then rebuilt with force: it continues at the translation, voices and video redone.
    await markRendered(p1!);
    await fsp.writeFile(store.paths(p1!).translatedJson, JSON.stringify({ segments: [{ id: 'seg_0001' }] }), 'utf8');
    expect((await r.series.rebuildParts(parent.id, { parts: [1] }))[0]).toMatchObject({ rebuilt: false, skipped: 'translated' });
    const [forced] = await r.series.rebuildParts(parent.id, { parts: [1], force: true });
    expect(forced).toMatchObject({ rebuilt: true, translationDiscarded: true });
    expect(await store.getPipeline(p1!)).toMatchObject({ status: 'paused', pausedStep: 'translation' });
    expect((await store.getProject(p1!)).status).toBe('paused');
    await expect(fsp.stat(store.paths(p1!).translatedJson)).rejects.toThrow();

    await r.orchestrator.cancelJob(p2!);
    await r.orchestrator.cancelJob(p3!);
  });

  it('queues a part ahead of its series\' later parts, and run_next moves one to the front (part 16, 2026-11-24)', async () => {
    const r = rig();
    const parent = await analysedParent(r);
    const [p1, p2, p3] = await r.series.createParts(parent.id);
    // Parts 2 and 3 wait; part 1 is retried after them and takes its place ahead.
    expect(await r.orchestrator.runPipeline(p2!)).toMatchObject({ queued: true, position: 1 });
    expect(await r.orchestrator.runPipeline(p3!)).toMatchObject({ queued: true, position: 2 });
    expect(await r.orchestrator.runPipeline(p1!)).toMatchObject({ queued: true, position: 1 });
    expect(await r.orchestrator.runPipeline(p3!)).toMatchObject({ position: 3 });
    // Its saved place keeps that order after a restart (queuedAt sorts it).
    const at = async (id: string): Promise<string> => (await store.getProject(id)).queue!.queuedAt;
    expect(await at(p1!) < (await at(p2!))).toBe(true);

    expect(await r.orchestrator.runNext(p3!)).toEqual({ position: 1 });
    expect(await r.orchestrator.runPipeline(p1!)).toMatchObject({ position: 2 });
    await r.orchestrator.cancelJob(p3!);
    await expect(r.orchestrator.runNext(p3!)).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    for (const id of [p1!, p2!]) await r.orchestrator.cancelJob(id);
  });

  it('starts nothing from the queue while it is held, and goes on after', async () => {
    const r = rig();
    const video = await writeDummyVideo(tmp);
    const a = await r.orchestrator.createProject(createProjectInput(video, { name: 'A' }));
    const b = await r.orchestrator.createProject(createProjectInput(video, { name: 'B' }));
    await r.orchestrator.runPipeline(a.id);
    await r.orchestrator.runPipeline(b.id);
    r.prefs.paused = false;
    await r.orchestrator.whileQueueHeld(async () => {
      // Taking B out of the queue asks the queue to go on: held, A waits
      // (unheld, the same pass starts it within a few milliseconds).
      await r.orchestrator.cancelJob(b.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(r.orchestrator.workOn(a.id)).toBe('queued');
    });
    await vi.waitFor(() => expect(r.orchestrator.workOn(a.id)).not.toBe('queued'));
    await vi.waitFor(async () => expect((await store.getProject(a.id)).status).toBe('completed'), { timeout: 15_000 });
  });
});

describe('a joined project is cut where its files meet (5.1)', { timeout: 60_000 }, () => {
  it('takes the boundary between two source videos over the pauses near the target', async () => {
    // P1 talks until 22:56, P2 from 23:03; a regular pause sits nearer the 25:00 target.
    const lines = [...talk(23).filter((l) => l.endMs <= 22 * MIN + 56_000)];
    for (const l of talk(27)) lines.push({ ...l, id: `seg_b${l.id}`, startMs: l.startMs + 23 * MIN + 2000, endMs: l.endMs + 23 * MIN + 2000 });
    const inputFiles: ProjectInputFile[] = [
      { path: 'D:/v/P1.mp4', name: 'P1.mp4', startMs: 0, durationMs: 23 * MIN },
      { path: 'D:/v/P2.mp4', name: 'P2.mp4', startMs: 23 * MIN, durationMs: 27 * MIN },
    ];
    const chat = chatTitling((n) => `{"title":"T${n}","summary":""}`);
    const r = rig({ chat });
    const parent = await analysedParent(r, { minutes: 50, lines, inputFiles, settings: { minMinutes: 20, maxMinutes: 30 } });
    const plan = (await r.series.view(parent.id)).plan!;
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts[1]!.startMs).toBe(23 * MIN);
    expect(plan.candidates.find((c) => c.boundary)?.ms).toBe(23 * MIN);
    // The AI is told where a source video ends; part numbers run across both files.
    expect(chat.asked.some((q) => q.includes('one source video ends here and the next begins'))).toBe(true);
    expect(plan.parts.map((p) => p.index)).toEqual([1, 2]);
  });
});

describe('a series that continues another (5.2)', { timeout: 60_000 }, () => {
  it('carries the name, numbers and template on, and gives matched speakers their voices', async () => {
    const chat = chatTitling((n) => `{"title":"Tập ${n}","summary":""}`);
    const r = rig({ chat });
    const first = await analysedParent(r, {
      settings: { nameTemplate: '{series} - Tập {nn}' },
      projectSettings: {
        speakerVoices: [
          { speakerId: 'SPEAKER_00', voiceId: 'clone-hero' },
          { speakerId: 'SPEAKER_01', voiceId: 'clone-villain' },
        ],
      },
      speakers: [
        { speakerId: 'SPEAKER_00', print: [1, 0, 0] },
        { speakerId: 'SPEAKER_01', print: [0, 1, 0] },
      ],
    });
    const firstParts = await r.series.createParts(first.id);
    expect(firstParts).toHaveLength(3);

    // Named by any of its parts' ids.
    const settings = await r.series.prepareSeries({
      minMinutes: 15,
      maxMinutes: 20,
      aiProviderId: 'fake-ai',
      recapSec: 4,
      autoStart: false,
      continues: firstParts[1]!,
    });
    expect(settings).toMatchObject({ continues: first.id, seriesName: 'Tây Du Ký', partNumberOffset: 3, nameTemplate: '{series} - Tập {nn}' });

    const second = await analysedParent(r, {
      name: 'Mùa 2',
      minutes: 40,
      settings,
      speakers: [
        { speakerId: 'SPEAKER_00', print: [0.05, 0.99, 0] }, // the villain again
        { speakerId: 'SPEAKER_01', print: [0, 0, 1] }, // someone new
      ],
    });
    expect(second.settings.speakerVoices).toEqual([{ speakerId: 'SPEAKER_00', voiceId: 'clone-villain' }]);
    const view = await r.series.view(second.id);
    expect(view.continues).toEqual({ parentId: first.id, name: 'Tây Du Ký' });
    expect(view.plan!.parts.map((p) => p.index)).toEqual([4, 5]);
    expect(view.plan!.notes.find((n) => n.startsWith('Voices from'))).toMatch(/1 of 2 speaker\(s\).*SPEAKER_00 = SPEAKER_01 there.*1 left/);

    const ids = await r.series.createParts(second.id);
    const parts = await Promise.all(ids.map((id) => store.getProject(id)));
    expect(parts.map((p) => p.name)).toEqual(['Tây Du Ký - Tập 04', 'Tây Du Ký - Tập 05']);
    expect(parts[0]!.series).toMatchObject({ index: 4, count: 5, seriesName: 'Tây Du Ký' });
    expect(parts[1]!.settings.speakerVoices).toEqual([{ speakerId: 'SPEAKER_00', voiceId: 'clone-villain' }]);

    // Its recap takes the previous part's translation by place, not by number.
    const [fourth, fifth] = ids;
    const prev = await lines(fourth!);
    await fsp.writeFile(store.paths(fourth!).translatedJson, JSON.stringify({ segments: prev.map((l) => ({ ...l, translatedText: `T:${l.sourceText}` })) }), 'utf8');
    await fsp.writeFile(store.paths(fifth!).translatedJson, JSON.stringify({ segments: await lines(fifth!) }), 'utf8');
    expect(await reuseRecapTranslations(await store.getProject(fifth!), store)).toBeGreaterThan(0);

    // Started, each part answers by the number it is shown with (the queue holds them here).
    expect((await r.series.startParts(second.id)).map((p) => [p.index, p.queued])).toEqual([
      [4, true],
      [5, true],
    ]);
    expect(await r.series.numberOffsetOf(fifth!)).toBe(3);
    for (const id of ids) await r.orchestrator.cancelJob(id);

    expect((await r.series.listSeries()).map((s) => [s.name, s.firstNumber, s.lastNumber, s.total]).sort()).toEqual([
      ['Tây Du Ký', 1, 3, 3],
      ['Tây Du Ký', 4, 5, 5],
    ]);
  });

  it('copies no voices across voice engines, and refuses what cannot be continued', async () => {
    const r = rig();
    const first = await analysedParent(r, {
      projectSettings: { speakerVoices: [{ speakerId: 'SPEAKER_00', voiceId: 'clone-hero' }] },
      speakers: [{ speakerId: 'SPEAKER_00', print: [1, 0, 0] }],
    });
    const settings = await r.series.prepareSeries({ minMinutes: 15, maxMinutes: 20, aiProviderId: 'fake-ai', recapSec: 4, autoStart: false, continues: first.id });
    const second = await analysedParent(r, {
      name: 'Mùa 2',
      settings,
      projectSettings: { ttsProviderId: 'neural-tts' },
      speakers: [{ speakerId: 'SPEAKER_00', print: [1, 0, 0] }],
    });
    expect(second.settings.speakerVoices).toBeUndefined();
    expect((await r.series.view(second.id)).plan!.notes.some((n) => n.includes('was voiced with piper-local'))).toBe(true);

    const video = await writeDummyVideo(tmp);
    const plain = await r.orchestrator.createProject(createProjectInput(video));
    const base = { minMinutes: 15, maxMinutes: 20, aiProviderId: 'fake-ai', recapSec: 4, autoStart: false };
    await expect(r.series.prepareSeries({ ...base, continues: plain.id })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    await expect(r.series.prepareSeries({ ...base, continues: 'proj_nope' })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    await expect(r.series.prepareSeries({ ...base, nameTemplate: '{series}' })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
  });
});

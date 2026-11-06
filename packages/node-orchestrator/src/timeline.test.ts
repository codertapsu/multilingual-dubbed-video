/**
 * The editor's timeline API end to end: GET/PATCH /projects/:id/timeline, the
 * regenerate path it feeds, and byte-range serving for the preview.
 *
 * What these pin, each a way the dub could silently disagree with the editor:
 *  - a drag re-places the EXISTING clip and recomputes every fit (gap-aware),
 *    without re-synthesizing anything;
 *  - the new timing reaches source.json too, so re-translating keeps it;
 *  - a per-line voice reaches the TTS engine, for that line only;
 *  - regenerating before alignment ever ran does not invent a partial
 *    translated.aligned.json ("an artifact that exists is complete");
 *  - `/file` answers byte ranges (WKWebView will not play media otherwise).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AlignedSegment, TranscriptSegment } from '@videodubber/shared';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
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
} from './test/fixtures.js';
import { ProjectStore } from './workspace/projectStore.js';
import type { WorkspacePaths } from './workspace/paths.js';

let tmp: string;
let store: ProjectStore;
let tts: FakeTtsProvider;
let orchestrator: LocalJobOrchestrator;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-timeline-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  tts = new FakeTtsProvider(() => 900);
  orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), tts),
    bus: new EventBusRegistry(),
  });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

/** A dubbed project: 3 lines, the first two voiced as ONE merged unit. */
async function dubbedProject(): Promise<{ id: string; paths: WorkspacePaths; segments: TranscriptSegment[] }> {
  const video = await writeDummyVideo(tmp);
  const project = await orchestrator.createProject(createProjectInput(video));
  await store.saveProject({ ...project, mediaInfo: fakeMediaInfo(20_000) });
  const paths = store.paths(project.id);
  const source = makeSegments([
    [0, 1000, 'one'],
    [1200, 2000, 'two'],
    [5000, 6000, 'three'],
  ]);
  const segments = source.map((s) => ({ ...s, translatedText: `vi ${s.sourceText}` }));
  await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: source }), 'utf8');
  await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments }), 'utf8');
  await fsp.writeFile(
    paths.synthesisGroupsJson,
    JSON.stringify({
      groups: [
        { id: 'seg_0001', segmentIds: ['seg_0001', 'seg_0002'], text: 'vi one vi two', startMs: 0, endMs: 2000 },
        { id: 'seg_0003', segmentIds: ['seg_0003'], text: 'vi three', startMs: 5000, endMs: 6000 },
      ],
    }),
    'utf8',
  );
  const aligned: AlignedSegment[] = [
    {
      segmentId: 'seg_0001',
      startMs: 0,
      endMs: 2000,
      audioPath: paths.ttsSegment(1),
      generatedDurationMs: 1800,
      placedDurationMs: 1800,
      speedRatio: 1,
      overflowMs: 0,
      status: 'ok',
    },
    {
      segmentId: 'seg_0003',
      startMs: 5000,
      endMs: 6000,
      audioPath: paths.ttsSegment(3),
      generatedDurationMs: 2500,
      placedDurationMs: 2500,
      speedRatio: 1,
      overflowMs: 0,
      status: 'ok',
    },
  ];
  await fsp.writeFile(paths.translatedAlignedJson, JSON.stringify(aligned), 'utf8');
  return { id: project.id, paths, segments };
}

describe('GET /timeline document', () => {
  it('returns cues, merged units with their fit, and the preview media', async () => {
    const { id } = await dubbedProject();
    const doc = await orchestrator.getTimeline(id);

    expect(doc.translated).toBe(true);
    expect(doc.aligned).toBe(true);
    expect(doc.segments.map((s) => s.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003']);
    expect(doc.units).toHaveLength(2);
    expect(doc.units[0]).toMatchObject({ id: 'seg_0001', segmentIds: ['seg_0001', 'seg_0002'], startMs: 0, endMs: 2000 });
    expect(doc.units[0]!.alignment?.generatedDurationMs).toBe(1800);
    expect(doc.media.durationMs).toBe(20_000);
    expect(doc.media.videoPath).toMatch(/original\.mp4$/);
  });

  it('has no dub track before TTS has planned any unit', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: makeSegments([[0, 1000, 'a']]) }), 'utf8');

    const doc = await orchestrator.getTimeline(project.id);
    expect(doc.translated).toBe(false);
    expect(doc.units).toEqual([]);
  });
});

describe('PATCH /timeline (patchSegments)', () => {
  it('re-places the existing clip on a drag, without re-synthesizing anything', async () => {
    const { id, paths } = await dubbedProject();
    // Drag the third line 1 s later.
    const doc = await orchestrator.patchSegments(id, [{ id: 'seg_0003', startMs: 6000, endMs: 7000 }]);

    expect(tts.calls).toBe(0);
    const unit = doc.units.find((u) => u.id === 'seg_0003')!;
    expect(unit.alignment).toMatchObject({ startMs: 6000, generatedDurationMs: 2500 });
    // Gap-aware: the slot runs to the media end, so the 2.5 s clip still fits.
    expect(unit.alignment?.status).toBe('ok');
    const onDisk = await readJson<AlignedSegment[]>(paths.translatedAlignedJson);
    expect(onDisk.find((a) => a.segmentId === 'seg_0003')?.startMs).toBe(6000);
  });

  it('writes the new timing to source.json so a re-translate keeps it', async () => {
    const { id, paths } = await dubbedProject();
    await orchestrator.patchSegments(id, [{ id: 'seg_0003', startMs: 5500, endMs: 6400 }]);
    const source = await readJson<{ segments: TranscriptSegment[] }>(paths.sourceJson);
    expect(source.segments[2]).toMatchObject({ startMs: 5500, endMs: 6400, sourceText: 'three' });
    // ...and source.json gained no translated fields.
    expect(source.segments[2]!.translatedText).toBeUndefined();
  });

  it('moving a merged unit\'s first line moves the unit', async () => {
    const { id, paths } = await dubbedProject();
    const doc = await orchestrator.patchSegments(id, [{ id: 'seg_0001', startMs: 100, endMs: 1100 }]);
    expect(doc.units[0]).toMatchObject({ startMs: 100, endMs: 2000 });
    const groups = await readJson<{ groups: { id: string; startMs: number }[] }>(paths.synthesisGroupsJson);
    expect(groups.groups[0]!.startMs).toBe(100);
    expect(doc.units[0]!.alignment?.startMs).toBe(100);
  });

  it('reports the consequence of a drag that squeezes a clip', async () => {
    const { id } = await dubbedProject();
    // Pull the first unit's end in, and bring line 3 right up against it: the
    // 1.8 s merged clip now has 1.5 s before line 3 speaks.
    const doc = await orchestrator.patchSegments(id, [
      { id: 'seg_0002', startMs: 1200, endMs: 1400 },
      { id: 'seg_0003', startMs: 1500, endMs: 2500 },
    ]);
    const first = doc.units[0]!.alignment!;
    expect(first.speedRatio).toBeGreaterThan(1);
    expect(first.status).not.toBe('ok');
  });

  it('regenerates the subtitle sidecars with the edited text and timing', async () => {
    const { id, paths } = await dubbedProject();
    await orchestrator.patchSegments(id, [{ id: 'seg_0003', translatedText: 'ba (đã sửa)', startMs: 5200, endMs: 6100 }]);
    const srt = await fsp.readFile(paths.translatedSrt, 'utf8');
    expect(srt).toContain('ba (đã sửa)');
    expect(srt).toContain('00:00:05,200 --> 00:00:06,100');
  });

  it('marks a text/voice edit stale and locked, and leaves the clip where it was', async () => {
    const { id } = await dubbedProject();
    const doc = await orchestrator.patchSegments(id, [
      { id: 'seg_0003', translatedText: 'ba mới', voiceId: 'vi_VN-alt' },
    ]);
    const seg = doc.segments[2]!;
    expect(seg).toMatchObject({ translatedText: 'ba mới', voiceId: 'vi_VN-alt', locked: true, ttsStale: true });
    expect(doc.units[1]!.alignment?.startMs).toBe(5000);
  });

  it('refuses an invalid edit and leaves every artifact untouched', async () => {
    const { id, paths } = await dubbedProject();
    const before = await fsp.readFile(paths.translatedJson, 'utf8');
    await expect(
      orchestrator.patchSegments(id, [{ id: 'seg_0003', startMs: 500, endMs: 900 }]),
    ).rejects.toMatchObject({ code: 'INVALID_EDIT' });
    expect(await fsp.readFile(paths.translatedJson, 'utf8')).toBe(before);
  });

  it('allows only timing edits before the transcript is translated', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: makeSegments([[0, 1000, 'a']]) }), 'utf8');

    await expect(
      orchestrator.patchSegments(project.id, [{ id: 'seg_0001', translatedText: 'x' }]),
    ).rejects.toMatchObject({ code: 'INVALID_EDIT' });
    const doc = await orchestrator.patchSegments(project.id, [{ id: 'seg_0001', startMs: 100 }]);
    expect(doc.segments[0]!.startMs).toBe(100);
    // ...and it did NOT create translated.json (that would skip translation).
    await expect(fsp.stat(paths.translatedJson)).rejects.toThrow();
  });
});

describe('regenerate (synthesizeSingleSegment) with per-line overrides', () => {
  it('sends a line\'s persisted voice and rate to the engine', async () => {
    const { id } = await dubbedProject();
    await orchestrator.patchSegments(id, [{ id: 'seg_0003', voiceId: 'vi_VN-alt', speakingRate: 1.2 }]);
    await orchestrator.synthesizeSingleSegment(id, 'seg_0003', {});

    expect(tts.inputs).toHaveLength(1);
    expect(tts.inputs[0]).toMatchObject({ voiceId: 'vi_VN-alt', speed: 1.2 });
    const doc = await orchestrator.getTimeline(id);
    expect(doc.segments[2]!.ttsStale).toBeUndefined();
  });

  it('degroups a merged unit and gives each former member ITS OWN voice', async () => {
    const { id, paths } = await dubbedProject();
    await orchestrator.patchSegments(id, [{ id: 'seg_0001', voiceId: 'voice-a' }]);
    await orchestrator.synthesizeSingleSegment(id, 'seg_0002', { voiceId: 'voice-b' });

    const byVoice = new Map(tts.inputs.map((i) => [i.voiceId, i.segments.map((s) => s.id)]));
    expect(byVoice.get('voice-a')).toEqual(['seg_0001']);
    expect(byVoice.get('voice-b')).toEqual(['seg_0002']);
    // The explicit override was persisted, so a later full run keeps it.
    const saved = await readJson<{ segments: TranscriptSegment[] }>(paths.translatedJson);
    expect(saved.segments[1]!.voiceId).toBe('voice-b');
    const groups = await readJson<{ groups: { segmentIds: string[] }[] }>(paths.synthesisGroupsJson);
    expect(groups.groups.map((g) => g.segmentIds)).toEqual([['seg_0001'], ['seg_0002'], ['seg_0003']]);
  });

  it('re-fits gap-aware, like the alignment step (not against the line\'s own cue)', async () => {
    const { id } = await dubbedProject();
    // A 1.4 s clip for a 1 s cue: it fits because the next line starts at 5 s
    // (the pipeline's gap-aware slot). The old single-line fit flagged it.
    tts = new FakeTtsProvider(() => 1400);
    orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService(),
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), tts),
      bus: new EventBusRegistry(),
    });
    const { alignment } = await orchestrator.synthesizeSingleSegment(id, 'seg_0003', {});
    expect(alignment).toMatchObject({ status: 'ok', speedRatio: 1 });
  });

  it('never invents a partial alignment artifact before alignment has run', async () => {
    const video = await writeDummyVideo(tmp);
    const project = await orchestrator.createProject(createProjectInput(video));
    const paths = store.paths(project.id);
    const segments = makeSegments([[0, 1000, 'a'], [2000, 3000, 'b']]).map((s) => ({ ...s, translatedText: 'x' }));
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments }), 'utf8');

    const { alignment } = await orchestrator.synthesizeSingleSegment(project.id, 'seg_0001', {});
    expect(alignment.segmentId).toBe('seg_0001');
    await expect(fsp.stat(paths.translatedAlignedJson)).rejects.toThrow();
  });
});

describe('HTTP: /file byte ranges and the timeline routes', () => {
  let app: FastifyInstance;
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = path.join(tmp, 'http-projects');
    app = await createServer({
      config: loadConfig({
        projectsDir,
        configDir: path.join(tmp, 'config'),
        modelsDir: path.join(tmp, 'models'),
      }),
      media: new FakeMediaService(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a Range request with 206 and exactly the requested bytes', async () => {
    const file = path.join(projectsDir, 'p', 'render', 'output.mp4');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from('0123456789'));

    const res = await app.inject({
      method: 'GET',
      url: `/file?path=${encodeURIComponent(file)}`,
      headers: { range: 'bytes=2-5' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toBe('2345');

    const whole = await app.inject({ method: 'GET', url: `/file?path=${encodeURIComponent(file)}` });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.body).toBe('0123456789');

    const bad = await app.inject({
      method: 'GET',
      url: `/file?path=${encodeURIComponent(file)}`,
      headers: { range: 'bytes=50-' },
    });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */10');
  });

  it('round-trips a PATCH through the timeline route, and maps a bad edit to 400', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: createProjectInput(await writeDummyVideo(tmp)),
    });
    const projectId = (created.json() as { id: string }).id;
    const paths = (await import('./workspace/paths.js')).workspacePaths(projectsDir, projectId);
    const segments = makeSegments([[0, 1000, 'a'], [2000, 3000, 'b']]).map((s) => ({ ...s, translatedText: 'x' }));
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments }), 'utf8');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/timeline`,
      payload: { segments: [{ id: 'seg_0002', startMs: 2100, endMs: 2900 }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { segments: TranscriptSegment[] }).segments[1]).toMatchObject({ startMs: 2100 });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/timeline`,
      payload: { segments: [{ id: 'seg_0002', startMs: 10, endMs: 500 }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('INVALID_EDIT');

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/projects/${projectId}/timeline`,
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'PATCH' },
    });
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('PATCH');
  });
});

describe('editor media caches (waveform + filmstrip)', () => {
  async function withMedia(): Promise<{ media: FakeMediaService; orch: LocalJobOrchestrator; id: string; paths: WorkspacePaths }> {
    const media = new FakeMediaService();
    const orch = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), tts),
      bus: new EventBusRegistry(),
    });
    const project = await orch.createProject(createProjectInput(await writeDummyVideo(tmp)));
    await store.saveProject({ ...project, mediaInfo: fakeMediaInfo(20_000) });
    return { media, orch, id: project.id, paths: store.paths(project.id) };
  }

  it('builds the waveform once, then serves it from the cache', async () => {
    const { media, orch, id, paths } = await withMedia();
    await fsp.mkdir(path.dirname(paths.originalWav), { recursive: true });
    await fsp.writeFile(paths.originalWav, 'pcm');

    const first = await orch.getWaveform(id);
    const second = await orch.getWaveform(id);
    expect(media.waveformCalls).toBe(1);
    expect(second).toEqual(first);
    expect(Buffer.from(first.peaks, 'base64')).toHaveLength(200);
    expect(first).not.toHaveProperty('stamp');

    // Re-extracted audio (new size/mtime) invalidates the cache.
    await fsp.writeFile(paths.originalWav, 'pcm, re-extracted');
    await orch.getWaveform(id);
    expect(media.waveformCalls).toBe(2);
  });

  it('shares one build between concurrent requests', async () => {
    const { media, orch, id } = await withMedia();
    await Promise.all([orch.getWaveform(id), orch.getWaveform(id), orch.getWaveform(id)]);
    expect(media.waveformCalls).toBe(1);
  });

  it('renders the filmstrip once and reuses the sprite + layout', async () => {
    const { media, orch, id, paths } = await withMedia();
    const layout = await orch.getFilmstrip(id);
    await orch.getFilmstrip(id);
    expect(media.filmstripCalls).toBe(1);
    expect(layout).toMatchObject({ path: paths.filmstripJpg, count: 8, intervalMs: 2500 });

    // A missing sprite (cache dir cleared) is rebuilt even though the JSON survived.
    await fsp.rm(paths.filmstripJpg);
    await orch.getFilmstrip(id);
    expect(media.filmstripCalls).toBe(2);
  });

  it('refuses a filmstrip for a project with no probed video stream', async () => {
    const { orch, id } = await withMedia();
    const project = await store.getProject(id);
    await store.saveProject({ ...project, mediaInfo: { ...fakeMediaInfo(20_000), videoStreams: [] } });
    await expect(orch.getFilmstrip(id)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });
});

describe('fitted preview clips', () => {
  async function setup(): Promise<{ media: FakeMediaService; orch: LocalJobOrchestrator; id: string; paths: WorkspacePaths }> {
    const media = new FakeMediaService();
    const orch = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media,
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), tts),
      bus: new EventBusRegistry(),
    });
    const project = await orch.createProject(createProjectInput(await writeDummyVideo(tmp)));
    const paths = store.paths(project.id);
    await fsp.mkdir(paths.ttsSegmentsDir, { recursive: true });
    await fsp.writeFile(paths.ttsSegment(3), 'wav-v1');
    return { media, orch, id: project.id, paths };
  }

  it('renders once per (clip, ratio) and reuses the cache', async () => {
    const { media, orch, id } = await setup();
    const a = await orch.getFittedClip(id, 'seg_0003', 1.25);
    const b = await orch.getFittedClip(id, 'seg_0003', 1.25);
    expect(a).toBe(b);
    expect(media.fittedCalls).toBe(1);
  });

  it('serves the raw clip at 1x and refuses ids that are not clip ids', async () => {
    const { media, orch, id, paths } = await setup();
    expect(await orch.getFittedClip(id, 'seg_0003', 1)).toBe(paths.ttsSegment(3));
    expect(media.fittedCalls).toBe(0);
    await expect(orch.getFittedClip(id, '../../etc/passwd', 1.2)).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  });

  it('re-fits after the line is regenerated and deletes the stale fit', async () => {
    const { media, orch, id, paths } = await setup();
    const first = await orch.getFittedClip(id, 'seg_0003', 1.2);
    await new Promise((r) => setTimeout(r, 15));
    await fsp.writeFile(paths.ttsSegment(3), 'wav-v2 (regenerated, different size)');
    const second = await orch.getFittedClip(id, 'seg_0003', 1.2);
    expect(second).not.toBe(first);
    expect(media.fittedCalls).toBe(2);
    await expect(fsp.stat(first)).rejects.toThrow();
  });
});

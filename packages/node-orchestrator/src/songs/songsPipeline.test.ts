/**
 * Lines kept as the original song, through the pipeline and the editor's
 * write path: no voice is made for them (TTS), no clip is placed for them
 * (alignment), the original plays in their windows (the mix), their subtitle
 * shows only with songSubtitles, and marking them restructures the voice
 * clips they shared without making any sound.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlignedSegment, Project, TranscriptSegment } from '@videodubber/shared';

import { listEdits } from '../activity/history.js';
import { loadConfig } from '../config.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import type { DuckAndMixInput } from '../media.js';
import { LocalJobOrchestrator } from '../orchestrator.js';
import { PipelineRunner } from '../pipeline/runner.js';
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
import { registerSongRoutes } from './songRoutes.js';
import { songSuggestionsPath } from './songSuggestions.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-songs-pipeline-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fsp.readFile(file, 'utf8')) as T;
const lines = async (file: string): Promise<TranscriptSegment[]> => (await readJson<{ segments: TranscriptSegment[] }>(file)).segments;

/** A dubbed project of three adjacent lines (one voice clip for all three), plus what its mixes were given. */
async function dubbed(): Promise<{ project: Project; runner: PipelineRunner; tts: FakeTtsProvider; mixes: DuckAndMixInput[]; media: FakeMediaService }> {
  const project = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
  const paths = store.paths(project.id);
  const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(10_000) });
  const mixes: DuckAndMixInput[] = [];
  const mix = media.duckAndMix.bind(media);
  media.duckAndMix = async (input: DuckAndMixInput) => {
    mixes.push(input);
    return mix(input);
  };
  // The merged clip of the three lines lasts as long as they do (no drift: it stays one clip).
  const tts = new FakeTtsProvider((id) => (id === 'seg_0001' ? 2900 : 900));
  const registry = fakeRegistry(
    new FakeSttProvider(makeSegments([[0, 1000, 'Hello'], [1000, 2000, 'Sung'], [2000, 3000, 'Again']])),
    new FakeTranslationProvider(),
    tts,
  );
  const bus = new EventBusRegistry().get(project.id);
  const runner = new PipelineRunner({ store, media, registry, bus, logger: new ProjectLogger(paths.pipelineLog, bus) });
  await runner.run(project, { signal: new AbortController().signal });
  return { project: await store.getProject(project.id), runner, tts, mixes, media };
}

const spoken = (tts: FakeTtsProvider, from = 0): string[] => tts.inputs.slice(from).flatMap((i) => i.segments.map((s) => s.text));

describe('song lines in the pipeline', () => {
  it('a unit holding a song line is cut and re-voiced at alignment; the song is never voiced, its window keeps the original, its subtitle is off', async () => {
    const { project, runner, tts, mixes } = await dubbed();
    const paths = store.paths(project.id);
    expect((await readJson<{ groups: { segmentIds: string[] }[] }>(paths.synthesisGroupsJson)).groups.map((g) => g.segmentIds)).toEqual([
      ['seg_0001', 'seg_0002', 'seg_0003'],
    ]);
    // Marked outside the editor's path (an undo, a hand edit): alignment sorts it out.
    const translated = await lines(paths.translatedJson);
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments: translated.map((l) => (l.id === 'seg_0002' ? { ...l, song: true } : l)) }));
    const before = tts.inputs.length;
    await runner.run(project, { signal: new AbortController().signal, retryFromStep: 'alignment' });

    expect(spoken(tts, before).sort()).toEqual(['[vi] Again', '[vi] Hello']);
    const aligned = await readJson<AlignedSegment[]>(paths.translatedAlignedJson);
    expect(aligned.map((a) => a.segmentId)).toEqual(['seg_0001', 'seg_0003']);
    expect(mixes.at(-1)?.keepOriginal).toEqual([{ startMs: 1000, endMs: 2000 }]);
    const srt = await fsp.readFile(paths.translatedSrt, 'utf8');
    expect(srt).toContain('[vi] Hello');
    expect(srt).not.toContain('[vi] Sung');
    // No line waits for a voice any more.
    expect((await lines(paths.translatedJson)).some((l) => l.ttsStale)).toBe(false);
  });

  it('the TTS step plans no clip for a song line; with songSubtitles its subtitle comes back', async () => {
    const { project, runner, tts } = await dubbed();
    const paths = store.paths(project.id);
    const translated = await lines(paths.translatedJson);
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments: translated.map((l) => (l.id === 'seg_0002' ? { ...l, song: true } : l)) }));
    await store.saveProject({ ...project, settings: { ...project.settings, songSubtitles: true } });
    const before = tts.inputs.length;
    await runner.run(await store.getProject(project.id), { signal: new AbortController().signal, retryFromStep: 'tts' });

    expect(spoken(tts, before)).not.toContain('[vi] Sung');
    const groups = (await readJson<{ groups: { segmentIds: string[] }[] }>(paths.synthesisGroupsJson)).groups;
    expect(groups.flatMap((g) => g.segmentIds)).toEqual(['seg_0001', 'seg_0003']);
    expect(await fsp.readFile(paths.translatedSrt, 'utf8')).toContain('[vi] Sung');
    // The song line stays in the transcript.
    expect((await lines(paths.translatedJson)).find((l) => l.id === 'seg_0002')).toMatchObject({ song: true });
  });
});

/** An orchestrator over the same store (its config kept in the temp folder, never the app's). */
function orchestratorFor(media: FakeMediaService): LocalJobOrchestrator {
  return new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects'), configDir: path.join(tmp, 'config') }),
    store,
    media,
    registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
  });
}

describe('marking songs (the editor, mark_song)', () => {
  it('flags the line in both transcripts, cuts its voice clip, marks the rest for re-voicing, refits, rewrites the subtitles, and records it', async () => {
    const { project, media } = await dubbed();
    const paths = store.paths(project.id);
    const orchestrator = orchestratorFor(media);

    const result = await orchestrator.markSongs(project.id, { song: true, lineIds: ['seg_0002'] });
    expect(result).toMatchObject({ song: true, changed: [{ id: 'seg_0002', startMs: 1000, endMs: 2000 }], revoice: ['seg_0001', 'seg_0003'], songs: 1 });

    const translated = await lines(paths.translatedJson);
    expect(translated.map((l) => [l.id, l.song ?? false, l.ttsStale ?? false])).toEqual([
      ['seg_0001', false, true],
      ['seg_0002', true, false],
      ['seg_0003', false, true],
    ]);
    expect((await lines(paths.sourceJson)).find((l) => l.id === 'seg_0002')).toMatchObject({ song: true });
    expect((await readJson<{ groups: { segmentIds: string[] }[] }>(paths.synthesisGroupsJson)).groups.map((g) => g.segmentIds)).toEqual([
      ['seg_0001'],
      ['seg_0003'],
    ]);
    expect((await readJson<AlignedSegment[]>(paths.translatedAlignedJson)).map((a) => a.segmentId)).toEqual(['seg_0001', 'seg_0003']);
    expect(await fsp.readFile(paths.translatedSrt, 'utf8')).not.toContain('[vi] Sung');
    expect(await fsp.readFile(paths.sourceSrt, 'utf8')).not.toContain('Sung');
    const [edit] = await listEdits(project.id);
    expect(edit).toMatchObject({ target: 'translation', summary: 'Kept 1 line(s) as the original song at 0:01' });

    // Shown again with the setting, at once: the subtitle files follow it.
    await orchestrator.updateProjectSettings(project.id, { songSubtitles: true });
    expect(await fsp.readFile(paths.translatedSrt, 'utf8')).toContain('[vi] Sung');
    await orchestrator.updateProjectSettings(project.id, { songSubtitles: false });
    expect((await store.getProject(project.id)).settings.songSubtitles).toBeUndefined();

    // Dubbed again: the line needs a voice of its own.
    const back = await orchestrator.markSongs(project.id, { song: false, fromMs: 1000, toMs: 2000 });
    expect(back).toMatchObject({ changed: [{ id: 'seg_0002' }], revoice: ['seg_0002'], songs: 0 });
    expect((await readJson<{ groups: { segmentIds: string[] }[] }>(paths.synthesisGroupsJson)).groups.map((g) => g.segmentIds)).toEqual([
      ['seg_0001'],
      ['seg_0002'],
      ['seg_0003'],
    ]);
    expect((await lines(paths.translatedJson)).find((l) => l.id === 'seg_0002')).toMatchObject({ ttsStale: true });
    // Asking for what is already so changes nothing.
    expect((await orchestrator.markSongs(project.id, { song: false, lineIds: ['seg_0002'] })).changed).toEqual([]);
  });

  it('keeps the minor-voice setting within 1..12, automatic otherwise', async () => {
    const { project, media } = await dubbed();
    const orchestrator = orchestratorFor(media);
    await orchestrator.updateProjectSettings(project.id, { minorVoices: 4 });
    expect((await store.getProject(project.id)).settings.minorVoices).toBe(4);
    await orchestrator.updateProjectSettings(project.id, { minorVoices: 40 });
    expect((await store.getProject(project.id)).settings.minorVoices).toBeUndefined();
  });
});

describe('the song routes', () => {
  it('list the songs and the open suggestions, mark lines, settle their suggestions, and mark a series\' parts by time', async () => {
    const { project, media } = await dubbed();
    const orchestrator = orchestratorFor(media);
    // A series of one part that starts 1 s into the parent's video.
    const part = await store.createProject(createProjectInput(await writeDummyVideo(tmp, 'part.mp4'), { name: 'Part 1' }));
    const partPaths = store.paths(part.id);
    await fsp.mkdir(partPaths.subtitlesDir, { recursive: true });
    await fsp.writeFile(partPaths.sourceJson, JSON.stringify({ segments: makeSegments([[0, 1000, 'Sung'], [1000, 2000, 'Again']]) }));
    await store.saveProject({ ...(await store.getProject(part.id)), sourceRange: { startMs: 1000, endMs: 10_000 } });
    await store.saveProject({
      ...project,
      series: { role: 'parent', settings: { minMinutes: 15, maxMinutes: 20, recapSec: 4, autoStart: false, aiProviderId: 'none' } as never, state: 'parts', partIds: [part.id] },
    });
    await fsp.writeFile(
      songSuggestionsPath(store.paths(project.id)),
      JSON.stringify({ checkedAt: 'x', suggestions: [{ lineId: 'seg_0002', startMs: 1000, endMs: 2000, text: 'Sung', reasons: ['sung'] }] }),
    );

    const app = Fastify();
    registerSongRoutes(app, {
      store,
      orchestrator,
      forEachPart: async (parentId, apply) => {
        const ids = (await store.getProject(parentId)).series?.role === 'parent' ? [part.id] : [];
        const out = [];
        for (const [i, id] of ids.entries()) {
          await apply(id);
          out.push({ projectId: id, index: i + 1, ok: true });
        }
        return out;
      },
      sendError: (reply, err) => void reply.status(400).send({ error: String(err) }),
    });

    const listed = (await app.inject({ method: 'GET', url: `/projects/${project.id}/songs` })).json();
    expect(listed).toMatchObject({ songs: [], suggestions: [{ lineId: 'seg_0002', reasons: ['sung'] }], songSubtitles: false });

    const marked = (await app.inject({ method: 'POST', url: `/projects/${project.id}/songs`, payload: { lineIds: ['seg_0002'], applyToParts: true } })).json();
    expect(marked).toMatchObject({ song: true, changed: [{ id: 'seg_0002' }], parts: [{ projectId: part.id, ok: true }] });
    // The part's line at 0-1 s is the parent's at 1-2 s.
    expect((await lines(partPaths.sourceJson)).map((l) => l.song ?? false)).toEqual([true, false]);

    const after = (await app.inject({ method: 'GET', url: `/projects/${project.id}/songs` })).json();
    expect(after).toMatchObject({ songs: [{ id: 'seg_0002', text: 'Sung', translatedText: '[vi] Sung' }], suggestions: [] });
    // A part without suggestions of its own points at its series.
    await store.saveProject({
      ...(await store.getProject(part.id)),
      series: { role: 'part', parentId: project.id, index: 1, count: 1, seriesName: 'S', recapEndMs: 0 },
    });
    expect((await app.inject({ method: 'GET', url: `/projects/${part.id}/songs` })).json()).toMatchObject({ seriesParentId: project.id });
    // An unknown line is refused, not ignored.
    expect((await app.inject({ method: 'POST', url: `/projects/${project.id}/songs`, payload: { lineIds: ['seg_0099'] } })).statusCode).toBe(400);
    await app.close();
  });
});

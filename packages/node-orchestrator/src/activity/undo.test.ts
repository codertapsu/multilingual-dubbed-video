import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditHistoryEntry, TranscriptSegment } from '@videodubber/shared';

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
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { configureEditHistory, listEditSummaries } from './history.js';
import { FileEditHistoryStore } from './historyStore.js';
import { planUndo, undoEdit, UndoRefusedError } from './undo.js';

const line = (id: string, startMs: number, endMs: number, sourceText: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment =>
  ({ id, index: 0, startMs, endMs, sourceText, ...extra }) as TranscriptSegment;

const entry = (over: Partial<EditHistoryEntry>): EditHistoryEntry => ({
  id: 'edit_0000000000000001',
  projectId: 'p1',
  at: '2026-11-23T10:00:00.000Z',
  initiator: { kind: 'ui' },
  summary: 'x',
  target: 'translation',
  before: [],
  after: [],
  ...over,
});

describe('planUndo (pure)', () => {
  it('restores the fields a line had, the speaker included, when it still reads as the change left it', () => {
    const before = line('seg_0002', 1000, 2000, '你好', { translatedText: 'Chào', speakerId: 'SPEAKER_00' });
    const after = line('seg_0002', 1000, 2000, '你好', { translatedText: 'Xin chào', speakerId: 'SPEAKER_03', locked: true, ttsStale: true });
    const now = [line('seg_0001', 0, 900, 'a'), { ...after, ttsStale: false }]; // re-voiced since: not an edit
    const plan = planUndo(entry({ before: [before], after: [after] }), now, true);
    expect(plan).toEqual({
      kind: 'patches',
      patches: [{ id: 'seg_0002', translatedText: 'Chào', speakerId: 'SPEAKER_00', locked: false }],
    });
  });

  it('gives lines kept as the song their dub back, through mark_song (no patch can carry the flag)', () => {
    // An entry of mark_song's: undo used to find "nothing to write", mark it
    // undone, and leave every line a song.
    const before = [line('seg_0004', 4000, 5000, '红婴孩儿回家啦'), line('seg_0005', 5000, 6000, '啊')];
    const after = before.map((l) => ({ ...l, song: true, ttsStale: true }));
    const plan = planUndo(entry({ before, after }), after, true);
    expect(plan).toEqual({ kind: 'patches', patches: [], songs: [{ song: false, lineIds: ['seg_0004', 'seg_0005'] }] });
    // Marked again by hand since: refused, as for any other field.
    const changed = planUndo(entry({ before, after }), [{ ...after[0]!, song: false }, after[1]!], true);
    expect(changed.kind).toBe('refused');
  });

  it('refuses when a line changed since, and says which and how', () => {
    const before = line('seg_0002', 1000, 2000, 'a', { translatedText: 'one' });
    const after = line('seg_0002', 1000, 2000, 'a', { translatedText: 'two', locked: true });
    const now = [{ ...after, translatedText: 'three' }];
    const plan = planUndo(entry({ before: [before], after: [after] }), now, true);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') return;
    expect(plan.changes).toEqual([{ id: 'seg_0002', atMs: 1000, what: 'translatedText', now: 'three', expected: 'two' }]);
    expect(plan.reason).toMatch(/translation of line seg_0002/);
  });

  it('finds a line renumbered since by its content', () => {
    const before = line('seg_0005', 9000, 9500, 'z', { speakerId: 'SPEAKER_01' });
    const after = line('seg_0005', 9000, 9500, 'z', { speakerId: 'SPEAKER_02' });
    const now = [line('seg_0005', 7000, 7500, 'other'), line('seg_0007', 9000, 9500, 'z', { speakerId: 'SPEAKER_02' })];
    const plan = planUndo(entry({ target: 'source', before: [before], after: [after] }), now, false);
    expect(plan).toEqual({ kind: 'patches', patches: [{ id: 'seg_0007', speakerId: 'SPEAKER_01' }] });
  });

  it('gives a range its old lines back, the range widened to a line that crossed its edge', () => {
    const removed = [line('seg_0002', 1500, 3200, 'loop', { speakerId: 'SPEAKER_04' }), line('seg_0003', 3300, 4000, 'loop')];
    const made = [line('seg_0002', 2000, 3900, 'fixed')];
    const now = [line('seg_0001', 0, 1000, 'a'), made[0]!, line('seg_0003', 5000, 6000, 'b')];
    const plan = planUndo(entry({ target: 'source', range: { fromMs: 2000, toMs: 4000 }, before: removed, after: made }), now, false);
    expect(plan).toEqual({
      kind: 'range',
      fromMs: 1500,
      toMs: 4000,
      lines: [
        { startMs: 1500, endMs: 3200, text: 'loop', speakerId: 'SPEAKER_04' },
        { startMs: 3300, endMs: 4000, text: 'loop' },
      ],
    });
  });

  it('refuses a range that holds other lines now, or a project translated since', () => {
    const e = entry({ target: 'source', range: { fromMs: 2000, toMs: 4000 }, before: [line('seg_0002', 2000, 3000, 'x')], after: [line('seg_0002', 2000, 3500, 'y')] });
    const crowded = [line('seg_0002', 2000, 3500, 'y'), line('seg_0003', 3600, 3900, 'new')];
    const plan = planUndo(e, crowded, false);
    expect(plan.kind === 'refused' && plan.changes[0]).toMatchObject({ what: 'count', now: '2', expected: '1' });
    const translated = planUndo(e, [line('seg_0002', 2000, 3500, 'y')], true);
    expect(translated.kind === 'refused' && translated.changes[0]?.what).toBe('translated');
  });

  it('refuses what was already undone', () => {
    const plan = planUndo(entry({ undoneAt: '2026-11-23T11:00:00.000Z' }), [], true);
    expect(plan.kind === 'refused' && plan.changes[0]?.what).toBe('already-undone');
  });
});

describe('undo through the orchestrator, with the history on disk', () => {
  let tmp: string;
  let store: ProjectStore;
  let orchestrator: LocalJobOrchestrator;
  let id: string;

  const read = async (file: string): Promise<TranscriptSegment[]> =>
    (JSON.parse(await fsp.readFile(file, 'utf8')) as { segments: TranscriptSegment[] }).segments;
  const deps = () => ({
    paths: (p: string) => store.paths(p),
    replaceSourceLines: orchestrator.replaceSourceLines.bind(orchestrator),
    patchSegments: orchestrator.patchSegments.bind(orchestrator),
  });

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-undo-'));
    store = new ProjectStore(path.join(tmp, 'projects'));
    configureEditHistory(new FileEditHistoryStore((p) => path.join(store.paths(p).root, 'history')));
    orchestrator = new LocalJobOrchestrator({
      config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
      store,
      media: new FakeMediaService({ mediaInfo: fakeMediaInfo(60_000) }),
      registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
      bus: new EventBusRegistry(),
    });
    const project = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
    id = project.id;
    const paths = store.paths(id);
    await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
    const lines = makeSegments([
      [0, 2000, 'Before'],
      [3000, 3900, 'again'],
      [4000, 4900, 'again'],
      [8000, 9000, 'After'],
    ]).map((s, i) => (i === 1 ? { ...s, speakerId: 'SPEAKER_01' } : s));
    await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: lines }), 'utf8');
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('undoes a replaced range: the old lines and their speakers come back, and the undo is an entry itself', async () => {
    await orchestrator.replaceSourceLines(id, 2500, 7000, [{ startMs: 3000, endMs: 6000, text: 'once', speakerId: 'SPEAKER_02' }]);
    const [replaced] = await listEditSummaries(id);
    expect(replaced).toMatchObject({ target: 'source', range: { fromMs: 2500, toMs: 7000 }, beforeCount: 2, afterCount: 1 });
    // The History tab words it in the reader's language from its key and values.
    expect(replaced).toMatchObject({
      summaryKey: 'history.summary.replaced',
      summaryParams: { replaced: 2, made: 1, from: '0:03', to: '0:07' },
    });

    const result = await undoEdit(deps(), id, replaced!.id);
    const now = await read(store.paths(id).sourceJson);
    expect(now.map((s) => s.sourceText)).toEqual(['Before', 'again', 'again', 'After']);
    expect(now[1]!.speakerId).toBe('SPEAKER_01');
    expect(result.undone.undoneAt).toBeDefined();
    expect(result.entry).toMatchObject({ undoOf: replaced!.id, summary: `Undid: ${replaced!.summary}`, range: { fromMs: 2500, toMs: 7000 } });
    expect(result.entry).toMatchObject({
      summaryKey: 'history.summary.undo',
      summaryParams: { of: 'history.summary.replaced', text: replaced!.summary, replaced: 2, made: 1 },
    });

    // And the undo can be undone in its turn: it still names the first change, one undo deeper.
    const again = await undoEdit(deps(), id, result.entry!.id);
    expect((await read(store.paths(id).sourceJson)).map((s) => s.sourceText)).toEqual(['Before', 'once', 'After']);
    expect(again.entry).toMatchObject({ summaryKey: 'history.summary.undo', summaryParams: { of: 'history.summary.replaced', depth: 2 } });
  });

  it('undoes a speaker change made in the editor, and refuses once the line changed again', async () => {
    await orchestrator.patchSegments(id, [{ id: 'seg_0002', speakerId: 'SPEAKER_05' }]);
    const [first] = await listEditSummaries(id);
    await orchestrator.patchSegments(id, [{ id: 'seg_0002', speakerId: 'SPEAKER_06' }]);

    const refused = await undoEdit(deps(), id, first!.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UndoRefusedError);
    expect((refused as UndoRefusedError).changes[0]).toMatchObject({ id: 'seg_0002', what: 'speakerId', now: 'SPEAKER_06', expected: 'SPEAKER_05' });
    expect((await read(store.paths(id).sourceJson))[1]!.speakerId).toBe('SPEAKER_06');

    // Newest first works: the second, then the first.
    const [second] = await listEditSummaries(id);
    await undoEdit(deps(), id, second!.id);
    await undoEdit(deps(), id, first!.id);
    expect((await read(store.paths(id).sourceJson))[1]!.speakerId).toBe('SPEAKER_01');
  });

  it('undoes a translation edit: the text, the lock and the speaker as they were', async () => {
    const source = await read(store.paths(id).sourceJson);
    await fsp.writeFile(
      store.paths(id).translatedJson,
      JSON.stringify({ segments: source.map((s) => ({ ...s, translatedText: `vi ${s.sourceText}` })) }),
      'utf8',
    );
    await orchestrator.saveTranslatedSegments(id, [{ id: 'seg_0003', translatedText: 'Lại nữa' }]);
    const [edit] = await listEditSummaries(id);
    expect(edit).toMatchObject({ target: 'translation', beforeCount: 1, afterCount: 1 });

    await undoEdit(deps(), id, edit!.id);
    const line3 = (await read(store.paths(id).translatedJson))[2]!;
    expect(line3.translatedText).toBe('vi again');
    expect(line3.locked).toBeUndefined();
    await expect(undoEdit(deps(), id, edit!.id)).rejects.toThrow(/already undone/);
  });
});

/**
 * A project's lines to look at, through the orchestrator (H7, 2026-11-25): the
 * list counts them (GET /projects), GET /projects/:id/issues names them, and a
 * line locked as it is (the editor's "Keep as is") leaves both the list and the
 * run's lines-flagged warning.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AlignedSegment, LineQualityFlag } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import { flaggedLinesWarning } from './pipeline/beforeVoicing.js';
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
import { ProjectStore, writeJsonAtomic } from './workspace/projectStore.js';

let tmp: string;
let store: ProjectStore;
let orchestrator: LocalJobOrchestrator;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-issues-orch-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService(),
    registry: fakeRegistry(new FakeSttProvider(makeSegments([[0, 1000, 'hi']])), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
  });
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const unit = (segmentId: string, startMs: number, status: AlignedSegment['status'], overflowMs: number): AlignedSegment => ({
  segmentId,
  startMs,
  endMs: startMs + 900,
  audioPath: '',
  generatedDurationMs: 900 + overflowMs,
  placedDurationMs: 900 + overflowMs,
  speedRatio: 1,
  overflowMs,
  status,
});

describe("a project's lines to look at (H7)", () => {
  it('counts them in the list, names them, and a line kept as it is leaves both the list and the warning', async () => {
    const a = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp), { name: 'Tập 1' }));
    const b = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp, 'b.mp4'), { name: 'Tập 2' }));
    const paths = store.paths(a.id);
    const pinyin: LineQualityFlag[] = ['pinyin'];
    const lines = makeSegments([[0, 900, '昆仑'], [1000, 1900, '师父'], [2000, 2900, '走']]).map((s, i) => ({
      ...s,
      translatedText: ['Kunlun', 'Sư phụ', 'Đi'][i]!,
      ...(i === 0 ? { qualityFlags: pinyin } : {}),
    }));
    await fsp.mkdir(path.dirname(paths.translatedJson), { recursive: true });
    await writeJsonAtomic(paths.translatedJson, { segments: lines });
    await writeJsonAtomic(paths.translatedAlignedJson, [unit('seg_0001', 0, 'ok', 0), unit('seg_0002', 1000, 'timing-conflict', 800), unit('seg_0003', 2000, 'ok', 0)]);
    const pipeline = await store.getPipeline(a.id);
    const raised = { ...flaggedLinesWarning([{ id: 'seg_0001', flags: pinyin, text: 'Kunlun' }], false), step: 'refine' as const, at: '2026-11-25T08:00:00.000Z' };
    await store.savePipeline({ ...pipeline, status: 'completed', warnings: [raised] });

    const listed = await orchestrator.listProjectsWithIssues();
    expect(listed.find((p) => p.id === a.id)?.issues).toEqual({ flagged: 1, overruns: 1 });
    expect(listed.find((p) => p.id === b.id)).not.toHaveProperty('issues');
    expect(await orchestrator.lineIssues(a.id)).toEqual({
      flagged: [{ id: 'seg_0001', flags: ['pinyin'] }],
      overruns: [{ id: 'seg_0002', overflowMs: 800 }],
    });

    // "Keep as is": the line is locked as it is.
    await orchestrator.patchSegments(a.id, [{ id: 'seg_0001', locked: true }]);
    expect((await orchestrator.lineIssues(a.id)).flagged).toEqual([]);
    expect((await store.getPipeline(a.id)).warnings ?? []).not.toContainEqual(expect.objectContaining({ code: 'lines-flagged' }));
    expect((await orchestrator.listProjectsWithIssues()).find((p) => p.id === a.id)?.issues).toEqual({ flagged: 0, overruns: 1 });
  });

  it('an unknown project is an error, not an empty list', async () => {
    await expect(orchestrator.lineIssues('proj_nope')).rejects.toThrow();
  });
});

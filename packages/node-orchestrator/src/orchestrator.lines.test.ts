import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
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
import { listEdits } from './activity/history.js';
import { planUndo } from './activity/undo.js';

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-lines-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setup(): Promise<{ orchestrator: LocalJobOrchestrator; id: string }> {
  const orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(60_000) }),
    registry: fakeRegistry(new FakeSttProvider([]), new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
  });
  const project = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
  const paths = store.paths(project.id);
  await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
  const loop = makeSegments([
    [0, 2000, 'Before'],
    [3000, 3900, 'again'],
    [4000, 4900, 'again'],
    [5000, 5900, 'again'],
    [8000, 9000, 'After'],
  ]).map((s, i) => (i >= 1 && i <= 3 ? { ...s, loopSuspect: true as const } : s));
  await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: loop }), 'utf8');
  return { orchestrator, id: project.id };
}

describe('replacing the lines of a range (replace_lines)', () => {
  it('replaces every line inside the range, renumbers, and returns the new ids', async () => {
    const { orchestrator, id } = await setup();
    const res = await orchestrator.replaceSourceLines(id, 2500, 7000, [
      { startMs: 3000, endMs: 4500, text: 'You know me', speakerId: 'SPEAKER_01' },
      { startMs: 4600, endMs: 6500, text: 'I saw you once' },
    ]);
    expect(res.replaced).toBe(3);
    expect(res.lines.map((l) => l.id)).toEqual(['seg_0002', 'seg_0003']);
    const doc = JSON.parse(await fsp.readFile(store.paths(id).sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(doc.segments.map((s) => s.sourceText)).toEqual(['Before', 'You know me', 'I saw you once', 'After']);
    expect(doc.segments.map((s) => s.id)).toEqual(['seg_0001', 'seg_0002', 'seg_0003', 'seg_0004']);
    expect(doc.segments[1]!.speakerId).toBe('SPEAKER_01');
    // The replaced lines carry no loop mark any more.
    expect(doc.segments.some((s) => s.loopSuspect)).toBe(false);
  });

  it('settles the warnings about the stretch it rewrote, and lets the others be dismissed', async () => {
    const { orchestrator, id } = await setup();
    const at = new Date().toISOString();
    const stretch = (fromMs: number, toMs: number) => ({ code: 'stt-no-speech' as const, step: 'stt' as const, at, key: 'warning.stt-no-speech-whole', message: 'm', params: { fromMs, toMs } });
    const pipeline = await store.getPipeline(id);
    await store.savePipeline({
      ...pipeline,
      warnings: [
        stretch(2600, 6800),
        stretch(20_000, 40_000),
        { code: 'transcript-mismatch', step: 'stt', at, key: 'warning.transcript-mismatch', message: 'm', params: { fromMs: 3000, toMs: 6000, percent: 0 } },
      ],
    });
    await orchestrator.replaceSourceLines(id, 2500, 7000, [{ startMs: 3000, endMs: 4500, text: 'You know me' }]);
    // Rewritten there: those two are settled; the one elsewhere stays.
    expect((await store.getPipeline(id)).warnings?.map((w) => [w.code, w.params?.['fromMs']])).toEqual([['stt-no-speech', 20_000]]);
    const { dismissed, pipeline: after } = await orchestrator.dismissWarnings(id, ['stt-no-speech']);
    expect(dismissed).toHaveLength(1);
    expect(after.warnings).toBeUndefined();
    expect(after.dismissedWarnings).toEqual([expect.objectContaining({ code: 'stt-no-speech', dismissedAt: expect.any(String) })]);
  });

  it('replaces many ranges in one write and one history entry, undone as one', async () => {
    const { orchestrator, id } = await setup();
    const res = await orchestrator.replaceSourceRanges(id, [
      { fromMs: 7500, toMs: 9500, lines: [{ startMs: 8000, endMs: 8800, text: 'After, fixed' }] },
      { fromMs: 2500, toMs: 7000, lines: [{ startMs: 3000, endMs: 4500, text: 'You know me', speakerId: 'SPEAKER_01' }] },
    ]);
    expect(res).toMatchObject({ replaced: 4, made: 2 });
    expect(res.ranges.map((r) => [r.fromMs, r.replaced, r.lines.map((l) => [l.id, l.text])])).toEqual([
      [2500, 3, [['seg_0002', 'You know me']]],
      [7500, 1, [['seg_0003', 'After, fixed']]],
    ]);
    const doc = JSON.parse(await fsp.readFile(store.paths(id).sourceJson, 'utf8')) as { segments: TranscriptSegment[] };
    expect(doc.segments.map((s) => s.sourceText)).toEqual(['Before', 'You know me', 'After, fixed']);
    const edits = await listEdits(id);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ summaryKey: 'history.summary.replaced-many', range: { fromMs: 2500, toMs: 9500 }, summaryParams: { ranges: 2 } });
    const plan = planUndo(edits[0]!, doc.segments, false);
    expect(plan.kind === 'range' ? plan.lines.map((l) => l.text) : plan).toEqual(['again', 'again', 'again', 'After']);
    // Ranges may not overlap: each stretch is given once.
    await expect(
      orchestrator.replaceSourceRanges(id, [
        { fromMs: 0, toMs: 5000, lines: [] },
        { fromMs: 4000, toMs: 6000, lines: [] },
      ]),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
  });

  it('refuses a project that does not exist, and writes nothing for it', async () => {
    const { orchestrator } = await setup();
    await expect(orchestrator.replaceSourceLines('proj_missing', 0, 1000, [])).rejects.toThrow(/not found/i);
    await expect(fsp.stat(store.paths('proj_missing').sourceJson)).rejects.toThrow();
  });

  it('refuses overlapping lines, and any restructuring once the project is translated', async () => {
    const { orchestrator, id } = await setup();
    await expect(
      orchestrator.replaceSourceLines(id, 2500, 7000, [
        { startMs: 3000, endMs: 5000, text: 'a' },
        { startMs: 4000, endMs: 6000, text: 'b' },
      ]),
    ).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    await fsp.writeFile(store.paths(id).translatedJson, JSON.stringify({ segments: [] }), 'utf8');
    await expect(orchestrator.replaceSourceLines(id, 2500, 7000, [])).rejects.toMatchObject({
      appError: { code: 'INVALID_EDIT', remediation: expect.stringMatching(/rebuild_parts/) },
    });
  });
});

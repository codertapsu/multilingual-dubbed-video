import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttInput, SttProvider, SttResult, TranscriptSegment } from '@videodubber/shared';

import { listEdits } from './activity/history.js';
import { activity } from './activity/registry.js';
import { loadConfig } from './config.js';
import { EventBusRegistry } from './events.js';
import { LocalJobOrchestrator } from './orchestrator.js';
import type { RetranscribeJobView, RetranscribeResult } from './pipeline/retranscribe.js';
import {
  FakeMediaService,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  fakeMediaInfo,
  fakeRegistry,
  writeDummyVideo,
} from './test/fixtures.js';
import { ProjectStore } from './workspace/projectStore.js';

const MIN = 60_000;

/** [startMs, endMs, text] relative to the clip. */
type Heard = [number, number, string][];

/**
 * Speech-to-text that answers by the clip it is given (range_<from>_<to>.wav,
 * what the orchestrator cuts): `byWindow(from, to)` in clip time.
 */
class ClipStt implements SttProvider {
  readonly id = 'faster-whisper';
  readonly displayName = 'Clip STT';
  readonly isLocal = true;
  readonly asked: [number, number, boolean][] = [];
  gate: Promise<void> | undefined;

  constructor(private readonly byWindow: (from: number, to: number) => Heard) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const m = /range_(\d+)_(\d+)\.wav$/.exec(input.audioPath)!;
    const from = Number(m[1]);
    const to = Number(m[2]);
    this.asked.push([from, to, input.noContext === true]);
    if (this.gate) await this.gate;
    const segments = this.byWindow(from, to).map(([startMs, endMs, sourceText], i) => ({ id: `s${i}`, index: i, startMs, endMs, sourceText }));
    return { segments, detectedLanguage: 'zh', durationMs: to - from };
  }
}

function lines(spec: [number, number, string, string?][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, sourceText, speakerId], i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    index: i,
    startMs,
    endMs,
    sourceText,
    ...(speakerId ? { speakerId } : {}),
  }));
}

let tmp: string;
let store: ProjectStore;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-retx-orch-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setup(stt: ClipStt, source: TranscriptSegment[], durationMs = 60 * MIN): Promise<{ orchestrator: LocalJobOrchestrator; id: string }> {
  const orchestrator = new LocalJobOrchestrator({
    config: loadConfig({ projectsDir: path.join(tmp, 'projects') }),
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(durationMs) }),
    registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 900)),
    bus: new EventBusRegistry(),
  });
  const created = await orchestrator.createProject(createProjectInput(await writeDummyVideo(tmp)));
  await store.saveProject({ ...created, mediaInfo: fakeMediaInfo(durationMs), settings: { ...created.settings, sourceLanguage: 'zh', diarize: true } });
  const paths = store.paths(created.id);
  await fsp.mkdir(path.dirname(paths.sourceJson), { recursive: true });
  await fsp.mkdir(path.dirname(paths.original16kMonoWav), { recursive: true });
  await fsp.writeFile(paths.original16kMonoWav, Buffer.alloc(64));
  await fsp.writeFile(paths.sourceJson, JSON.stringify({ segments: source }), 'utf8');
  return { orchestrator, id: created.id };
}

const read = async (file: string): Promise<TranscriptSegment[]> => (JSON.parse(await fsp.readFile(file, 'utf8')) as { segments: TranscriptSegment[] }).segments;

describe('re-transcribing a range of up to 15 minutes', () => {
  // 1:00-1:40: a loop of 25 repeats and a credit line, as the 27.8-hour
  // series' re-transcriptions wrote them (claude-dubber report, F2).
  const source = lines([
    [10_000, 12_000, '开场', 'SPEAKER_00'],
    [61_000, 63_000, '你认得老夫吗', 'SPEAKER_01'],
    [64_000, 80_000, '回身缠住他们', 'SPEAKER_02'],
    [81_000, 99_000, '杂音', 'SPEAKER_03'],
    [130_000, 132_000, '后来', 'SPEAKER_00'],
  ]);
  const heard = (from: number): Heard =>
    from === 60_000
      ? [[1000, 3000, '你认得老夫吗？'], ...Array.from({ length: 25 }, (_, i) => [4000 + i * 1000, 4900 + i * 1000, '回身缠住他们'] as [number, number, string]), [35_000, 37_000, '请不吝点赞 订阅 转发 打赏']]
      : // The loop decoded again without context, 500 ms around it.
        [[1000, 2500, '晚辈昔日有幸见过'], [3500, 6500, '前辈风采依旧']];

  it('runs the loop pass, keeps speakers only where the text still matches, and says what it did', async () => {
    const stt = new ClipStt(heard);
    const { orchestrator, id } = await setup(stt, source);
    const paths = store.paths(id);
    const res = (await orchestrator.retranscribeRange(id, 60_000, 100_000, { apply: true })) as RetranscribeResult;

    // The decode without context, then the loop's range again, 500 ms around it.
    expect(stt.asked).toEqual([
      [60_000, 100_000, true],
      [63_500, 89_400, true],
    ]);
    expect(res.lines.map((l) => [l.text, l.speakerId])).toEqual([
      ['你认得老夫吗？', 'SPEAKER_01'],
      ['晚辈昔日有幸见过', undefined],
      ['前辈风采依旧', undefined],
    ]);
    expect(res.speakers).toEqual({ carried: 1, unassigned: 2 });
    expect(res.loops.map((r) => [r.kind, r.status])).toEqual([
      ['repeat', 'replaced'],
      ['phrase', 'removed'],
    ]);
    expect(res.applied!.replaced).toBe(3);
    expect(res.applied!.lines.map((l) => l.id)).toEqual(['seg_0002', 'seg_0003', 'seg_0004']);

    const after = await read(paths.sourceJson);
    expect(after.map((l) => l.sourceText)).toEqual(['开场', '你认得老夫吗？', '晚辈昔日有幸见过', '前辈风采依旧', '后来']);
    // The loop report and the project's warnings say what is true now.
    const report = JSON.parse(await fsp.readFile(paths.loopRangesJson, 'utf8')) as { ranges: { status: string }[] };
    expect(report.ranges.map((r) => r.status)).toEqual(['replaced', 'removed']);
    const pipeline = await store.getPipeline(id);
    expect(pipeline.warnings?.map((w) => [w.code, w.step, w.params])).toEqual([
      ['loops-repaired', 'stt', { count: 2 }],
      ['speakers-unassigned', 'stt', { count: 2, ranges: '1:05–1:10' }],
    ]);
    // One history entry, in the plan's words; one activity entry.
    const [edit] = await listEdits(id);
    expect(edit!.summary).toBe('Re-transcribed 1:00–1:40: 3 lines, 2 loops removed, 2 without a speaker');
    expect(edit!.range).toEqual({ fromMs: 60_000, toMs: 100_000 });
    const [entry] = activity.list({ projectId: id });
    expect(entry).toMatchObject({ kind: 'lines.retranscribe', state: 'done', title: 'Re-transcribing 1:00–1:40' });
  });

  it('only shows what it hears without apply, and widens the range to whole lines', async () => {
    const stt = new ClipStt(heard);
    const { orchestrator, id } = await setup(stt, source);
    const res = (await orchestrator.retranscribeRange(id, 62_000, 100_000)) as RetranscribeResult;
    expect([res.fromMs, res.toMs]).toEqual([61_000, 100_000]);
    expect(res.applied).toBeUndefined();
    expect((await read(store.paths(id).sourceJson)).map((l) => l.sourceText)).toEqual(source.map((l) => l.sourceText));
    expect(await listEdits(id)).toEqual([]);
  });

  it('refuses a translated project before decoding anything', async () => {
    const stt = new ClipStt(heard);
    const { orchestrator, id } = await setup(stt, source);
    await fsp.writeFile(store.paths(id).translatedJson, JSON.stringify({ segments: source }), 'utf8');
    await expect(orchestrator.retranscribeRange(id, 60_000, 100_000, { apply: true })).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    expect(stt.asked).toEqual([]);
    // Looking is still allowed.
    await orchestrator.retranscribeRange(id, 60_000, 100_000);
    expect(stt.asked.length).toBeGreaterThan(0);
  });
});

describe('re-transcribing a long range', () => {
  it('is one job in windows of up to 15 minutes, each applied as it is heard, with progress', async () => {
    const source = lines([
      [5 * MIN, 5 * MIN + 2000, '第一段', 'SPEAKER_00'],
      [20 * MIN, 20 * MIN + 2000, '第二段', 'SPEAKER_01'],
      [32 * MIN, 32 * MIN + 2000, '第三段', 'SPEAKER_00'],
    ]);
    // Each window hears one line where the old one was; the last one hears other words.
    const stt = new ClipStt((from) =>
      from === 0 ? [[5 * MIN, 5 * MIN + 2000, '第一段']] : from === 15 * MIN ? [[5 * MIN, 5 * MIN + 2000, '第二段落']] : [[2 * MIN, 2 * MIN + 2000, '完全不同的话']],
    );
    let release!: () => void;
    stt.gate = new Promise<void>((r) => {
      release = r;
    });
    const { orchestrator, id } = await setup(stt, source, 40 * MIN);
    const res = await orchestrator.retranscribeRange(id, 0, 40 * MIN, { apply: true });
    const job = (res as { job: RetranscribeJobView }).job;
    expect(job).toMatchObject({ state: 'running', windows: 3, done: 0, apply: true, fromMs: 0, toMs: 40 * MIN });
    // While it runs, the project is busy: no dub, no second re-transcription.
    await expect(orchestrator.runPipeline(id)).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    await expect(orchestrator.retranscribeRange(id, 0, 1000)).rejects.toMatchObject({ appError: { code: 'RUN_IN_PROGRESS' } });
    expect(orchestrator.busyProjects()).toContain(id);
    release();
    await vi.waitFor(() => expect(orchestrator.retranscribeJob(id, job.id)?.state).toBe('done'), { timeout: 5000 });

    const done = orchestrator.retranscribeJob(id, job.id)!;
    expect(done.results.map((r) => [r.fromMs, r.toMs, r.speakers])).toEqual([
      [0, 15 * MIN, { carried: 1, unassigned: 0 }],
      [15 * MIN, 30 * MIN, { carried: 1, unassigned: 0 }],
      [30 * MIN, 40 * MIN, { carried: 0, unassigned: 1 }],
    ]);
    expect(done.result).toMatchObject({ lines: 3, replaced: 3, speakers: { carried: 2, unassigned: 1 } });
    expect((await read(store.paths(id).sourceJson)).map((l) => [l.startMs, l.sourceText, l.speakerId])).toEqual([
      [5 * MIN, '第一段', 'SPEAKER_00'],
      [20 * MIN, '第二段落', 'SPEAKER_01'],
      [32 * MIN, '完全不同的话', undefined],
    ]);
    // One history entry per window, newest first.
    expect((await listEdits(id)).map((e) => e.summary)).toEqual([
      'Re-transcribed 30:00–40:00: 1 line, 1 without a speaker',
      'Re-transcribed 15:00–30:00: 1 line',
      'Re-transcribed 0:00–15:00: 1 line',
    ]);
    expect(activity.get(job.id)).toMatchObject({ kind: 'lines.retranscribe', state: 'done', percent: 100, projectId: id });
    expect(orchestrator.busyProjects()).not.toContain(id);
    expect(orchestrator.retranscribeJob('another', job.id)).toBeUndefined();
  });
});

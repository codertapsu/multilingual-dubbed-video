/**
 * The runner's checks of the source and of its own transcript
 * (docs/plans/production-requests-2026-11-23.md 1.1 and 1.6), with fakes:
 * no ffmpeg, no speech-to-text engine.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SERIES_SETTINGS,
  type Project,
  type ProjectSettings,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TranscriptSegment,
} from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import type { SpeechMapService } from './speechMap.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import {
  FakeMediaService,
  FakeTranslationProvider,
  FakeTtsProvider,
  createProjectInput,
  defaultSettings,
  fakeMediaInfo,
  fakeRegistry,
  makeSegments,
  writeDummyVideo,
} from '../test/fixtures.js';

let tmp: string;
let store: ProjectStore;
let buses: EventBusRegistry;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-source-checks-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

interface Built {
  project: Project;
  deps: RunnerDeps;
  media: FakeMediaService;
  paths: ReturnType<ProjectStore['paths']>;
}

async function build(opts: {
  durationMs?: number;
  settings?: Partial<ProjectSettings>;
  stt?: SttProvider;
  speechMap?: SpeechMapService;
  sttChunkWindowMs?: number;
  sttChunkThresholdMs?: number;
}): Promise<Built> {
  const video = await writeDummyVideo(tmp);
  const project = await store.createProject(createProjectInput(video, { settings: defaultSettings(opts.settings ?? {}) }));
  const paths = store.paths(project.id);
  const media = new FakeMediaService({ mediaInfo: fakeMediaInfo(opts.durationMs ?? 10_000) });
  const stt: SttProvider =
    opts.stt ??
    ({
      id: 'faster-whisper',
      displayName: 'fixed',
      isLocal: true,
      async transcribe(): Promise<SttResult> {
        return { segments: makeSegments([[0, 1000, 'Hello']]), detectedLanguage: 'en', durationMs: 10_000 };
      },
    } satisfies SttProvider);
  const bus = buses.get(project.id);
  const deps: RunnerDeps = {
    store,
    media,
    registry: fakeRegistry(stt, new FakeTranslationProvider(), new FakeTtsProvider(() => 800)),
    bus,
    logger: new ProjectLogger(paths.pipelineLog, bus),
    ...(opts.speechMap ? { speechMap: opts.speechMap } : {}),
    ...(opts.sttChunkWindowMs ? { sttChunkWindowMs: opts.sttChunkWindowMs } : {}),
    ...(opts.sttChunkThresholdMs ? { sttChunkThresholdMs: opts.sttChunkThresholdMs } : {}),
  };
  return { project, deps, media, paths };
}

/** Run the pipeline up to the end of speech-to-text (the parent of a series stops there too). */
async function runToStt(b: Built): Promise<void> {
  const parent = { role: 'parent' as const, settings: { ...DEFAULT_SERIES_SETTINGS, aiProviderId: 'anthropic' }, state: 'analysing' as const };
  await store.saveProject({ ...(await store.getProject(b.project.id)), series: parent });
  await new PipelineRunner(b.deps).run(await store.getProject(b.project.id), { signal: new AbortController().signal });
}

async function warningsOf(projectId: string) {
  return (await store.getPipeline(projectId)).warnings ?? [];
}

async function log(b: Built): Promise<string> {
  return fsp.readFile(b.paths.pipelineLog, 'utf8');
}

describe('extract-audio: the audio against the picture (1.1)', () => {
  it('records the drift in the media info and the log, and warns from 0.5 s', async () => {
    const b = await build({});
    b.media.audioDrift = {
      driftMs: 4810,
      audioMs: 14_810,
      pictureMs: 10_000,
      method: 'packets',
      claimedAudioMs: 10_000,
      count: { codec: 'aac', sampleRate: 48000, packets: 695, frameSize: 1024, primingSamples: 1024 },
    };
    await runToStt(b);

    const info = (await store.getProject(b.project.id)).mediaInfo;
    expect(info?.audioDrift).toMatchObject({ driftMs: 4810, method: 'packets', claimedAudioMs: 10_000 });
    expect(info?.audioDrift?.measuredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const drift = (await warningsOf(b.project.id)).find((w) => w.code === 'audio-drift');
    expect(drift).toMatchObject({ step: 'extract-audio', key: 'warning.audio-drift', params: { seconds: 4.8 } });
    expect(await log(b)).toContain('Audio vs picture: the audio holds 14.81 s, the picture lasts 10.00 s: +4.81 s');
  });

  it('a small drift is recorded and logged, never a warning', async () => {
    const b = await build({});
    b.media.audioDrift = { driftMs: 20, audioMs: 10_020, pictureMs: 10_000, method: 'decode', count: { codec: 'opus', sampleRate: 48000, samples: 480_960 } };
    await runToStt(b);
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift?.driftMs).toBe(20);
    expect((await warningsOf(b.project.id)).map((w) => w.code)).not.toContain('audio-drift');
    expect(await log(b)).toContain('+0.02 s (480960 samples decoded, opus 48000 Hz)');
  });

  it("a series part measures its own window, replacing the parent's whole-video value", async () => {
    const b = await build({ durationMs: 60_000 });
    const fresh = await store.getProject(b.project.id);
    await store.saveProject({
      ...fresh,
      sourceRange: { startMs: 600_000, endMs: 660_000 },
      mediaInfo: { ...fakeMediaInfo(60_000), audioDrift: { driftMs: 4810, audioMs: 1, pictureMs: 1, method: 'packets', measuredAt: 'then' } },
    });
    b.media.audioDrift = { driftMs: 30, audioMs: 60_030, pictureMs: 60_000, method: 'packets', range: { startMs: 600_000, endMs: 660_000 } };
    await runToStt(b);
    expect(b.media.driftRanges).toEqual([{ startMs: 600_000, endMs: 660_000 }]);
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift).toMatchObject({ driftMs: 30, range: { startMs: 600_000 } });
  });

  it('a measurement that fails never fails the step, and leaves no stale value', async () => {
    const b = await build({});
    const fresh = await store.getProject(b.project.id);
    await store.saveProject({
      ...fresh,
      mediaInfo: { ...fakeMediaInfo(10_000), audioDrift: { driftMs: 999, audioMs: 1, pictureMs: 1, method: 'packets', measuredAt: 'then' } },
    });
    b.media.measureAudioDrift = async () => {
      throw new Error('ffprobe crashed');
    };
    await runToStt(b);
    const pipeline = await store.getPipeline(b.project.id);
    expect(pipeline.steps.find((s) => s.id === 'extract-audio')?.status).toBe('completed');
    expect((await store.getProject(b.project.id)).mediaInfo?.audioDrift).toBeUndefined();
    expect(await log(b)).toContain('Could not measure the audio against the picture (ffprobe crashed)');
  });
});

/** Varied Chinese lines (no loop), different for every `i`; `pool` 1 shares no words with pool 0. */
function said(i: number, pool = 0): string {
  const words = [
    [['你说', '他们', '我们', '这个', '那边', '大人', '将军', '兄弟', '姑娘', '师父'], ['今天', '明天', '昨晚', '刚才', '马上', '一直', '终于', '已经', '还是', '真的'], ['回来了', '走不了', '想见你', '不知道', '要出发', '吃饭了', '杀过来', '睡着了', '在等我', '赢了啊']],
    [['风雨', '山河', '岁月', '星辰', '烟花', '江湖', '红尘', '落叶', '孤城', '长亭'], ['飘摇', '无声', '如梦', '似水', '依旧', '渐远', '难寻', '已逝', '未央', '成空'], ['映斜阳', '寄相思', '锁清秋', '叹浮生', '醉春风', '望天涯', '照归途', '落花间', '绕青山', '入画屏']],
  ][pool]!;
  return `${words[0]![i % 10]}${words[1]![Math.floor(i / 10) % 10]}${words[2]![Math.floor(i / 100) % 10]}`;
}

/** An STT engine: `chunk(audioPath)` for the transcription, `again(audioPath)` for a decode without context. */
function engine(
  chunk: (audioPath: string) => TranscriptSegment[],
  again: (audioPath: string) => TranscriptSegment[] = () => [],
  detectedLanguage = 'zh',
): SttProvider & { asked: SttInput[] } {
  const asked: SttInput[] = [];
  return {
    id: 'faster-whisper',
    displayName: 'scripted',
    isLocal: true,
    asked,
    async transcribe(input: SttInput): Promise<SttResult> {
      asked.push(input);
      const segments = input.noContext ? again(input.audioPath) : chunk(input.audioPath);
      return { segments, detectedLanguage, durationMs: 0 };
    },
  };
}

const regionsOf = (spans: [number, number][]): SpeechMapService => ({
  regions: async () => spans.map(([startMs, endMs]) => ({ startMs, endMs })),
});

async function sourceLines(b: Built): Promise<TranscriptSegment[]> {
  return (JSON.parse(await fsp.readFile(b.paths.sourceJson, 'utf8')) as { segments: TranscriptSegment[] }).segments;
}

describe('stt: lines written over silence (1.6a)', () => {
  it('a chunk that heard no speech is flagged, and its lines go through the loop pass', async () => {
    // 4 chunks of 30 s; chunk 2 (30-60 s) is silent, and the engine wrote 8 lines there.
    const stt = engine((audioPath) => {
      if (!audioPath.includes('chunk_0001')) return makeSegments([[2000, 5000, `${said(1)}啊`], [10_000, 14_000, said(2)]]);
      return makeSegments(Array.from({ length: 8 }, (_, i) => [i * 3500, i * 3500 + 3000, said(10 + i, 1)] as [number, number, string]));
    });
    const b = await build({
      durationMs: 100_000,
      settings: { sourceLanguage: 'zh-CN' },
      stt,
      speechMap: regionsOf([[0, 30_000], [60_000, 100_000]]),
      sttChunkWindowMs: 30_000,
      sttChunkThresholdMs: 20_000,
    });
    await runToStt(b);

    const silent = (await warningsOf(b.project.id)).find((w) => w.code === 'stt-no-speech');
    expect(silent).toMatchObject({ step: 'stt', key: 'warning.stt-no-speech', params: { chunk: '2', chunks: 4, count: 8, from: '0:30', speech: 0 } });
    expect(silent!.message).toMatch(/^STT chunk 2 of 4 heard no speech at 0:30-0:5\d: 8 line\(s\) over silence/);
    // The second decode heard nothing: the lines are gone, and the loop pass says so.
    expect((await sourceLines(b)).filter((l) => l.startMs >= 30_000 && l.startMs < 60_000)).toEqual([]);
    const report = JSON.parse(await fsp.readFile(b.paths.loopRangesJson, 'utf8')) as { ranges: { kind: string; status: string }[] };
    expect(report.ranges).toContainEqual(expect.objectContaining({ kind: 'silence', status: 'removed' }));
    expect((await warningsOf(b.project.id)).map((w) => w.code)).toContain('loops-repaired');
    expect(stt.asked.filter((a) => a.noContext)).toHaveLength(1);
  });

  it('inSilence reaches the loop pass: a common credit word over silence is removed, in speech it stays', async () => {
    const stt = engine(() =>
      makeSegments([
        [1000, 4000, said(1)],
        [5000, 7000, '感谢观看'],
        [8000, 11_000, said(2)],
        [20_000, 22_000, '感谢观看'],
      ]),
    );
    const b = await build({ durationMs: 30_000, settings: { sourceLanguage: 'zh-CN' }, stt, speechMap: regionsOf([[0, 15_000]]) });
    await runToStt(b);
    expect((await sourceLines(b)).map((l) => l.startMs)).toEqual([1000, 5000, 8000]);
  });

  it('the speech map is asked once: a failure is said once, and anchoring does not ask again', async () => {
    let asked = 0;
    const speechMap: SpeechMapService = {
      regions: async () => {
        asked += 1;
        throw new Error('worker down');
      },
    };
    const b = await build({ durationMs: 30_000, settings: { sourceLanguage: 'zh-CN' }, speechMap });
    await runToStt(b);
    expect(asked).toBe(1);
    expect((await log(b)).match(/Could not map where speech is/g)).toHaveLength(1);
  });

  it('a long video whose lines have word timings is not measured for the checks alone', async () => {
    let asked = 0;
    const speechMap: SpeechMapService = {
      regions: async () => {
        asked += 1;
        return [];
      },
    };
    const words = (s: number, e: number) => [{ word: 'hello', startMs: s, endMs: e }];
    const stt = engine(() => [
      { id: 'seg_0001', index: 0, startMs: 1000, endMs: 2000, sourceText: 'hello', words: words(1000, 2000) },
    ]);
    const b = await build({ durationMs: 4 * 3_600_000, stt, speechMap, sttChunkThresholdMs: 10 * 3_600_000 });
    await runToStt(b);
    expect(asked).toBe(0);
    expect(await log(b)).toContain('Lines over silence are not checked on this long video');
  });
});

describe('stt: the spot check (1.6c)', () => {
  const HOUR = 3_600_000;
  /** One line every 5 s for `hours`; inside [garbledFrom, garbledTo) the transcript says something else. */
  const lines = (hours: number, garbled?: [number, number]): TranscriptSegment[] =>
    makeSegments(
      Array.from({ length: (hours * HOUR) / 5000 }, (_, i) => {
        const t = i * 5000;
        const bad = garbled && t >= garbled[0] && t < garbled[1];
        return [t, t + 4000, said(i, bad ? 1 : 0)] as [number, number, string];
      }),
    );
  /** What the audio says in a spot clip ("spot_<from>_<to>.wav"): the clean lines, in the clip's own time. */
  const truth = (hours: number) => {
    const clean = lines(hours);
    return (audioPath: string): TranscriptSegment[] => {
      const m = /spot_(\d+)_(\d+)\.wav$/.exec(audioPath);
      if (!m) return [];
      const [from, to] = [Number(m[1]), Number(m[2])];
      return clean
        .filter((l) => (l.startMs + l.endMs) / 2 >= from && (l.startMs + l.endMs) / 2 < to)
        .map((l) => ({ ...l, startMs: l.startMs - from, endMs: l.endMs - from }));
    };
  };

  it('a long transcript that stops matching its audio for an hour gets a warning with the range', async () => {
    const stt = engine(() => lines(3, [HOUR, 2 * HOUR]), truth(3));
    const b = await build({ durationMs: 3 * HOUR, settings: { sourceLanguage: 'zh-CN' }, stt, sttChunkThresholdMs: 10 * HOUR });
    await runToStt(b);

    const spot = stt.asked.filter((a) => a.noContext);
    expect(spot.length).toBeGreaterThanOrEqual(6);
    expect(spot.every((a) => /spot_\d+_\d+\.wav$/.test(a.audioPath) && a.wordTimestamps === false)).toBe(true);
    const mismatch = (await warningsOf(b.project.id)).filter((w) => w.code === 'transcript-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({ step: 'stt', key: 'warning.transcript-mismatch-span' });
    expect(Number(mismatch[0]!.params!.fromMs)).toBeGreaterThanOrEqual(HOUR);
    expect(Number(mismatch[0]!.params!.fromMs)).toBeLessThan(HOUR + 5 * 60_000);
    expect(Number(mismatch[0]!.params!.toMs)).toBeGreaterThan(2 * HOUR - 5 * 60_000);
    expect(Number(mismatch[0]!.params!.toMs)).toBeLessThanOrEqual(2 * HOUR + 60_000);
    expect(await log(b)).toMatch(/Spot check: \d+ minute\(s\) decoded again/);
  });

  it('off when the setting says so, and by default on videos of 2 hours or less', async () => {
    const off = engine(() => lines(3, [HOUR, 2 * HOUR]), truth(3));
    const b = await build({ durationMs: 3 * HOUR, settings: { sourceLanguage: 'zh-CN', transcriptSpotCheck: false }, stt: off, sttChunkThresholdMs: 10 * HOUR });
    await runToStt(b);
    expect(off.asked.filter((a) => a.noContext)).toEqual([]);

    const short = engine(() => lines(1), truth(1));
    const s = await build({ durationMs: HOUR, settings: { sourceLanguage: 'zh-CN' }, stt: short, sttChunkThresholdMs: 10 * HOUR });
    await runToStt(s);
    expect(short.asked.filter((a) => a.noContext)).toEqual([]);
  });

  it('on for a shorter video when asked; a clean transcript gives no warning', async () => {
    const stt = engine(() => lines(1), truth(1));
    const b = await build({ durationMs: HOUR, settings: { sourceLanguage: 'zh-CN', transcriptSpotCheck: true }, stt, sttChunkThresholdMs: 10 * HOUR });
    await runToStt(b);
    expect(stt.asked.filter((a) => a.noContext)).toHaveLength(2);
    expect((await warningsOf(b.project.id)).map((w) => w.code)).not.toContain('transcript-mismatch');
  });

  it('skipped for a transcript in another script', async () => {
    const stt = engine(() => makeSegments([[1000, 3000, 'Hello there, how are you?']]), () => [], 'en');
    const b = await build({ durationMs: 3 * HOUR, settings: { sourceLanguage: 'en-US' }, stt, sttChunkThresholdMs: 10 * HOUR });
    await runToStt(b);
    expect(stt.asked.filter((a) => a.noContext)).toEqual([]);
    expect(await log(b)).toContain('Spot check skipped');
  });
});

describe('stt: digital silence (1.6b)', () => {
  /** A talk-heavy 20 minutes: a line every 3 s, except in the silence. */
  const talk = (silence: [number, number]) =>
    makeSegments(
      Array.from({ length: 400 }, (_, i) => [i * 3000, i * 3000 + 2500, said(i)] as [number, number, string]).filter(
        ([s]) => s < silence[0] || s >= silence[1],
      ),
    );

  it('a minute or more below -80 dB in a talk-heavy video is a warning with its range', async () => {
    const stt = engine(() => talk([600_000, 700_000]));
    const b = await build({ durationMs: 1_200_000, settings: { sourceLanguage: 'zh-CN' }, stt, sttChunkThresholdMs: 3_600_000 });
    b.media.trackSilences = [{ startMs: 600_000, endMs: 700_000 }];
    await runToStt(b);
    const silence = (await warningsOf(b.project.id)).find((w) => w.code === 'digital-silence');
    expect(silence).toMatchObject({ step: 'stt', key: 'warning.digital-silence', params: { from: '10:00', to: '11:40', minutes: 2 } });
    expect(b.media.calls).toContain(`detectSilences:${b.paths.original16kMonoWav}`);
  });

  it('not in a video with little talk', async () => {
    const stt = engine(() => makeSegments([[1000, 4000, said(1)]]));
    const b = await build({ durationMs: 1_200_000, settings: { sourceLanguage: 'zh-CN' }, stt, sttChunkThresholdMs: 3_600_000 });
    b.media.trackSilences = [{ startMs: 600_000, endMs: 700_000 }];
    await runToStt(b);
    expect((await warningsOf(b.project.id)).map((w) => w.code)).not.toContain('digital-silence');
    expect(await log(b)).toContain('Not flagged: the rest of the video has little talk');
  });
});

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
  type PictureDetection,
  type Project,
  type ProjectSettings,
  type SttInput,
  type SttProvider,
  type SttResult,
  type TranscriptSegment,
} from '@videodubber/shared';
import { PipelineRunner, type RunnerDeps } from './runner.js';
import { listEdits } from '../activity/history.js';
import { adTailFrom, pictureDirOf, savedDetection } from '../picture/pictureDetection.js';
import { planUndo } from '../activity/undo.js';
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

describe('a series parent counts only the steps it runs (claude-dubber, 2026-11-27)', () => {
  it('reports its progress over probe, extract and speech-to-text, not the nine steps its parts dub', async () => {
    const b = await build({});
    // Every overall percent seen while speech-to-text ran.
    const during: number[] = [];
    const off = b.deps.bus.subscribe((e) => {
      if (e.type === 'state' && e.pipeline.steps.find((s) => s.id === 'stt')?.status === 'running') during.push(e.pipeline.progressPercent);
    });
    await runToStt(b);
    off();
    // Two of its three steps done before speech-to-text: 67 % and up. Over nine
    // steps it read 22–33 %, and "about 20 h 45 min left" for under two hours.
    expect(during.length).toBeGreaterThan(0);
    expect(Math.min(...during)).toBeGreaterThanOrEqual(67);
    const end = await store.getPipeline(b.project.id);
    expect(end).toMatchObject({ endsAfter: 'stt', progressPercent: 100, status: 'completed' });
  });
});

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

    // Said once the loop pass decided them: how many, and what became of them.
    const silent = (await warningsOf(b.project.id)).find((w) => w.code === 'stt-no-speech');
    expect(silent).toMatchObject({ step: 'stt', key: 'warning.stt-no-speech-checked', params: { count: 8, kept: 0, added: 0, removed: 8 } });
    expect(silent!.message).toMatch(/^8 line\(s\) \([\d.]+ min\) were written where the speech map heard no speech\. A second decode without context checked them: 0 heard again and kept, 0 heard only by it and added, 8 removed\./);
    // The second decode heard only its neighbours' words there: two signals of no speech, the lines go.
    expect((await sourceLines(b)).filter((l) => l.startMs >= 30_000 && l.startMs < 60_000)).toEqual([]);
    const report = JSON.parse(await fsp.readFile(b.paths.loopRangesJson, 'utf8')) as { ranges: { kind: string; status: string; originalLines?: unknown[] }[] };
    expect(report.ranges).toContainEqual(expect.objectContaining({ kind: 'silence', status: 'removed', counts: expect.objectContaining({ kept: 0, dropped: 8 }) }));
    // The evidence stays with the report: what each decode heard.
    expect(report.ranges.find((r) => r.kind === 'silence')!.originalLines).toHaveLength(8);
    expect((await warningsOf(b.project.id)).map((w) => w.code)).toContain('loops-repaired');
    // The second opinion listens to every second (no voice filter), without context.
    expect(stt.asked.filter((a) => a.noContext)).toEqual([expect.objectContaining({ noContext: true, vadFilter: false })]);
    // And the change is an undoable entry of the edit history.
    const edits = await listEdits(b.project.id);
    const entry = edits.find((e) => e.summaryKey === 'history.summary.stt-checked');
    expect(entry).toMatchObject({ target: 'source', summaryParams: { before: 8, after: 0 } });
    // Undone, the range gets its eight lines back, as speech-to-text wrote them.
    const plan = planUndo(entry!, await sourceLines(b), false);
    expect(plan).toMatchObject({ kind: 'range' });
    expect(plan.kind === 'range' ? plan.lines.map((l) => l.text) : []).toEqual(Array.from({ length: 8 }, (_, i) => said(10 + i, 1)));
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

describe("stt: the video's own subtitles (claude-dubber A2, 2026-11-25)", () => {
  /** Chunk 2 (30–60 s) is silent to the speech map, and the engine wrote 8 real lines there. */
  const sttWithQuietSpeech = () =>
    engine((audioPath) => {
      if (!audioPath.includes('chunk_0001')) return makeSegments([[2000, 5000, `${said(1)}啊`], [10_000, 14_000, said(2)]]);
      return makeSegments(Array.from({ length: 8 }, (_, i) => [i * 3500, i * 3500 + 3000, said(10 + i, 1)] as [number, number, string]));
    });
  const detection = {
    at: '2026-11-25T00:00:00.000Z',
    videoWidth: 1920,
    videoHeight: 1080,
    regions: [],
    band: { y: 0.915, h: 0.055, confidence: 0.8, method: 'appearance' as const },
    frameAtMs: 0,
    frames: 100,
    notes: [],
  };
  /** Subtitles under every line (the 8 quiet ones too), and 6 more at 76–88 s that no line has. */
  const onScreen = [
    ...[2000, 10_000, 62_000, 70_000, 92_000].map((t) => ({ startMs: t, endMs: t + 3000 })),
    ...Array.from({ length: 8 }, (_, i) => ({ startMs: 30_000 + i * 3500 + 100, endMs: 30_000 + i * 3500 + 2900 })),
    ...Array.from({ length: 6 }, (_, k) => ({ startMs: 76_000 + k * 2000, endMs: 77_500 + k * 2000 })),
  ].sort((a, b) => a.startMs - b.startMs);

  async function withSubtitles(settings: Partial<ProjectSettings> = {}) {
    const b = await build({
      durationMs: 100_000,
      settings: { sourceLanguage: 'zh-CN', ...settings },
      stt: sttWithQuietSpeech(),
      speechMap: regionsOf([[0, 30_000], [60_000, 100_000]]),
      sttChunkWindowMs: 30_000,
      sttChunkThresholdMs: 20_000,
    });
    const scans: unknown[] = [];
    b.deps.watermark = { detect: async () => detection };
    b.media.scanSubtitlePresence = async (_video, input, onProgress) => {
      scans.push(input);
      onProgress?.(1);
      return { fps: 5, startMs: 0, endMs: 100_000, frames: 500, framesWithText: 150, events: onScreen };
    };
    return { b, scans };
  }

  it('lines under a subtitle are never taken for silence; subtitles with no line are named', async () => {
    const { b, scans } = await withSubtitles();
    await runToStt(b);

    expect(scans).toEqual([{ band: { y: 0.915, h: 0.055 }, startMs: 0 }]);
    expect((await sourceLines(b)).filter((l) => l.startMs >= 30_000 && l.startMs < 60_000)).toHaveLength(8);
    const warnings = await warningsOf(b.project.id);
    expect(warnings.find((w) => w.code === 'stt-no-speech')).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'subtitles-without-lines', step: 'stt', params: { count: 6, seconds: 9, biggest: '1:16–1:28 (6)' } }),
    );
    expect(warnings.map((w) => w.code)).not.toContain('lines-without-subtitles');
    const report = JSON.parse(await fsp.readFile(b.paths.subtitlePresenceJson, 'utf8')) as { bandFrom: string; events: unknown[] };
    expect(report).toMatchObject({ bandFrom: 'detection', events: onScreen });
  });

  it('read once: a retry of speech-to-text uses what was read', async () => {
    const { b, scans } = await withSubtitles();
    await runToStt(b);
    await new PipelineRunner(b.deps).run(await store.getProject(b.project.id), { signal: new AbortController().signal, retryFromStep: 'stt' });
    expect(scans).toHaveLength(1);
  });

  it('off by the setting, and by default for a language that does not burn its subtitles in', async () => {
    const off = await withSubtitles({ subtitleCoverageCheck: false });
    await runToStt(off.b);
    expect(off.scans).toEqual([]);
    expect((await warningsOf(off.b.project.id)).map((w) => w.code)).toContain('stt-no-speech');

    const english = await withSubtitles({ sourceLanguage: 'en' });
    await runToStt(english.b);
    expect(english.scans).toEqual([]);
  });
});

describe("stt: the video's own subtitles as the transcript (claude-dubber A3)", () => {
  const detection = {
    at: '2026-11-25T00:00:00.000Z',
    videoWidth: 1920,
    videoHeight: 1080,
    regions: [],
    band: { y: 0.915, h: 0.055, confidence: 0.8, method: 'appearance' as const },
    frameAtMs: 0,
    frames: 100,
    notes: [],
  };
  const events = Array.from({ length: 12 }, (_, k) => ({ startMs: k * 4000 + 500, endMs: k * 4000 + 2500 }));

  async function reading(opts: { installed?: boolean; readable?: boolean; bilingual?: boolean } = {}) {
    const stt = engine(() => makeSegments([[0, 3000, '我是语音识别']]));
    const b = await build({
      durationMs: 60_000,
      settings: { sourceLanguage: 'zh-CN', useBurnedInSubtitles: true },
      stt,
      speechMap: regionsOf([[0, 60_000]]),
    });
    b.deps.watermark = { detect: async () => detection };
    b.media.scanSubtitlePresence = async () => ({ fps: 5, startMs: 0, endMs: 60_000, frames: 300, framesWithText: 120, events });
    const cuts: { timesMs: readonly number[]; outputPath: string }[] = [];
    b.media.readBandFrames = async (_video, input) => {
      cuts.push(input);
      await fsp.writeFile(input.outputPath, Buffer.alloc(input.timesMs.length * 100));
      return { width: 10, height: 10, count: input.timesMs.length, indexOf: input.timesMs.map((_, i) => i) };
    };
    let reads = 0;
    b.deps.ocr = {
      available: async () => opts.installed !== false,
      read: async (frames) => {
        reads += 1;
        return Array.from({ length: frames.count }, (_, i) => ({
          index: i,
          text: opts.readable === false ? '' : opts.bilingual ? `${said(i)} Line ${i} in English` : said(i),
          confidence: 0.95,
          lines: opts.bilingual ? 2 : 1,
          // A bilingual subtitle: the Chinese row above its English translation.
          ...(opts.bilingual ? { texts: [said(i), `Line ${i} in English`] } : {}),
        }));
      },
    };
    return { b, stt, cuts, reads: () => reads };
  }

  it('reads the subtitles instead of transcribing the speech, and only once', async () => {
    const { b, stt, cuts, reads } = await reading();
    await runToStt(b);

    expect(stt.asked).toEqual([]);
    const lines = await sourceLines(b);
    expect(lines.map((l) => l.sourceText)).toEqual(events.map((_, i) => said(i)));
    expect(lines[3]).toMatchObject({ startMs: 12_500, endMs: 14_500 });
    // One frame 40 % into each subtitle, cut into a file that is gone afterwards.
    expect(cuts[0]!.timesMs).toEqual(events.map((e) => e.startMs + 800));
    await expect(fsp.stat(cuts[0]!.outputPath)).rejects.toThrow();
    expect(await log(b)).toContain("Using the video's own subtitles (12 lines read from the picture) instead of speech-to-text.");

    await new PipelineRunner(b.deps).run(await store.getProject(b.project.id), { signal: new AbortController().signal, retryFromStep: 'stt' });
    expect(reads()).toBe(1);
    expect(stt.asked).toEqual([]);
  });

  it('keeps only the Chinese row of bilingual subtitles, and says how many were (Phong Thủy Thiên Sư, 2026-11-27)', async () => {
    const { b } = await reading({ bilingual: true });
    await runToStt(b);
    expect((await sourceLines(b)).map((l) => l.sourceText)).toEqual(events.map((_, i) => said(i)));
    expect(await log(b)).toContain('12 were bilingual: their translation row was left out.');
  });

  it('without the reader, speech-to-text transcribes, and a warning says why', async () => {
    const { b, stt } = await reading({ installed: false });
    await runToStt(b);
    expect(stt.asked.length).toBeGreaterThan(0);
    expect(await warningsOf(b.project.id)).toContainEqual(
      expect.objectContaining({ code: 'burned-in-fallback', key: 'warning.burned-in-not-installed', step: 'stt' }),
    );
  });

  it('subtitles that read as nothing are no transcript: speech-to-text, with the count', async () => {
    const { b, stt } = await reading({ readable: false });
    await runToStt(b);
    expect(stt.asked.length).toBeGreaterThan(0);
    expect(await warningsOf(b.project.id)).toContainEqual(
      expect.objectContaining({ key: 'warning.burned-in-unreadable', params: { count: 0, total: 12 } }),
    );
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

describe('stt: an advert tail (claude-dubber, 2026-11-27)', () => {
  const MIN = 60_000;
  /** Drama at 5 and 30 minutes, the advert's reader at 45 and 55. */
  const heard: SttProvider = {
    id: 'faster-whisper',
    displayName: 'fixed',
    isLocal: true,
    async transcribe(): Promise<SttResult> {
      return {
        segments: makeSegments([
          [5 * MIN, 5 * MIN + 2000, '我们走吧'],
          [30 * MIN, 30 * MIN + 2000, '你还好吗'],
          [45 * MIN, 45 * MIN + 2000, '可免费观看完整版'],
          [55 * MIN, 55 * MIN + 2000, '点击评论区蓝色链接'],
        ]),
        detectedLanguage: 'zh',
        durationMs: 60 * MIN,
      };
    },
  };
  const detection = (fromMs?: number): PictureDetection => ({
    at: '2026-11-27T10:00:00.000Z',
    videoWidth: 1920,
    videoHeight: 1080,
    regions: [],
    frameAtMs: 0,
    frames: 100,
    notes: [],
    tailChecked: true,
    ...(fromMs !== undefined ? { adTail: { fromMs, box: { x: 0.1, y: 0.6, w: 0.8, h: 0.35 }, confidence: 0.9 } } : {}),
  });
  const lines = async (b: Built) => (JSON.parse(await fsp.readFile(b.paths.sourceJson, 'utf8')) as { segments: TranscriptSegment[] }).segments;

  it('stops speech-to-text where the banner begins, keeps no line past it, and says where', async () => {
    const b = await build({ durationMs: 60 * MIN, stt: heard, sttChunkThresholdMs: 10 * 60 * MIN, settings: { sourceLanguage: 'zh' } });
    const asked: unknown[] = [];
    b.deps.watermark = { detect: async (_id, opts) => (asked.push(opts), detection(40 * MIN)) };
    await runToStt(b);
    expect((await lines(b)).map((l) => l.sourceText)).toEqual(['我们走吧', '你还好吗']);
    expect(asked[0]).toEqual({ tail: true });
    const tail = (await warningsOf(b.project.id)).find((w) => w.code === 'ad-tail');
    expect(tail).toMatchObject({ step: 'stt', key: 'warning.ad-tail-series', params: { from: '40:00', end: '1:00:00' } });
    expect(tail?.message).toContain('the series ends there');
  });

  it("stops where the advert's voice begins, when before its banner, and keeps that for the series (Săn Yêu)", async () => {
    const voiceFirst: SttProvider = {
      ...heard,
      async transcribe(): Promise<SttResult> {
        return {
          segments: makeSegments([
            [5 * MIN, 5 * MIN + 2000, '我们走吧'],
            [30 * MIN, 30 * MIN + 2000, '你还好吗'],
            // 8 s before the banner at 40:00, as "个个个点击评论区蓝色链接" was at 50:46.68 for 50:50.75.
            [40 * MIN - 8000, 40 * MIN - 4000, '个个个点击评论区蓝色链接'],
            [45 * MIN, 45 * MIN + 2000, '可免费观看完整版'],
          ]),
          detectedLanguage: 'zh',
          durationMs: 60 * MIN,
        };
      },
    };
    const b = await build({ durationMs: 60 * MIN, stt: voiceFirst, sttChunkThresholdMs: 10 * 60 * MIN, settings: { sourceLanguage: 'zh' } });
    // The detection as saved beside the project, where the series plan reads it.
    const dir = pictureDirOf(b.project);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'detection.json'), JSON.stringify(detection(40 * MIN)));
    b.deps.watermark = { detect: async () => detection(40 * MIN) };
    await runToStt(b);
    expect((await lines(b)).map((l) => l.sourceText)).toEqual(['我们走吧', '你还好吗']);
    expect((await warningsOf(b.project.id)).find((w) => w.code === 'ad-tail')).toMatchObject({ params: { from: '39:52', end: '1:00:00' } });
    expect((await savedDetection(b.project))?.adTail?.speechFromMs).toBe(40 * MIN - 8000);
    expect(await adTailFrom(await store.getProject(b.project.id))).toBe(40 * MIN - 8000);
  });

  it('dubs the whole video when told to, or when none was found, or the video is too short to have one', async () => {
    const off = await build({ durationMs: 60 * MIN, stt: heard, sttChunkThresholdMs: 10 * 60 * MIN, settings: { sourceLanguage: 'zh', stopAtAdTail: false } });
    let looked = 0;
    off.deps.watermark = { detect: async (_id, opts) => (opts?.tail && looked++, detection(40 * MIN)) };
    await runToStt(off);
    expect(await lines(off)).toHaveLength(4);
    expect(looked).toBe(0);

    const none = await build({ durationMs: 60 * MIN, stt: heard, sttChunkThresholdMs: 10 * 60 * MIN, settings: { sourceLanguage: 'zh' } });
    none.deps.watermark = { detect: async () => detection() };
    await runToStt(none);
    expect(await lines(none)).toHaveLength(4);
    expect((await warningsOf(none.project.id)).map((w) => w.code)).not.toContain('ad-tail');

    const short = await build({ durationMs: 15 * MIN, settings: { sourceLanguage: 'zh' } });
    short.deps.watermark = { detect: async (_id, opts) => (opts?.tail && looked++, detection(10 * MIN)) };
    await runToStt(short);
    expect(looked).toBe(0);
  });

  it('transcribes the whole video when the picture cannot be read', async () => {
    const b = await build({ durationMs: 60 * MIN, stt: heard, sttChunkThresholdMs: 10 * 60 * MIN, settings: { sourceLanguage: 'zh' } });
    b.deps.watermark = {
      detect: async () => {
        throw new Error('no frames');
      },
    };
    await runToStt(b);
    expect(await lines(b)).toHaveLength(4);
    expect(await log(b)).toContain('Could not look at the picture for an advert tail (no frames): transcribing the whole video.');
  });
});

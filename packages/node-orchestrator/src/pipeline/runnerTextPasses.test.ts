/**
 * The translation-quality passes driven through the REAL runner: the
 * character sheet (built, persisted, or failing loudly), per-line checks and
 * repairs with persisted quality flags, the review pass's audit trail, and the
 * measured voice pace feeding the next translation's budgets.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Project,
  TranscriptSegment,
  TranslationInput,
  TranslationProvider,
  TranslationResult,
  TtsInput,
  TtsProvider,
  TtsResult,
} from '@videodubber/shared';
import { PipelineRunner } from './runner.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { EventBusRegistry } from '../events.js';
import { ProjectLogger } from '../logging.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { robustMedian, type VoiceRateBook } from '../providers/translation/speechFit.js';
import {
  FakeMediaService,
  FakeSttProvider,
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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-textpasses-test-'));
  store = new ProjectStore(path.join(tmp, 'projects'));
  buses = new EventBusRegistry();
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Ten zh cues, one second each with a 500 ms pause (separate synthesis units). */
const SOURCE = ['昆仑墟到了', '谢谢师尊', '你干什么', '我要走了', '女娲娘娘', '长安城', '他来了', '快跑', '在', '好'];
/** What a line-by-line translator returns: three lines fail the checks. */
const DRAFT: Record<string, string> = {
  seg_0001: 'Kunlun Xu đã đến rồi',
  seg_0002: 'Cảm ơn thầy/cô',
  seg_0005: 'Nữ Th娲 nương nương',
};

function sttSegments(): TranscriptSegment[] {
  return makeSegments(SOURCE.map((text, i) => [i * 1500, i * 1500 + 1000, text]));
}

/** Context-free translator ("TranslateGemma"): records the order of calls. */
function lineByLineTranslator(events: string[], inputs: TranslationInput[]): TranslationProvider {
  return {
    id: 'llama-cpp',
    displayName: 'TranslateGemma (fake)',
    isLocal: true,
    async translateSegments(input: TranslationInput): Promise<TranslationResult> {
      events.push('translate');
      inputs.push(input);
      return {
        segments: input.segments.map((s) => ({ id: s.id, translatedText: DRAFT[s.id] ?? `Câu số ${s.id.slice(-2)} ạ` })),
      };
    },
  };
}

/** TTS: 300 ms per syllable, so every clip has a measurable pace. */
function syllableTts(): TtsProvider {
  return {
    id: 'piper-local',
    displayName: 'syllable-tts',
    isLocal: true,
    async synthesizeSegments(input: TtsInput): Promise<TtsResult> {
      const segments = await Promise.all(
        input.segments.map(async (s, i) => {
          const num = Number.parseInt(s.id.replace(/\D/g, ''), 10) || i + 1;
          const audioPath = path.join(input.outputDir, `segment_${String(num).padStart(4, '0')}.wav`);
          const durationMs = Math.max(1, s.text.trim().split(/\s+/).length) * 300;
          await fsp.mkdir(input.outputDir, { recursive: true });
          await fsp.writeFile(audioPath, String(durationMs), 'utf8');
          return { segmentId: s.id, text: s.text, audioPath, durationMs, startMs: s.startMs, endMs: s.endMs, speedRatio: 1 };
        }),
      );
      return { segments };
    },
  };
}

/** The built-in chat engine: answers analysis, repair and review prompts. */
function chatEngine(
  events: string[],
  answer: { analysis?: string; repair?: (id: string, prompt: string) => string; review?: (id: string) => string },
): TranslationProvider {
  return {
    id: 'llama-cpp-chat',
    displayName: 'Fake Gemma chat',
    isLocal: true,
    supportsRefinement: true,
    async translateSegments(): Promise<TranslationResult> {
      throw new Error('not used');
    },
    async chatComplete(_system: string | undefined, user: string): Promise<string> {
      if (user.includes('Analyze the following transcript')) {
        events.push('analysis');
        return answer.analysis ?? 'Sorry, I cannot do that.';
      }
      const ids = [...user.matchAll(/^(seg_\d{4})/gm)].map((m) => m[1]!);
      const repairing = user.includes('failed an automatic check');
      events.push(repairing ? (user.includes('A first fix of these lines still failed') ? 'repair-again' : 'repair') : 'review');
      const reply = (id: string): string => (repairing ? answer.repair?.(id, user) : answer.review?.(id)) ?? '';
      return JSON.stringify({ segments: ids.map((id) => ({ id, text: reply(id) })) });
    },
  } as TranslationProvider;
}

async function setup(settings: Parameters<typeof defaultSettings>[0], register: (r: ProviderRegistry) => void, voiceRates?: VoiceRateBook) {
  const video = await writeDummyVideo(tmp);
  const project = await store.createProject(
    createProjectInput(video, {
      settings: defaultSettings({ sourceLanguage: 'zh', targetLanguage: 'vi-VN', translationProviderId: 'llama-cpp', ...settings }),
    }),
  );
  const paths = store.paths(project.id);
  const events: string[] = [];
  const inputs: TranslationInput[] = [];
  const registry = fakeRegistry(new FakeSttProvider(sttSegments()), lineByLineTranslator(events, inputs), syllableTts());
  register(registry);
  const bus = buses.get(project.id);
  const runner = new PipelineRunner({
    store,
    media: new FakeMediaService({ mediaInfo: fakeMediaInfo(30_000) }),
    registry,
    bus,
    logger: new ProjectLogger(paths.pipelineLog, bus),
    ...(voiceRates ? { voiceRates } : {}),
  });
  return { project, paths, events, inputs, runner };
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fsp.readFile(file, 'utf8')) as T;
const segmentsOf = async (file: string): Promise<TranscriptSegment[]> =>
  (await readJson<{ segments: TranscriptSegment[] }>(file)).segments;
const run = (runner: PipelineRunner, project: Project, retryFromStep?: 'translation' | 'alignment') =>
  runner.run(project, { signal: new AbortController().signal, ...(retryFromStep ? { retryFromStep } : {}) });

describe('translation step — character sheet', () => {
  it('builds it with the context engine AFTER a line-by-line translator, persists and reports it', async () => {
    const events: string[] = [];
    const sheet = JSON.stringify({
      synopsis: 'Tiên hiệp.',
      cast: [{ name: 'Sư tôn', role: 'thầy' }],
      glossary: [
        { source: '昆仑墟', target: 'Côn Lôn Khư' },
        { source: '女娲', target: 'Nuwa' }, // pinyin: dropped
      ],
      pronounGuide: 'Đệ tử → sư tôn: xưng "con", gọi "sư tôn".',
    });
    const { project, paths, runner, events: order } = await setup({}, (r) =>
      r.registerTranslation(chatEngine(events, { analysis: sheet, repair: () => '' }) as never),
    );
    await run(runner, project);

    const saved = await readJson<{ glossary: { source: string; target: string }[] }>(paths.translationContextJson);
    expect(saved.glossary).toEqual([{ source: '昆仑墟', target: 'Côn Lôn Khư' }]);
    expect(order[0]).toBe('translate');
    expect(events[0]).toBe('analysis'); // one model swap: translator first, then the chat model
    const report = await readJson<{ characterSheet: { status: string; engine: string } }>(
      path.join(paths.subtitlesDir, 'translation_report.json'),
    );
    expect(report.characterSheet).toMatchObject({ status: 'generated', engine: 'Fake Gemma chat' });
  });

  it('fails LOUDLY when the sheet cannot be built: a warning and a failed status', async () => {
    const events: string[] = [];
    const { project, paths, runner } = await setup({}, (r) => r.registerTranslation(chatEngine(events, {}) as never));
    await run(runner, project);

    await expect(fsp.stat(paths.translationContextJson)).rejects.toThrow();
    expect(events.filter((e) => e === 'analysis')).toHaveLength(2); // full + glossary-only retry
    const log = await fsp.readFile(paths.pipelineLog, 'utf8');
    expect(log).toMatch(/WARN.*Could not build the translation character sheet with "Fake Gemma chat"/);
    const report = await readJson<{ characterSheet: { status: string; attempts: unknown[] } }>(
      path.join(paths.subtitlesDir, 'translation_report.json'),
    );
    expect(report.characterSheet.status).toBe('failed');
    expect(report.characterSheet.attempts).toHaveLength(2);
  });

  it('reports "skipped" (not failed) when no instruction-following model exists', async () => {
    const { project, paths, runner } = await setup({}, () => {});
    await run(runner, project);
    const report = await readJson<{ characterSheet: { status: string } }>(path.join(paths.subtitlesDir, 'translation_report.json'));
    expect(report.characterSheet.status).toBe('skipped');
  });
});

describe('translation step — per-line checks', () => {
  it('repairs what the context engine can fix and FLAGS the rest in translated.json', async () => {
    const events: string[] = [];
    const repairs: Record<string, string> = {
      seg_0001: 'Côn Lôn Khư đến rồi',
      seg_0002: 'Cảm ơn thầy/cô', // not better: kept + flagged
      seg_0005: 'Nữ Oa nương nương',
    };
    const { project, paths, runner } = await setup({}, (r) =>
      r.registerTranslation(chatEngine(events, { repair: (id) => repairs[id] ?? '' }) as never),
    );
    await run(runner, project);

    const segs = await segmentsOf(paths.translatedJson);
    const byId = new Map(segs.map((s) => [s.id, s]));
    expect(byId.get('seg_0001')).toMatchObject({ translatedText: 'Côn Lôn Khư đến rồi' });
    expect(byId.get('seg_0001')!.qualityFlags).toBeUndefined();
    expect(byId.get('seg_0005')!.translatedText).toBe('Nữ Oa nương nương');
    expect(byId.get('seg_0002')).toMatchObject({ translatedText: 'Cảm ơn thầy/cô', qualityFlags: ['alternatives'] });
    const report = await readJson<{ quality: { checked: number; repaired: { id: string }[]; flagged: { id: string }[] } }>(
      path.join(paths.subtitlesDir, 'translation_report.json'),
    );
    expect(report.quality.checked).toBe(10);
    expect(report.quality.repaired.map((r) => r.id)).toEqual(['seg_0001', 'seg_0005']);
    expect(report.quality.flagged.map((f) => f.id)).toEqual(['seg_0002']);
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toMatch(/WARN.*1 line\(s\) still fail the translation checks/);
  });
});

describe('before voicing — lines that still fail the checks (claude-dubber H7)', () => {
  it('tries them once more, naming the words at fault, and names what is left in a warning', async () => {
    const events: string[] = [];
    const prompts: string[] = [];
    const { project, paths, runner } = await setup({}, (r) =>
      r.registerTranslation(
        chatEngine(events, {
          repair: (id, prompt) => {
            if (!prompt.includes('A first fix of these lines still failed')) return ''; // the translation step's try fixes nothing
            prompts.push(prompt);
            if (id === 'seg_0002') return 'Cảm ơn sư phụ';
            if (id === 'seg_0001' && !prompt.includes('already tried')) return 'Kunlun Xu đến rồi'; // still pinyin
            return '';
          },
        }) as never,
      ),
    );
    await run(runner, project);

    const byId = new Map((await segmentsOf(paths.translatedJson)).map((s) => [s.id, s]));
    expect(byId.get('seg_0002')!.translatedText).toBe('Cảm ơn sư phụ');
    expect(byId.get('seg_0002')!.qualityFlags).toBeUndefined();
    expect(byId.get('seg_0001')!.qualityFlags).toEqual(['pinyin']);
    expect(byId.get('seg_0005')!.qualityFlags).toEqual(['wrong-script']);
    // A line fixed by the first request is not asked again; the second request knows what was tried.
    expect(prompts.filter((p) => /^seg_0002/m.test(p))).toHaveLength(1);
    const second = prompts.find((p) => p.includes('seg_0001') && p.includes('already tried'))!;
    expect(second).toContain('words at fault: "Kunlun"');
    expect(second).toContain('already tried, still wrong (do not repeat): Kunlun Xu đến rồi');
    expect(prompts.find((p) => p.includes('seg_0005'))).toContain('words at fault: "Th娲"');

    const report = await readJson<{ beforeVoicing: { checked: number; repaired: { id: string }[]; flagged: { id: string }[] } }>(
      path.join(paths.subtitlesDir, 'translation_report.json'),
    );
    expect(report.beforeVoicing.checked).toBe(3);
    expect(report.beforeVoicing.repaired.map((r) => r.id)).toEqual(['seg_0002']);
    expect(report.beforeVoicing.flagged.map((f) => f.id)).toEqual(['seg_0001', 'seg_0005']);
    const pipeline = await store.getPipeline(project.id);
    expect(pipeline.status).toBe('completed'); // voiced as they are: the setting is off
    expect(pipeline.warnings).toContainEqual(
      expect.objectContaining({ code: 'lines-flagged', step: 'refine', key: 'warning.lines-flagged', params: { count: 2, ids: 'seg_0001, seg_0005' } }),
    );
  });

  it('with holdFlaggedLines, stops before any voice is made; continuing voices the lines as they are', async () => {
    const events: string[] = [];
    const { project, paths, runner } = await setup({ holdFlaggedLines: true }, (r) =>
      r.registerTranslation(chatEngine(events, { repair: () => '' }) as never),
    );
    await run(runner, project);

    const held = await store.getPipeline(project.id);
    expect(held.awaitingReview).toBe(true);
    expect(held.heldLines).toEqual(['seg_0001', 'seg_0002', 'seg_0005']);
    expect(held.steps.find((s) => s.id === 'tts')!.status).toBe('pending');
    expect((await store.getProject(project.id)).status).toBe('paused');
    expect(held.warnings).toContainEqual(expect.objectContaining({ code: 'lines-flagged', key: 'warning.lines-flagged-held' }));
    expect(await fsp.readFile(paths.pipelineLog, 'utf8')).toMatch(/Stopped before voicing: 3 line\(s\) still fail/);

    await run(runner, await store.getProject(project.id));
    const after = await store.getPipeline(project.id);
    expect(after.status).toBe('completed');
    expect(after.awaitingReview).toBe(false);
    expect(after.heldLines).toBeUndefined();
  });

  it('never touches or counts a locked line or a song', async () => {
    const events: string[] = [];
    const { project, paths, runner } = await setup({ holdFlaggedLines: true, reviewBeforeSynthesis: true }, (r) =>
      r.registerTranslation(chatEngine(events, { repair: () => '' }) as never),
    );
    await run(runner, project); // paused for review (both settings)
    const lines = await segmentsOf(paths.translatedJson);
    const mine = lines.map((s) =>
      s.id === 'seg_0001' ? { ...s, locked: true } : s.id === 'seg_0002' ? { ...s, song: true } : s.id === 'seg_0005' ? { ...s, translatedText: 'Nữ Oa nương nương', locked: true } : s,
    );
    await fsp.writeFile(paths.translatedJson, JSON.stringify({ segments: mine }), 'utf8');
    events.length = 0;
    await run(runner, await store.getProject(project.id), 'alignment');
    expect(events).not.toContain('repair-again');
  });
});

describe('refine step — audit trail', () => {
  it('saves the pre-review draft and records every change with before/after (no cap)', async () => {
    const events: string[] = [];
    const { project, paths, runner } = await setup({ refineProviderId: 'llama-cpp-chat' }, (r) =>
      r.registerTranslation(
        chatEngine(events, {
          analysis: JSON.stringify({ glossary: [{ source: '昆仑墟', target: 'Côn Lôn Khư' }] }),
          repair: () => '',
          review: (id) => (id === 'seg_0003' ? 'Ngươi làm gì vậy?' : id === 'seg_0004' ? 'Ta 要 đi đây' : ''),
        }) as never,
      ),
    );
    await run(runner, project);

    const draft = await segmentsOf(path.join(paths.subtitlesDir, 'translated.draft.json'));
    expect(draft.find((s) => s.id === 'seg_0003')!.translatedText).toBe('Câu số 03 ạ');
    const final = await segmentsOf(paths.translatedJson);
    expect(final.find((s) => s.id === 'seg_0003')!.translatedText).toBe('Ngươi làm gì vậy?');
    expect(final.find((s) => s.id === 'seg_0004')!.translatedText).toBe('Câu số 04 ạ');

    const report = await readJson<{
      changed: number;
      changedIds: string[];
      changes: { id: string; before: string; after: string }[];
      rejected: { id: string; reason: string }[];
      draft: string;
    }>(paths.refineReportJson);
    expect(report.changedIds).toEqual(['seg_0003']);
    expect(report.changes).toEqual([{ id: 'seg_0003', source: '你干什么', before: 'Câu số 03 ạ', after: 'Ngươi làm gì vậy?' }]);
    expect(report.rejected).toEqual([expect.objectContaining({ id: 'seg_0004', reason: expect.stringContaining('fails line checks') })]);
    expect(report.draft).toBe('translated.draft.json');
  });
});

describe('voice pace', () => {
  it('is measured from the clips at alignment and budgets the next translation', async () => {
    const recorded = new Map<string, number[]>();
    const book: VoiceRateBook = {
      rate: async (key) => robustMedian(recorded.get(key) ?? []),
      record: async (key, rates) => {
        recorded.set(key, [...(recorded.get(key) ?? []), ...rates]);
      },
    };
    const { project, runner, inputs } = await setup({ ttsVoiceId: 'vi_VN-vais1000-medium' }, () => {}, book);
    await run(runner, project);
    // "Câu số NN ạ" = 4 syllables in a 1200 ms clip, measured on its speech:
    // the fake's 80/220 ms edges trimmed to 50/80 ms pads leave 1030 ms → 3.88/s.
    const key = 'piper-local|vi_VN-vais1000-medium|vi';
    expect(recorded.get(key)?.length).toBeGreaterThan(0);
    expect(robustMedian(recorded.get(key)!)).toBeCloseTo(3.88, 1);

    await run(runner, await store.getProject(project.id), 'translation');
    expect((inputs[1] as { speechRate?: number }).speechRate).toBeCloseTo(3.88, 1);
    // The first run had no history: Piper's engine default.
    expect((inputs[0] as { speechRate?: number }).speechRate).toBeGreaterThan(3.5);

    // A retry from alignment measures the same clips again: recorded once only.
    const before = recorded.get(key)!.length;
    await run(runner, await store.getProject(project.id), 'alignment');
    expect(recorded.get(key)!.length).toBe(before);
  });
});

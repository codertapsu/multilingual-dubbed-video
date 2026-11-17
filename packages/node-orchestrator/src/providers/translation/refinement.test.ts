import { describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import {
  buildReviewPrompt,
  copiedLine,
  detectContentMoves,
  swapsThirdPersonForYou,
  grewTooLong,
  reviewBatchKey,
  reviewTranslations,
  type ReviewChat,
} from './refinement.js';
import type { PromptSegment } from './llmTranslationProvider.js';

const seg = (id: string, sourceText: string, startMs: number, endMs: number, speakerId?: string): PromptSegment => ({
  id,
  sourceText,
  startMs,
  endMs,
  ...(speakerId ? { speakerId } : {}),
});

describe('buildReviewPrompt', () => {
  const batch = [seg('seg_0001', '你干什么', 0, 1200, 'SPEAKER_00'), seg('seg_0002', '自不量力', 1200, 2400, 'SPEAKER_01')];
  const drafts = new Map([
    ['seg_0001', 'Bạn làm gì?'],
    ['seg_0002', 'Tự lượng sức mình.'],
  ]);

  it('says who speaks each line, that the source is speech recognition, and checks meaning first', () => {
    const prompt = buildReviewPrompt('zh', 'vi', batch, drafts, 'refine', undefined, { perSecond: 3.5 });
    expect(prompt).toContain('seg_0001 (SPEAKER_00):');
    expect(prompt).toContain('WHO SPEAKS');
    expect(prompt).toContain('speech recognition');
    expect(prompt).toContain('a negation dropped or reversed');
    expect(prompt).toContain('never move words, names or meaning from one segment into another');
    expect(prompt).toMatch(/\[length: about \d+ syllables \(âm tiết\), never more than \d+\]/);
    expect(prompt).not.toContain('previous reply was not valid JSON');
  });

  it('insists on JSON on the retry', () => {
    expect(buildReviewPrompt('zh', 'vi', batch, drafts, 'refine', undefined, { insist: true })).toContain(
      'previous reply was not valid JSON',
    );
  });
});

describe('detectContentMoves', () => {
  it('catches a glossary name pulled into the neighbouring cue (audit: 0271/0272)', () => {
    const moved = detectContentMoves(
      [
        { id: 'seg_0271', sourceText: '又存有盘古大神的', draft: 'Lại còn có sức mạnh của Đại thần Bàn Cổ', reviewed: 'lại có cả sức mạnh của' },
        { id: 'seg_0272', sourceText: '混沌之力', draft: 'Sức mạnh hỗn độn.', reviewed: 'Bàn Cổ.' },
        { id: 'seg_0273', sourceText: '三界之内', draft: 'Trong tam giới.', reviewed: 'Trong tam giới.' },
      ],
      [{ source: '盘古', target: 'Bàn Cổ' }],
    );
    expect([...moved].sort()).toEqual(['seg_0271', 'seg_0272']);
  });

  it('catches three words of a neighbour draft appearing in a line that did not have them', () => {
    const moved = detectContentMoves([
      { id: 'a', sourceText: '他终于', draft: 'Cuối cùng hắn', reviewed: 'Cuối cùng hắn đã tìm ra' },
      { id: 'b', sourceText: '走出了自己的道', draft: 'đã tìm ra Đạo của riêng mình', reviewed: 'Đạo của riêng mình' },
    ]);
    expect(moved.size).toBe(2);
  });

  it('catches a number that moved', () => {
    const moved = detectContentMoves([
      { id: 'a', sourceText: '他活了', draft: 'Ông ấy đã sống', reviewed: 'Ông ấy đã sống 10000 năm' },
      { id: 'b', sourceText: '10000年', draft: '10000 năm', reviewed: 'rồi.' },
    ]);
    expect(moved.size).toBe(2);
  });

  it('leaves ordinary polishing alone (shared function words are not content)', () => {
    const moved = detectContentMoves([
      { id: 'a', sourceText: '你干什么', draft: 'Bạn làm gì?', reviewed: 'Ngươi làm gì vậy?' },
      { id: 'b', sourceText: '我要走了', draft: 'Tôi phải đi.', reviewed: 'Ta phải đi rồi.' },
    ]);
    expect(moved.size).toBe(0);
  });
});

describe('copiedLine', () => {
  const batch = [seg('seg_0036', '少废话', 0, 1000), seg('seg_0041', '谢谢师尊', 1000, 2000), seg('seg_0004', '在', 2000, 2500), seg('seg_0006', '在', 2500, 3000)];
  const drafts = new Map([
    ['seg_0036', 'Không cần nói nhiều'],
    ['seg_0041', 'Cảm ơn thầy/cô'],
    ['seg_0004', 'Có mặt!'],
    ['seg_0006', 'Ở'],
  ]);
  it("catches one line's text returned under another line's id", () => {
    expect(copiedLine(batch[1]!, 'Không cần nói nhiều.', batch, drafts)).toBe('seg_0036');
  });
  it('allows lines with the same source to share a rendering', () => {
    expect(copiedLine(batch[3]!, 'Có mặt!', batch, drafts)).toBeUndefined();
  });
});

describe('swapsThirdPersonForYou', () => {
  it('catches 他 turned into "you" (Gemma 3 4B review, 2026-11-17)', () => {
    expect(swapsThirdPersonForYou('放过他', 'Hãy tha thứ cho anh ấy.', 'Hãy tha thứ cho ngươi')).toBe(true);
    expect(swapsThirdPersonForYou('镇压他千年', 'Ngăn chặn hắn suốt ngàn năm', 'Ngăn chặn ngươi suốt ngàn năm')).toBe(true);
  });
  it('allows register changes of a real "you" and third-person rewordings', () => {
    expect(swapsThirdPersonForYou('你不过区区妖猴', 'Anh chỉ là một con quỷ nhỏ.', 'Ngươi chỉ là một con yêu hầu.')).toBe(false);
    expect(swapsThirdPersonForYou('他来了', 'Anh ấy đến rồi', 'Hắn đến rồi')).toBe(false);
    expect(swapsThirdPersonForYou('他来了', 'Anh ấy đến rồi', 'Bạn ấy đến rồi')).toBe(false);
  });
});

describe('grewTooLong', () => {
  it('refuses a review that blows through the ceiling well past the draft', () => {
    expect(grewTooLong('một hai ba bốn năm', 'một hai ba bốn năm sáu bảy tám', 'vi', 6)).toBe(true);
    expect(grewTooLong('một hai ba bốn năm', 'một hai ba bốn năm sáu', 'vi', 6)).toBe(false);
    // A draft that was already over its ceiling is not the review's fault.
    expect(grewTooLong('một hai ba bốn năm sáu bảy tám', 'một hai ba bốn năm sáu bảy tám', 'vi', 4)).toBe(false);
  });
});

describe('reviewTranslations', () => {
  const segments = [
    seg('seg_0001', '你干什么', 0, 1500, 'SPEAKER_00'),
    seg('seg_0002', '昆仑墟东北', 1500, 3500, 'SPEAKER_01'),
    seg('seg_0003', '自不量力', 3500, 5000, 'SPEAKER_00'),
  ];
  const drafts = new Map([
    ['seg_0001', 'Bạn làm gì?'],
    ['seg_0002', 'Phía đông bắc Côn Lôn Khư.'],
    ['seg_0003', 'Tự lượng sức mình.'],
  ]);

  function chat(replies: string[]): ReviewChat & { prompts: string[]; schemas: unknown[] } {
    const prompts: string[] = [];
    const schemas: unknown[] = [];
    return {
      prompts,
      schemas,
      async chatComplete(_system, user, _signal, opts) {
        prompts.push(user);
        schemas.push(opts?.jsonSchema);
        return replies.shift() ?? '';
      },
    };
  }

  it('reports progress and each finished batch, then a resumed run sends only the batches not done', async () => {
    const reply = (ids: string[], texts: Record<string, string>) =>
      JSON.stringify({ segments: ids.map((id) => ({ id, text: texts[id] ?? drafts.get(id)! })) });
    const input = { sourceLanguage: 'zh', targetLanguage: 'vi', segments, draftById: drafts, mode: 'refine' as const, skipAnalysis: true, batchSegments: 2 };

    // First run: two batches (2 + 1 lines); the second reply is unusable.
    const first = chat([reply(['seg_0001', 'seg_0002'], { seg_0001: 'Ngươi làm gì vậy?' }), 'not json', 'still not json']);
    const progress: string[] = [];
    const saved: { ids: string[]; proposals: Record<string, string> }[] = [];
    await reviewTranslations({ ...input, onProgress: (d, t) => progress.push(`${d}/${t}`), onBatch: (b) => saved.push(b) }, first);
    expect(progress).toEqual(['2/3', '3/3']);
    // Only the usable batch is saved: a resumed run asks again for the other.
    expect(saved).toEqual([expect.objectContaining({ ids: ['seg_0001', 'seg_0002'], proposals: { seg_0001: 'Ngươi làm gì vậy?' } })]);

    // Resumed: the saved batch is not sent again, and its change still counts.
    const second = chat([reply(['seg_0003'], { seg_0003: 'Không biết lượng sức mình.' })]);
    const out = await reviewTranslations(
      { ...input, resume: new Map(saved.map((b) => [reviewBatchKey(b.ids), b as never])) },
      second,
    );
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain('自不量力');
    expect(out.changes.map((c) => c.id)).toEqual(['seg_0001', 'seg_0003']);
  });

  it('applies good changes, refuses lines that fail the checks, and records before/after', async () => {
    const engine = chat([
      JSON.stringify({
        segments: [
          { id: 'seg_0001', text: 'Ngươi làm gì vậy?' },
          { id: 'seg_0002', text: 'Đông bắc Kunlun Xu.' }, // pinyin: worse than the draft
          { id: 'seg_0003', text: 'Không biết lượng sức mình.' },
        ],
      }),
    ]);
    const out = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments, draftById: drafts, mode: 'refine', skipAnalysis: true },
      engine,
    );
    expect(out.segments.map((s) => s.translatedText)).toEqual([
      'Ngươi làm gì vậy?',
      'Phía đông bắc Côn Lôn Khư.',
      'Không biết lượng sức mình.',
    ]);
    expect(out.changes).toEqual([
      { id: 'seg_0001', source: '你干什么', before: 'Bạn làm gì?', after: 'Ngươi làm gì vậy?' },
      { id: 'seg_0003', source: '自不量力', before: 'Tự lượng sức mình.', after: 'Không biết lượng sức mình.' },
    ]);
    expect(out.rejected).toEqual([
      expect.objectContaining({ id: 'seg_0002', proposed: 'Đông bắc Kunlun Xu.', reason: expect.stringContaining('pinyin') }),
    ]);
    // Constrained to exactly the batch's ids.
    expect(JSON.stringify(engine.schemas[0])).toContain('"enum":["seg_0001","seg_0002","seg_0003"]');
  });

  it('ignores punctuation-only edits (no churn, no re-synthesis)', async () => {
    const out = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments, draftById: drafts, mode: 'refine', skipAnalysis: true },
      chat([JSON.stringify({ segments: [{ id: 'seg_0001', text: 'Bạn làm gì' }, { id: 'seg_0003', text: 'Tự lượng sức mình!' }] })]),
    );
    expect(out.changedIds).toEqual([]);
  });

  it('retries a reply with no usable JSON once, then keeps the drafts and reports the batch', async () => {
    const retried = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments, draftById: drafts, mode: 'refine', skipAnalysis: true },
      chat(['I think these lines are fine.', JSON.stringify({ segments: [{ id: 'seg_0001', text: 'Ngươi làm gì?' }] })]),
    );
    expect(retried.changedIds).toEqual(['seg_0001']);
    expect(retried.failedBatches).toEqual([]);

    const failed = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments, draftById: drafts, mode: 'refine', skipAnalysis: true },
      chat(['nope', 'still nope']),
    );
    expect(failed.changedIds).toEqual([]);
    expect(failed.failedBatches).toEqual([['seg_0001', 'seg_0002', 'seg_0003']]);
  });

  it('keeps both drafts when the review moves content across cues — unless a draft is unusable', async () => {
    const pair = [seg('a', '又存有盘古大神的', 0, 1500), seg('b', '混沌之力', 1500, 2200)];
    const glossary = [{ source: '盘古', target: 'Bàn Cổ' }];
    const reply = JSON.stringify({ segments: [{ id: 'a', text: 'lại có cả sức mạnh của' }, { id: 'b', text: 'Bàn Cổ.' }] });

    const cleanDrafts = new Map([
      ['a', 'Lại còn có sức mạnh của Đại thần Bàn Cổ'],
      ['b', 'Sức mạnh hỗn độn.'],
    ]);
    const kept = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments: pair, draftById: cleanDrafts, documentContext: { glossary }, mode: 'refine' },
      chat([reply]),
    );
    expect(kept.changedIds).toEqual([]);
    expect(kept.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining('moves content'),
      expect.stringContaining('moves content'),
    ]);

    // The real 0271 draft still had Chinese in it: the moved review is the lesser evil.
    const brokenDrafts = new Map([
      ['a', 'Ngoài ra, còn có bản "盘古大神".'],
      ['b', 'Đo đạc không rõ ràng'],
    ]);
    const accepted = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments: pair, draftById: brokenDrafts, documentContext: { glossary }, mode: 'refine' },
      chat([reply]),
    );
    expect(accepted.changedIds).toEqual(['a', 'b']);
  });

  it('generates a character sheet when none was given, recording the attempts; cancellation propagates', async () => {
    const many = Array.from({ length: 8 }, (_, i) => seg(`seg_${i}`, `第${i}句到长安`, i * 1000, i * 1000 + 900));
    const drafts8 = new Map(many.map((s) => [s.id, `Câu thứ ${s.id}`]));
    const engine = chat([
      'not json', // full analysis fails
      JSON.stringify({ glossary: [{ source: '长安', target: 'Trường An' }] }), // glossary-only retry
      JSON.stringify({ segments: [] }),
      JSON.stringify({ segments: [] }),
    ]);
    const out = await reviewTranslations(
      { sourceLanguage: 'zh', targetLanguage: 'vi', segments: many, draftById: drafts8, mode: 'refine' },
      engine,
    );
    expect(out.analysis).toEqual({ glossary: [{ source: '长安', target: 'Trường An' }] });
    expect(out.analysisAttempts).toEqual([
      { mode: 'full', ok: false, error: expect.any(String) },
      { mode: 'glossary-only', ok: true },
    ]);

    const cancelling: ReviewChat = {
      chatComplete: async () => Promise.reject(new AppErrorException('CANCELLED', 'Review was cancelled.')),
    };
    await expect(
      reviewTranslations({ sourceLanguage: 'zh', targetLanguage: 'vi', segments: many, draftById: drafts8, mode: 'refine' }, cancelling),
    ).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
  });
});

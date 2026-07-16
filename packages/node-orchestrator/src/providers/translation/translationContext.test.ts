import { describe, expect, it } from 'vitest';
import {
  buildAnalysisPrompt,
  buildAnalysisSample,
  buildContextHeader,
  collectRollingPairs,
  isSceneBreak,
  parseAnalysisReply,
  planContextBatches,
} from './translationContext.js';
import {
  buildRawTranslationPrompt,
  buildTranslationPrompt,
  looksUntranslated,
  parseTranslationReply,
  recoverBatch,
  sanitizeTranslatedLine,
  speechBudget,
  type PromptSegment,
} from './llmTranslationProvider.js';

function seg(id: string, startMs: number, endMs: number, text = 'line'): PromptSegment {
  return { id, sourceText: text, startMs, endMs };
}

describe('planContextBatches', () => {
  it('never lets a batch span a scene gap', () => {
    const segs = [
      seg('seg_0001', 0, 1000),
      seg('seg_0002', 1500, 2500),
      seg('seg_0003', 20_000, 21_000), // 17.5 s silence = scene break
      seg('seg_0004', 21_500, 22_000),
    ];
    const batches = planContextBatches(segs, { maxSegments: 25, maxChars: 8000 });
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([
      ['seg_0001', 'seg_0002'],
      ['seg_0003', 'seg_0004'],
    ]);
  });

  it('still respects segment and char caps inside a scene', () => {
    const segs = Array.from({ length: 5 }, (_, i) => seg(`seg_000${i + 1}`, i * 1000, i * 1000 + 900));
    expect(planContextBatches(segs, { maxSegments: 2, maxChars: 8000 })).toHaveLength(3);
    const bigSegs = [seg('seg_0001', 0, 1000, 'x'.repeat(500)), seg('seg_0002', 1000, 2000, 'y'.repeat(500))];
    expect(planContextBatches(bigSegs, { maxSegments: 25, maxChars: 600 })).toHaveLength(2);
  });

  it('keeps every segment exactly once', () => {
    const segs = Array.from({ length: 30 }, (_, i) => seg(`seg_${String(i + 1).padStart(4, '0')}`, i * 7000, i * 7000 + 900));
    const flat = planContextBatches(segs, { maxSegments: 4, maxChars: 8000 }).flat();
    expect(flat.map((s) => s.id)).toEqual(segs.map((s) => s.id));
  });
});

describe('analysis prompt + reply', () => {
  it('asks for a Vietnamese xưng hô plan when targeting vi', () => {
    const prompt = buildAnalysisPrompt('en', 'vi-VN', 'Teacher: sit down.\nStudent: yes sir.');
    expect(prompt).toContain('xưng hô');
    expect(prompt).toContain('"pronounGuide"');
    expect(prompt).toContain('"glossary"');
  });

  it('falls back to a generic register plan for other targets', () => {
    const prompt = buildAnalysisPrompt('en', 'de', 'sample');
    expect(prompt).not.toContain('xưng hô');
    expect(prompt).toContain('T-V distinction');
  });

  it('parses a full analysis reply', () => {
    const analysis = parseAnalysisReply(
      JSON.stringify({
        synopsis: 'A chemistry lecture.',
        cast: [{ name: 'Teacher', role: 'lecturer' }, { name: 'Student' }],
        glossary: [{ source: 'benzene', target: 'benzen' }],
        pronounGuide: 'Student -> Teacher: thầy/em.',
      }),
    );
    expect(analysis?.synopsis).toContain('chemistry');
    expect(analysis?.cast).toHaveLength(2);
    expect(analysis?.glossary?.[0]).toEqual({ source: 'benzene', target: 'benzen' });
    expect(analysis?.pronounGuide).toContain('thầy');
  });

  it('returns undefined on junk and tolerates partial replies', () => {
    expect(parseAnalysisReply('no json at all')).toBeUndefined();
    expect(parseAnalysisReply('{}')).toBeUndefined();
    const partial = parseAnalysisReply('{"synopsis":"x","cast":"not-an-array"}');
    expect(partial).toEqual({ synopsis: 'x' });
  });

  it('samples beginning + middle + end of long transcripts within the cap', () => {
    const segs = Array.from({ length: 400 }, (_, i) => seg(`s${i}`, i, i + 1, `line number ${i} with some words`));
    const sample = buildAnalysisSample(segs, 3000);
    expect(sample.length).toBeLessThanOrEqual(3200);
    expect(sample).toContain('line number 0');
    expect(sample).toContain('line number 399');
    expect(sample).toContain('[...]');
  });
});

describe('context header + rolling pairs', () => {
  const analysis = {
    synopsis: 'A cooking show.',
    cast: [{ name: 'Host', role: 'chef' }],
    glossary: [{ source: 'whisk', target: 'phới lồng' }],
    pronounGuide: 'Host -> audience: các bạn.',
  };

  it('renders analysis + previous pairs and marks scene breaks', () => {
    const header = buildContextHeader({
      analysis,
      previousPairs: [{ source: 'Hello.', target: 'Xin chào.' }],
      sceneBreak: true,
    });
    expect(header).toContain('Synopsis: A cooking show.');
    expect(header).toContain('Host (chef)');
    expect(header).toContain('"whisk" -> "phới lồng"');
    expect(header).toContain('các bạn');
    expect(header).toContain('"Hello." -> "Xin chào."');
    expect(header).toContain('scene change');
    expect(header).toContain('do NOT translate');
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(buildContextHeader({})).toBe('');
  });

  it('collects the last N translated pairs, skipping missing ids', () => {
    const batch = Array.from({ length: 8 }, (_, i) => seg(`seg_${i}`, i * 1000, i * 1000 + 900, `src ${i}`));
    const byId = new Map(batch.slice(0, 7).map((s) => [s.id, `tgt ${s.id}`]));
    const pairs = collectRollingPairs(batch, byId, 5);
    expect(pairs).toHaveLength(5);
    expect(pairs[4]).toEqual({ source: 'src 6', target: 'tgt seg_6' });
  });

  it('detects a scene break between batches', () => {
    const a = [seg('seg_0001', 0, 1000)];
    const b = [seg('seg_0002', 10_000, 11_000)];
    const c = [seg('seg_0003', 1200, 2000)];
    expect(isSceneBreak(a, b)).toBe(true);
    expect(isSceneBreak(a, c)).toBe(false);
    expect(isSceneBreak(undefined, b)).toBe(false);
  });
});

describe('speech budgets (duration-aware, target-language units)', () => {
  it('uses syllables for Vietnamese (whitespace-countable)', () => {
    expect(speechBudget('vi-VN', 0, 3000)).toEqual({ amount: 14, unit: 'syllables' });
  });
  it('uses characters for Chinese and words elsewhere', () => {
    expect(speechBudget('zh', 0, 3000)).toEqual({ amount: 13, unit: 'characters' });
    expect(speechBudget('en-US', 0, 3000)).toEqual({ amount: 8, unit: 'words' });
  });
  it('returns undefined without timing', () => {
    expect(speechBudget('vi')).toBeUndefined();
  });

  it('surfaces the syllable budget in both prompt styles for vi', () => {
    const batch = buildTranslationPrompt('en', 'vi', [seg('seg_0001', 0, 3000, 'Hello there my friend')]);
    expect(batch).toContain('target 14 syllables (âm tiết) or fewer');
    const raw = buildRawTranslationPrompt('en', 'vi', seg('seg_0001', 0, 3000, 'Hello there my friend'));
    expect(raw).toContain('14 syllables (âm tiết) or fewer');
  });

  it('prepends the context block before the rules', () => {
    const prompt = buildTranslationPrompt('en', 'vi', [seg('seg_0001', 0, 1000)], 'Context (do NOT translate this block; use it for consistency):\nSynopsis: test\n');
    expect(prompt.indexOf('Synopsis: test')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Synopsis: test')).toBeLessThan(prompt.indexOf('Rules:'));
    expect(prompt).toContain('xưng hô');
  });

  it('hardens against source echoes + annotation leakage; insist mode adds the directive', () => {
    const prompt = buildTranslationPrompt('zh', 'vi', [seg('seg_0001', 0, 1000)]);
    expect(prompt).toContain('never return a line unchanged');
    expect(prompt).toContain('Sino-Vietnamese');
    expect(prompt).toContain('Never copy the bracketed timing hints');
    expect(prompt).not.toContain('previous attempt');
    const insist = buildTranslationPrompt('zh', 'vi', [seg('seg_0001', 0, 1000)], undefined, { insist: true });
    expect(insist).toContain('previous attempt left some of these segments untranslated');
  });
});

describe('sanitizeTranslatedLine', () => {
  it('strips a trailing bracketed duplicate of the line (prompt-format mimicry)', () => {
    expect(sanitizeTranslatedLine('Hôm nay đến Linh Sơn. [Hôm nay đến Linh Sơn.]')).toBe('Hôm nay đến Linh Sơn.');
    expect(sanitizeTranslatedLine('Chỉ làm ba việc. (Chỉ làm ba việc)')).toBe('Chỉ làm ba việc.');
  });

  it('strips trailing budget-hint echoes (possibly stacked)', () => {
    expect(sanitizeTranslatedLine('Thầy ở đây! (4 syllables)')).toBe('Thầy ở đây!');
    expect(sanitizeTranslatedLine('Xin thầy cho con bái vọng. [target 6 âm tiết or fewer]')).toBe(
      'Xin thầy cho con bái vọng.',
    );
    expect(sanitizeTranslatedLine('Đi thôi. (Đi thôi) [spoken window: 2.5s; target 11 syllables]')).toBe('Đi thôi.');
  });

  it('strips seg-id echoes and whole-line quote wrappers', () => {
    expect(sanitizeTranslatedLine('seg_0001: Xin chào.')).toBe('Xin chào.');
    expect(sanitizeTranslatedLine('"Xin chào."')).toBe('Xin chào.');
    expect(sanitizeTranslatedLine('「こんにちは」')).toBe('こんにちは');
  });

  it('preserves legitimate brackets and clean lines', () => {
    expect(sanitizeTranslatedLine('Anh ấy nói (rất nhỏ) rồi đi.')).toBe('Anh ấy nói (rất nhỏ) rồi đi.');
    expect(sanitizeTranslatedLine('Điều 3 (khoản 2) được sửa đổi.')).toBe('Điều 3 (khoản 2) được sửa đổi.');
    expect(sanitizeTranslatedLine('[âm nhạc]')).toBe('[âm nhạc]');
    expect(sanitizeTranslatedLine('Xin chào.')).toBe('Xin chào.');
  });

  it('preserves Vietnamese digit-leading parentheticals (review finding: ASCII \\b)', () => {
    expect(sanitizeTranslatedLine('Đọc cho tôi (2 số cuối)')).toBe('Đọc cho tôi (2 số cuối)');
    expect(sanitizeTranslatedLine('Anh ấy trồng lúa (5 sào ruộng)')).toBe('Anh ấy trồng lúa (5 sào ruộng)');
    expect(sanitizeTranslatedLine('Nói đi (2 từ thôi)')).toBe('Nói đi (2 từ thôi)');
    expect(sanitizeTranslatedLine('It was a hit song (1980s)')).toBe('It was a hit song (1980s)');
    // The decimal seconds form IS a hint echo and still strips.
    expect(sanitizeTranslatedLine('Đi thôi. (2.5s)')).toBe('Đi thôi.');
  });

  it('strips the REAL zh→vi hint (nested parens: "syllables (âm tiết)")', () => {
    expect(
      sanitizeTranslatedLine('Anh ấy đến rồi. [spoken window: 2.5s; target 11 syllables (âm tiết) or fewer]'),
    ).toBe('Anh ấy đến rồi.');
  });

  it('empties annotation-only lines so recovery treats them as unresolved', () => {
    expect(sanitizeTranslatedLine('(4 âm tiết)')).toBe('');
    expect(sanitizeTranslatedLine('[spoken window: 2.5s; target 4 syllables]')).toBe('');
    expect(sanitizeTranslatedLine('seg_0012: (4 âm tiết)')).toBe('');
  });

  it('keeps elision apostrophes (no straight-single-quote unwrapping)', () => {
    expect(sanitizeTranslatedLine("'Cause we keep on runnin'")).toBe("'Cause we keep on runnin'");
  });

  it('cleans compound artifacts to a fixpoint', () => {
    expect(sanitizeTranslatedLine('"seg_0001: Xin chào."')).toBe('Xin chào.');
    expect(sanitizeTranslatedLine('"Xin chào." (xin chào)')).toBe('Xin chào.');
  });

  it('is applied by parseTranslationReply', () => {
    const map = parseTranslationReply(
      '{"segments":[{"id":"seg_0001","text":"Xin chào. [Xin chào.]"},{"id":"seg_0002","text":"Tốt. (2 syllables)"}]}',
    );
    expect(map.get('seg_0001')).toBe('Xin chào.');
    expect(map.get('seg_0002')).toBe('Tốt.');
  });
});

describe('looksUntranslated + recoverBatch', () => {
  const zh = (id: string, text: string): PromptSegment => ({ id, sourceText: text, startMs: 0, endMs: 2000 });

  it('flags missing/empty/source-echo lines but tolerates trivial identical lines', () => {
    const s = zh('seg_0001', '你真以为我是吃干饭的吗');
    expect(looksUntranslated(s, undefined)).toBe(true);
    expect(looksUntranslated(s, '  ')).toBe(true);
    expect(looksUntranslated(s, '你真以为我是吃干饭的吗')).toBe(true);
    expect(looksUntranslated(s, 'Ngươi tưởng ta ăn không ngồi rồi à?')).toBe(false);
    expect(looksUntranslated(zh('seg_0002', '3'), '3')).toBe(false); // trivial: legitimately identical
  });

  it('CJK echoes always flag; short Latin identical lines never do (review findings 5/6/13)', () => {
    // Even a 2-char CJK line can't be spoken by a vi voice.
    expect(looksUntranslated(zh('a', '小鹰'), '小鹰')).toBe(true);
    // Legitimately-identical Latin/numeric lines stay accepted.
    for (const t of ['OK?', '2023', 'Anna!', 'iPhone 15', 'No, no, no!', 'Wi-Fi?']) {
      expect(looksUntranslated(zh('b', t), t)).toBe(false);
    }
    // A substantial Latin sentence echoed back IS a failure.
    const long = 'I have been waiting here all day long';
    expect(looksUntranslated(zh('c', long), long)).toBe(true);
  });

  it('recovers via the retry rung, then the per-line raw rung', async () => {
    const batch = [zh('seg_0001', '白子'), zh('seg_0002', '真经'), zh('seg_0003', '小鹰')];
    // Initial parse got seg_0001 only, as a source echo -> ALL three unresolved.
    const byId = new Map<string, string>([['seg_0001', '白子']]);
    const calls: string[] = [];
    const out = await recoverBatch(
      batch,
      byId,
      {
        sendBatch: async (segs, insist) => {
          calls.push(`batch:${segs.map((s) => s.id).join(',')}:${insist}`);
          // Retry resolves only seg_0001.
          return '{"segments":[{"id":"seg_0001","text":"Bạch Tử"}]}';
        },
        sendSingle: async (s) => {
          calls.push(`single:${s.id}`);
          return s.id === 'seg_0002' ? 'Chân Kinh' : '小鹰'; // seg_0003 echoes again
        },
      },
      true,
    );
    expect(calls[0]).toBe('batch:seg_0001,seg_0002,seg_0003:true');
    expect(calls).toContain('single:seg_0002');
    expect(calls).toContain('single:seg_0003');
    expect(out.get('seg_0001')).toBe('Bạch Tử');
    expect(out.get('seg_0002')).toBe('Chân Kinh');
    // seg_0003's single reply was ANOTHER echo — rejected, left for the
    // caller's source fallback + the runner's untranslated warning.
    expect(out.get('seg_0003')).toBeUndefined();
  });

  it('does nothing when every line resolved', async () => {
    const batch = [zh('seg_0001', '你好')];
    const byId = new Map([['seg_0001', 'Xin chào']]);
    const out = await recoverBatch(batch, byId, { sendBatch: async () => { throw new Error('must not be called'); } }, true);
    expect(out.get('seg_0001')).toBe('Xin chào');
  });

  it('survives a throwing retry (keeps earlier results)', async () => {
    const batch = [zh('seg_0001', '你好'), zh('seg_0002', '再见')];
    const byId = new Map([['seg_0001', 'Xin chào']]);
    const out = await recoverBatch(
      batch,
      byId,
      {
        sendBatch: async () => { throw new Error('engine died'); },
        sendSingle: async () => 'Tạm biệt',
      },
      true,
    );
    expect(out.get('seg_0001')).toBe('Xin chào');
    expect(out.get('seg_0002')).toBe('Tạm biệt');
  });

  it('rethrows cancellation instead of degrading into fallbacks (review finding 8/14)', async () => {
    const batch = [zh('seg_0001', '你好'), zh('seg_0002', '再见')];
    const singles: string[] = [];
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      recoverBatch(
        batch,
        new Map(),
        {
          sendBatch: async () => { throw abortError; },
          sendSingle: async (s) => { singles.push(s.id); return 'x'; },
        },
        true,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Rung 3 never fired doomed requests after the abort.
    expect(singles).toHaveLength(0);

    // An already-aborted signal stops rung 3 between lines too.
    const controller = new AbortController();
    controller.abort();
    await expect(
      recoverBatch(batch, new Map(), { sendBatch: async () => '{"segments":[]}', sendSingle: async () => 'x' }, true, controller.signal),
    ).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
  });

  it('drops unresolved echo entries so they cannot poison rolling context (review finding 9/10)', async () => {
    const batch = [zh('seg_0001', '你好吗')];
    // Initial reply: a cosmetic-delta echo ('你好吗。') — rejected, then both
    // rungs keep echoing.
    const byId = new Map([['seg_0001', '你好吗。']]);
    const out = await recoverBatch(
      batch,
      byId,
      { sendBatch: async () => '{"segments":[]}', sendSingle: async () => '你好吗' },
      true,
    );
    expect(out.has('seg_0001')).toBe(false);
  });
});

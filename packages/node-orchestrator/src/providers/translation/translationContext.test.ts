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
});

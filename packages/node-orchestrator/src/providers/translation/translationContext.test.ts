import { describe, expect, it } from 'vitest';
import { AppErrorException } from '@videodubber/shared';
import {
  analysisJsonSchema,
  buildAnalysisPrompt,
  buildAnalysisSample,
  buildAnalysisTranscript,
  buildContextHeader,
  collectRollingPairs,
  estimateTokens,
  generateCharacterSheet,
  GLOSSARY_JSON_SCHEMA,
  isHanVietReadingShaped,
  isSceneBreak,
  parseAnalysisReply,
  planContextBatches,
  recurringTerms,
  type AnalysisChat,
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

describe('character sheet (analysis) — constrained, whole-transcript, retried, loud', () => {
  it('estimates tokens on the safe side of what Gemma measured (zh 0.79/char, vi 0.37/char)', () => {
    expect(estimateTokens('昆仑墟东北')).toBe(5);
    expect(estimateTokens('Đông bắc Côn Lôn Khư.')).toBe(Math.ceil(21 * 0.4));
  });

  it('sends the WHOLE transcript when it fits, with speaker tags', () => {
    const segs = [
      { id: 'a', sourceText: '师父，我们去哪', speakerId: 'SPEAKER_01' },
      { id: 'b', sourceText: '长安', speakerId: 'SPEAKER_00' },
    ];
    expect(buildAnalysisTranscript(segs, 5000)).toBe('SPEAKER_01: 师父，我们去哪\nSPEAKER_00: 长安');
  });

  it('samples whole lines from beginning, middle and end when it does not fit', () => {
    const segs = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, sourceText: `第${i}句话在这里` }));
    const sample = buildAnalysisTranscript(segs, 300);
    expect(estimateTokens(sample)).toBeLessThanOrEqual(320);
    expect(sample).toContain('第0句话在这里');
    expect(sample).toContain('第299句话在这里');
    expect(sample).toContain('[...]');
    expect(sample.split('\n').every((l) => l === '[...]' || /^第\d+句话在这里$/.test(l))).toBe(true);
  });

  it('asks for Hán-Việt names (never pinyin) and per-speaker-pair xưng hô for zh→vi', () => {
    const prompt = buildAnalysisPrompt('zh', 'vi-VN', 'SPEAKER_00: 师父');
    expect(prompt).toContain('Hán-Việt');
    expect(prompt).toContain('NEVER pinyin');
    expect(prompt).toContain('PER SPEAKER PAIR');
    expect(prompt).toContain('ta/ngươi');
    expect(prompt).toContain('Analyze the following transcript');
    // Mentioned only when the transcript has labels (4B invented SPEAKER_00..04 otherwise).
    expect(prompt).toContain('Speaker labels like SPEAKER_00');
    expect(buildAnalysisPrompt('zh', 'vi-VN', '师父')).not.toContain('Speaker labels');
    const glossaryOnly = buildAnalysisPrompt('zh', 'vi', 'x', { glossaryOnly: true });
    expect(glossaryOnly).toContain('"glossary"');
    expect(glossaryOnly).not.toContain('"pronounGuide"');
  });

  it('drops glossary entries the voice could not say (pinyin, Chinese, untranslated)', () => {
    const reply = JSON.stringify({
      glossary: [
        { source: '昆仑墟', target: 'Côn Lôn Khư' },
        { source: '女娲', target: 'Nuwa' },
        { source: '盘古', target: '盘古' },
        { source: '鸿蒙', target: 'Hồng Mông' },
        { source: '鸿蒙', target: 'Hồng Mông (duplicate)' },
      ],
    });
    expect(parseAnalysisReply(reply, { sourceLanguage: 'zh', targetLanguage: 'vi' })?.glossary).toEqual([
      { source: '昆仑墟', target: 'Côn Lôn Khư' },
      { source: '鸿蒙', target: 'Hồng Mông' },
    ]);
  });

  it('keeps only glossary names that occur in the transcript (Gemma 3 4B listed the prompt examples)', () => {
    const reply = JSON.stringify({
      glossary: [
        { source: '唐三藏', target: 'Đường Tam Tạng' }, // never said in this video
        { source: '西方教', target: 'Tây Phương Giáo' },
      ],
    });
    expect(parseAnalysisReply(reply, { sourceLanguage: 'zh', targetLanguage: 'vi' }, '你们西方教\n乃西方教之地')?.glossary).toEqual([
      { source: '西方教', target: 'Tây Phương Giáo' },
    ]);
  });

  it('renders structured address pairs into the editable guide and drops CJK cast names for a vi dub', () => {
    const reply = JSON.stringify({
      cast: [{ name: '臭猴子 (臭猴子)', role: 'Monkey' }, { name: 'Tôn Ngộ Không (孙悟空)', role: 'hero' }],
      pronounGuide: [
        { speaker: 'Tôn Ngộ Không', listener: 'Thiên binh', self: 'lão Tôn', address: 'các ngươi' },
        { speaker: '', listener: 'x', self: 'a', address: 'b' },
        { speaker: 'Tôn Ngộ Không', listener: 'Sư tôn', self: '猴子', address: 'thầy' }, // Chinese term: dropped
        { speaker: 'Hou Zi', listener: 'Zhu Que', self: 'ta', address: 'ngươi' }, // pinyin names: dropped
      ],
    });
    const out = parseAnalysisReply(reply, { sourceLanguage: 'zh', targetLanguage: 'vi' });
    expect(out?.cast).toEqual([{ name: 'Tôn Ngộ Không (孙悟空)', role: 'hero' }]);
    expect(out?.pronounGuide).toBe('Tôn Ngộ Không → Thiên binh: xưng "lão Tôn", gọi "các ngươi"');
  });

  it('drops "ordinary word" entries and name-styled targets that cannot be a Hán-Việt reading', () => {
    const reply = JSON.stringify({
      glossary: [
        { source: '西方教', kind: 'group', target: 'Tây Phương Giáo' },
        { source: '现在', kind: 'ordinary word', target: 'Hiện tại' },
        { source: '我天庭', kind: 'place', target: 'Thiên Đàng của ta' }, // 3 characters, 4 syllables
        { source: '镇压', kind: 'technique', target: 'bế quan' }, // lowercase: an ordinary word (and wrong)
      ],
    });
    expect(parseAnalysisReply(reply, { sourceLanguage: 'zh', targetLanguage: 'vi' })?.glossary).toEqual([
      { source: '西方教', target: 'Tây Phương Giáo' },
    ]);
    expect(isHanVietReadingShaped('之力', 'Lực lượng của nó', { sourceLanguage: 'zh', targetLanguage: 'vi' })).toBe(false);
    expect(isHanVietReadingShaped('之力', 'Lực lượng của nó', { sourceLanguage: 'en', targetLanguage: 'vi' })).toBe(true);
  });

  it('extracts recurring terms, preferring the full name over its parts and skipping grammar', () => {
    const lines = ['乃西方教之地', '天庭已向西方教宣战', '西方教的手', '你们西方教', '我们什么', '我们什么', '我们什么'].map(
      (sourceText) => ({ sourceText }),
    );
    const terms = recurringTerms(lines);
    expect(terms[0]).toEqual({ term: '西方教', count: 4 });
    expect(terms.map((t) => t.term)).not.toContain('西方');
    expect(terms.map((t) => t.term)).not.toContain('我们什么');
  });

  /** A chat that returns `replies` in order and records each request's schema. */
  function chat(replies: (string | Error)[], contextTokens?: number): AnalysisChat & { calls: { user: string; schema?: unknown }[] } {
    const calls: { user: string; schema?: unknown }[] = [];
    return {
      calls,
      ...(contextTokens ? { contextTokens } : {}),
      async chatComplete(_system, user, _signal, opts) {
        calls.push({ user, schema: opts?.jsonSchema });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next ?? '';
      },
    };
  }

  const input = {
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    segments: [{ id: 'a', sourceText: '师父，长安到了' }],
  };

  it('constrains the reply with the sheet schema and returns the sheet', async () => {
    const engine = chat([JSON.stringify({ synopsis: 'Đường đi thỉnh kinh.', cast: [], glossary: [], pronounGuide: 'x' })]);
    const out = await generateCharacterSheet(engine, input);
    expect(out.analysis?.synopsis).toBe('Đường đi thỉnh kinh.');
    expect(out.attempts).toEqual([{ mode: 'full', ok: true }]);
    expect(engine.calls[0]!.schema).toEqual(analysisJsonSchema('vi'));
  });

  it('retries ONCE with the glossary-only request, then reports both failures without throwing', async () => {
    const engine = chat([new Error('llama-server returned HTTP 500'), JSON.stringify({ glossary: [{ source: '长安', target: 'Trường An' }] })]);
    const ok = await generateCharacterSheet(engine, input);
    expect(ok.analysis).toEqual({ glossary: [{ source: '长安', target: 'Trường An' }] });
    expect(engine.calls[1]!.schema).toBe(GLOSSARY_JSON_SCHEMA);
    expect(ok.attempts).toEqual([
      { mode: 'full', ok: false, error: 'llama-server returned HTTP 500' },
      { mode: 'glossary-only', ok: true },
    ]);

    const failed = await generateCharacterSheet(chat(['prose, no json', '{"glossary":[]}']), input);
    expect(failed.analysis).toBeUndefined();
    expect(failed.attempts.map((a) => a.ok)).toEqual([false, false]);
  });

  it('asks who each speaker is and prefers the source\'s own spellings (《反相之地》, F1/F2)', () => {
    const prompt = buildAnalysisPrompt('zh', 'vi-VN', 'SPEAKER_02: 潘博文是我哥', { hints: ['File: 反相之地 07', 'Project: 反相之地'] });
    expect(prompt).toContain('The source as people named it');
    expect(prompt).toContain('  File: 反相之地 07');
    expect(prompt).toContain('"speakerId": the label of THAT character\'s own lines');
    expect(buildAnalysisPrompt('zh', 'vi-VN', '潘博文是我哥')).not.toContain('"speakerId"');
    const schema = analysisJsonSchema('vi') as { properties: { cast: { items: { properties: Record<string, unknown> } } } };
    expect(schema.properties.cast.items.properties).toHaveProperty('speakerId');
    const parsed = parseAnalysisReply(
      JSON.stringify({ cast: [{ name: 'Phan Bác Nhã (潘博雅)', role: 'em', speakerId: 'SPEAKER_02' }, { name: 'A Cẩu (阿狗)', role: 'bạn', speakerId: 'speaker two' }] }),
      { sourceLanguage: 'zh', targetLanguage: 'vi' },
    );
    expect(parsed?.cast).toEqual([
      { name: 'Phan Bác Nhã (潘博雅)', role: 'em', speakerId: 'SPEAKER_02' },
      { name: 'A Cẩu (阿狗)', role: 'bạn' },
    ]);
  });

  it('tries the whole sheet once more on half the transcript before names alone (no pronoun plan without it)', async () => {
    const long = { ...input, segments: Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, sourceText: `这是第${i}句很长的台词` })) };
    const engine = chat([new Error('timed out'), JSON.stringify({ synopsis: 'x', cast: [], glossary: [], pronounGuide: 'y' })], 8192);
    const out = await generateCharacterSheet(engine, long);
    expect(out.attempts.map((a) => a.mode)).toEqual(['full', 'full-short']);
    expect(out.analysis?.pronounGuide).toBe('y');
    expect(engine.calls[1]!.user.length).toBeLessThan(engine.calls[0]!.user.length);
  });

  it('propagates cancellation instead of retrying', async () => {
    const engine = chat([new AppErrorException('CANCELLED', 'cancelled')]);
    await expect(generateCharacterSheet(engine, input)).rejects.toMatchObject({ appError: { code: 'CANCELLED' } });
    expect(engine.calls).toHaveLength(1);
  });

  it('sizes the transcript to the engine context window', async () => {
    const long = { ...input, segments: Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, sourceText: `这是第${i}句很长的台词` })) };
    const engine = chat(['{}', '{}'], 8192);
    await generateCharacterSheet(engine, long);
    expect(engine.calls[0]!.user).toContain('[...]');
    const big = chat(['{}', '{}'], 200_000);
    await generateCharacterSheet(big, long);
    expect(big.calls[0]!.user).not.toContain('[...]');
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

  it('asks for a length RANGE in both prompt styles for vi, not "shorter is better"', () => {
    // "A firm ceiling — shorter is BETTER" made models cut meaning on lines
    // that had room (此乃上古至高道术 → "Đạo thuật thượng cổ.", dropping 至高).
    const batch = buildTranslationPrompt('en', 'vi', [seg('seg_0001', 0, 3000, 'Hello there my friend')]);
    expect(batch).toContain('length: about 14 syllables (âm tiết), never more than 16');
    expect(batch).toContain('keeping the FULL meaning');
    expect(batch).not.toMatch(/shorter is BETTER|or fewer/);
    const raw = buildRawTranslationPrompt('en', 'vi', seg('seg_0001', 0, 3000, 'Hello there my friend'));
    expect(raw).toContain('Aim for about 14 syllables (âm tiết), never more than 16');
    expect(raw).toContain('keep the full meaning');
  });

  it('budgets with the voice rate and the pause after the cue when given', () => {
    // VieNeu speaks ~3.5 syllables/s; the 600 ms pause before the next line
    // adds 450 ms (150 ms is kept as a breath).
    const prompt = buildTranslationPrompt(
      'zh',
      'vi',
      [{ ...seg('seg_0001', 0, 3000, '此乃上古至高道术'), fitMs: 3450 }],
      undefined,
      { perSecond: 3.5 },
    );
    expect(prompt).toContain('[spoken window: 3.5s; length: about 12 syllables (âm tiết), never more than 14]');
  });

  it('the plain raw prompt is exactly the trained TranslateGemma template (no dubbing sentence)', () => {
    const raw = buildRawTranslationPrompt('zh', 'vi', seg('seg_0001', 0, 3000, '你好'), { plain: true });
    expect(raw).not.toContain('Aim for');
    expect(raw).toContain('without any additional explanations or commentary. Please translate the following Chinese text into Vietnamese:\n\n\n你好');
  });

  it('prepends the context block before the rules', () => {
    const prompt = buildTranslationPrompt('en', 'vi', [seg('seg_0001', 0, 1000)], 'Context (do NOT translate this block; use it for consistency):\nSynopsis: test\n');
    expect(prompt.indexOf('Synopsis: test')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Synopsis: test')).toBeLessThan(prompt.indexOf('Rules:'));
    expect(prompt).toContain('xưng hô');
  });

  it('tags each line with its diarized speaker and explains the tag', () => {
    // Who is speaking is what decides Vietnamese xưng hô. The STT step computes
    // speakerIds (WhisperX diarization) and the prompt used to ignore them, so a
    // two-person dialogue read as one voice talking to itself.
    const prompt = buildTranslationPrompt('en', 'vi', [
      { ...seg('seg_0001', 0, 1000, 'Good morning, teacher.'), speakerId: 'SPEAKER_00' },
      { ...seg('seg_0002', 1000, 2000, 'Good morning.'), speakerId: 'SPEAKER_01' },
    ]);
    expect(prompt).toContain('seg_0001 (SPEAKER_00): Good morning, teacher.');
    expect(prompt).toContain('seg_0002 (SPEAKER_01): Good morning.');
    expect(prompt).toContain('is WHO SPEAKS that line');
    expect(prompt).toContain('Never write the speaker tag into the translated text');
  });

  it('says nothing about speakers when the run was not diarized', () => {
    const prompt = buildTranslationPrompt('en', 'vi', [seg('seg_0001', 0, 1000, 'Hello')]);
    expect(prompt).toContain('seg_0001: Hello');
    expect(prompt).not.toContain('WHO SPEAKS');
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

  it('strips tone-stripped romanization echoes and dangling quotes (Gemma 3 4B review, 2026-11)', () => {
    expect(sanitizeTranslatedLine('Ở (O)')).toBe('Ở');
    expect(sanitizeTranslatedLine('Thượng tướng Trần Phượng ở đâu? (Thượng tướng Trần Phượng o dau?)')).toBe(
      'Thượng tướng Trần Phượng ở đâu?',
    );
    expect(sanitizeTranslatedLine('Kết thúc “')).toBe('Kết thúc');
    expect(sanitizeTranslatedLine('Ấn khắc “Đại Quang” “')).toBe('Ấn khắc “Đại Quang”');
    // A real parenthetical and balanced quotes stay.
    expect(sanitizeTranslatedLine('Anh ta nói "đi" rồi.')).toBe('Anh ta nói "đi" rồi.');
    expect(sanitizeTranslatedLine('Đọc cho tôi (2 số cuối)')).toBe('Đọc cho tôi (2 số cuối)');
  });

  it('strips the range hint when a model echoes it (new "length:" wording)', () => {
    expect(sanitizeTranslatedLine('Hiện tại, sư phụ nên giúp đỡ đồ nhi này. [length: about 11 syllables (âm tiết), never more than 13]')).toBe(
      'Hiện tại, sư phụ nên giúp đỡ đồ nhi này.',
    );
    expect(sanitizeTranslatedLine('Đi thôi. (about 4 syllables)')).toBe('Đi thôi.');
    // The pronoun plan's notation, and a stray token after the sentence (Gemma 3 4B review).
    expect(sanitizeTranslatedLine("Thiên giới. (xưng 'bạn')")).toBe('Thiên giới.');
    expect(sanitizeTranslatedLine('Khi đó, bạn không còn là đối thủ của tôi nữa. k')).toBe(
      'Khi đó, bạn không còn là đối thủ của tôi nữa.',
    );
    expect(sanitizeTranslatedLine('Gọi cho anh (gọi điện) nhé')).toBe('Gọi cho anh (gọi điện) nhé');
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

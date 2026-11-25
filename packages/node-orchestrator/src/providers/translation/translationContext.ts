/**
 * Document-level context for LLM subtitle translation.
 *
 * Translating cues in isolation produces discourse errors — most damagingly in
 * Vietnamese, where every "you"/"I" must be rendered as a relationship-specific
 * pair of address terms (xưng hô: thầy/cô–em, anh/chị–em, bạn/cậu–tớ, bố/mẹ–con…)
 * that a single line cannot determine. Research is equally clear that just
 * dumping neighbouring lines into the prompt is NOT enough (models largely
 * ignore raw context for pronoun repair): what works is STRUCTURED context —
 * an explicit synopsis/cast/pronoun map plus a short window of already-translated
 * lines (Karpinska & Iyyer 2023; Koneru et al., NAACL 2024; DelTA, ICLR 2025).
 *
 * This module provides the pure pieces:
 *   - {@link planContextBatches}: scene-aware batching (batches never span a
 *     long silence — the natural discourse boundary in subtitles).
 *   - {@link buildAnalysisPrompt} / {@link parseAnalysisReply}: a one-shot
 *     transcript analysis producing a synopsis, cast list, glossary, and
 *     target-language pronoun/address guide (the "character sheet").
 *   - {@link generateCharacterSheet}: drives that analysis with constrained
 *     JSON, a reduced retry, and an attempt log for loud failure reporting.
 *   - {@link buildContextHeader}: renders analysis + rolling context into the
 *     block prepended to each batch prompt.
 *
 * Used by both the cloud LLM provider and the local chat-LLM path. The
 * raw-segment TranslateGemma path CANNOT use any of this: its trained template
 * accepts exactly one source text and treats everything else as text to
 * translate (officially confirmed — no instructions, no glossaries, 2K context).
 */
import { AppErrorException, type TranslationDocContext } from '@videodubber/shared';
import { extractJsonObject } from '../cloud/cloudHttp.js';
import type { ChatOptions, PromptSegment } from './llmTranslationProvider.js';
import { checkDubLine, wrongScripts } from './lineQuality.js';

/** Kill-switch: VD_TRANSLATION_CONTEXT=off disables analysis + context headers. */
export function translationContextEnabled(): boolean {
  const raw = process.env.VD_TRANSLATION_CONTEXT?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/** A gap this long between cues starts a new scene (discourse boundary). */
export const SCENE_GAP_MS = 6_000;

/** Skip the analysis pass for tiny jobs (a few lines carry their own context). */
export const MIN_SEGMENTS_FOR_ANALYSIS = 8;

/** How many already-translated pairs are carried into the next batch prompt. */
export const ROLLING_PAIR_COUNT = 5;

/**
 * Group segments into request batches that respect (a) a max segment count,
 * (b) a soft source-character budget, and (c) SCENE BOUNDARIES: a batch never
 * spans a silence of `sceneGapMs` or more, so each request stays within one
 * dialogue/scene and the model's consistency instructions apply to lines that
 * actually belong together. Pure / unit-tested.
 */
export function planContextBatches<T extends PromptSegment>(
  segments: T[],
  opts: { maxSegments: number; maxChars: number; sceneGapMs?: number },
): T[][] {
  const sceneGapMs = opts.sceneGapMs ?? SCENE_GAP_MS;
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  let prev: T | undefined;

  for (const seg of segments) {
    const segChars = seg.id.length + seg.sourceText.length + 40; // + per-line overhead
    const sceneBreak =
      prev !== undefined &&
      typeof prev.endMs === 'number' &&
      typeof seg.startMs === 'number' &&
      seg.startMs - prev.endMs >= sceneGapMs;
    if (
      current.length > 0 &&
      (sceneBreak || current.length >= opts.maxSegments || chars + segChars > opts.maxChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(seg);
    chars += segChars;
    prev = seg;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The structured result of the transcript-analysis pass. Same shape as the
 * persisted, user-editable character sheet ({@link TranslationDocContext}).
 */
export type TranslationAnalysis = TranslationDocContext;

/**
 * Build a bounded sample of the source transcript for the analysis pass:
 * beginning + middle + end slices so long videos still expose their cast and
 * closing context without blowing the prompt budget. Pure.
 */
export function buildAnalysisSample(segments: PromptSegment[], maxChars = 9_000): string {
  const lines = segments.map((s) => s.sourceText.replace(/\s*\r?\n\s*/g, ' ').trim()).filter((t) => t.length > 0);
  const all = lines.join('\n');
  if (all.length <= maxChars) return all;
  const third = Math.floor(maxChars / 3);
  const head = all.slice(0, third);
  const midStart = Math.floor(all.length / 2 - third / 2);
  const mid = all.slice(midStart, midStart + third);
  const tail = all.slice(all.length - third);
  return `${head}\n[...]\n${mid}\n[...]\n${tail}`;
}

/**
 * Rough token count for prompt budgeting. Measured with Gemma's tokenizer
 * (llama-server /tokenize, 2026-11): a 31-minute Chinese transcript of 2,500
 * characters was 1,984 tokens (0.79/char), its Vietnamese translation 0.37
 * tokens/char. Han/Kana/Hangul count 1 each and everything else 0.4, which
 * over-estimates both — the safe side for a context window.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other * 0.4);
}

/**
 * The transcript the analysis reads: the WHOLE thing when it fits
 * `maxTokens`, else beginning + middle + end. The old 9,000-character sample
 * was sized for English; a 30-minute Chinese video is only ~2,000 tokens, so
 * the model was reading a third of a video that would have fitted entirely —
 * and missing the names introduced in the other two thirds. Speaker tags are
 * kept ("SPEAKER_01: …") because they are what per-pair xưng hô is built from.
 */
export function buildAnalysisTranscript(segments: readonly PromptSegment[], maxTokens: number): string {
  const lines = segments
    .map((s) => {
      const text = s.sourceText.replace(/\s*\r?\n\s*/g, ' ').trim();
      return text && s.speakerId ? `${s.speakerId}: ${text}` : text;
    })
    .filter((t) => t.length > 0);
  const all = lines.join('\n');
  if (estimateTokens(all) <= maxTokens) return all;
  // Keep whole lines: take from the start, the middle and the end until each
  // third of the budget is spent.
  const third = Math.max(1, Math.floor(maxTokens / 3));
  const take = (from: number, step: 1 | -1): string[] => {
    const out: string[] = [];
    let used = 0;
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const cost = estimateTokens(lines[i]!) + 1;
      if (used + cost > third) break;
      out.push(lines[i]!);
      used += cost;
    }
    return step === 1 ? out : out.reverse();
  };
  const head = take(0, 1);
  const midStart = Math.max(head.length, Math.floor(lines.length / 2 - head.length / 2));
  const mid = take(midStart, 1);
  const tail = take(lines.length - 1, -1);
  return [head.join('\n'), '[...]', mid.join('\n'), '[...]', tail.join('\n')].join('\n');
}

/** A term that recurs in the source transcript, with how often it occurs. */
export interface RecurringTerm {
  term: string;
  count: number;
}

/**
 * Characters that make up most Chinese function words: a run made only of
 * these ("我们", "什么", "一个", "这个") is grammar, not a name.
 */
const ZH_FUNCTION_CHARS = new Set(
  '的了是不我你他她它们这那什么一个有在就也都要会说去来吗呢吧啊么没还和与就把被给让对从到为以能可得着过又很太真再才只个上下中大小多少些好看知道想做'.split(''),
);
/**
 * Characters that never START a name: pronouns, particles, question words,
 * adverbs ("我天庭", "的本源", "你怎么", "这猴子", "已经"). A run starting with
 * one is a phrase that happens to contain a name, not the name.
 */
const ZH_NOT_NAME_START = new Set('的之了我你他她它这那是在有不也都就把被给让对从到为以能可得着过又很太真再才只个怎么什哪吗呢吧啊会要一已即别回问走现终所如但而还和与或等每各俺咱'.split(''));
/** Characters that never END a name: particles, plural/locative suffixes, measure words. */
const ZH_NOT_NAME_END = new Set('的之了们吗呢吧啊么着过就都也在是有儿里个去来啥哪等呀嘛哦'.split(''));

/**
 * Recurring Han-character terms of a Chinese/Japanese transcript, most
 * frequent first: every 2–4 character run that occurs at least `minCount`
 * times, keeping the longest form when a shorter one is mostly a part of it
 * (西方教 over 西方). Handed to the analysis as candidates, because a 4B model
 * reading 2,000 tokens of dialogue listed 3 of the names that mattered and
 * missed 西方教 — the one an audited dub rendered four different ways. Pure.
 */
export function recurringTerms(
  segments: readonly { sourceText: string }[],
  opts: { minCount?: number; limit?: number } = {},
): RecurringTerm[] {
  const minCount = opts.minCount ?? 3;
  const counts = new Map<string, number>();
  for (const s of segments) {
    for (const run of s.sourceText.match(/\p{Script=Han}+/gu) ?? []) {
      const seen = new Set<string>(); // count a term once per line
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const t = run.slice(i, i + n);
          if (seen.has(t)) continue;
          seen.add(t);
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
    }
  }
  const frequent = [...counts].filter(
    ([t, c]) =>
      c >= minCount &&
      ![...t].every((ch) => ZH_FUNCTION_CHARS.has(ch)) &&
      !ZH_NOT_NAME_START.has(t[0]!) &&
      !ZH_NOT_NAME_END.has(t[t.length - 1]!),
  );
  // Drop a term that mostly occurs inside a longer frequent one.
  const kept = frequent.filter(
    ([t, c]) => !frequent.some(([longer, lc]) => longer.length > t.length && longer.includes(t) && lc >= c * 0.6),
  );
  return kept
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length || b[1] - a[1])
    .slice(0, opts.limit ?? 30)
    .map(([term, count]) => ({ term, count }));
}

/** Options for {@link buildAnalysisPrompt}. */
export interface AnalysisPromptOptions {
  /** How the source names itself (title, file names): spellings to prefer over what was heard. */
  hints?: readonly string[];
  /**
   * The reduced retry: ask for the glossary only. A small model that ran out of
   * room or broke its JSON on the full sheet usually still gets a name list
   * right, and names are the part a dub cannot do without.
   */
  glossaryOnly?: boolean;
  /** Recurring source terms to consider for the glossary ({@link recurringTerms}). */
  candidates?: readonly RecurringTerm[];
}

const isVietnamese = (lang: string): boolean => lang.split('-')[0]!.toLowerCase() === 'vi';

/**
 * Build the transcript-analysis prompt. The model must reply with strict JSON
 * matching {@link TranslationAnalysis}. Vietnamese targets get explicit xưng hô
 * instructions (as structured speaker→listener pairs) and Hán-Việt naming;
 * other languages get a generic register/formality plan.
 *
 * Example names in the instructions are single characters on purpose: given
 * whole names (唐三藏 → Đường Tam Tạng…) Gemma 3 4B copied them into the
 * glossary of a video that never mentions them.
 */
export function buildAnalysisPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  sample: string,
  opts: AnalysisPromptOptions = {},
): string {
  const fromChinese = sourceLanguage.split('-')[0]!.toLowerCase() === 'zh';
  // How people wrote the source's names (its title, the files' names), unlike
  // what speech recognition heard: 《反相之地》 was heard 反向之地, and the
  // glossary and every part title carried the mishearing (claude-dubber, F1).
  const hints = (opts.hints ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 20);
  const hintBlock =
    hints.length > 0
      ? [
          'The source as people named it (its title, its files), written by hand, unlike the transcript:',
          ...hints.map((h) => `  ${h}`),
          'When a name in the transcript sounds like one written here, use the written form.',
        ]
      : [];
  const labelled = /^SPEAKER_\d+: /m.test(sample);
  const vi = isVietnamese(targetLanguage);
  const candidates =
    opts.candidates && opts.candidates.length > 0
      ? [
          '  These terms recur in the transcript (count in brackets). SOME are names; mark each one you list with its "kind"',
    '  (person, place, group, title, technique, item) and use "ordinary word" for everyday words, which are dropped:',
          `  ${opts.candidates.map((c) => `${c.term} [${c.count}]`).join(', ')}`,
        ]
      : [];
  const glossaryAsk = [
    '- "glossary": array of {"source","kind","target"} for EVERY recurring name and term that must stay consistent across the',
    '  whole video: people, titles, places, sects, techniques, artifacts. Only names that APPEAR in the transcript,',
    '  with "source" written exactly as it appears there. The dub is SPOKEN, so the target must be pronounceable in',
    '  the target language — never source-script characters.',
    ...(vi && fromChinese
      ? [
          '  Vietnamese target from Chinese: write each name in its Hán-Việt (Sino-Vietnamese) reading, character by',
          '  character (山 → Sơn, 王 → Vương, 龙 → Long, 门 → Môn), with full Vietnamese diacritics, each syllable a',
          '  separate capitalized word. NEVER pinyin, never a loose English translation.',
        ]
      : vi
        ? ['  Vietnamese target: use the established Vietnamese form of each name (Hán-Việt for Chinese names).']
        : ['  Technical terms get their standard target translation.']),
    '  The source is automatic speech recognition: when the same name appears in slightly different written forms',
    '  (homophones), list the form that makes sense in context once.',
    ...candidates,
  ];
  if (opts.glossaryOnly) {
    return [
      `You are preparing a name list for a professional dubbing translator working from "${sourceLanguage}" to "${targetLanguage}".`,
      ...hintBlock,
      'Analyze the following transcript and respond with ONLY a strict JSON object with one key:',
      ...glossaryAsk,
      'No prose, no markdown fences — JSON only.',
      '',
      'Transcript:',
      sample,
    ].join('\n');
  }
  const pronounAsk = vi
    ? [
        '- "pronounGuide": the Vietnamese xưng hô plan as an array, ONE ENTRY PER SPEAKER PAIR who talk to each other',
        '  (both directions are separate entries): {"speaker","listener","self","address"} — what the speaker calls',
        '  himself ("self") and what he calls the listener ("address"), from their relationship (master/disciple,',
        '  senior/junior, enemies, siblings, superior/subordinate, friends, parent/child...). Use the cast names.',
        '  Match the register to the genre: ancient/xianxia/wuxia → ta/ngươi, bổn tọa, sư phụ/đồ nhi, huynh/đệ,',
        '  tỷ/muội, lão phu, tiền bối/vãn bối; modern → tôi/anh/chị/em, cậu/tớ, bố/mẹ/con. NEVER default to',
        '  "bạn/tôi" when a more specific relationship is inferable. If a narrator addresses the audience, add an',
        '  entry with listener "audience". "self" and "address" are Vietnamese words.',
        // Only when the transcript HAS labels: told about them unconditionally,
        // Gemma 3 4B invented SPEAKER_00..04 for an undiarized video.
        ...(labelled ? ['  Speaker labels like SPEAKER_00 in the transcript mark who is talking.'] : []),
      ].join('\n')
    : [
        '- "pronounGuide": the register/formality plan for the target language (formal vs informal address,',
        '  honorifics, T-V distinction), per speaker pair where relationships are inferable.',
      ].join('\n');
  return [
    `You are preparing notes for a professional subtitle/dubbing translator working from "${sourceLanguage}" to "${targetLanguage}".`,
    ...hintBlock,
    'Analyze the following transcript sample and respond with ONLY a strict JSON object with these keys:',
    '- "synopsis": 1-2 sentences on what this video is about (genre, setting, who is talking to whom).',
    `- "cast": array of {"name","role"${labelled ? ',"speakerId"' : ''}} for each character who speaks or is spoken to (labels like "narrator",`,
    `  "master" when unnamed). "name" is the name AS IT SHOULD SOUND IN ${vi ? 'VIETNAMESE (Hán-Việt for Chinese names)' : 'THE TARGET LANGUAGE'},`,
    '  followed by the source form in parentheses.',
    // The translator keys the forms of address by speaker: without the ids
    // the sheet of 《反相之地》 mapped nobody (claude-dubber, F2).
    ...(labelled
      ? [
          '  "speakerId": the label of THAT character\'s own lines (e.g. "SPEAKER_02"), for every main character who speaks;',
          '  find it from who is called by name and who answers. Leave it out when unsure; never give two characters one id.',
        ]
      : []),
    ...glossaryAsk,
    pronounAsk,
    'No prose, no markdown fences — JSON only.',
    '',
    'Transcript sample:',
    sample,
  ].join('\n');
}

/**
 * Each entry says what KIND of thing it is, and ordinary words are dropped:
 * handed recurring-term candidates, Gemma 3 4B otherwise turned every one into
 * a "verbatim" glossary entry, ordinary words included (先天 → "Tiên sinh").
 */
export const GLOSSARY_KINDS = ['person', 'place', 'group', 'title', 'technique', 'item', 'ordinary word'] as const;
const GLOSSARY_PROPERTY = {
  type: 'array',
  maxItems: 48,
  items: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      kind: { type: 'string', enum: [...GLOSSARY_KINDS] },
      target: { type: 'string' },
    },
    required: ['source', 'kind', 'target'],
  },
};

/**
 * JSON schema for the full character sheet. Sent as llama-server's
 * `json_schema` (grammar-constrained decoding, verified on build b12110), so a
 * small local model can no longer answer with prose, a fenced block or a
 * half-closed object — the failure that left all six audited projects
 * (2026-11) without a sheet. The item caps bound the reply so it cannot run
 * past n_predict and truncate. For Vietnamese the pronoun plan is STRUCTURED
 * pairs: asked for free text, Gemma 3 4B returned a placeholder template
 * ("A → B: Sư phụ gọi đồ nhi…").
 */
export function analysisJsonSchema(targetLanguage: string): Record<string, unknown> {
  const pronounGuide = isVietnamese(targetLanguage)
    ? {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string' },
            listener: { type: 'string' },
            self: { type: 'string' },
            address: { type: 'string' },
          },
          required: ['speaker', 'listener', 'self', 'address'],
        },
      }
    : { type: 'string' };
  return {
    type: 'object',
    properties: {
      synopsis: { type: 'string' },
      cast: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, role: { type: 'string' }, speakerId: { type: 'string' } },
          required: ['name', 'role'],
        },
      },
      glossary: GLOSSARY_PROPERTY,
      pronounGuide,
    },
    required: ['synopsis', 'cast', 'glossary', 'pronounGuide'],
  };
}

/** JSON schema for the glossary-only retry. */
export const GLOSSARY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { glossary: GLOSSARY_PROPERTY },
  required: ['glossary'],
};

/** Languages, for checking the glossary the model returns. */
export interface AnalysisLanguages {
  sourceLanguage: string;
  targetLanguage: string;
}

/**
 * Render structured address pairs as the editable one-line-per-pair guide. A
 * pair whose terms the voice could not say is dropped (Gemma 3 4B wrote
 * xưng "猴子" — Chinese — into a Vietnamese plan).
 */
function renderAddressPairs(pairs: unknown[], vi: boolean, languages?: AnalysisLanguages): string | undefined {
  const sayable = (term: string): boolean =>
    !term || !languages || wrongScripts(term, { sourceText: '', ...languages }).length === 0;
  const lines = pairs.flatMap((p) => {
    const e = p as { speaker?: unknown; listener?: unknown; self?: unknown; address?: unknown };
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const [speaker, listener, self, address] = [str(e.speaker), str(e.listener), str(e.self), str(e.address)];
    if (!speaker || !listener || (!self && !address)) return [];
    if (!sayable(self) || !sayable(address)) return [];
    // Names go into every prompt too: a pinyin "Hou Zi" in the guide came back
    // inside reviewed lines ("(Hou Zi ở đâu?)").
    const badName = (n: string): boolean =>
      !!languages && checkDubLine(n, { sourceText: '', ...languages }).some((f) => f === 'pinyin' || f === 'wrong-script');
    if (badName(speaker) || badName(listener)) return [];
    return vi
      ? [`${speaker} → ${listener}: xưng "${self}", gọi "${address}"`]
      : [`${speaker} → ${listener}: self "${self}", address "${address}"`];
  });
  return lines.length > 0 ? lines.join('; ') : undefined;
}

const CJK_LETTER_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * For zh→vi the glossary holds NAMES, and a name must be shaped like its
 * Hán-Việt reading: capitalized, one syllable per Han character. Rejects
 * translations dressed up as names ("我天庭" → "Thiên Đàng của ta", "之力" →
 * "Lực lượng của nó") and lowercase entries, which are ordinary words — on the
 * 2026-11 verification Gemma 3 4B lowercased those (镇压 → "bế quan", 先天 →
 * "tiên sinh") and every one was wrong. Ordinary words are the translator's
 * job; a wrong one pasted "verbatim" into every prompt does more harm than
 * none. (It cannot tell a right reading from a wrong one — "Pháp Hiền" for
 * 普贤 passes; that needs a Hán-Việt dictionary.) Other pairs: always true. Pure.
 */
export function isHanVietReadingShaped(source: string, target: string, languages: AnalysisLanguages): boolean {
  if (!/^zh/i.test(languages.sourceLanguage) || !isVietnamese(languages.targetLanguage)) return true;
  const chars = [...source].filter((c) => /\p{Script=Han}/u.test(c)).length;
  if (chars === 0) return true;
  const words = target.trim().split(/[\s-]+/u).filter((w) => /\p{L}/u.test(w));
  return words.length === chars && /^\p{Lu}/u.test(words[0] ?? '');
}

/**
 * Parse the analysis reply into a {@link TranslationAnalysis} (undefined on
 * junk). With `languages`, glossary entries whose target the voice could not
 * say (source script, pinyin — see lineQuality) are DROPPED: a glossary is
 * pasted into every later prompt as "use these verbatim", so one "Kunlun Xu"
 * entry would plant pinyin in every line that names the place. With
 * `transcript`, entries whose source never occurs in it are dropped too — a
 * small model lists the prompt's examples or invents names. For a non-CJK
 * target, a cast name still written in CJK is dropped (it was meant to be the
 * target form; the parenthesized source may stay).
 */
export function parseAnalysisReply(
  reply: string,
  languages?: AnalysisLanguages,
  transcript?: string,
): TranslationAnalysis | undefined {
  const parsed = extractJsonObject(reply) as
    | {
        synopsis?: unknown;
        cast?: { name?: unknown; role?: unknown; speakerId?: unknown }[];
        glossary?: { source?: unknown; target?: unknown }[];
        pronounGuide?: unknown;
      }
    | undefined;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const cjkTarget = languages ? /^(zh|ja|ko)/i.test(languages.targetLanguage) : true;
  const analysis: TranslationAnalysis = {};
  if (typeof parsed.synopsis === 'string' && parsed.synopsis.trim()) analysis.synopsis = parsed.synopsis.trim();
  if (Array.isArray(parsed.cast)) {
    const cast = parsed.cast
      .filter((c) => typeof c?.name === 'string' && c.name.trim())
      .map((c) => ({
        name: (c.name as string).trim(),
        ...(typeof c.role === 'string' && c.role.trim() ? { role: c.role.trim() } : {}),
        ...(typeof c.speakerId === 'string' && /^SPEAKER_\d+$/.test(c.speakerId.trim()) ? { speakerId: c.speakerId.trim() } : {}),
      }))
      .filter((c) => cjkTarget || !CJK_LETTER_RE.test(c.name.replace(/\([^)]*\)/g, '')));
    if (cast.length > 0) analysis.cast = cast;
  }
  if (Array.isArray(parsed.glossary)) {
    const seen = new Set<string>();
    const glossary = parsed.glossary
      .filter((g) => typeof g?.source === 'string' && typeof g?.target === 'string' && g.source.trim())
      .filter((g) => (g as { kind?: unknown }).kind !== 'ordinary word')
      .map((g) => ({ source: (g.source as string).trim(), target: (g.target as string).trim() }))
      .filter((g) => {
        if (!g.target || seen.has(g.source)) return false;
        seen.add(g.source);
        if (transcript !== undefined && !transcript.includes(g.source)) return false;
        if (!languages) return true;
        if (!isHanVietReadingShaped(g.source, g.target, languages)) return false;
        return checkDubLine(g.target, { sourceText: g.source, ...languages }).length === 0;
      });
    if (glossary.length > 0) analysis.glossary = glossary;
  }
  if (typeof parsed.pronounGuide === 'string' && parsed.pronounGuide.trim()) {
    analysis.pronounGuide = parsed.pronounGuide.trim();
  } else if (Array.isArray(parsed.pronounGuide)) {
    const guide = renderAddressPairs(parsed.pronounGuide, languages ? isVietnamese(languages.targetLanguage) : true, languages);
    if (guide) analysis.pronounGuide = guide;
  }
  return Object.keys(analysis).length > 0 ? analysis : undefined;
}

/** The chat primitive the analysis drives (any refinement-capable provider). */
export interface AnalysisChat {
  chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string>;
  /** The engine's context window in tokens (sizes the transcript); default 8192. */
  readonly contextTokens?: number;
}

/** One analysis request and how it ended. */
export interface AnalysisAttempt {
  mode: 'full' | 'full-short' | 'glossary-only';
  ok: boolean;
  /** Why it failed: the engine's error, or "unusable reply". */
  error?: string;
}

/** Result of {@link generateCharacterSheet}. */
export interface AnalysisOutcome {
  analysis?: TranslationAnalysis;
  attempts: AnalysisAttempt[];
}

/** Reply budget for the analysis (tokens): a 48-entry glossary + 16-entry cast fit well inside. */
const ANALYSIS_REPLY_TOKENS = 2048;
/** Prompt text around the transcript (instructions), with headroom. */
const ANALYSIS_PROMPT_OVERHEAD_TOKENS = 1200;
/** llama-server is launched with `-c 8192` (engineManager.ts); the default for an unknown engine. */
const DEFAULT_CONTEXT_TOKENS = 8192;

const ANALYSIS_SYSTEM = 'You prepare structured notes for dubbing translators. Respond with strict JSON only.';

/** True for cancellation/timeouts, which must abort instead of being retried. */
function isAbort(err: unknown): boolean {
  const name = (err as Error | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return (err as { appError?: { code?: string } } | undefined)?.appError?.code === 'CANCELLED';
}

/**
 * Produce the character sheet: the full analysis with constrained JSON, then
 * ONE reduced (glossary-only) retry when that fails. Never throws for a model
 * failure — the attempts say what happened so the caller can fail LOUDLY
 * (pipeline warning + translation report) instead of the old `.catch(() =>
 * undefined)` that hid every failure. Cancellation propagates.
 */
export async function generateCharacterSheet(
  chat: AnalysisChat,
  input: {
    sourceLanguage: string;
    targetLanguage: string;
    segments: readonly PromptSegment[];
    /** How the source names itself (title, file names): spellings to prefer over what was heard. */
    hints?: readonly string[];
  },
  signal?: AbortSignal,
): Promise<AnalysisOutcome> {
  const languages = { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage };
  const context = chat.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const transcriptBudget = Math.max(1000, context - ANALYSIS_REPLY_TOKENS - ANALYSIS_PROMPT_OVERHEAD_TOKENS);
  const transcript = buildAnalysisTranscript(input.segments, transcriptBudget);
  const shorter = buildAnalysisTranscript(input.segments, Math.max(1000, Math.floor(transcriptBudget / 2)));
  // Every source line (not just the sampled ones): the glossary is checked
  // against it, and recurring terms are counted over the whole video.
  const sourceText = input.segments.map((s) => s.sourceText).join('\n');
  const cjkSource = /^(zh|ja)/i.test(input.sourceLanguage);
  const candidates = cjkSource ? recurringTerms(input.segments) : [];
  const attempts: AnalysisAttempt[] = [];

  const attempt = async (mode: AnalysisAttempt['mode']): Promise<TranslationAnalysis | undefined> => {
    if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Translation was cancelled.');
    try {
      const reply = await chat.chatComplete(
        ANALYSIS_SYSTEM,
        buildAnalysisPrompt(input.sourceLanguage, input.targetLanguage, mode === 'full-short' ? shorter : transcript, {
          glossaryOnly: mode === 'glossary-only',
          candidates,
          ...(input.hints?.length ? { hints: input.hints } : {}),
        }),
        signal,
        {
          jsonSchema: mode === 'glossary-only' ? GLOSSARY_JSON_SCHEMA : analysisJsonSchema(input.targetLanguage),
          maxTokens: ANALYSIS_REPLY_TOKENS,
        },
      );
      const analysis = parseAnalysisReply(reply, languages, sourceText);
      attempts.push(analysis ? { mode, ok: true } : { mode, ok: false, error: 'unusable reply (no JSON character sheet)' });
      return analysis;
    } catch (err) {
      // Only the run's own signal is a cancel: a model that timed out is a
      // failed attempt, which the caller reports, not a reason to throw away
      // the translation the step just finished.
      if (signal ? signal.aborted : isAbort(err)) throw err;
      const message = (err as { appError?: { message?: string } })?.appError?.message ?? (err as Error)?.message ?? String(err);
      attempts.push({ mode, ok: false, error: message });
      return undefined;
    }
  };

  const full = await attempt('full');
  if (full) return { analysis: full, attempts };
  // The whole sheet once more on half the transcript before settling for
  // names alone: the glossary-only fallback has no cast and no pronoun plan,
  // and the translator then has no forms of address (claude-dubber, F2).
  if (shorter !== transcript) {
    const short = await attempt('full-short');
    if (short) return { analysis: short, attempts };
  }
  const glossary = await attempt('glossary-only');
  return glossary ? { analysis: glossary, attempts } : { attempts };
}

/**
 * The character sheet's "heard as → is" fixes applied to a line's source text
 * before it is translated: speech-to-text heard 枪人 where 羌人 is said, and
 * every line with it translated the wrong word (field report B4). Whole
 * matches, in order; empty or identical pairs are ignored. Pure.
 */
export function applySourceCorrections(text: string, corrections: readonly { heard: string; is: string }[] | undefined): string {
  if (!corrections || corrections.length === 0) return text;
  let out = text;
  for (const c of corrections) {
    const heard = c.heard?.trim();
    if (!heard || heard === c.is) continue;
    out = out.split(heard).join(c.is ?? '');
  }
  return out;
}

/** An already-translated source→target pair carried forward for continuity. */
export interface RollingPair {
  source: string;
  target: string;
}

/**
 * Render the context block prepended to a batch prompt: the analysis "character
 * sheet" plus the last few already-translated lines. Returns '' when there is
 * nothing to say. Pure.
 */
export function buildContextHeader(args: {
  analysis?: TranslationAnalysis;
  previousPairs?: RollingPair[];
  sceneBreak?: boolean;
}): string {
  const parts: string[] = [];
  const a = args.analysis;
  if (a?.synopsis) parts.push(`Synopsis: ${a.synopsis}`);
  if (a?.cast && a.cast.length > 0) {
    // A character tied to a detected speaker says who a [SPEAKER_03] line is:
    // the forms of address follow from it (field report B7).
    parts.push(
      `Cast: ${a.cast
        .map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.speakerId ? ` = ${c.speakerId}` : ''}`)
        .join('; ')}`,
    );
  }
  if (a?.glossary && a.glossary.length > 0) {
    parts.push(
      `Glossary (use these target renderings verbatim): ${a.glossary.map((g) => `"${g.source}" -> "${g.target}"`).join('; ')}`,
    );
  }
  if (a?.pronounGuide) parts.push(`Pronouns/terms of address (follow strictly): ${a.pronounGuide}`);
  if (args.previousPairs && args.previousPairs.length > 0) {
    parts.push(
      'Previous lines (already translated — continue their style, pronouns, and terminology):\n' +
        args.previousPairs.map((p) => `  "${p.source}" -> "${p.target}"`).join('\n'),
    );
  }
  if (parts.length === 0) return '';
  const sceneNote = args.sceneBreak ? '\nA scene change (long pause) occurs right before these segments.' : '';
  return `Context (do NOT translate this block; use it for consistency):\n${parts.join('\n')}${sceneNote}\n`;
}

/** Collect the rolling context pairs from a finished batch (last N non-empty). */
export function collectRollingPairs(
  batch: PromptSegment[],
  translatedById: Map<string, string>,
  count = ROLLING_PAIR_COUNT,
): RollingPair[] {
  const pairs: RollingPair[] = [];
  for (const seg of batch) {
    const target = translatedById.get(seg.id);
    if (typeof target === 'string' && target.trim().length > 0) {
      pairs.push({ source: seg.sourceText.replace(/\s*\r?\n\s*/g, ' ').trim(), target: target.trim() });
    }
  }
  return pairs.slice(-count);
}

/** True when a scene gap separates the previous batch's tail from this batch. */
export function isSceneBreak(prevBatch: PromptSegment[] | undefined, batch: PromptSegment[], sceneGapMs = SCENE_GAP_MS): boolean {
  const prevLast = prevBatch?.[prevBatch.length - 1];
  const first = batch[0];
  return (
    prevLast !== undefined &&
    first !== undefined &&
    typeof prevLast.endMs === 'number' &&
    typeof first.startMs === 'number' &&
    first.startMs - prevLast.endMs >= sceneGapMs
  );
}

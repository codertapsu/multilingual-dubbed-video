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
 *   - {@link buildContextHeader}: renders analysis + rolling context into the
 *     block prepended to each batch prompt.
 *
 * Used by both the cloud LLM provider and the local chat-LLM path. The
 * raw-segment TranslateGemma path CANNOT use any of this: its trained template
 * accepts exactly one source text and treats everything else as text to
 * translate (officially confirmed — no instructions, no glossaries, 2K context).
 */
import type { TranslationDocContext } from '@videodubber/shared';
import { extractJsonObject } from '../cloud/cloudHttp.js';
import type { PromptSegment } from './llmTranslationProvider.js';

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
export function planContextBatches(
  segments: PromptSegment[],
  opts: { maxSegments: number; maxChars: number; sceneGapMs?: number },
): PromptSegment[][] {
  const sceneGapMs = opts.sceneGapMs ?? SCENE_GAP_MS;
  const batches: PromptSegment[][] = [];
  let current: PromptSegment[] = [];
  let chars = 0;
  let prev: PromptSegment | undefined;

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
 * Build the transcript-analysis prompt. The model must reply with strict JSON
 * matching {@link TranslationAnalysis}. Vietnamese targets get explicit xưng hô
 * instructions; other languages get a generic register/formality plan.
 */
export function buildAnalysisPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  sample: string,
): string {
  const base = targetLanguage.split('-')[0]!.toLowerCase();
  const pronounAsk =
    base === 'vi'
      ? [
          '- "pronounGuide": a Vietnamese xưng hô plan. Infer each speaker\'s relationships (teacher/student,',
          '  senior/junior, siblings, friends, parent/child, host/audience...) and state, per speaker pair, the',
          '  address terms to use consistently (e.g. "học sinh nói với giáo viên: gọi \'thầy\'/\'cô\', xưng \'em\';',
          '  giáo viên nói với học sinh: gọi \'em\', xưng \'thầy\'/\'cô\'"). NEVER default to "bạn/tôi" when a more',
          '  specific relationship is inferable. If only one narrator speaks to the audience, state the register',
          '  to use for "you" (e.g. "các bạn").',
        ].join('\n')
      : [
          '- "pronounGuide": the register/formality plan for the target language (formal vs informal address,',
          '  honorifics, T-V distinction), per speaker pair where relationships are inferable.',
        ].join('\n');
  return [
    `You are preparing notes for a professional subtitle/dubbing translator working from "${sourceLanguage}" to "${targetLanguage}".`,
    'Analyze the following transcript sample and respond with ONLY a strict JSON object with these keys:',
    '- "synopsis": 1-2 sentences on what this video is about (genre, setting, who is talking to whom).',
    '- "cast": array of {"name","role"} for each speaker/character you can infer (use labels like "narrator",',
    '  "teacher", "interviewer" when unnamed).',
    '- "glossary": array of {"source","target"} for recurring names/terms that must stay consistent across the',
    '  whole video (proper nouns, technical terms). Translate the "target" values into the target language;',
    '  keep untranslatable proper names as-is.',
    pronounAsk,
    'No prose, no markdown fences — JSON only.',
    '',
    'Transcript sample:',
    sample,
  ].join('\n');
}

/** Parse the analysis reply into a {@link TranslationAnalysis} (undefined on junk). */
export function parseAnalysisReply(reply: string): TranslationAnalysis | undefined {
  const parsed = extractJsonObject(reply) as
    | {
        synopsis?: unknown;
        cast?: { name?: unknown; role?: unknown }[];
        glossary?: { source?: unknown; target?: unknown }[];
        pronounGuide?: unknown;
      }
    | undefined;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const analysis: TranslationAnalysis = {};
  if (typeof parsed.synopsis === 'string' && parsed.synopsis.trim()) analysis.synopsis = parsed.synopsis.trim();
  if (Array.isArray(parsed.cast)) {
    const cast = parsed.cast
      .filter((c) => typeof c?.name === 'string' && c.name.trim())
      .map((c) => ({ name: (c.name as string).trim(), ...(typeof c.role === 'string' ? { role: c.role.trim() } : {}) }));
    if (cast.length > 0) analysis.cast = cast;
  }
  if (Array.isArray(parsed.glossary)) {
    const glossary = parsed.glossary
      .filter((g) => typeof g?.source === 'string' && typeof g?.target === 'string' && g.source.trim())
      .map((g) => ({ source: (g.source as string).trim(), target: (g.target as string).trim() }));
    if (glossary.length > 0) analysis.glossary = glossary;
  }
  if (typeof parsed.pronounGuide === 'string' && parsed.pronounGuide.trim()) {
    analysis.pronounGuide = parsed.pronounGuide.trim();
  }
  return Object.keys(analysis).length > 0 ? analysis : undefined;
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
    parts.push(`Cast: ${a.cast.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join('; ')}`);
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

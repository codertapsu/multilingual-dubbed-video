/**
 * Context-aware review of EXISTING translations — the shared core behind:
 *   - the `argos-llm-repair` provider (Argos drafts, LLM repairs), and
 *   - the optional `refine` pipeline step (any translation's output reviewed
 *     by a context-capable LLM after the translation step).
 *
 * The reviewer sees each line's source + current translation plus structured
 * document context (character sheet, rolling window of the preceding reviewed
 * lines, scene breaks) and returns the corrected line — or the input unchanged
 * when it is already right. Research backing: draft + context-aware
 * post-editing holds the best published pronoun-disambiguation scores
 * (Koneru et al., NAACL 2024), and a review pass is where document-level
 * consistency (terms of address, terminology, register) is cheapest to enforce.
 *
 * Failure posture: a malformed/missing reviewed line keeps the current text —
 * a less-polished line beats a broken pipeline. Cancellation propagates.
 */
import {
  normalizeLanguageCode,
  type TranslationDocContext,
  type TranslationInput,
  type TranslationResult,
  type TranslationResultSegment,
} from '@videodubber/shared';
import {
  budgetUnitLabel,
  looksUntranslated,
  parseTranslationReply,
  speechBudget,
  type PromptSegment,
} from './llmTranslationProvider.js';
import {
  buildAnalysisPrompt,
  buildAnalysisSample,
  buildContextHeader,
  collectRollingPairs,
  isSceneBreak,
  MIN_SEGMENTS_FOR_ANALYSIS,
  parseAnalysisReply,
  planContextBatches,
  translationContextEnabled,
  type RollingPair,
  type TranslationAnalysis,
} from './translationContext.js';

/** Review batches are smaller than translation batches: each line appears
 * twice (source + current translation), so the same char budget covers fewer
 * lines. */
export const REVIEW_BATCH_SEGMENTS = 16;
export const REVIEW_BATCH_CHARS = 5_000;

/** How the reviewed lines are framed to the model. */
export type ReviewMode =
  /** Drafts from a context-free MT system (Argos/TranslateGemma): expect and
   * fix context damage aggressively. */
  | 'repair'
  /** Output of a (possibly context-aware) translation: polish conservatively —
   * naturalness, cohesion, consistency — change only what improves the dub. */
  | 'refine';

/**
 * Build the review prompt for one batch: each line shows the source and the
 * current translation; the model returns the corrected translation per id (or
 * the current text verbatim when it is already right). Pure / unit-tested.
 */
export function buildReviewPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  batch: PromptSegment[],
  draftById: ReadonlyMap<string, string>,
  mode: ReviewMode,
  context?: string,
): string {
  const list = batch
    .map((s) => {
      const src = s.sourceText.replace(/\s*\r?\n\s*/g, ' ');
      const draft = (draftById.get(s.id) ?? '').replace(/\s*\r?\n\s*/g, ' ');
      const budget = speechBudget(targetLanguage, s.startMs, s.endMs);
      const hint =
        budget !== undefined ? `  [target ${budget.amount} ${budgetUnitLabel(budget.unit, targetLanguage)} or fewer]` : '';
      return `${s.id}:\n  source: ${src}\n  draft: ${draft}${hint}`;
    })
    .join('\n');
  const framing =
    mode === 'repair'
      ? [
          'Each segment below has the original source and a draft translation from a sentence-level MT system that had NO conversation context.',
          'Fix ONLY what the missing context broke:',
        ]
      : [
          'Each segment below has the original source and the current translation of a dubbing script. Review the WHOLE dialogue and polish each line:',
        ];
  return [
    `You are reviewing machine-translated dubbing lines ("${sourceLanguage}" -> "${targetLanguage}").`,
    ...framing,
    ...(context ? [context] : []),
    '- Pronouns and terms of address: make them match the speaker relationships (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con — per the context) and keep them consistent across ALL segments.',
    '- Terminology and names: follow the glossary and keep the same rendering everywhere.',
    '- Cohesion with the previous lines (connectives, register, tone) and natural SPOKEN phrasing — these lines are performed by a voice, not read.',
    '- Stay at or under the length budget when one is given; never make a line meaningfully longer than its draft.',
    'When a draft is already correct and natural, return it unchanged. Never merge or split segments.',
    'Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — one entry per input id, no prose, no markdown fences.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

/** The chat primitive a reviewer engine must provide. */
export interface ReviewChat {
  chatComplete(system: string | undefined, user: string, signal?: AbortSignal): Promise<string>;
}

/** Inputs to {@link reviewTranslations}. */
export interface ReviewInput {
  sourceLanguage: string;
  targetLanguage: string;
  /** Segments WITH timing (budgets) — `sourceText` is the original line. */
  segments: PromptSegment[];
  /** Current translation per segment id (the text under review). */
  draftById: ReadonlyMap<string, string>;
  /** Persisted character sheet; when absent one is generated (and returned). */
  documentContext?: TranslationDocContext;
  mode: ReviewMode;
}

/** Result of a review pass. */
export interface ReviewOutcome {
  segments: TranslationResultSegment[];
  /** Ids whose text actually changed. */
  changedIds: string[];
  /** Character sheet generated by this pass (only when none was provided). */
  analysis?: TranslationAnalysis;
}

/**
 * Review a whole transcript's translations with document context: optional
 * analysis pass (when no sheet was provided), then scene-aware batches with a
 * rolling window of already-reviewed pairs. Unusable replies (missing, empty,
 * or — across languages — a source echo) keep the current text.
 */
export async function reviewTranslations(
  input: ReviewInput,
  chat: ReviewChat,
  signal?: AbortSignal,
): Promise<ReviewOutcome> {
  const source = normalizeLanguageCode(input.sourceLanguage);
  const target = normalizeLanguageCode(input.targetLanguage);
  const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];

  let analysis: TranslationAnalysis | undefined = input.documentContext;
  let generated: TranslationAnalysis | undefined;
  if (
    translationContextEnabled() &&
    analysis === undefined &&
    input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS
  ) {
    generated = await chat
      .chatComplete(
        'You prepare structured notes for dubbing translators. Respond with strict JSON only.',
        buildAnalysisPrompt(source, target, buildAnalysisSample(input.segments)),
        signal,
      )
      .then(parseAnalysisReply)
      .catch(() => undefined);
    analysis = generated;
  }

  const batches = planContextBatches(input.segments, {
    maxSegments: REVIEW_BATCH_SEGMENTS,
    maxChars: REVIEW_BATCH_CHARS,
  });
  const segments: TranslationResultSegment[] = [];
  const changedIds: string[] = [];
  let previousBatch: PromptSegment[] | undefined;
  let rolling: RollingPair[] = [];
  for (const batch of batches) {
    const context = buildContextHeader({
      analysis,
      previousPairs: rolling,
      sceneBreak: isSceneBreak(previousBatch, batch),
    });
    const prompt = buildReviewPrompt(source, target, batch, input.draftById, input.mode, context || undefined);
    const reply = await chat.chatComplete(
      'You are a professional subtitle/dubbing translator. Respond with strict JSON only.',
      prompt,
      signal,
    );
    const byId = parseTranslationReply(reply);
    const mergedById = new Map<string, string>();
    for (const seg of batch) {
      const current = input.draftById.get(seg.id) ?? seg.sourceText;
      const reviewed = byId.get(seg.id)?.trim();
      const usable = reviewed && reviewed.length > 0 && !(detectSourceEcho && looksUntranslated(seg, reviewed));
      const text = usable ? reviewed : current;
      if (text !== current) changedIds.push(seg.id);
      segments.push({ id: seg.id, translatedText: text });
      mergedById.set(seg.id, text);
    }
    rolling = collectRollingPairs(batch, mergedById);
    previousBatch = batch;
  }

  return { segments, changedIds, ...(generated ? { analysis: generated } : {}) };
}

/** Convert a TranslationInput's segments to the reviewer's PromptSegment shape. */
export function toPromptSegments(input: TranslationInput): PromptSegment[] {
  return input.segments.map((s) => ({ id: s.id, sourceText: s.sourceText, startMs: s.startMs, endMs: s.endMs }));
}

/** Assemble a TranslationResult from a review outcome (provider convenience). */
export function reviewToTranslationResult(outcome: ReviewOutcome): TranslationResult {
  return { segments: outcome.segments, ...(outcome.analysis ? { analysis: outcome.analysis } : {}) };
}

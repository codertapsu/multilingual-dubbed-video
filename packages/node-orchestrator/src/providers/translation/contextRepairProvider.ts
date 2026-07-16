/**
 * Argos draft + local-LLM context repair — the fully-offline context-aware tier.
 *
 * Argos translates every line instantly on CPU but knows nothing about the
 * conversation, so its Vietnamese pronouns default to generic forms and its
 * terminology drifts. Instead of paying for a full LLM translation, this
 * provider lets Argos produce the DRAFT and a small local instruct model
 * (Gemma 3 4B/12B via llama.cpp) only REPAIR it with document context: the
 * project character sheet (cast, glossary, xưng hô plan), scene-aware batches,
 * and a rolling window of already-repaired lines.
 *
 * This division of labor is directly research-backed: draft-NMT + context-aware
 * LLM post-editing holds the best published pronoun-disambiguation scores
 * (Koneru et al., NAACL 2024 — 88.7% ContraPro) while needing far less compute
 * than LLM translation from scratch.
 *
 * Failure posture: the repair engine is readiness-gated before a run starts;
 * a mid-run engine failure propagates (consistent with every other provider).
 * A malformed repair REPLY, however, silently keeps the draft for the affected
 * lines — a worse-translated line beats a failed pipeline.
 */
import {
  normalizeLanguageCode,
  type TranslationInput,
  type TranslationResult,
  type TranslationResultSegment,
} from '@videodubber/shared';
import type { CancellableTranslationProvider } from '../types.js';
import type { LocalLlmTranslationProvider } from './localLlmTranslationProvider.js';
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

/** Repair batches are smaller than translation batches: each line appears twice
 * (source + draft), so the same char budget covers fewer lines. */
const REPAIR_BATCH_SEGMENTS = 16;
const REPAIR_BATCH_CHARS = 5_000;

/**
 * Build the repair prompt for one batch: each line shows the source and the
 * draft; the model returns the CORRECTED translation per id (or the draft
 * verbatim when it is already right). Pure / unit-tested.
 */
export function buildRepairPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  batch: PromptSegment[],
  draftById: ReadonlyMap<string, string>,
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
  return [
    `You are reviewing machine-translated dubbing lines ("${sourceLanguage}" -> "${targetLanguage}").`,
    'Each segment below has the original source and a draft translation from a sentence-level MT system that had NO conversation context.',
    ...(context ? [context] : []),
    'Fix ONLY what the missing context broke:',
    '- Pronouns and terms of address: make them match the speaker relationships (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con — per the context) and keep them consistent across ALL segments.',
    '- Terminology and names: follow the glossary and keep the same rendering everywhere.',
    '- Cohesion with the previous lines (connectives, register, tone).',
    '- Stay at or under the length budget when one is given; never make a line meaningfully longer than its draft.',
    'When a draft is already correct, return it unchanged. Never merge or split segments.',
    'Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — one entry per input id, no prose, no markdown fences.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

/** Constructor options for {@link ContextRepairTranslationProvider}. */
export interface ContextRepairOptions {
  id?: string;
  displayName?: string;
  /** The fast context-free drafting provider (Argos). */
  draft: CancellableTranslationProvider;
  /** The local instruct LLM used for the analysis + repair passes. */
  chat: Pick<LocalLlmTranslationProvider, 'chatComplete'>;
  /** Engine pack the repair engine needs (surfaced to readiness/UI). */
  requiresEnginePack?: string;
}

/** Argos-draft + local-LLM-repair translation provider. */
export class ContextRepairTranslationProvider implements CancellableTranslationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal = true;
  readonly requiresEnginePack?: string;

  constructor(private readonly opts: ContextRepairOptions) {
    this.id = opts.id ?? 'argos-llm-repair';
    this.displayName = opts.displayName ?? 'Argos + Gemma repair (offline, context-aware)';
    if (opts.requiresEnginePack) this.requiresEnginePack = opts.requiresEnginePack;
  }

  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    // 1. Draft everything with the fast context-free engine.
    const draft = await this.opts.draft.translateSegments(input, signal);
    const draftById = new Map(draft.segments.map((s) => [s.id, s.translatedText]));
    if (!translationContextEnabled()) return draft;

    const source = normalizeLanguageCode(input.sourceLanguage);
    const target = normalizeLanguageCode(input.targetLanguage);
    // Echo rejection only makes sense across languages: same-language projects
    // (and lines whose correct rendering IS the source) must be able to accept
    // a source-identical repair.
    const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];

    // 2. The character sheet: provided (persisted/user-edited) wins; else one
    //    analysis pass generates it (best-effort — see class doc).
    const provided = input.documentContext;
    let analysis: TranslationAnalysis | undefined = provided;
    let generated: TranslationAnalysis | undefined;
    if (analysis === undefined && input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS) {
      generated = await this.opts.chat
        .chatComplete(
          'You prepare structured notes for dubbing translators. Respond with strict JSON only.',
          buildAnalysisPrompt(source, target, buildAnalysisSample(input.segments)),
          signal,
        )
        .then(parseAnalysisReply)
        .catch(() => undefined);
      analysis = generated;
    }

    // 3. Repair scene-aware batches with rolling context.
    const batches = planContextBatches(input.segments, {
      maxSegments: REPAIR_BATCH_SEGMENTS,
      maxChars: REPAIR_BATCH_CHARS,
    });
    const results: TranslationResultSegment[] = [];
    let previousBatch: PromptSegment[] | undefined;
    let rolling: RollingPair[] = [];
    for (const batch of batches) {
      const context = buildContextHeader({
        analysis,
        previousPairs: rolling,
        sceneBreak: isSceneBreak(previousBatch, batch),
      });
      const prompt = buildRepairPrompt(source, target, batch, draftById, context || undefined);
      const reply = await this.opts.chat.chatComplete(
        'You are a professional subtitle/dubbing translator. Respond with strict JSON only.',
        prompt,
        signal,
      );
      const byId = parseTranslationReply(reply);
      const mergedById = new Map<string, string>();
      for (const seg of batch) {
        // A missing/empty repaired line keeps the draft (worse beats broken) —
        // and so does a "repair" that merely echoes the SOURCE back (a weak
        // model un-translating the line is strictly worse than the draft).
        const repaired = byId.get(seg.id)?.trim();
        const usable =
          repaired && repaired.length > 0 && !(detectSourceEcho && looksUntranslated(seg, repaired));
        const text = usable ? repaired : (draftById.get(seg.id) ?? seg.sourceText);
        results.push({ id: seg.id, translatedText: text });
        mergedById.set(seg.id, text);
      }
      rolling = collectRollingPairs(batch, mergedById);
      previousBatch = batch;
    }

    return { segments: results, ...(generated ? { analysis: generated } : {}) };
  }
}

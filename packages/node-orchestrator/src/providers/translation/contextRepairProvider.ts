/**
 * Argos draft + local-LLM context repair — the fully-offline context-aware tier.
 *
 * Argos translates every line instantly on CPU but knows nothing about the
 * conversation, so its Vietnamese pronouns default to generic forms and its
 * terminology drifts. Instead of paying for a full LLM translation, this
 * provider lets Argos produce the DRAFT and a small local instruct model
 * (Gemma 3 4B/12B via llama.cpp) only REPAIR it with document context — the
 * shared review core in refinement.ts (character sheet, scene batches,
 * rolling window). See that module for the research backing + failure posture.
 */
import type { TranslationInput, TranslationResult } from '@videodubber/shared';
import type { CancellableTranslationProvider } from '../types.js';
import type { LocalLlmTranslationProvider } from './localLlmTranslationProvider.js';
import { translationContextEnabled } from './translationContext.js';
import {
  reviewToTranslationResult,
  reviewTranslations,
  toPromptSegments,
  type ReviewChat,
} from './refinement.js';

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
    if (!translationContextEnabled()) return draft; // kill switch: draft only
    const draftById = new Map(draft.segments.map((s) => [s.id, s.translatedText]));

    // 2. Repair with document context (analysis pass included when no sheet
    //    was provided; unusable repairs keep the draft).
    const chat: ReviewChat = this.opts.chat;
    const outcome = await reviewTranslations(
      {
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        segments: toPromptSegments(input),
        draftById,
        documentContext: input.documentContext,
        mode: 'repair',
      },
      chat,
      signal,
    );
    return reviewToTranslationResult(outcome);
  }
}

/**
 * Cloud translation via a chat LLM (OpenAI / Anthropic Claude / Google Gemini).
 *
 * One provider class covers all three services:
 *   - OpenAI and Gemini speak the same chat-completions dialect (Gemini via its
 *     official OpenAI-compatible endpoint), differing only in base URL, model
 *     and auth header.
 *   - Anthropic uses its native /v1/messages API.
 *
 * Segments are translated in batches: the model receives a numbered list and
 * must return STRICT JSON `{"segments":[{"id","text"}]}`. Missing ids fall back
 * to the source text (the editor flags them for review) rather than failing the
 * whole pipeline. SDK-free by design — see cloudHttp.ts.
 */
import {
  normalizeLanguageCode,
  type CloudServiceId,
  type TranslationInput,
  type TranslationResult,
  type TranslationResultSegment,
} from '@videodubber/shared';
import type { CancellableTranslationProvider } from '../types.js';
import type { CredentialsStore } from '../../credentials/credentialsStore.js';
import { cloudPostJson, extractJsonObject, requireCredential, SERVICE_LABELS } from '../cloud/cloudHttp.js';
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

function envIntDefault(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max segments per LLM request (cap; a batch may be smaller when text is long). */
const MAX_BATCH_SEGMENTS = envIntDefault('CLOUD_LLM_BATCH_SIZE', 25);
/**
 * Soft cap on source-text characters per request. A batch of 25 SHORT subtitle
 * lines still goes in one request (unchanged), but a run of very long lines is
 * split into smaller requests so the prompt can't overflow a smaller model's
 * context window or truncate its JSON reply. ~8000 source chars ≈ a couple
 * thousand input tokens plus a similar response budget.
 */
const MAX_BATCH_CHARS = envIntDefault('CLOUD_LLM_MAX_PROMPT_CHARS', 8000);

/** Per-service chat defaults (model overridable via stored credentials). */
const SERVICE_DEFAULTS: Record<
  CloudServiceId,
  { baseUrl: string; model: string; dialect: 'openai' | 'anthropic' }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', dialect: 'openai' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    dialect: 'openai',
  },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5-20251001', dialect: 'anthropic' },
};

/** A segment for prompting: id + source text, plus optional timing for fitting. */
export interface PromptSegment {
  id: string;
  sourceText: string;
  startMs?: number;
  endMs?: number;
}

/**
 * Group segments into request batches respecting BOTH a max segment count and a
 * soft source-character budget — so 25 short lines still batch together, but a
 * run of very long lines is split into smaller requests that won't overflow a
 * model's context window or truncate its JSON reply. Pure / unit-tested.
 */
export function planTranslationBatches(
  segments: PromptSegment[],
  maxSegments = MAX_BATCH_SEGMENTS,
  maxChars = MAX_BATCH_CHARS,
): PromptSegment[][] {
  const batches: PromptSegment[][] = [];
  let current: PromptSegment[] = [];
  let chars = 0;
  for (const seg of segments) {
    const segChars = seg.id.length + seg.sourceText.length + 40; // + per-line overhead
    if (current.length > 0 && (current.length >= maxSegments || chars + segChars > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(seg);
    chars += segChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** How a spoken-length budget is counted in the target language. */
export type BudgetUnit = 'words' | 'syllables' | 'characters';

/**
 * Per-language speaking rates for the duration budget. Vietnamese is written
 * one syllable per whitespace-separated token, so a SYLLABLE budget is exactly
 * countable — and Vietnamese (like Chinese/Japanese) has no useful "word"
 * count. Rates are deliberately a touch under natural speed so the line fits
 * without stretching. Everything else uses the ~2.8 words/s heuristic.
 */
const BUDGET_RATES: Record<string, { unit: BudgetUnit; perSecond: number }> = {
  vi: { unit: 'syllables', perSecond: 4.6 },
  zh: { unit: 'characters', perSecond: 4.2 },
  ja: { unit: 'characters', perSecond: 5.5 },
};
const DEFAULT_RATE = { unit: 'words' as BudgetUnit, perSecond: 2.8 };

/** The spoken-length budget that fits a window, in target-language units. */
export function speechBudget(
  targetLanguage: string,
  startMs?: number,
  endMs?: number,
): { amount: number; unit: BudgetUnit } | undefined {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return undefined;
  const seconds = Math.max(0, endMs - startMs) / 1000;
  if (seconds <= 0) return undefined;
  const base = targetLanguage.split('-')[0]!.toLowerCase();
  const rate = BUDGET_RATES[base] ?? DEFAULT_RATE;
  return { amount: Math.max(1, Math.round(seconds * rate.perSecond)), unit: rate.unit };
}

/** Human wording for a budget unit ("syllables (âm tiết)" for Vietnamese). */
export function budgetUnitLabel(unit: BudgetUnit, targetLanguage: string): string {
  if (unit === 'syllables' && targetLanguage.split('-')[0]!.toLowerCase() === 'vi') return 'syllables (âm tiết)';
  return unit;
}

/**
 * Build the strict-JSON translation prompt for one batch.
 *
 * Duration-aware: when a segment carries timing, the prompt states the spoken
 * time window and a target budget IN TARGET-LANGUAGE UNITS (Vietnamese
 * syllables, Chinese characters, otherwise words) so the model produces a line
 * that fits without heavy time-stretching downstream.
 *
 * Context-aware: an optional `context` block (synopsis, cast, glossary,
 * pronoun/address plan, previous translated lines — see translationContext.ts)
 * is prepended so pronouns, registers, and terminology stay consistent across
 * the whole video instead of resetting at every request.
 */
export function buildTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  segments: PromptSegment[],
  context?: string,
): string {
  const unitLabel = (unit: BudgetUnit): string => budgetUnitLabel(unit, targetLanguage);
  const list = segments
    .map((s) => {
      const budget = speechBudget(targetLanguage, s.startMs, s.endMs);
      const hint =
        budget !== undefined
          ? `  [spoken window: ${((s.endMs! - s.startMs!) / 1000).toFixed(1)}s; target ${budget.amount} ${unitLabel(budget.unit)} or fewer]`
          : '';
      // Collapse any internal line breaks so each segment stays on one line of
      // the numbered list the model reads.
      const oneLine = s.sourceText.replace(/\s*\r?\n\s*/g, ' ');
      return `${s.id}: ${oneLine}${hint}`;
    })
    .join('\n');
  return [
    `Translate the following subtitle segments from "${sourceLanguage}" to "${targetLanguage}".`,
    ...(context ? [context] : []),
    'Rules:',
    '- These are spoken dialogue lines for dubbing: they must fit the original spoken time window. Favor concise, natural phrasing over literal completeness — drop filler and redundancy so the line is no longer than it needs to be.',
    '- When a target length budget is given, treat it as a firm ceiling: a shorter line that fits the timing is BETTER than a complete line that overflows. Stay at or under the budget.',
    '- Preserve names, numbers, and the tone of the original.',
    '- Keep pronouns and terms of address consistent with the context and across ALL segments: pick the forms the speaker relationships call for (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con — not a generic default) and never switch mid-conversation.',
    '- Use the same terminology for the same things across segments.',
    '- Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — no prose, no markdown fences. One entry per input segment id; never merge or split segments.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

/** Display names for the common dubbing languages (falls back to the code). */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', vi: 'Vietnamese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', ar: 'Arabic', hi: 'Hindi', th: 'Thai', id: 'Indonesian',
  nl: 'Dutch', pl: 'Polish', tr: 'Turkish', uk: 'Ukrainian', cs: 'Czech',
  ro: 'Romanian', el: 'Greek', sv: 'Swedish', da: 'Danish', fi: 'Finnish',
  no: 'Norwegian', hu: 'Hungarian', he: 'Hebrew', fa: 'Persian', ms: 'Malay',
  tl: 'Filipino', km: 'Khmer', lo: 'Lao', my: 'Burmese', bn: 'Bengali',
};

/** Display name for a language code ("en" -> "English"); falls back to the code. */
function languageName(code: string): string {
  const base = code.split('-')[0]!.toLowerCase();
  return LANGUAGE_NAMES[base] ?? code;
}

/**
 * Build a single-segment raw-MT prompt for translation-SPECIALIZED models
 * (TranslateGemma, Seed-X, etc.) that take one source text and return plain text.
 *
 * This reproduces TranslateGemma's OWN trained chat-template instruction
 * VERBATIM (verified against the published `chat_template.jinja`: the
 * "You are a professional <Src> (<src>) to <Tgt> (<tgt>) translator … Please
 * translate the following <Src> text into <Tgt>:\n\n\n<text>" body). Because we
 * drive llama.cpp's raw `/completion` endpoint and wrap this in the Gemma turn
 * ourselves (the server's own TranslateGemma template is broken), matching the
 * trained text byte-for-byte keeps the model in-distribution. The model card's
 * template appends `<end_of_turn>` DIRECTLY after the trimmed text (no newline),
 * which is exactly what {@link wrapGemmaTurn} relies on.
 *
 * The one deliberate addition is the dubbing `fit` sentence (a target word
 * budget) when timing is known. Source text is CRLF-normalized + trimmed (a
 * stray `\r` is a known cause of garbled local-LLM output, and the template
 * trims too).
 */
export function buildRawTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  segment: PromptSegment,
): string {
  const sName = languageName(sourceLanguage);
  const tName = languageName(targetLanguage);
  const budget = speechBudget(targetLanguage, segment.startMs, segment.endMs);
  const fit =
    budget !== undefined
      ? ` Keep it to ${budget.amount} ${budgetUnitLabel(budget.unit, targetLanguage)} or fewer so it fits the spoken dubbing timing; prefer a concise line that fits over a longer, more literal one.`
      : '';
  const text = segment.sourceText.replace(/\r\n?/g, '\n').trim();
  return (
    `You are a professional ${sName} (${sourceLanguage}) to ${tName} (${targetLanguage}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${sName} text while adhering to ` +
    `${tName} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${tName} translation, without any additional explanations or commentary.${fit} ` +
    `Please translate the following ${sName} text into ${tName}:\n\n\n${text}`
  );
}

/** Parse the model reply into id->text, tolerating fences and stray prose. */
export function parseTranslationReply(reply: string): Map<string, string> {
  const parsed = extractJsonObject(reply) as
    | { segments?: { id?: unknown; text?: unknown }[] }
    | undefined;
  const out = new Map<string, string>();
  for (const seg of parsed?.segments ?? []) {
    if (typeof seg.id === 'string' && typeof seg.text === 'string') {
      out.set(seg.id, seg.text);
    }
  }
  return out;
}

/** Minimal fetch-like seam so tests can stub network calls. */
export type PostJsonFn = typeof cloudPostJson;

/** Chat-LLM translation provider for one cloud service. */
export class LlmTranslationProvider implements CancellableTranslationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal = false;
  readonly credentialService: CloudServiceId;

  constructor(
    service: CloudServiceId,
    private readonly credentials: CredentialsStore,
    private readonly timeoutMs: number,
    private readonly postJson: PostJsonFn = cloudPostJson,
  ) {
    this.credentialService = service;
    this.id = `${service}-translate`;
    this.displayName = `${SERVICE_LABELS[service]} translation (cloud)`;
  }

  async translateSegments(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const defaults = SERVICE_DEFAULTS[this.credentialService];
    const baseUrl = (cred.baseUrl ?? defaults.baseUrl).replace(/\/$/, '');
    const model = cred.model ?? defaults.model;

    const source = normalizeLanguageCode(input.sourceLanguage);
    const target = normalizeLanguageCode(input.targetLanguage);

    const send = (prompt: string, system?: string): Promise<string> =>
      defaults.dialect === 'anthropic'
        ? this.callAnthropic(baseUrl, cred.apiKey, model, prompt, signal, system)
        : this.callOpenAiCompatible(baseUrl, cred.apiKey, model, prompt, signal, system);

    // Document-level context: the project's character sheet (synopsis, cast,
    // glossary, pronoun/address plan) keeps Vietnamese xưng hô and terminology
    // consistent across batches. A sheet provided by the caller (persisted /
    // user-edited) is authoritative; otherwise one analysis pass generates it
    // and it is returned for persistence. Best-effort: an analysis failure must
    // never fail the translation itself.
    const provided = input.documentContext;
    const useContext =
      translationContextEnabled() && (provided !== undefined || input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS);
    let analysis: TranslationAnalysis | undefined = provided;
    let generated: TranslationAnalysis | undefined;
    if (useContext && analysis === undefined) {
      generated = await send(
        buildAnalysisPrompt(source, target, buildAnalysisSample(input.segments)),
        'You prepare structured notes for dubbing translators. Respond with strict JSON only.',
      )
        .then(parseAnalysisReply)
        .catch(() => undefined);
      analysis = generated;
    }

    // Scene-aware batches + a rolling window of the previous batch's translated
    // pairs, so style/pronoun decisions flow across request boundaries.
    const batches = planContextBatches(input.segments, {
      maxSegments: MAX_BATCH_SEGMENTS,
      maxChars: MAX_BATCH_CHARS,
    });
    const results: TranslationResultSegment[] = [];
    let previousBatch: PromptSegment[] | undefined;
    let rolling: RollingPair[] = [];
    for (const batch of batches) {
      const context = useContext
        ? buildContextHeader({ analysis, previousPairs: rolling, sceneBreak: isSceneBreak(previousBatch, batch) })
        : undefined;
      const prompt = buildTranslationPrompt(source, target, batch, context || undefined);
      const reply = await send(prompt);

      const byId = parseTranslationReply(reply);
      for (const seg of batch) {
        // Missing translation: fall back to the source text so the pipeline
        // continues; the editor surfaces it for manual review.
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
      rolling = collectRollingPairs(batch, byId);
      previousBatch = batch;
    }

    return { segments: results, ...(generated ? { analysis: generated } : {}) };
  }

  /** OpenAI-compatible chat completion (OpenAI itself + Gemini compat). */
  private async callOpenAiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    signal?: AbortSignal,
    system = 'You are a professional subtitle/dubbing translator.',
  ): Promise<string> {
    const data = await this.postJson<{ choices?: { message?: { content?: string } }[] }>(
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
      { service: this.credentialService, timeoutMs: this.timeoutMs, signal },
    );
    return data.choices?.[0]?.message?.content ?? '';
  }

  /** Anthropic /v1/messages call. */
  private async callAnthropic(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    signal?: AbortSignal,
    system = 'You are a professional subtitle/dubbing translator. Respond with strict JSON only.',
  ): Promise<string> {
    const data = await this.postJson<{ content?: { type: string; text?: string }[] }>(
      `${baseUrl}/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: prompt }],
      },
      { service: this.credentialService, timeoutMs: this.timeoutMs, signal },
    );
    return (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }
}

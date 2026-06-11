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

/** Words that fit naturally in a window, assuming ~2.8 spoken words/second. */
function targetWords(startMs?: number, endMs?: number): number | undefined {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return undefined;
  const seconds = Math.max(0, endMs - startMs) / 1000;
  return seconds > 0 ? Math.max(1, Math.round(seconds * 2.8)) : undefined;
}

/**
 * Build the strict-JSON translation prompt for one batch.
 *
 * Duration-aware: when a segment carries timing, the prompt states the spoken
 * time window and a target word budget so the model produces a line that fits
 * without heavy time-stretching downstream (the "HeyGen trick" from the
 * research). This is a free quality win on cloud and local alike.
 */
export function buildTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  segments: PromptSegment[],
): string {
  const list = segments
    .map((s) => {
      const words = targetWords(s.startMs, s.endMs);
      const hint =
        words !== undefined
          ? `  [spoken window: ${((s.endMs! - s.startMs!) / 1000).toFixed(1)}s; target ${words} words or fewer]`
          : '';
      return `${s.id}: ${s.sourceText}${hint}`;
    })
    .join('\n');
  return [
    `Translate the following subtitle segments from "${sourceLanguage}" to "${targetLanguage}".`,
    'Rules:',
    '- These are spoken dialogue lines for dubbing: they must fit the original spoken time window. Favor concise, natural phrasing over literal completeness — drop filler and redundancy so the line is no longer than it needs to be.',
    '- When a target word budget is given, treat it as a firm ceiling: a shorter line that fits the timing is BETTER than a complete line that overflows. Stay at or under the budget.',
    '- Preserve names, numbers, and the tone of the original.',
    '- Translate each segment independently but consistently (same terms across segments).',
    '- Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — no prose, no markdown fences.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

/**
 * Build a single-segment raw-MT prompt for translation-SPECIALIZED models
 * (TranslateGemma, Seed-X, etc.) that expect one source text and return plain
 * translated text rather than chat JSON.
 */
export function buildRawTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  segment: PromptSegment,
): string {
  const words = targetWords(segment.startMs, segment.endMs);
  const fit =
    words !== undefined
      ? ` Keep it to ${words} words or fewer so it fits the spoken timing — for dubbing, prefer a concise line that fits over a longer, more literal one.`
      : '';
  return `Translate from ${sourceLanguage} to ${targetLanguage}. Output ONLY the translation, no quotes or notes.${fit}\n\n${segment.sourceText}`;
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

    const results: TranslationResultSegment[] = [];
    for (const batch of planTranslationBatches(input.segments)) {
      const prompt = buildTranslationPrompt(source, target, batch);
      const reply =
        defaults.dialect === 'anthropic'
          ? await this.callAnthropic(baseUrl, cred.apiKey, model, prompt, signal)
          : await this.callOpenAiCompatible(baseUrl, cred.apiKey, model, prompt, signal);

      const byId = parseTranslationReply(reply);
      for (const seg of batch) {
        // Missing translation: fall back to the source text so the pipeline
        // continues; the editor surfaces it for manual review.
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
    }

    return { segments: results };
  }

  /** OpenAI-compatible chat completion (OpenAI itself + Gemini compat). */
  private async callOpenAiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const data = await this.postJson<{ choices?: { message?: { content?: string } }[] }>(
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: [
          { role: 'system', content: 'You are a professional subtitle/dubbing translator.' },
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
  ): Promise<string> {
    const data = await this.postJson<{ content?: { type: string; text?: string }[] }>(
      `${baseUrl}/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: 8192,
        system: 'You are a professional subtitle/dubbing translator. Respond with strict JSON only.',
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

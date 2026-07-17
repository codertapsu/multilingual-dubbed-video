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
  AppErrorException,
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
  opts?: {
    /**
     * Retry emphasis: a previous reply skipped these segments or echoed the
     * source back. Prepends a hard "translate EVERY segment" directive.
     */
    insist?: boolean;
  },
): string {
  const unitLabel = (unit: BudgetUnit): string => budgetUnitLabel(unit, targetLanguage);
  const tName = languageName(targetLanguage);
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
    ...(opts?.insist
      ? [
          `IMPORTANT: a previous attempt left some of these segments untranslated. You MUST translate EVERY segment below into ${tName} — do not skip any, and do not return the source text unchanged.`,
        ]
      : []),
    ...(context ? [context] : []),
    'Rules:',
    '- These are spoken dialogue lines for dubbing: they must fit the original spoken time window. Favor concise, natural phrasing over literal completeness — drop filler and redundancy so the line is no longer than it needs to be.',
    '- When a target length budget is given, treat it as a firm ceiling: a shorter line that fits the timing is BETTER than a complete line that overflows. Stay at or under the budget.',
    '- Preserve names, numbers, and the tone of the original.',
    `- EVERY segment must be rendered in ${tName} — never return a line unchanged and never leave source-script characters in the output. Render names with the target language's convention (e.g. Chinese names into Sino-Vietnamese when translating into Vietnamese: 唐三藏 → Đường Tam Tạng). When the context lists a name as "target form (source form)", use ONLY the target form in the spoken line — never copy the parenthesized source form.`,
    '- Keep pronouns and terms of address consistent with the context and across ALL segments: pick the forms the speaker relationships call for (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con — not a generic default) and never switch mid-conversation.',
    '- Use the same terminology for the same things across segments.',
    '- The "text" value must be ONLY the spoken translation. Never copy the bracketed timing hints, segment ids, or any annotation into it — no "(4 syllables)", no "[spoken window...]", no repeated copy of the line.',
    '- Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — no prose, no markdown fences. One entry per input segment id; never merge or split segments.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

// ---- Batch recovery (missing ids / source echoes) ---------------------------

/** True when a reply line is effectively "not translated": absent, empty, or
 * the source text echoed back (compared punctuation/case-insensitively). Only
 * meaningful when source and target languages differ.
 *
 * Identical-to-source is only damning when the source actually needed
 * transforming: a CJK-script source in a non-CJK dub can NEVER legitimately
 * survive verbatim (the voice can't say it), while short Latin lines often do
 * ("OK", "2023", "Anna!", "iPhone 15", "No, no, no!"). So: CJK echo → always a
 * failure; otherwise only a substantial line (≥15 normalized chars) counts —
 * flagging those short lines would burn retries and pressure the model into
 * mutating already-correct output. */
export function looksUntranslated(seg: PromptSegment, text: string | undefined): boolean {
  if (text === undefined || text.trim().length === 0) return true;
  const src = normalizeForCompare(seg.sourceText);
  if (src.length < 2 || normalizeForCompare(text) !== src) return false;
  if (CJK_RE.test(seg.sourceText)) return true;
  return src.length >= 15;
}

/** True for cancellation/timeout errors that must ABORT recovery, not be
 * swallowed as a per-line failure (structural checks: no hard dependency on
 * the throwing layer). */
function isCancellation(err: unknown): boolean {
  const name = (err as Error | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = (err as { appError?: { code?: string } } | undefined)?.appError?.code;
  return code === 'CANCELLED' || code === 'WORKER_TIMEOUT';
}

/** Transport hooks {@link recoverBatch} drives (per provider). */
export interface BatchRecoveryIO {
  /** JSON-batch request over a subset of segments, with retry emphasis. */
  sendBatch: (segments: PromptSegment[], insist: boolean) => Promise<string>;
  /**
   * Optional last-resort per-line request: a plain raw-MT prompt returning the
   * bare translation (no JSON to comply with — the most robust shape for small
   * local models). Absent for transports without a plain-text mode.
   */
  sendSingle?: (segment: PromptSegment) => Promise<string>;
}

/**
 * Recover a batch's unresolved lines instead of silently keeping source text.
 *
 * Small local models routinely violate the batch contract: a truncated or
 * malformed JSON reply loses the WHOLE batch, and weak compliance leaves
 * individual lines skipped or echoed back untranslated. (A real zh→vi run left
 * 169/795 lines in Chinese this way — silently.) The ladder:
 *
 *   1. detect unresolved lines (missing / empty / source echo),
 *   2. ONE batch retry over just those lines with an explicit directive,
 *   3. per-line raw-prompt fallback where the transport supports it.
 *
 * Returns the merged id→text map; anything still unresolved keeps whatever the
 * model produced (or nothing — the caller's per-line source fallback applies).
 * Errors from retry calls degrade gracefully (the earlier result stands).
 */
export async function recoverBatch(
  batch: PromptSegment[],
  byId: Map<string, string>,
  io: BatchRecoveryIO,
  detectSourceEcho: boolean,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Translation was cancelled.');
  };
  const unresolved = (): PromptSegment[] =>
    batch.filter((s) => {
      const text = byId.get(s.id);
      if (text === undefined || text.trim().length === 0) return true;
      return detectSourceEcho && looksUntranslated(s, text);
    });

  let missing = unresolved();
  if (missing.length === 0) return byId;

  // Rung 2: one emphatic batch retry over just the unresolved lines.
  throwIfAborted();
  try {
    const retryById = parseTranslationReply(await io.sendBatch(missing, true));
    for (const seg of missing) {
      const text = retryById.get(seg.id);
      if (text !== undefined && text.trim().length > 0 && !(detectSourceEcho && looksUntranslated(seg, text))) {
        byId.set(seg.id, text);
      }
    }
  } catch (err) {
    // Cancellation/timeout must abort the run, not degrade into fallbacks —
    // otherwise a cancel during the last batch "succeeds" with untranslated
    // lines and the completed step is never re-run on resume.
    if (isCancellation(err)) throw err;
    /* otherwise keep what we have; the per-line rung may still recover */
  }

  // Rung 3: per-line raw prompts (no JSON contract to violate). A few lanes in
  // parallel — a persistently-failing batch is up to 20 extra calls, and a
  // strictly serial loop would dominate the step's wall-clock.
  missing = unresolved();
  if (missing.length > 0 && io.sendSingle) {
    const lanes = Math.min(3, missing.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (next < missing.length) {
          const seg = missing[next++]!;
          throwIfAborted();
          try {
            const text = sanitizeTranslatedLine(await io.sendSingle!(seg));
            if (text.length > 0 && !(detectSourceEcho && looksUntranslated(seg, text))) {
              byId.set(seg.id, text);
            }
          } catch (err) {
            if (isCancellation(err)) throw err;
            /* leave unresolved — the caller's source-text fallback applies */
          }
        }
      }),
    );
  }

  // Drop still-unresolved entries entirely: a lingering echo (even one with a
  // cosmetic punctuation delta) would otherwise (a) ship as the "translation"
  // while dodging the exact-equality warnings downstream, and (b) poison the
  // rolling-context exemplars with "source -> source" pairs that teach the
  // model that echoing is acceptable. Absent entries fall back to the source
  // text at the call site AND stay visible to the runner warning/editor badge.
  for (const seg of unresolved()) byId.delete(seg.id);
  return byId;
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

/** Case/punctuation/width-insensitive comparison key for echo detection. */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .normalize('NFC');
}

/** CJK detection (Han/Kana/Hangul) — the scripts a spoken vi/en dub can't say. */
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Bracket/paren content that IS a leaked timing/budget annotation — matched
 * against the WHOLE inner text (anchored both ends), so legitimate
 * parentheticals that merely START with a digit are preserved. The
 * seconds-form requires a decimal ("2.5s") so decades ("1980s") and ages
 * ("20s") survive, and unit words are matched as full alternatives so
 * "(2 số cuối)" / "(2 từ thôi)" survive too.
 */
const HINT_ECHO_RE =
  /^(?:spoken window\b.*|target\s*\d.*|≤\s*\d.*|\d+[.,]\d+\s*(?:s|secs?|seconds?|giây)|\d+\s*(?:syllables?|âm tiết|characters?|words?|từ|ký tự)(?:\s*(?:or fewer|trở xuống))?)$/iu;

/** A trailing bracketed group, tolerating ONE level of nesting inside (the
 * standard vi hint "[... 11 syllables (âm tiết) or fewer]" nests parens). */
const TRAILING_GROUP_RE = /^(.*\S)\s*[([]((?:[^()[\]]|\([^()[\]]*\)|\[[^()[\]]*\])*)[)\]]$/s;
/** A line that is NOTHING but one bracketed group (same nesting tolerance). */
const WHOLE_LINE_GROUP_RE = /^[([]((?:[^()[\]]|\([^()[\]]*\)|\[[^()[\]]*\])*)[)\]]$/s;

/**
 * Clean one translated line of the artifacts weak models leak from the prompt:
 *   - a `seg_0001:`-style id echo at the head,
 *   - quotes wrapping the WHOLE line,
 *   - a trailing bracketed/parenthesized duplicate of the line itself
 *     (mimicking the prompt's `text  [hint]` layout),
 *   - trailing bracketed/parenthesized budget-hint echoes
 *     ("(4 syllables)", "[spoken window: 2.5s; target 11 syllables (âm tiết) or fewer]"), and
 *   - a line that is NOTHING but the annotation (returned as '' so the
 *     recovery ladder treats it as unresolved instead of speaking it).
 * Legit content is preserved: only trailing groups that duplicate the text or
 * match the hint grammar are removed; a fully-bracketed non-hint line
 * ("[âm nhạc]") is left alone. Passes run to a fixpoint so compound artifacts
 * ('"seg_0001: Xin chào."') are fully cleaned. Pure / unit-tested.
 */
export function sanitizeTranslatedLine(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();

  // Quotes wrapping the whole line (curly, double, or CJK corner quotes).
  // Deliberately NOT the straight apostrophe: both ends of a line can be
  // legitimate elision marks ("'Cause we keep on runnin'").
  const quotePairs: [string, string][] = [['"', '"'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];

  // Run all passes to a fixpoint: artifacts nest ('"seg_0001: Xin chào."'
  // needs quote-strip then id-strip; 'text" (text)"' the reverse).
  for (let pass = 0; pass < 4; pass++) {
    const before = out;

    // Leading segment-id echo ("seg_0001: ...").
    out = out.replace(/^seg[_-]?\d{1,6}\s*[:.\-–—]\s*/i, '').trim();

    for (const [open, close] of quotePairs) {
      if (
        out.length > 2 &&
        out.startsWith(open) &&
        out.endsWith(close) &&
        !out.slice(1, -1).includes(open) &&
        !out.slice(1, -1).includes(close)
      ) {
        out = out.slice(1, -1).trim();
      }
    }

    // Trailing bracketed/parenthesized groups that are duplicates or hint
    // echoes. Loop: a line can carry several ("text (text) [4 syllables]").
    for (;;) {
      const m = out.match(TRAILING_GROUP_RE);
      if (!m) break;
      const head = m[1]!;
      const inner = m[2]!.trim();
      const isDuplicate = inner.length > 0 && normalizeForCompare(inner) === normalizeForCompare(head);
      const isHintEcho = HINT_ECHO_RE.test(inner);
      if (!isDuplicate && !isHintEcho) break;
      out = head.trim();
    }

    if (out === before) break;
  }

  // A line that is ONLY the annotation ("(4 âm tiết)", "[spoken window: ...]")
  // is no translation at all — empty it so recovery/fallback kicks in.
  const whole = out.match(WHOLE_LINE_GROUP_RE);
  if (whole && HINT_ECHO_RE.test(whole[1]!.trim())) return '';

  return out;
}

/** Parse the model reply into id->text (sanitized), tolerating fences and prose. */
export function parseTranslationReply(reply: string): Map<string, string> {
  const parsed = extractJsonObject(reply) as
    | { segments?: { id?: unknown; text?: unknown }[] }
    | undefined;
  const out = new Map<string, string>();
  for (const seg of parsed?.segments ?? []) {
    if (typeof seg.id === 'string' && typeof seg.text === 'string') {
      out.set(seg.id, sanitizeTranslatedLine(seg.text));
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
  /** Instruction-following + context-capable → can run the refine pass. */
  readonly supportsRefinement = true;

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

  /**
   * One-shot chat completion (system + user → text) — the primitive the
   * review/refine pass drives. Credentials resolve per call, like
   * translateSegments.
   */
  async chatComplete(system: string | undefined, user: string, signal?: AbortSignal): Promise<string> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const defaults = SERVICE_DEFAULTS[this.credentialService];
    const baseUrl = (cred.baseUrl ?? defaults.baseUrl).replace(/\/$/, '');
    const model = cred.model ?? defaults.model;
    const sys = system ?? 'You are a professional subtitle/dubbing translator.';
    return defaults.dialect === 'anthropic'
      ? this.callAnthropic(baseUrl, cred.apiKey, model, user, signal, sys)
      : this.callOpenAiCompatible(baseUrl, cred.apiKey, model, user, signal, sys);
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
    const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];
    let previousBatch: PromptSegment[] | undefined;
    let rolling: RollingPair[] = [];
    for (const batch of batches) {
      const context = useContext
        ? buildContextHeader({ analysis, previousPairs: rolling, sceneBreak: isSceneBreak(previousBatch, batch) })
        : undefined;
      const prompt = buildTranslationPrompt(source, target, batch, context || undefined);
      const reply = await send(prompt);

      // Recover skipped/echoed lines with one emphatic retry instead of
      // silently keeping the source text. (No per-line raw rung here: the
      // JSON response_format is pinned on this transport, and cloud models'
      // batch compliance makes the retry sufficient.)
      const byId = await recoverBatch(batch, parseTranslationReply(reply), {
        sendBatch: (segs, insist) => send(buildTranslationPrompt(source, target, segs, context || undefined, { insist })),
      }, detectSourceEcho, signal);
      for (const seg of batch) {
        // Still-missing translation: fall back to the source text so the
        // pipeline continues; the runner + editor surface it for review.
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

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
import { claudeMessage, DEFAULT_CLAUDE_MODEL, sdkSend, type ClaudeSend } from '../cloud/claudeMessages.js';
import {
  buildContextHeader,
  collectRollingPairs,
  generateCharacterSheet,
  isSceneBreak,
  MIN_SEGMENTS_FOR_ANALYSIS,
  planContextBatches,
  translationContextEnabled,
  type RollingPair,
  type TranslationAnalysis,
} from './translationContext.js';
import { looksUntranslated, normalizeForCompare } from './lineQuality.js';
import { budgetPhrase, segmentFitBudget, withFitWindows } from './speechFit.js';

// The echo check moved to lineQuality.ts (every per-line check lives there);
// re-exported because the runner and tests import it from here.
export { looksUntranslated };

/**
 * Per-call options for {@link LlmTranslationProvider.chatComplete} and the
 * local provider's equivalent. Engines that cannot honour an option ignore it.
 */
export interface ChatOptions {
  /**
   * JSON schema the reply must match. llama-server enforces it with a grammar
   * (`json_schema` on /completion — verified on the pinned build b12110); the
   * cloud transports keep their existing JSON mode and the prompt's own
   * format instructions.
   */
  jsonSchema?: Record<string, unknown>;
  /** Reply token budget. */
  maxTokens?: number;
  /**
   * Sampling temperature, for the transports that honour it (the local
   * llama.cpp one, 0 by default there). A retry raises it: at 0 a local model
   * answers an identical prompt with the identical unusable reply.
   */
  temperature?: number;
}

/**
 * What the pipeline passes beyond the shared {@link TranslationInput} contract.
 * Optional on purpose: other callers (the eval script, the Argos+repair tier)
 * keep sending a plain TranslationInput.
 */
export interface DubbingTranslationExtras {
  /**
   * Speaking rate of the voice that will say these lines, in the target's
   * budget unit per second (Vietnamese syllables/s). Without it budgets use
   * the shared language default, which is ~30% too generous for VieNeu.
   */
  speechRate?: number;
  /**
   * The caller already ran (or deliberately did not run) the character-sheet
   * analysis; providers must not start another. The pipeline drives the
   * analysis itself so a failure is reported instead of swallowed.
   */
  skipAnalysis?: boolean;
  /**
   * Lines translated so far, out of all of them, called as batches (or, line
   * by line, requests) finish. The step reported nothing of its own: a
   * 31-minute dub sat at "translation 0%" for 11.5 minutes, with no log line
   * for nine, which reads as stuck to a user and to Claude (get_project).
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * Lines an earlier, unfinished run of this same translation already did, by
   * id (a pause, a closed app, a crash). A batch whose lines are all here is
   * not sent again, and still serves as context for the next one. Only the
   * pipeline sets it, and only for an unchanged translation
   * (pipeline/translationCheckpoint.ts).
   */
  resume?: ReadonlyMap<string, string>;
  /**
   * Each batch's lines as it finishes, the ones the engine really translated
   * (a line left in the source is not one), so the pipeline can save them.
   */
  onBatch?: (lines: readonly TranslationResultSegment[]) => void;
}

/** A {@link TranslationInput} with the pipeline's extras. */
export type DubbingTranslationInput = TranslationInput & DubbingTranslationExtras;

/**
 * The lines of `batch` from an earlier run, when every one of them is there. A
 * batch with any line missing is translated again whole: its lines are written
 * together, as one passage.
 */
export function resumedBatch(
  batch: readonly { id: string }[],
  resume: ReadonlyMap<string, string> | undefined,
): Map<string, string> | undefined {
  if (!resume || resume.size === 0 || batch.length === 0) return undefined;
  const lines = new Map<string, string>();
  for (const seg of batch) {
    const text = resume.get(seg.id);
    if (text === undefined) return undefined;
    lines.set(seg.id, text);
  }
  return lines;
}

/** The lines of a finished batch the engine really translated, for {@link DubbingTranslationExtras.onBatch}. */
export function translatedLines(
  batch: readonly { id: string }[],
  byId: ReadonlyMap<string, string>,
): TranslationResultSegment[] {
  return batch.filter((s) => byId.has(s.id)).map((s) => ({ id: s.id, translatedText: byId.get(s.id)! }));
}

/** JSON schema for a `{"segments":[{"id","text"}]}` reply covering exactly `ids`. */
export function segmentsReplySchema(ids: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: [...ids] }, text: { type: 'string' } },
          required: ['id', 'text'],
        },
      },
    },
    required: ['segments'],
  };
}

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
    model: 'gemini-3.5-flash',
    dialect: 'openai',
  },
  // Claude goes through the official SDK (providers/cloud/claudeMessages.ts);
  // the model is the user's choice in Settings, Claude Opus 5.5 by default.
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: DEFAULT_CLAUDE_MODEL, dialect: 'anthropic' },
};

/** A segment for prompting: id + source text, plus optional timing for fitting. */
export interface PromptSegment {
  id: string;
  sourceText: string;
  startMs?: number;
  endMs?: number;
  /**
   * Diarization speaker id, when the STT step produced one. Rendered into the
   * prompt so the model can keep a speaker's register/pronouns stable instead of
   * re-deciding them line by line (see buildTranslationPrompt).
   */
  speakerId?: string;
  /**
   * The window (ms) the line may fill — its cue plus a capped share of the
   * pause after it (speechFit.ts). Set from the FULL transcript before
   * batching, so a line at the end of a batch still sees its real successor.
   */
  fitMs?: number;
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

// The spoken-length budget moved to @videodubber/shared so the editor and the
// MCP server count exactly what these prompts count; re-exported for callers.
import { budgetUnitLabel, speechBudget, type BudgetUnit } from '@videodubber/shared';
import { viEstablishedNamesRule } from './viNames.js';
export { budgetUnitLabel, speechBudget };
export type { BudgetUnit };

/**
 * The source line is speech recognition, not a script. Said once in every
 * prompt that reads source lines: an audit of four zh→vi dubs (2026-11) found
 * recognizer homophones translated literally into invented names (a misheard
 * 普贤 became a new character), because nothing told the model the text could
 * be wrong.
 */
export const ASR_SOURCE_NOTE =
  'The source lines are automatic speech recognition of the audio: they can contain homophone errors (a word written with the wrong characters that SOUND the same) and odd line breaks mid-sentence. When a word makes no sense in context, translate the most plausible word that was actually SAID — never invent a new name from a misheard word.';

/** Options for {@link buildTranslationPrompt}. */
export interface TranslationPromptOptions {
  /**
   * Retry emphasis: a previous reply skipped these segments or echoed the
   * source back. Prepends a hard "translate EVERY segment" directive.
   */
  insist?: boolean;
  /** Speaking rate of the dub voice (budget units/s); default: the language's. */
  perSecond?: number;
}

/**
 * Build the strict-JSON translation prompt for one batch.
 *
 * Duration-aware: when a segment carries timing, the prompt states the spoken
 * window and a length target with a ceiling IN TARGET-LANGUAGE UNITS
 * (Vietnamese syllables, Chinese characters, otherwise words), computed from the
 * dub voice's real speaking rate (speechFit.ts), so the model writes a line
 * that fits without heavy time-stretching — and without cutting meaning to be
 * "as short as possible", which the old ceiling-only wording invited.
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
  opts?: TranslationPromptOptions,
): string {
  const tName = languageName(targetLanguage);
  const list = segments
    .map((s) => {
      const budget = segmentFitBudget(s, targetLanguage, opts?.perSecond);
      const windowMs = s.fitMs ?? (s.endMs ?? 0) - (s.startMs ?? 0);
      const hint =
        budget !== undefined
          ? `  [spoken window: ${(windowMs / 1000).toFixed(1)}s; length: ${budgetPhrase(budget, targetLanguage)}]`
          : '';
      // Collapse any internal line breaks so each segment stays on one line of
      // the numbered list the model reads.
      const oneLine = s.sourceText.replace(/\s*\r?\n\s*/g, ' ');
      // Speaker tag (diarized runs only): the single most useful fact for
      // Vietnamese address forms, and it was being dropped on the floor.
      const who = s.speakerId ? ` (${s.speakerId})` : '';
      return `${s.id}${who}: ${oneLine}${hint}`;
    })
    .join('\n');
  // Only explain the tag when at least one line carries one.
  const hasSpeakers = segments.some((s) => s.speakerId);
  return [
    `Translate the following subtitle segments from "${sourceLanguage}" to "${targetLanguage}".`,
    ...(opts?.insist
      ? [
          `IMPORTANT: a previous attempt left some of these segments untranslated. You MUST translate EVERY segment below into ${tName} — do not skip any, and do not return the source text unchanged.`,
        ]
      : []),
    ...(context ? [context] : []),
    'Rules:',
    '- These are spoken dialogue lines for dubbing: each one is performed by a voice in the time the original speaker took. Write it the way a native speaker would SAY it — natural and concise, no filler.',
    '- When a length is given ("about N, never more than M"), aim for about N and never exceed M — while keeping the FULL meaning. Do not drop content to get below N; a line that keeps its meaning at N beats a shorter one that loses it.',
    `- ${ASR_SOURCE_NOTE}`,
    '- Preserve names, numbers, and the tone of the original.',
    `- EVERY segment must be rendered in ${tName} — never return a line unchanged and never leave source-script characters in the output. Render names with the target language's convention (e.g. Chinese names into Sino-Vietnamese when translating into Vietnamese: 唐三藏 → Đường Tam Tạng — never pinyin like "Tang Sanzang"). When the context lists a name as "target form (source form)", use ONLY the target form in the spoken line — never copy the parenthesized source form.`,
    ...(/^vi\b/i.test(targetLanguage) ? [`- ${viEstablishedNamesRule()}`] : []),
    '- Keep pronouns and terms of address consistent with the context and across ALL segments: pick the forms the speaker relationships call for (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con — not a generic default) and never switch mid-conversation.',
    ...(hasSpeakers
      ? [
          '- A name in parentheses after a segment id is WHO SPEAKS that line. Use it to keep each speaker\'s register and self-reference stable across the whole video, and to address the other speakers consistently. Never write the speaker tag into the translated text.',
        ]
      : []),
    '- Use the same terminology for the same things across segments.',
    '- Each line is spoken aloud: never offer alternatives with "/" (choose ONE form, e.g. one pronoun), never add notes or explanations.',
    '- The "text" value must be ONLY the spoken translation. Never copy the bracketed timing hints, segment ids, or any annotation into it — no "(4 syllables)", no "[spoken window...]", no repeated copy of the line.',
    '- Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — no prose, no markdown fences. One entry per input segment id; never merge or split segments.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

// ---- Batch recovery (missing ids / source echoes) ---------------------------

/** True for cancellation/timeout errors that must ABORT recovery, not be
 * swallowed as a per-line failure (structural checks: no hard dependency on
 * the throwing layer). */
export function isCancellation(err: unknown): boolean {
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
export function languageName(code: string): string {
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
 * The one deliberate addition is the dubbing `fit` sentence (a length target
 * with a ceiling) when timing is known; `plain` drops it, which is exactly the
 * trained prompt — the empty-reply retry uses that. Source text is
 * CRLF-normalized + trimmed (a stray `\r` is a known cause of garbled
 * local-LLM output, and the template trims too).
 */
export function buildRawTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  segment: PromptSegment,
  opts?: { perSecond?: number; plain?: boolean },
): string {
  const sName = languageName(sourceLanguage);
  const tName = languageName(targetLanguage);
  const budget = opts?.plain ? undefined : segmentFitBudget(segment, targetLanguage, opts?.perSecond);
  const fit =
    budget !== undefined
      ? ` Aim for ${budgetPhrase(budget, targetLanguage)}, so it fits the spoken dubbing timing, and keep the full meaning.`
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

/**
 * Bracket/paren content that IS a leaked timing/budget annotation — matched
 * against the WHOLE inner text (anchored both ends), so legitimate
 * parentheticals that merely START with a digit are preserved. The
 * seconds-form requires a decimal ("2.5s") so decades ("1980s") and ages
 * ("20s") survive, and unit words are matched as full alternatives so
 * "(2 số cuối)" / "(2 từ thôi)" survive too.
 */
const HINT_ECHO_RE =
  /^(?:spoken window\b.*|length\s*:.*|(?:xưng|gọi)\s*['"‘’“”].*|about\s+\d+\s+(?:syllables?|characters?|words?)\b.*|target\s*\d.*|≤\s*\d.*|\d+[.,]\d+\s*(?:s|secs?|seconds?|giây)|\d+\s*(?:syllables?|âm tiết|characters?|words?|từ|ký tự)(?:\s*(?:or fewer|trở xuống))?)$/iu;

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

    // A dangling quote mark at either end with no partner inside the line
    // ("Kết thúc “" — a Gemma 3 4B review pass appended one to eight lines in
    // a row). The voice cannot say it and the subtitle shows it.
    out = out.replace(/\s*[“”"]$/u, (m) => (countQuotes(out) % 2 === 1 ? '' : m)).trim();
    out = out.replace(/^[“”"]\s*/u, (m) => (countQuotes(out) % 2 === 1 ? '' : m)).trim();

    // Trailing bracketed/parenthesized groups that are duplicates or hint
    // echoes. Loop: a line can carry several ("text (text) [4 syllables]").
    // The duplicate test ignores diacritics: the same review pass appended
    // each line's tone-stripped romanization ("Ở (O)", "… ở đâu? (… o dau?)").
    for (;;) {
      const m = out.match(TRAILING_GROUP_RE);
      if (!m) break;
      const head = m[1]!;
      const inner = m[2]!.trim();
      const isDuplicate = inner.length > 0 && stripDiacritics(normalizeForCompare(inner)) === stripDiacritics(normalizeForCompare(head));
      const isHintEcho = HINT_ECHO_RE.test(inner);
      if (!isDuplicate && !isHintEcho) break;
      out = head.trim();
    }

    // A stray single letter after the sentence's end ("… của tôi nữa. k"),
    // a token a model emitted past its answer: no language ends a line so.
    out = out.replace(/([.!?…])\s+\p{L}$/u, '$1').trim();

    if (out === before) break;
  }

  // A line that is ONLY the annotation ("(4 âm tiết)", "[spoken window: ...]")
  // is no translation at all — empty it so recovery/fallback kicks in.
  const whole = out.match(WHOLE_LINE_GROUP_RE);
  if (whole && HINT_ECHO_RE.test(whole[1]!.trim())) return '';

  return out;
}

/** Double quote marks in a line (straight and curly). */
function countQuotes(text: string): number {
  return (text.match(/[“”"]/gu) ?? []).length;
}

/** Base letters only: NFD without combining marks, đ → d. */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
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
  /**
   * Context window used to size the character-sheet analysis. Every default
   * model here takes >=128K tokens; 100K leaves room for a user-chosen smaller
   * one without ever sampling a transcript that would have fitted whole.
   */
  readonly contextTokens = 100_000;

  constructor(
    service: CloudServiceId,
    private readonly credentials: CredentialsStore,
    private readonly timeoutMs: number,
    private readonly postJson: PostJsonFn = cloudPostJson,
    /** Claude's transport (the official SDK); tests pass a fake. */
    private readonly claudeSend: ClaudeSend = sdkSend,
  ) {
    this.credentialService = service;
    this.id = `${service}-translate`;
    this.displayName = `${SERVICE_LABELS[service]} translation (cloud)`;
  }

  /**
   * One-shot chat completion (system + user → text) — the primitive the
   * review/refine pass drives. Credentials resolve per call, like
   * translateSegments. On Claude, `opts.jsonSchema` becomes structured output
   * and `opts.maxTokens` the reply budget; the OpenAI-compatible transports
   * keep their JSON mode and the prompts' own format instructions.
   */
  async chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const defaults = SERVICE_DEFAULTS[this.credentialService];
    const baseUrl = (cred.baseUrl ?? defaults.baseUrl).replace(/\/$/, '');
    const model = cred.model ?? defaults.model;
    const sys = system ?? 'You are a professional subtitle/dubbing translator.';
    return defaults.dialect === 'anthropic'
      ? this.callAnthropic(baseUrl, cred.apiKey, model, user, signal, sys, opts, cred.via)
      : this.callOpenAiCompatible(baseUrl, cred.apiKey, model, user, signal, sys);
  }

  /** The model and endpoint the next request goes to (both come from Settings). */
  async modelIdentity(): Promise<string | undefined> {
    const cred = await this.credentials.get(this.credentialService);
    const defaults = SERVICE_DEFAULTS[this.credentialService];
    return `${cred.model ?? defaults.model}@${(cred.baseUrl ?? defaults.baseUrl).replace(/\/$/, '')}`;
  }

  async translateSegments(input: DubbingTranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const defaults = SERVICE_DEFAULTS[this.credentialService];
    const baseUrl = (cred.baseUrl ?? defaults.baseUrl).replace(/\/$/, '');
    const model = cred.model ?? defaults.model;

    const source = normalizeLanguageCode(input.sourceLanguage);
    const target = normalizeLanguageCode(input.targetLanguage);
    const perSecond = input.speechRate;

    const send = (prompt: string, system?: string, opts?: ChatOptions): Promise<string> =>
      defaults.dialect === 'anthropic'
        ? this.callAnthropic(baseUrl, cred.apiKey, model, prompt, signal, system, opts, cred.via)
        : this.callOpenAiCompatible(baseUrl, cred.apiKey, model, prompt, signal, system);

    // Document-level context: the project's character sheet (synopsis, cast,
    // glossary, pronoun/address plan) keeps Vietnamese xưng hô and terminology
    // consistent across batches. A sheet provided by the caller (persisted /
    // user-edited) is authoritative; otherwise one analysis pass generates it
    // and it is returned for persistence — unless the caller (the pipeline)
    // runs the analysis itself, so it can report a failure instead of losing it.
    // An analysis failure never fails the translation itself.
    const provided = input.documentContext;
    const useContext =
      translationContextEnabled() && (provided !== undefined || input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS);
    let analysis: TranslationAnalysis | undefined = provided;
    let generated: TranslationAnalysis | undefined;
    if (useContext && analysis === undefined && input.skipAnalysis !== true) {
      generated = (
        await generateCharacterSheet(
          {
            // Pass the sheet's schema and reply budget through (Claude: structured output).
            chatComplete: (system, user, _signal, opts) => send(user, system, opts),
            contextTokens: this.contextTokens,
          },
          { sourceLanguage: source, targetLanguage: target, segments: input.segments },
          signal,
        )
      ).analysis;
      analysis = generated;
    }

    // Scene-aware batches + a rolling window of the previous batch's translated
    // pairs, so style/pronoun decisions flow across request boundaries. Fit
    // windows are measured on the WHOLE list first (a batch's last line still
    // sees its real successor).
    const batches = planContextBatches(withFitWindows(input.segments as PromptSegment[]), {
      maxSegments: MAX_BATCH_SEGMENTS,
      maxChars: MAX_BATCH_CHARS,
    });
    const results: TranslationResultSegment[] = [];
    const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];
    let previousBatch: PromptSegment[] | undefined;
    let rolling: RollingPair[] = [];
    for (const batch of batches) {
      // Done before a pause: keep its lines, and let them carry the context on.
      const resumed = resumedBatch(batch, input.resume);
      if (resumed) {
        for (const seg of batch) results.push({ id: seg.id, translatedText: resumed.get(seg.id)! });
        rolling = collectRollingPairs(batch, resumed);
        previousBatch = batch;
        input.onProgress?.(results.length, input.segments.length);
        continue;
      }
      const context = useContext
        ? buildContextHeader({ analysis, previousPairs: rolling, sceneBreak: isSceneBreak(previousBatch, batch) })
        : undefined;
      const prompt = buildTranslationPrompt(source, target, batch, context || undefined, { perSecond });
      // The batch's reply shape: Claude enforces it as structured output.
      const shape = (segs: readonly PromptSegment[]): ChatOptions => ({ jsonSchema: segmentsReplySchema(segs.map((s) => s.id)) });
      const reply = await send(prompt, undefined, shape(batch));

      // Recover skipped/echoed lines with one emphatic retry instead of
      // silently keeping the source text. (No per-line raw rung here: the
      // JSON response_format is pinned on this transport, and cloud models'
      // batch compliance makes the retry sufficient.)
      const byId = await recoverBatch(batch, parseTranslationReply(reply), {
        sendBatch: (segs, insist) =>
          send(buildTranslationPrompt(source, target, segs, context || undefined, { insist, perSecond }), undefined, shape(segs)),
      }, detectSourceEcho, signal);
      for (const seg of batch) {
        // Still-missing translation: fall back to the source text so the
        // pipeline continues; the runner + editor surface it for review.
        results.push({ id: seg.id, translatedText: byId.get(seg.id) ?? seg.sourceText });
      }
      input.onBatch?.(translatedLines(batch, byId));
      rolling = collectRollingPairs(batch, byId);
      previousBatch = batch;
      input.onProgress?.(results.length, input.segments.length);
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

  /**
   * One Claude request through the official SDK (claudeMessage): a refusal or a
   * reply cut off at the token limit is an error with its reason — before, both
   * quietly left lines in the source language — and a JSON schema becomes
   * structured output.
   */
  private async callAnthropic(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    signal?: AbortSignal,
    system = 'You are a professional subtitle/dubbing translator. Respond with strict JSON only.',
    opts?: ChatOptions,
    via?: 'mother-claude',
  ): Promise<string> {
    const reply = await claudeMessage(
      {
        apiKey,
        baseUrl,
        model,
        system,
        user: prompt,
        timeoutMs: this.timeoutMs,
        ...(signal ? { signal } : {}),
        ...(opts?.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
        ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        ...(via ? { via } : {}),
      },
      this.claudeSend,
    );
    return reply.text;
  }
}

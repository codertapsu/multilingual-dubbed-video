/**
 * The "context engine": the best instruction-following model a project can
 * use for work that needs to READ the dub — the character sheet, repairs of
 * lines that failed the checks, and shortening lines that overflow their time
 * (auto-fit and the editor's "Tighten to fit").
 *
 * Why not the translation provider. Auto-fit used to re-translate overflowing
 * lines FROM THE SOURCE with the project's translator, after the review pass,
 * with a shrunken window and no neighbours. With TranslateGemma (which cannot
 * take instructions at all) that rewrote 36/330, 62/396 and 51/396 reviewed
 * lines in three real dubs, many broken: 我只要掉一根毫毛 → "Tôi chỉ cần một
 * sợi lông.", 母符必碎 → "Tránh làm vỡ.", 在 → "Ở." beside four "Có mặt!". And
 * it alternated the LLM and the GPU voice per pass: four full model reloads in
 * four minutes. Shortening the CURRENT line with a model that sees the context
 * keeps the review's work and the meaning; doing every shortening before any
 * re-synthesis loads each engine once.
 *
 * Order (never TranslateGemma or Argos — they cannot follow an instruction):
 *   1. the project's review/refine provider, when set and capable;
 *   2. the built-in Gemma chat model, when its pack is installed;
 *   3. the translation provider itself, when it is an instruction-following LLM.
 */
import {
  AppErrorException,
  budgetUnitLabel,
  type BudgetUnit,
  type ProjectSettings,
  type TranslationDocContext,
} from '@videodubber/shared';
import type { ProviderRegistry } from '../registry.js';
import { isTranslationRefiner, type CancellableTranslationProvider, type TranslationRefiner } from '../types.js';
import {
  ASR_SOURCE_NOTE,
  isCancellation,
  parseTranslationReply,
  segmentsReplySchema,
  type ChatOptions,
} from './llmTranslationProvider.js';
import { buildContextHeader } from './translationContext.js';
import { checkDubLine, describeFlags, looksUntranslated, qualityScore, type QualityFlag } from './lineQuality.js';
import { countSpeechUnits } from './speechFit.js';

/** Provider id of the built-in context-aware Gemma chat model (registry.ts). */
export const BUILT_IN_CHAT_PROVIDER_ID = 'llama-cpp-chat';

/** A provider that can drive the context engine. */
export type ContextCapableProvider = CancellableTranslationProvider &
  TranslationRefiner & {
    chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string>;
    readonly contextTokens?: number;
  };

/**
 * The context-capable providers for a project, best first (see the module
 * comment for the order). The registry falls back to its default provider for
 * an unknown id, so a candidate counts only when it IS the id asked for.
 */
export function contextEngineCandidates(
  registry: Pick<ProviderRegistry, 'getTranslation'>,
  settings: Pick<ProjectSettings, 'refineProviderId' | 'translationProviderId'>,
): ContextCapableProvider[] {
  const ids = [settings.refineProviderId, BUILT_IN_CHAT_PROVIDER_ID, settings.translationProviderId];
  const out: ContextCapableProvider[] = [];
  for (const id of ids) {
    if (!id || id === 'none' || out.some((p) => p.id === id)) continue;
    let provider: CancellableTranslationProvider;
    try {
      provider = registry.getTranslation(id);
    } catch {
      continue;
    }
    if (provider.id !== id || !isTranslationRefiner(provider)) continue;
    out.push(provider as ContextCapableProvider);
  }
  return out;
}

/** A request that ran out of time (not a cancel: callers tell those apart by the run's signal). */
function isTimeout(err: unknown): boolean {
  if ((err as Error | undefined)?.name === 'TimeoutError') return true;
  return (err as { appError?: { code?: string } } | undefined)?.appError?.code === 'WORKER_TIMEOUT';
}

/**
 * Errors that mean "this engine cannot run here", so the next candidate should.
 * ENGINE_BUSY is one: the local model's lane belongs to another dub right now,
 * and a project that also has a cloud model must use it rather than fail.
 */
function isEngineMissing(err: unknown): boolean {
  const code = (err as { appError?: { code?: string } } | undefined)?.appError?.code;
  return (
    code === 'ENGINE_PACK_MISSING' ||
    code === 'ENGINE_PACK_FAILED' ||
    code === 'ENGINE_UNAVAILABLE' ||
    code === 'ENGINE_BUSY' ||
    code === 'CLOUD_CREDENTIALS_MISSING'
  );
}

/**
 * A chat over the candidates: the first call tries them in order and sticks
 * with the first that answers; a candidate that is merely NOT INSTALLED (no
 * pack, no key, engine cannot start) is skipped. After that every call goes to
 * the chosen engine, so a run never mixes models. Errors other than "missing"
 * propagate — callers decide what a failed rewrite means for them.
 */
export class FallbackContextChat {
  private chosen?: ContextCapableProvider;
  private readonly unavailable = new Set<ContextCapableProvider>();
  /**
   * The timeout of a model that stopped answering. Every later call fails
   * with it at once: a hung llama-server used to cost the full per-request
   * timeout once per line to repair.
   */
  private stalled?: unknown;

  constructor(
    private readonly candidates: readonly ContextCapableProvider[],
    private readonly onSkip?: (provider: ContextCapableProvider, err: unknown) => void,
  ) {}

  /** True when there is at least one candidate left to try. */
  get available(): boolean {
    return this.chosen !== undefined || this.candidates.some((c) => !this.unavailable.has(c));
  }

  /** The engine in use (or the next to be tried). */
  get engine(): ContextCapableProvider | undefined {
    return this.chosen ?? this.candidates.find((c) => !this.unavailable.has(c));
  }

  get contextTokens(): number | undefined {
    return this.engine?.contextTokens;
  }

  async chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string> {
    if (this.stalled) throw this.stalled;
    for (;;) {
      const engine = this.engine;
      if (!engine) {
        throw new AppErrorException('ENGINE_UNAVAILABLE', 'No instruction-following model is available for this project.');
      }
      try {
        const reply = await engine.chatComplete(system, user, signal, opts);
        this.chosen = engine;
        return reply;
      } catch (err) {
        if (isTimeout(err) && !signal?.aborted) this.stalled = err;
        if (this.chosen || isCancellation(err) || !isEngineMissing(err)) throw err;
        this.unavailable.add(engine);
        this.onSkip?.(engine, err);
      }
    }
  }
}

// ---- Rewrites: shortening and repair -------------------------------------------

/** A neighbouring line shown for context. */
export interface NeighbourLine {
  sourceText: string;
  text: string;
}

/** One line to rewrite. */
export interface RewriteItem {
  id: string;
  sourceText: string;
  /** The current translation (the text being rewritten). */
  currentText: string;
  speakerId?: string;
  /** Length range for the rewrite, in the target's budget unit. */
  target?: number;
  max?: number;
  unit?: BudgetUnit;
  /** For repairs: what the checks found wrong. */
  problem?: string;
  /**
   * Fewest units an accepted shortening may have — the cut floor of the
   * ORIGINAL line, so a second pass cannot compound two cuts past
   * {@link MAX_CUT_SHARE} (11 syllables → 7 → 4 happened before this).
   */
  minUnits?: number;
  previous?: NeighbourLine[];
  next?: NeighbourLine[];
}

/** What the rewrite is for. */
export type RewriteKind = 'shorten' | 'repair';

/** Inputs to {@link buildRewritePrompt}. */
export interface RewritePromptArgs {
  kind: RewriteKind;
  sourceLanguage: string;
  targetLanguage: string;
  items: readonly RewriteItem[];
  documentContext?: TranslationDocContext;
  /** Second shortening pass: the first rewrite was still too long. */
  strict?: boolean;
}

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();

/**
 * The rewrite prompt. Each line carries its neighbours (source and current
 * translation), the speaker, and the length range, under the character sheet;
 * the model rewrites the CURRENT translation — it is told outright not to
 * re-translate from the source, which is what lost the meaning before. Pure.
 */
export function buildRewritePrompt(args: RewritePromptArgs): string {
  const { kind, sourceLanguage, targetLanguage } = args;
  const vi = targetLanguage.split('-')[0]!.toLowerCase() === 'vi';
  const unitLabel = (unit: BudgetUnit | undefined): string => budgetUnitLabel(unit ?? 'words', targetLanguage);
  const list = args.items
    .map((item) => {
      const who = item.speakerId ? ` (${item.speakerId})` : '';
      const length =
        item.max !== undefined
          ? item.target !== undefined && item.target < item.max
            ? `about ${item.target} ${unitLabel(item.unit)}, at most ${item.max}`
            : `at most ${item.max} ${unitLabel(item.unit)}`
          : undefined;
      const rows = [
        `${item.id}${who}${length ? ` — length: ${length}` : ''}`,
        ...(item.previous ?? []).map((p) => `  context before (do not copy): ${oneLine(p.sourceText)} => ${oneLine(p.text)}`),
        `  source: ${oneLine(item.sourceText)}`,
        `  current: ${oneLine(item.currentText)}`,
        ...(item.problem ? [`  problem: ${item.problem}`] : []),
        ...(item.next ?? []).map((n) => `  context after (do not copy): ${oneLine(n.sourceText)} => ${oneLine(n.text)}`),
      ];
      return rows.join('\n');
    })
    .join('\n');
  const context = buildContextHeader({ analysis: args.documentContext });
  const task =
    kind === 'shorten'
      ? [
          `Each line below is a ${vi ? 'Vietnamese' : targetLanguage} dubbing line that is too long for the time the original speaker took. Rewrite the CURRENT line shorter:`,
          `- Keep its full meaning, names (per the glossary), pronouns/terms of address (consistent with the lines before and after), and tone. Remove filler and redundancy, prefer shorter words and phrasings${vi ? ' (e.g. drop "đã", "rồi", "thì", "là" where the meaning survives)' : ''}.`,
          '- Rewrite the current line — do NOT translate the source again from scratch. The source is there so you can check the meaning.',
          `- ${args.strict ? 'Your previous rewrite was still too long: the length is a HARD limit this time.' : 'Stay within each line\'s length; never exceed the "at most" number.'}`,
          '- Never add content, never move content from the lines before or after into this line.',
        ]
      : [
          `Each line below is a ${vi ? 'Vietnamese' : targetLanguage} dubbing line that failed an automatic check (see "problem"). Rewrite the CURRENT line so the problem is gone:`,
          `- Fix only the problem; keep the meaning, the pronouns/terms of address and the tone.${vi ? ' Every name in Hán-Việt with Vietnamese letters (each syllable a separate word, full diacritics) — never Chinese characters, never pinyin.' : ''}`,
          '- When the current line is empty or untranslated, translate the source, consistent with the lines before and after.',
          '- Keep within the length when one is given.',
        ];
  return [
    `You are editing dubbing lines ("${sourceLanguage}" -> "${targetLanguage}"). Every line is spoken aloud by a voice.`,
    ...task,
    `- ${ASR_SOURCE_NOTE}`,
    '- One spoken form only: no alternatives with "/", no notes, no quotes around the line.',
    ...(context ? [context] : []),
    'Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — one entry per line id, the rewritten line only.',
    '',
    'Lines:',
    list,
  ].join('\n');
}

/**
 * Lines per rewrite request: ONE. Batching 12 lines, Gemma 3 4B put lines'
 * texts under the wrong ids — every "repair" of the 2026-11-17 verification
 * run was another line ("Cảm ơn thầy/cô" → "Con quạ đáng ghét"). The shared
 * prompt prefix is cached by llama-server, so single-line requests are cheap.
 */
export const REWRITE_BATCH_SIZE = 1;

/**
 * Ask the engine to rewrite `items`; returns id → proposed text (sanitized).
 * Constrained to the batch's ids where the engine supports a schema; a reply
 * with no usable JSON is retried once. Engine errors other than cancellation
 * are collected per batch (the caller keeps the current text for those).
 */
export async function requestRewrites(
  chat: Pick<FallbackContextChat, 'chatComplete'>,
  args: RewritePromptArgs,
  signal?: AbortSignal,
  opts: { batchSize?: number } = {},
): Promise<{ proposals: Map<string, string>; errors: string[] }> {
  const proposals = new Map<string, string>();
  const errors: string[] = [];
  const system = 'You are a professional dubbing editor. Respond with strict JSON only.';
  const batchSize = Math.max(1, opts.batchSize ?? REWRITE_BATCH_SIZE);
  for (let at = 0; at < args.items.length; at += batchSize) {
    const items = args.items.slice(at, at + batchSize);
    const ids = items.map((i) => i.id);
    const prompt = buildRewritePrompt({ ...args, items });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Pipeline run was cancelled.');
      try {
        const reply = await chat.chatComplete(system, prompt, signal, {
          jsonSchema: segmentsReplySchema(ids),
          maxTokens: 2048,
          // The retry samples: the same prompt at 0 gets the same reply.
          ...(attempt > 0 ? { temperature: 0.4 } : {}),
        });
        const parsed = parseTranslationReply(reply);
        const usable = ids.filter((id) => (parsed.get(id) ?? '').length > 0);
        for (const id of usable) proposals.set(id, parsed.get(id)!);
        if (usable.length > 0) break;
        if (attempt === 1) errors.push(`no usable reply for ${ids.join(', ')}`);
      } catch (err) {
        // Only the run's own signal is a cancel; a timeout is this line's failure.
        if (signal ? signal.aborted : isCancellation(err)) throw err;
        errors.push((err as { appError?: { message?: string } })?.appError?.message ?? (err as Error)?.message ?? String(err));
        break;
      }
    }
  }
  return { proposals, errors };
}

/**
 * Never ask a line to lose more than this share of itself, and never accept a
 * proposal that did: past it, the cut is meaning, not filler. A context-free
 * re-translation turned 母符必碎 into "Tránh làm vỡ." exactly this way.
 */
export const MAX_CUT_SHARE = 0.6;

const words = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 0);

/**
 * Does `proposed` take its words from a NEIGHBOUR instead of the line itself?
 * True when it reproduces a neighbour's text, contains a whole neighbour of 2+
 * words, or carries three consecutive words of a neighbour that the current
 * line does not have. Gemma 3 4B, shown "after: <next line>", appended the
 * next line to its shortening ("… Chúng ta sẽ trao đổi chi tiết hơn nữa.").
 * Pure.
 */
export function copiesNeighbour(
  item: Pick<RewriteItem, 'currentText' | 'previous' | 'next'>,
  proposed: string,
): boolean {
  const p = words(proposed);
  const pJoined = ` ${p.join(' ')} `;
  const current = ` ${words(item.currentText).join(' ')} `;
  for (const n of [...(item.previous ?? []), ...(item.next ?? [])]) {
    const w = words(n.text);
    if (w.length === 0) continue;
    const joined = w.join(' ');
    if (joined === p.join(' ')) return true;
    if (w.length >= 2 && pJoined.includes(` ${joined} `) && !current.includes(` ${joined} `)) return true;
    for (let i = 0; i + 3 <= w.length; i++) {
      const tri = ` ${w.slice(i, i + 3).join(' ')} `;
      if (pJoined.includes(tri) && !current.includes(tri)) return true;
    }
  }
  return false;
}

/** Verdict on one proposed rewrite. */
export interface RewriteVerdict {
  accepted: boolean;
  reason?: string;
  flags: QualityFlag[];
  units: number;
}

/** Languages a verdict is computed in. */
export interface RewriteLanguages {
  sourceLanguage: string;
  targetLanguage: string;
}

/**
 * The acceptance rule for a SHORTENING. Accept only when the proposal:
 *   1. is strictly shorter than the current line in budget units — the whole
 *      point; a "shortening" that is not shorter just re-rolls the line;
 *   2. passes the line checks (lineQuality) — the old auto-fit accepted any
 *      text that differed, including untranslated and broken lines;
 *   3. did not collapse: never below 40% of the current line or half the
 *      target ({@link MAX_CUT_SHARE}) — a 12-syllable line returned as 3 has
 *      lost meaning, not filler ("Tránh làm vỡ." for 母符必碎);
 *   4. is not the source echoed back.
 * Otherwise the current text stays and time-stretch absorbs the overflow.
 */
export function judgeShortening(
  item: Pick<RewriteItem, 'sourceText' | 'currentText' | 'target' | 'previous' | 'next' | 'minUnits'>,
  proposed: string | undefined,
  languages: RewriteLanguages,
): RewriteVerdict {
  const text = (proposed ?? '').trim();
  const units = countSpeechUnits(text, languages.targetLanguage);
  const flags = checkDubLine(text, { sourceText: item.sourceText, ...languages });
  if (!text) return { accepted: false, reason: 'no proposal', flags, units };
  if (looksUntranslated({ sourceText: item.sourceText }, text)) {
    return { accepted: false, reason: 'echoes the source', flags, units };
  }
  if (copiesNeighbour(item, text)) return { accepted: false, reason: 'copies a neighbouring line', flags, units };
  const before = countSpeechUnits(item.currentText, languages.targetLanguage);
  if (units >= before) return { accepted: false, reason: `not shorter (${units} vs ${before})`, flags, units };
  // Only what the shortening BREAKS counts against it: a line already flagged
  // (a name the checks cannot place) must still be shortenable, or it keeps
  // its heavy time-stretch forever.
  const current = checkDubLine(item.currentText, { sourceText: item.sourceText, ...languages });
  const broken = flags.filter((f) => !current.includes(f));
  if (broken.length > 0) {
    return { accepted: false, reason: `fails line checks: ${describeFlags(broken, languages.targetLanguage)}`, flags, units };
  }
  const floor = Math.max(
    1,
    item.minUnits ?? Math.ceil(before * (1 - MAX_CUT_SHARE)),
    item.target !== undefined ? Math.floor(item.target / 2) : 1,
  );
  if (units < floor) {
    return {
      accepted: false,
      reason: `cut too far (${units} of ${before}${item.target !== undefined ? `, target about ${item.target}` : ''})`,
      flags,
      units,
    };
  }
  return { accepted: true, flags, units };
}

/**
 * The acceptance rule for a REPAIR: accept a proposal that is clean, or at
 * least strictly better on the checks than the current line, and that is not
 * the source echoed back. A repair that fixes nothing changes nothing.
 */
export function judgeRepair(
  item: Pick<RewriteItem, 'sourceText' | 'currentText' | 'previous' | 'next'>,
  proposed: string | undefined,
  languages: RewriteLanguages,
): RewriteVerdict {
  const text = (proposed ?? '').trim();
  const units = countSpeechUnits(text, languages.targetLanguage);
  const flags = checkDubLine(text, { sourceText: item.sourceText, ...languages });
  if (!text) return { accepted: false, reason: 'no proposal', flags, units };
  if (copiesNeighbour(item, text)) return { accepted: false, reason: 'copies a neighbouring line', flags, units };
  const current = checkDubLine(item.currentText, { sourceText: item.sourceText, ...languages });
  if (qualityScore(flags) >= qualityScore(current)) {
    return { accepted: false, reason: `not better (${describeFlags(flags, languages.targetLanguage) || 'no change'})`, flags, units };
  }
  return { accepted: true, flags, units };
}

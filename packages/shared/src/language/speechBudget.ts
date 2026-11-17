/**
 * How much speech fits in a dub line's time slot, in target-language units.
 *
 * Lives here (not in the orchestrator's LLM translation provider, where it was
 * born) because three readers must agree on it: the built-in LLM translators'
 * prompts, the editor, and the MCP server that shows Claude each line's budget.
 * A budget that differed between them would have Claude write lines the app
 * then calls too long.
 */

/** How a spoken-length budget is counted in the target language. */
export type BudgetUnit = 'words' | 'syllables' | 'characters';

/**
 * Per-language speaking rates for the duration budget. Vietnamese is written
 * one syllable per whitespace-separated token, so a SYLLABLE budget is exactly
 * countable — and Vietnamese (like Chinese/Japanese) has no useful "word"
 * count. Everything else uses the ~2.8 words/s heuristic.
 *
 * These are LANGUAGE defaults for callers that do not know which voice will
 * speak the line. They are not what any particular voice does: the VieNeu v3
 * voices measured 3.3–3.7 syllables per second of clip on four real zh→vi dubs
 * (2026-11), against the 4.6 assumed here, and 10 of 13 / 20 of 25 / 18 of 22
 * units that still needed more than a 1.25× stretch were already inside this
 * budget. Callers that know the voice pass its measured rate (see `opts`).
 */
const BUDGET_RATES: Record<string, { unit: BudgetUnit; perSecond: number }> = {
  vi: { unit: 'syllables', perSecond: 4.6 },
  zh: { unit: 'characters', perSecond: 4.2 },
  ja: { unit: 'characters', perSecond: 5.5 },
};
const DEFAULT_RATE = { unit: 'words' as BudgetUnit, perSecond: 2.8 };

/**
 * The language's default speaking rate and the unit it is counted in — for a
 * caller that has no measured or engine rate. Assuming the Vietnamese 4.6
 * syllables/s for English (2.8 words/s) made an ordinary English clip look
 * like an engine failure, and auto-fit planned no cut at all.
 */
export function languageSpeechRate(targetLanguage: string): { unit: BudgetUnit; perSecond: number } {
  return BUDGET_RATES[targetLanguage.split('-')[0]!.toLowerCase()] ?? DEFAULT_RATE;
}

/** Optional knobs for {@link speechBudget}. */
export interface SpeechBudgetOptions {
  /**
   * The speaking rate of the voice that will say the line, in the language's
   * budget unit per second (Vietnamese: syllables/s). Overrides the language
   * default; ignored unless it is a finite positive number, so a caller can
   * pass through "unknown" without a branch.
   */
  perSecond?: number;
}

/** The spoken-length budget that fits a window, in target-language units. */
export function speechBudget(
  targetLanguage: string,
  startMs?: number,
  endMs?: number,
  opts?: SpeechBudgetOptions,
): { amount: number; unit: BudgetUnit } | undefined {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return undefined;
  const seconds = Math.max(0, endMs - startMs) / 1000;
  if (seconds <= 0) return undefined;
  const rate = languageSpeechRate(targetLanguage);
  const override = opts?.perSecond;
  const perSecond = typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : rate.perSecond;
  return { amount: Math.max(1, Math.round(seconds * perSecond)), unit: rate.unit };
}

/** Human wording for a budget unit ("syllables (âm tiết)" for Vietnamese). */
export function budgetUnitLabel(unit: BudgetUnit, targetLanguage: string): string {
  if (unit === 'syllables' && targetLanguage.split('-')[0]!.toLowerCase() === 'vi') return 'syllables (âm tiết)';
  return unit;
}

/**
 * A line's length in its budget unit: Vietnamese syllables (one per
 * whitespace-separated token with a letter or digit), Chinese/Japanese
 * characters, otherwise words. The pipeline's prompts, the editor and the MCP
 * server all count with this, so a line Claude sizes counts the same everywhere.
 */
export function countSpeechUnits(text: string, targetLanguage: string): number {
  const base = targetLanguage.split('-')[0]!.toLowerCase();
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (base === 'zh' || base === 'ja') return [...trimmed.replace(/[\s\p{P}]/gu, '')].length;
  return trimmed.split(/\s+/u).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

// ---- The window a line may fill, and the range it is asked for ---------------

/**
 * How far past its own cue a line may run when it is budgeted. Alignment lets a
 * clip use the silence up to the next line (it is gap-aware), so budgeting the
 * cue alone over-compressed lines followed by a pause. But a long pause is a
 * scene boundary, not room to talk: an uncapped credit would let one line ramble
 * across seconds of silence that the picture does not match. One second covers a
 * normal conversational pause.
 */
export const MAX_GAP_CREDIT_MS = 1000;
/** The breath kept before the next line starts (never budgeted). */
export const GAP_BREATH_MS = 150;
/**
 * The speed-up a fitted line may need and still sound like the same speaker
 * (alignment's STRETCH_COMFORT): the ceiling of a budget is what fits at it.
 */
export const FIT_COMFORT_RATIO = 1.15;

/** The window (ms) a cue's line may fill: the cue plus a capped share of the following gap. */
export function fitWindowMs(seg: { startMs: number; endMs: number }, nextStartMs?: number): number {
  const own = Math.max(0, seg.endMs - seg.startMs);
  if (typeof nextStartMs !== 'number') return own;
  const credit = Math.min(MAX_GAP_CREDIT_MS, Math.max(0, nextStartMs - seg.endMs - GAP_BREATH_MS));
  return own + credit;
}

/** A line's length target: aim for `target`, never above `max` (both in `unit`). */
export interface FitBudget {
  target: number;
  max: number;
  unit: BudgetUnit;
}

/**
 * The budget for a window: `target` fits at the voice's natural pace, `max`
 * fits with the comfortable {@link FIT_COMFORT_RATIO} speed-up. Rate = the
 * voice's measured/engine rate, else the language default.
 */
export function fitBudget(targetLanguage: string, windowMs: number | undefined, perSecond?: number): FitBudget | undefined {
  if (typeof windowMs !== 'number' || !(windowMs > 0)) return undefined;
  const opts = perSecond !== undefined ? { perSecond } : undefined;
  const natural = speechBudget(targetLanguage, 0, windowMs, opts);
  const comfortable = speechBudget(targetLanguage, 0, windowMs * FIT_COMFORT_RATIO, opts);
  if (!natural || !comfortable) return undefined;
  return { target: natural.amount, max: Math.max(natural.amount, comfortable.amount), unit: natural.unit };
}

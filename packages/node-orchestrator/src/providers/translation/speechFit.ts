/**
 * How long a dub line may be: the voice's real speaking rate and the window a
 * line may fill, turned into the "about N, never above M" budget every LLM
 * prompt (translation, review, auto-fit shortening, Tighten to fit) quotes.
 *
 * Why this exists. The budget used a fixed 4.6 Vietnamese syllables per second
 * of window and told models it was "a firm ceiling — shorter is BETTER". On
 * four real zh→vi dubs (2026-11) the VieNeu v3 voices actually spoke a median
 * 3.3–3.7 syllables per second of clip, so the ceiling was ~30% too generous
 * exactly where lines overflowed (10 of 13, 20 of 25 and 18 of 22 of the units
 * still needing more than a 1.25× stretch were INSIDE their budget), while the
 * "shorter is better" wording made models cut meaning on lines that had room
 * (median budget use 67–75%; 此乃上古至高道术 became "Đạo thuật thượng cổ.",
 * dropping 至高). So: measure the voice, budget the real window, and ask for
 * a target with a ceiling instead of "as short as possible".
 *
 * The language-level budget itself stays in @videodubber/shared
 * (`speechBudget`), the single source the editor and MCP server also read;
 * this module only supplies the rate and the window it is applied to.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  budgetUnitLabel,
  countSpeechUnits,
  fitBudget,
  fitWindowMs,
  speechBudget,
  type BudgetUnit,
  type FitBudget,
} from '@videodubber/shared';
import { writeJsonAtomic } from '../../workspace/projectStore.js';

// The counting, the window and the budget range live in @videodubber/shared so
// the editor and the MCP server size lines exactly as these prompts do.
export {
  countSpeechUnits,
  fitBudget,
  fitWindowMs,
  FIT_COMFORT_RATIO,
  GAP_BREATH_MS,
  MAX_GAP_CREDIT_MS,
} from '@videodubber/shared';
export type { FitBudget } from '@videodubber/shared';

const baseLanguage = (code: string): string => code.split('-')[0]!.toLowerCase();

/** Anything with a timed window that a prompt can budget. */
export interface FitTimed {
  startMs?: number;
  endMs?: number;
  /** Pre-computed window to budget (ms); wins over startMs/endMs. */
  fitMs?: number;
}

/**
 * Set `fitMs` on every timed segment from its successor (in list order — the
 * transcript order). Segments that already carry `fitMs` keep it. Pure: returns
 * new objects, so batching code downstream can split freely without losing the
 * neighbour each window was measured against.
 */
export function withFitWindows<T extends FitTimed>(segments: readonly T[]): T[] {
  return segments.map((s, i) => {
    if (typeof s.fitMs === 'number' || typeof s.startMs !== 'number' || typeof s.endMs !== 'number') return s;
    const next = segments[i + 1]?.startMs;
    return { ...s, fitMs: fitWindowMs({ startMs: s.startMs, endMs: s.endMs }, next) };
  });
}

/** The unit a language's budget counts in (Vietnamese syllables, Chinese characters, else words). */
export function budgetUnitFor(targetLanguage: string): BudgetUnit {
  return speechBudget(targetLanguage, 0, 1000)!.unit;
}

/** The budget of a prompt segment (its `fitMs`, else its own cue). */
export function segmentFitBudget(seg: FitTimed, targetLanguage: string, perSecond?: number): FitBudget | undefined {
  const windowMs =
    typeof seg.fitMs === 'number'
      ? seg.fitMs
      : typeof seg.startMs === 'number' && typeof seg.endMs === 'number'
        ? seg.endMs - seg.startMs
        : undefined;
  return fitBudget(targetLanguage, windowMs, perSecond);
}

/** "about 9 syllables (âm tiết), never more than 10" — the range every prompt quotes. */
export function budgetPhrase(budget: FitBudget, targetLanguage: string): string {
  const unit = budgetUnitLabel(budget.unit, targetLanguage);
  return budget.max > budget.target
    ? `about ${budget.target} ${unit}, never more than ${budget.max}`
    : `about ${budget.target} ${unit}, never more`;
}

// ---- Voice speaking rates -----------------------------------------------------

/**
 * Engine defaults (budget units per second of synthesized clip) used until a
 * voice has been measured. Keys are TTS provider ids, then target language.
 *
 *  - VieNeu v3 (`neural-tts`): per-voice medians of syllables ÷ clip length on
 *    four real zh→vi dubs (2026-11): 3.68 (xuan-vinh), 3.41 (duc-tri), 3.26
 *    (thai-son), 3.39 (trong-huu) → 3.5.
 *  - Piper `vi_VN-vais1000-medium` (`piper-local`): median 4.85, p25 4.66
 *    syllables/s over 175 clips of the same zh→vi dub (2026-11-17), so the
 *    p25-ish 4.6 is the conservative default: Piper really is ~40% faster
 *    than VieNeu, and one shared number fitted neither.
 */
export const PIPER_VI_RATE = 4.6;
export const ENGINE_DEFAULT_RATES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'neural-tts': { vi: 3.5 },
  'neural-tts-v2': { vi: 3.5 },
  // The same v3-Turbo checkpoint as neural-tts; its own measured pace is
  // learned per voice from the first dub (speechFit's per-voice key).
  'vieneu-tts': { vi: 3.5 },
  'piper-local': { vi: PIPER_VI_RATE },
};

/** The engine's default rate for a language, when known. */
export function defaultVoiceRate(ttsProviderId: string | undefined, targetLanguage: string): number | undefined {
  if (!ttsProviderId) return undefined;
  return ENGINE_DEFAULT_RATES[ttsProviderId]?.[baseLanguage(targetLanguage)];
}

/** A synthesized clip: what was said and how long the clip is. */
export interface VoiceRateSample {
  text: string;
  durationMs: number;
}

/**
 * Clips shorter than this many units say little about pace: VieNeu spends ~0.5 s
 * per syllable on 1–2-syllable clips (lead-in and release) against ~0.28 s on
 * 5+, so short clips would drag the median down.
 */
export const MIN_SAMPLE_UNITS = 4;
/** Rates outside this band are engine failures, not pace (VieNeu once read a 6-syllable line for 24 s). */
const PLAUSIBLE_RATE = { min: 1, max: 9 };

/** Per-clip rates (units/s) worth learning from; failures and short clips dropped. */
export function clipRates(samples: readonly VoiceRateSample[], targetLanguage: string): number[] {
  const rates: number[] = [];
  for (const s of samples) {
    const units = countSpeechUnits(s.text, targetLanguage);
    if (units < MIN_SAMPLE_UNITS || !(s.durationMs >= 800)) continue;
    const rate = units / (s.durationMs / 1000);
    if (rate >= PLAUSIBLE_RATE.min && rate <= PLAUSIBLE_RATE.max) rates.push(rate);
  }
  return rates;
}

/** Median (robust to the odd hallucinated clip); undefined for no values. */
export function robustMedian(values: readonly number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Fewest samples before a measured rate replaces the engine default. */
export const MIN_SAMPLES_FOR_RATE = 12;
/** Most recent samples kept per voice (old ones age out as the voice/engine changes). */
export const MAX_SAMPLES_PER_VOICE = 300;

/** Identity of a voice for rate purposes: engine, voice, language. */
export function voiceRateKey(ttsProviderId: string, voiceId: string | undefined, targetLanguage: string): string {
  return `${ttsProviderId}|${voiceId ?? ''}|${baseLanguage(targetLanguage)}`;
}

/** Where measured voice rates live (per voice key). Injected; tests use memory. */
export interface VoiceRateBook {
  /** Robust median of the stored samples, once there are enough of them. */
  rate(key: string): Promise<number | undefined>;
  /** Append freshly measured per-clip rates. */
  record(key: string, rates: readonly number[]): Promise<void>;
}

/** Keep the newest samples, oldest dropped first. Pure. */
export function mergeSamples(existing: readonly number[], fresh: readonly number[], cap = MAX_SAMPLES_PER_VOICE): number[] {
  const all = [...existing, ...fresh].filter((v) => Number.isFinite(v) && v > 0);
  return all.slice(Math.max(0, all.length - cap));
}

interface VoiceRateFile {
  version: 1;
  voices: Record<string, { samples: number[]; updatedAt: string }>;
}

/**
 * {@link VoiceRateBook} persisted as one JSON file (`<configDir>/voice_rates.json`).
 * Writes are atomic (temp + renameReplacing) and serialized in-process, so two
 * dubs finishing alignment together cannot interleave a read-modify-write —
 * provided they share ONE book per file ({@link voiceRateBookFor}): each dub
 * used to get its own instance, whose queue ordered only its own writes.
 */
export class FileVoiceRateBook implements VoiceRateBook {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * The file, or an empty book when it is missing or unparseable (it is a
   * cache of measurements). Any other read error throws: treated as empty, a
   * transient one (Defender holding the file) made the next write replace
   * every voice's history with one dub's samples.
   */
  private async load(): Promise<VoiceRateFile> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, voices: {} };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VoiceRateFile>;
      if (parsed && typeof parsed === 'object' && parsed.voices && typeof parsed.voices === 'object') {
        return { version: 1, voices: parsed.voices };
      }
    } catch {
      /* corrupt: start over */
    }
    return { version: 1, voices: {} };
  }

  async rate(key: string): Promise<number | undefined> {
    const file = await this.load();
    const samples = file.voices[key]?.samples ?? [];
    return samples.length >= MIN_SAMPLES_FOR_RATE ? robustMedian(samples) : undefined;
  }

  record(key: string, rates: readonly number[]): Promise<void> {
    if (rates.length === 0) return Promise.resolve();
    const run = this.queue.then(async () => {
      const file = await this.load();
      const samples = mergeSamples(file.voices[key]?.samples ?? [], rates);
      file.voices[key] = { samples, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(this.filePath, file);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** File name of the measured-rate book under the app's config dir. */
export const VOICE_RATES_FILE = 'voice_rates.json';

const booksByFile = new Map<string, FileVoiceRateBook>();

/** The app's rate book, `<configDir>/voice_rates.json`: one instance per file, shared by every dub. */
export function voiceRateBookFor(configDir: string): FileVoiceRateBook {
  const file = path.resolve(configDir, VOICE_RATES_FILE);
  let book = booksByFile.get(file);
  if (!book) {
    book = new FileVoiceRateBook(file);
    booksByFile.set(file, book);
  }
  return book;
}

/** The rate to budget a voice with, and where it came from (for the log). */
export interface ResolvedVoiceRate {
  perSecond?: number;
  source: 'measured' | 'engine-default' | 'language-default';
}

/** Measured rate if the voice has enough history, else the engine default, else none (language default). */
export async function resolveVoiceRate(
  book: VoiceRateBook | undefined,
  ttsProviderId: string | undefined,
  voiceId: string | undefined,
  targetLanguage: string,
): Promise<ResolvedVoiceRate> {
  if (book && ttsProviderId) {
    const measured = await book.rate(voiceRateKey(ttsProviderId, voiceId, targetLanguage)).catch(() => undefined);
    if (measured !== undefined) return { perSecond: measured, source: 'measured' };
  }
  const engine = defaultVoiceRate(ttsProviderId, targetLanguage);
  if (engine !== undefined) return { perSecond: engine, source: 'engine-default' };
  return { source: 'language-default' };
}

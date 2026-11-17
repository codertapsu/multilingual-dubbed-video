/**
 * The text passes the pipeline runs around translation, kept out of runner.ts
 * so each is a function with its I/O injected (the chat engine) and can be
 * tested without a pipeline:
 *
 *   - {@link checkAndRepairLines}: the translation step's per-line checks and
 *     repairs (wrong script, pinyin, "/" hedges, untranslated lines);
 *   - {@link applyReviewOutcome}: merges a review pass into the transcript,
 *     keeping locked lines and refreshing each line's quality flags;
 *   - {@link planUnitShortening} / {@link shortenOverflowingLines}: auto-fit,
 *     which SHORTENS the current lines of overflowing synthesis units — all of
 *     them, both passes, before any re-synthesis;
 *   - {@link tightenOneLine}: the editor's "Tighten to fit" on one line.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { languageSpeechRate, type TranscriptSegment, type TranslationDocContext } from '@videodubber/shared';
import { writeJsonAtomic } from '../../workspace/projectStore.js';
import type { PromptSegment } from './llmTranslationProvider.js';
import type { AnalysisAttempt } from './translationContext.js';
import {
  judgeRepair,
  MAX_CUT_SHARE,
  judgeShortening,
  requestRewrites,
  type FallbackContextChat,
  type NeighbourLine,
  type RewriteItem,
} from './contextEngine.js';
import { checkDubLine, describeFlags, pickBestCandidate, type QualityFlag } from './lineQuality.js';
import type { ReviewOutcome } from './refinement.js';
import {
  budgetUnitFor,
  countSpeechUnits,
  FIT_COMFORT_RATIO,
  fitBudget,
  segmentFitBudget,
  withFitWindows,
} from './speechFit.js';

/** Translation-quality report the UI/MCP can read: `subtitles/translation_report.json`. */
export const TRANSLATION_REPORT_FILE = 'translation_report.json';
/** The pre-review draft the refine step saves: `subtitles/translated.draft.json`. */
export const TRANSLATION_DRAFT_FILE = 'translated.draft.json';

export function translationReportPath(subtitlesDir: string): string {
  return path.join(subtitlesDir, TRANSLATION_REPORT_FILE);
}

export function translationDraftPath(subtitlesDir: string): string {
  return path.join(subtitlesDir, TRANSLATION_DRAFT_FILE);
}

/**
 * What happened to the character sheet in this project. `failed` is the loud
 * case: every audited project (2026-11) silently ran without one, because
 * analysis errors were swallowed — names drifted (西方教 rendered four ways,
 * 昆仑墟 three) and xưng hô flipped between consecutive lines.
 */
export interface CharacterSheetStatus {
  status: 'provided' | 'generated' | 'failed' | 'skipped';
  /** The model that ran the analysis. */
  engine?: string;
  attempts?: AnalysisAttempt[];
  /** Why it was skipped. */
  reason?: string;
  at: string;
}

/** `subtitles/translation_report.json`: what the text passes did, for the editor and MCP. */
export interface TranslationReport {
  characterSheet?: CharacterSheetStatus;
  /** The speaking rate the budgets used and where it came from. */
  speechRate?: { perSecond?: number; source: string };
  /** The translation step's per-line checks. */
  quality?: {
    checked: number;
    repaired: LineRepair[];
    flagged: FlaggedLine[];
    errors?: string[];
    engine?: string;
    at: string;
  };
  /** The last auto-fit shortening pass (alignment step). */
  autoFit?: {
    engine?: string;
    units: number;
    changes: ShortenChange[];
    rejected: ShortenRejection[];
    stillLong: string[];
    errors?: string[];
    at: string;
  };
}

/** Read the translation report (empty when absent or unreadable). */
export async function readTranslationReport(file: string): Promise<TranslationReport> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as TranslationReport;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the translation report (atomic write). */
export async function updateTranslationReport(file: string, patch: Partial<TranslationReport>): Promise<void> {
  const current = await readTranslationReport(file);
  await writeJsonAtomic(file, { ...current, ...patch });
}

/** The chat a pass drives (a FallbackContextChat in production, a fake in tests). */
export type PassChat = Pick<FallbackContextChat, 'chatComplete'>;

/** Languages of the dub. */
export interface DubLanguages {
  sourceLanguage: string;
  targetLanguage: string;
}

/** A line's neighbours as the rewrite prompts show them (2 before, 1 after). */
function neighboursOf(
  segments: readonly TranscriptSegment[],
  index: number,
  textOf: (s: TranscriptSegment) => string,
): { previous: NeighbourLine[]; next: NeighbourLine[] } {
  const line = (s: TranscriptSegment): NeighbourLine => ({ sourceText: s.sourceText, text: textOf(s) });
  return {
    previous: segments.slice(Math.max(0, index - 2), index).map(line),
    next: segments.slice(index + 1, index + 2).map(line),
  };
}

/** Set or clear a segment's quality flags. */
function withFlags(seg: TranscriptSegment, flags: readonly QualityFlag[]): TranscriptSegment {
  const { qualityFlags: _old, ...rest } = seg;
  return flags.length > 0 ? { ...rest, qualityFlags: [...flags] } : rest;
}

// ---- Translation step: check every line, repair what fails ---------------------

/** A line the repair pass changed. */
export interface LineRepair {
  id: string;
  before: string;
  after: string;
}

/** A line still failing after repair (flagged on the segment). */
export interface FlaggedLine {
  id: string;
  flags: QualityFlag[];
  text: string;
}

/** Result of {@link checkAndRepairLines}. */
export interface RepairPassResult {
  segments: TranscriptSegment[];
  repaired: LineRepair[];
  flagged: FlaggedLine[];
  /** Engine errors (the affected lines kept their best candidate). */
  errors: string[];
}

/**
 * Check every translated line (lineQuality) and send the failures to the
 * context engine for ONE repair attempt with their neighbours, the character
 * sheet and their length. A repair is kept only if it is better on the checks;
 * a line that is still bad keeps its best candidate and is FLAGGED on the
 * segment — and an empty best candidate becomes the source text (flagged
 * `untranslated`), never silently. Without an engine, failures are flagged.
 */
export async function checkAndRepairLines(
  input: DubLanguages & {
    segments: readonly TranscriptSegment[];
    documentContext?: TranslationDocContext;
    perSecond?: number;
  },
  chat: PassChat | undefined,
  signal?: AbortSignal,
): Promise<RepairPassResult> {
  const languages = { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage };
  const textOf = (s: TranscriptSegment): string => (s.translatedText ?? '').trim();
  const check = (s: TranscriptSegment, text: string): QualityFlag[] =>
    checkDubLine(text, { sourceText: s.sourceText, ...languages });
  const timed = withFitWindows(input.segments.map((s) => ({ ...s }) as TranscriptSegment & PromptSegment));

  const failing: number[] = [];
  timed.forEach((s, i) => {
    if (check(s, textOf(s)).length > 0) failing.push(i);
  });
  const failingIds = new Set(failing.map((i) => timed[i]!.id));

  const proposals = new Map<string, string>();
  const errors: string[] = [];
  const itemById = new Map<string, RewriteItem>();
  if (failing.length > 0 && chat) {
    const items: RewriteItem[] = failing.map((i) => {
      const s = timed[i]!;
      const budget = segmentFitBudget(s, input.targetLanguage, input.perSecond);
      return {
        id: s.id,
        sourceText: s.sourceText,
        currentText: textOf(s),
        problem: describeFlags(check(s, textOf(s)), input.targetLanguage),
        ...(s.speakerId ? { speakerId: s.speakerId } : {}),
        ...(budget ? { target: budget.target, max: budget.max, unit: budget.unit } : {}),
        ...neighboursOf(timed, i, textOf),
      };
    });
    const result = await requestRewrites(
      chat,
      {
        kind: 'repair',
        ...languages,
        items,
        ...(input.documentContext ? { documentContext: input.documentContext } : {}),
      },
      signal,
    );
    for (const [id, text] of result.proposals) proposals.set(id, text);
    for (const item of items) itemById.set(item.id, item);
    errors.push(...result.errors);
  }

  const repaired: LineRepair[] = [];
  const flagged: FlaggedLine[] = [];
  const segments = input.segments.map((seg) => {
    const current = textOf(seg);
    if (!failingIds.has(seg.id)) return withFlags(seg, []);
    let text = current;
    const proposal = proposals.get(seg.id);
    const item = itemById.get(seg.id) ?? { sourceText: seg.sourceText, currentText: current };
    if (proposal !== undefined && judgeRepair(item, proposal, languages).accepted) {
      text = proposal.trim();
    }
    const best =
      pickBestCandidate([
        { text, flags: check(seg, text) },
        ...(text !== current ? [{ text: current, flags: check(seg, current) }] : []),
      ]) ?? { text, flags: check(seg, text) };
    if (best.text !== current) repaired.push({ id: seg.id, before: current, after: best.text });
    // An empty line is the worst thing to hand a voice or a subtitle track:
    // keep the source instead (what the editor's "Untranslated?" badge looks
    // for), flagged — not counted as a repair.
    const finalText = best.text.trim().length > 0 ? best.text : seg.sourceText;
    const flags = check(seg, finalText);
    if (flags.length > 0) flagged.push({ id: seg.id, flags, text: finalText });
    return withFlags({ ...seg, translatedText: finalText }, flags);
  });
  return { segments, repaired, flagged, errors };
}

// ---- Refine step: merge the review -------------------------------------------

/**
 * Merge a review outcome into the transcript. Locked lines (hand-written or
 * approved in the editor) were sent as CONTEXT — the reviewer still reads them
 * to keep pronouns and terms consistent — but their text is never replaced.
 * Every line's quality flags are recomputed from its final text. Pure.
 */
export function applyReviewOutcome(
  segments: readonly TranscriptSegment[],
  outcome: Pick<ReviewOutcome, 'segments' | 'changes'>,
  languages: DubLanguages,
): { segments: TranscriptSegment[]; applied: ReviewOutcome['changes']; lockedSkipped: string[] } {
  const lockedIds = new Set(segments.filter((s) => s.locked === true).map((s) => s.id));
  const reviewed = new Map(outcome.segments.map((s) => [s.id, s.translatedText]));
  const applied = outcome.changes.filter((c) => !lockedIds.has(c.id));
  const lockedSkipped = outcome.changes.filter((c) => lockedIds.has(c.id)).map((c) => c.id);
  const merged = segments.map((s) => {
    // A locked line is the user's: its text AND its flags (the editor clears
    // them on a hand edit; re-checking here put them back).
    if (lockedIds.has(s.id)) return s;
    const text = reviewed.get(s.id) ?? s.translatedText ?? '';
    return withFlags({ ...s, translatedText: text }, checkDubLine(text, { sourceText: s.sourceText, ...languages }));
  });
  return { segments: merged, applied, lockedSkipped };
}

// ---- Auto-fit: shorten the lines of overflowing units --------------------------

/** A synthesis unit that does not fit its slot (from alignment). */
export interface OverflowUnit {
  /** Unit id (= first member's id; names the WAV). */
  id: string;
  /** Member segment ids, in order. */
  memberIds: readonly string[];
  /** The clip as synthesized (ms). */
  generatedMs: number;
  /** The slot alignment had for it (ms): placed duration minus overflow. */
  availableMs: number;
}

/** Members shorter than this are left alone: "Có mặt!" cannot lose a syllable. */
export const MIN_SHORTENABLE_UNITS = 3;

/** One member's rewrite request: current text and its length range. */
export interface MemberShortening {
  id: string;
  units: number;
  target: number;
  max: number;
}

/**
 * How short each member of an overflowing unit must become. Works from the
 * clip itself: ms per unit = clip length ÷ the unit's units, so the voice's
 * real pace on THIS line (lead-in and release included) sets the limit — the
 * old code shrank a nominal window instead. A clip slower than twice the
 * voice's expected pace is an engine failure (VieNeu once read a 6-syllable
 * line for 24 s); the voice's rate stands in for it then. The unit must fit at
 * {@link FIT_COMFORT_RATIO}; members at or under {@link MIN_SHORTENABLE_UNITS}
 * and locked members keep their length, the rest share the cut in proportion
 * to their length, and no member is asked to lose more than
 * {@link MAX_CUT_SHARE}. Pure.
 */
export function planUnitShortening(
  unit: Pick<OverflowUnit, 'generatedMs' | 'availableMs'>,
  members: readonly {
    id: string;
    text: string;
    locked?: boolean;
    /** Never ask for fewer units than this (the floor of the ORIGINAL line, on a second pass). */
    minUnits?: number;
  }[],
  targetLanguage: string,
  perSecond: number | undefined,
): MemberShortening[] {
  const counts = members.map((m) => ({ ...m, units: countSpeechUnits(m.text, targetLanguage) }));
  const total = counts.reduce((a, m) => a + m.units, 0);
  if (total === 0 || unit.generatedMs <= 0 || unit.availableMs <= 0) return [];
  const expectedMsPerUnit = 1000 / (perSecond && perSecond > 0 ? perSecond : languageSpeechRate(targetLanguage).perSecond);
  let msPerUnit = unit.generatedMs / total;
  if (msPerUnit > 2 * expectedMsPerUnit) msPerUnit = expectedMsPerUnit;
  const allowed = Math.floor((unit.availableMs * FIT_COMFORT_RATIO) / msPerUnit);
  const natural = Math.max(1, Math.round(unit.availableMs / msPerUnit));
  if (allowed >= total) return [];
  const shrinkable = counts.filter((m) => !m.locked && m.units >= MIN_SHORTENABLE_UNITS);
  const shrinkTotal = shrinkable.reduce((a, m) => a + m.units, 0);
  if (shrinkTotal === 0) return [];
  const fixed = total - shrinkTotal;
  const maxShare = Math.max(0, (allowed - fixed) / shrinkTotal);
  const targetShare = Math.max(0, (Math.min(natural, allowed) - fixed) / shrinkTotal);
  return shrinkable.flatMap((m) => {
    const floor = Math.max(1, m.minUnits ?? Math.ceil(m.units * (1 - MAX_CUT_SHARE)));
    if (floor >= m.units) return []; // already cut as far as meaning allows
    const max = Math.min(m.units - 1, Math.max(floor, Math.floor(m.units * maxShare)));
    const target = Math.min(max, Math.max(floor, Math.round(m.units * targetShare)));
    return [{ id: m.id, units: m.units, target, max }];
  });
}

/** One shortening that was applied. */
export interface ShortenChange {
  id: string;
  before: string;
  after: string;
  unitsBefore: number;
  unitsAfter: number;
}

/** One shortening that was refused (the line kept its text). */
export interface ShortenRejection {
  id: string;
  proposed: string;
  reason: string;
}

/** Result of {@link shortenOverflowingLines}. */
export interface ShortenOutcome {
  /** id → accepted new text (only lines that changed). */
  accepted: Map<string, string>;
  changes: ShortenChange[];
  rejected: ShortenRejection[];
  /** Units still estimated to need more than the comfortable stretch. */
  stillLong: string[];
  errors: string[];
}

/**
 * Shorten the current lines of every overflowing unit with the context
 * engine — pass 1 for all units, then a STRICT pass 2 for units whose estimate
 * (same ms per unit as their clip) still does not fit — before anything is
 * re-synthesized, so the LLM and the voice engine each load once per run.
 * Each proposal goes through {@link judgeShortening}; refused lines keep their
 * text and time-stretch absorbs the rest.
 */
export async function shortenOverflowingLines(
  input: DubLanguages & {
    units: readonly OverflowUnit[];
    /** The whole transcript, in order (texts are read, never mutated). */
    segments: readonly TranscriptSegment[];
    documentContext?: TranslationDocContext;
    perSecond?: number;
  },
  chat: PassChat,
  signal?: AbortSignal,
): Promise<ShortenOutcome> {
  const languages = { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage };
  const indexOf = new Map(input.segments.map((s, i) => [s.id, i]));
  const text = new Map(input.segments.map((s) => [s.id, (s.translatedText ?? s.sourceText ?? '').trim()]));
  const original = new Map(text);
  const textOf = (s: TranscriptSegment): string => text.get(s.id) ?? '';
  const rejected: ShortenRejection[] = [];
  const errors: string[] = [];

  // The cut floor always refers to the ORIGINAL line, so two passes can never
  // compound into more than MAX_CUT_SHARE of it.
  const originalFloor = (id: string): number =>
    Math.max(1, Math.ceil(countSpeechUnits(original.get(id) ?? '', input.targetLanguage) * (1 - MAX_CUT_SHARE)));
  const plan = (unit: OverflowUnit, generatedMs: number): MemberShortening[] =>
    planUnitShortening(
      { generatedMs, availableMs: unit.availableMs },
      unit.memberIds.map((id) => {
        const seg = input.segments[indexOf.get(id) ?? -1];
        return { id, text: text.get(id) ?? '', locked: seg?.locked === true, minUnits: originalFloor(id) };
      }),
      input.targetLanguage,
      input.perSecond,
    );

  const runPass = async (requests: MemberShortening[], strict: boolean): Promise<void> => {
    if (requests.length === 0) return;
    const items: RewriteItem[] = requests.map((r) => {
      const i = indexOf.get(r.id)!;
      const seg = input.segments[i]!;
      return {
        id: r.id,
        sourceText: seg.sourceText,
        currentText: text.get(r.id) ?? '',
        target: r.target,
        max: r.max,
        minUnits: originalFloor(r.id),
        unit: budgetUnitFor(input.targetLanguage),
        ...(seg.speakerId ? { speakerId: seg.speakerId } : {}),
        ...neighboursOf(input.segments, i, textOf),
      };
    });
    const result = await requestRewrites(
      chat,
      {
        kind: 'shorten',
        ...languages,
        items,
        strict,
        ...(input.documentContext ? { documentContext: input.documentContext } : {}),
      },
      signal,
    );
    errors.push(...result.errors);
    for (const item of items) {
      const proposed = result.proposals.get(item.id);
      const verdict = judgeShortening(item, proposed, languages);
      // A proposal that is shorter and clean but still above its ceiling is
      // accepted as progress: pass 2 pushes the unit further if it needs it.
      if (verdict.accepted) text.set(item.id, proposed!.trim());
      else if (proposed !== undefined) rejected.push({ id: item.id, proposed, reason: verdict.reason ?? 'refused' });
    }
  };

  // Pass 1: every overflowing unit.
  const first = input.units.flatMap((u) => plan(u, u.generatedMs));
  await runPass(first, false);

  // Pass 2: units whose estimated new length still needs more than the
  // comfortable speed-up — estimated, not re-synthesized.
  const estimateMs = (u: OverflowUnit): number => {
    const before = u.memberIds.reduce((a, id) => a + countSpeechUnits(original.get(id) ?? '', input.targetLanguage), 0);
    const after = u.memberIds.reduce((a, id) => a + countSpeechUnits(text.get(id) ?? '', input.targetLanguage), 0);
    return before > 0 ? (u.generatedMs * after) / before : u.generatedMs;
  };
  const second = input.units
    .filter((u) => estimateMs(u) > u.availableMs * FIT_COMFORT_RATIO)
    .flatMap((u) => plan(u, estimateMs(u)));
  await runPass(second, true);

  const accepted = new Map<string, string>();
  const changes: ShortenChange[] = [];
  for (const [id, after] of text) {
    const before = original.get(id) ?? '';
    if (after === before) continue;
    accepted.set(id, after);
    changes.push({
      id,
      before,
      after,
      unitsBefore: countSpeechUnits(before, input.targetLanguage),
      unitsAfter: countSpeechUnits(after, input.targetLanguage),
    });
  }
  const stillLong = input.units.filter((u) => estimateMs(u) > u.availableMs * FIT_COMFORT_RATIO).map((u) => u.id);
  return { accepted, changes, rejected, stillLong, errors };
}

// ---- Editor: Tighten to fit -----------------------------------------------------

/** Result of {@link tightenOneLine}. */
export interface TightenOutcome {
  text: string;
  shortened: boolean;
  /** Why the line was kept, when it was. */
  reason?: string;
}

/**
 * "Tighten to fit" for one line: ask the context engine to shorten the
 * CURRENT text to the line's budget (its cue plus the pause after it, at the
 * voice's rate — and always at least one unit shorter than now, since the user
 * asked), with neighbours and the character sheet; keep it only if
 * {@link judgeShortening} accepts. Engine errors other than cancellation keep
 * the text and say why.
 */
export async function tightenOneLine(
  input: DubLanguages & {
    segments: readonly TranscriptSegment[];
    segmentId: string;
    /** The window the line may fill (ms). */
    windowMs: number;
    documentContext?: TranslationDocContext;
    perSecond?: number;
  },
  chat: PassChat,
  signal?: AbortSignal,
): Promise<TightenOutcome> {
  const languages = { sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage };
  const index = input.segments.findIndex((s) => s.id === input.segmentId);
  const seg = input.segments[index];
  if (!seg) return { text: '', shortened: false, reason: 'segment not found' };
  const current = (seg.translatedText ?? '').trim();
  const units = countSpeechUnits(current, input.targetLanguage);
  if (units <= 1) return { text: current, shortened: false, reason: 'the line is already as short as it can be' };
  const budget = fitBudget(input.targetLanguage, input.windowMs, input.perSecond);
  const floor = Math.max(1, Math.ceil(units * (1 - MAX_CUT_SHARE)));
  const max = Math.max(floor, Math.min(units - 1, budget?.max ?? units - 1));
  const target = Math.min(max, Math.max(floor, budget?.target ?? max));
  const textOf = (s: TranscriptSegment): string => (s.translatedText ?? '').trim();
  const item: RewriteItem = {
    id: seg.id,
    sourceText: seg.sourceText,
    currentText: current,
    target,
    max,
    unit: budget?.unit ?? budgetUnitFor(input.targetLanguage),
    ...(seg.speakerId ? { speakerId: seg.speakerId } : {}),
    ...neighboursOf(input.segments, index, textOf),
  };
  const result = await requestRewrites(
    chat,
    {
      kind: 'shorten',
      ...languages,
      items: [item],
      ...(input.documentContext ? { documentContext: input.documentContext } : {}),
    },
    signal,
  );
  const proposed = result.proposals.get(seg.id);
  if (proposed === undefined) {
    return { text: current, shortened: false, reason: result.errors[0] ?? 'the model returned nothing usable' };
  }
  const verdict = judgeShortening(item, proposed, languages);
  return verdict.accepted
    ? { text: proposed.trim(), shortened: true }
    : { text: current, shortened: false, reason: verdict.reason ?? 'refused' };
}

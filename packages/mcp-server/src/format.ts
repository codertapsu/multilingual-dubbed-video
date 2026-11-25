/**
 * Turning the app's documents into text Claude reads well: one compact line
 * per cue rather than JSON (a 30-minute video has ~500 cues, and the line form
 * is roughly a third of the tokens), with the numbers that matter for a dub —
 * how long the original line lasts, how much speech fits in it, and how the
 * current translation fits.
 */
import {
  countSpeechUnits,
  fitBudget,
  fitWindowMs,
  type AudioDrift,
  type FitBudget,
  type PipelineState,
  type TimelineSegment,
} from '@videodubber/shared';

/**
 * The source's audio against its picture as the extract-audio step counted it
 * (docs/plans/production-requests-2026-11-23.md 1.1): a line for get_project,
 * or none before that step ran. Pure.
 */
export function audioDriftLines(info: { audioDrift?: AudioDrift } | undefined): string[] {
  const d = info?.audioDrift;
  if (!d) return [];
  const s = (ms: number): string => (Math.abs(ms) / 1000).toFixed(2);
  const what =
    d.driftMs >= 500
      ? `the audio was ${s(d.driftMs)} s longer than the picture, re-timed to it`
      : d.driftMs <= -500
        ? `the audio ends ${s(d.driftMs)} s before the picture, silence fills the rest`
        : `in step with the picture (${d.driftMs >= 0 ? '+' : '-'}${s(d.driftMs)} s)`;
  return [`Audio vs picture: ${what} (counted from its decoded samples${d.range ? ", in this part's window" : ''}).`];
}

/**
 * How a line is budgeted: the voice's pace (the timeline's `speechRate`; else
 * the language default) and when the next line starts (a line may use up to a
 * second of the pause after it). The same budget the app's own prompts quote.
 */
export interface BudgetContext {
  perSecond?: number;
  nextStartMs?: number;
}

/** 83456 -> "01:23.46". Hours appear only when needed. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000) % 60;
  const h = Math.floor(total / 360000);
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/**
 * How long a line is, in the unit its spoken-length budget uses: Vietnamese
 * syllables (one per whitespace token), Chinese/Japanese characters, else words.
 * The app's own counting (shared), so Claude and the pipeline agree.
 */
export const spokenLength = countSpeechUnits;

/** The budget of one cue: aim for `target`, never above `max`. */
export function lineBudget(
  seg: { startMs: number; endMs: number },
  targetLanguage: string,
  ctx: BudgetContext = {},
): FitBudget | undefined {
  return fitBudget(targetLanguage, fitWindowMs(seg, ctx.nextStartMs), ctx.perSecond);
}

/** "≤13 syllables (aim 11)" for a cue, or "" when it has no usable timing. */
export function budgetLabel(seg: { startMs: number; endMs: number }, targetLanguage: string, ctx: BudgetContext = {}): string {
  const b = lineBudget(seg, targetLanguage, ctx);
  if (!b) return '';
  return b.max > b.target ? `≤${b.max} ${b.unit} (aim ${b.target})` : `≤${b.max} ${b.unit}`;
}

export interface LineFlags {
  stale: boolean;
  locked: boolean;
  conflict: boolean;
  review: boolean;
  overBudget: boolean;
  /** The app's per-line checks failed (foreign script, pinyin, "a/b" alternatives…). */
  quality: NonNullable<TimelineSegment['qualityFlags']>;
}

/** What is worth a reviewer's attention on one cue. */
export function lineFlags(seg: TimelineSegment, targetLanguage: string, ctx: BudgetContext = {}): LineFlags {
  const b = lineBudget(seg, targetLanguage, ctx);
  const len = seg.translatedText ? spokenLength(seg.translatedText, targetLanguage) : 0;
  return {
    stale: seg.ttsStale === true,
    locked: seg.locked === true,
    conflict: seg.alignment?.status === 'timing-conflict',
    review: seg.alignment?.status === 'needs-review',
    // Past the budget's ceiling the dub has to speed up audibly.
    overBudget: b !== undefined && len > b.max,
    quality: seg.qualityFlags ?? [],
  };
}

/**
 * One cue as one line:
 * `seg_0012 00:46.84-00:49.76 (2.9s, ≤13 syllables (aim 11)) | 这地方不在三界 => Nơi này không thuộc tam giới [6] fit 1.00x ok`
 */
export function renderLine(
  seg: TimelineSegment,
  targetLanguage: string,
  ctx: BudgetContext = {},
  /** Why the app suggests this line is sung (GET /projects/:id/songs), when it does. */
  songReasons?: readonly string[],
): string {
  const dur = ((seg.endMs - seg.startMs) / 1000).toFixed(1);
  const budget = budgetLabel(seg, targetLanguage, ctx);
  const head = `${seg.id} ${clock(seg.startMs)}-${clock(seg.endMs)} (${dur}s${budget ? `, ${budget}` : ''})`;
  const parts = [`${head} | ${seg.sourceText.trim()}`];
  if (seg.translatedText !== undefined) {
    parts.push(`=> ${seg.translatedText.trim()} [${spokenLength(seg.translatedText, targetLanguage)}]`);
  }
  const a = seg.alignment;
  if (a) parts.push(`fit ${a.speedRatio.toFixed(2)}x ${a.status}${a.overflowMs > 0 ? ` +${a.overflowMs}ms` : ''}`);
  const tags: string[] = [];
  // A range that looked like a transcription loop and could not be repaired:
  // compare it with the audio (retranscribe_range) and fix it (replace_lines).
  if (seg.loopSuspect) tags.push('LOOP? check against the audio');
  // Kept as the original song (mark_song): no voice, the original plays. A
  // suggestion is only that: the app never applies one by itself.
  if (seg.song) tags.push('SONG: the original plays, no voice');
  else if (songReasons?.length) tags.push(`SONG? ${songReasons.join('+')}: keep the original with mark_song`);
  if (seg.qualityFlags?.length) tags.push(`NEEDS FIX: ${seg.qualityFlags.join(', ')}`);
  if (seg.locked) tags.push('locked');
  if (seg.ttsStale) tags.push('voice out of date');
  if (seg.voiceId) tags.push(`voice=${seg.voiceId}`);
  if (seg.speakingRate !== undefined) tags.push(`rate=${seg.speakingRate}`);
  if (seg.speakerId) tags.push(`speaker=${seg.speakerId}`);
  if (tags.length > 0) parts.push(`{${tags.join(', ')}}`);
  return parts.join(' ');
}

/** The parts of the app's translation reports the summary reads (GET /projects/:id/translation-report). */
export interface TranslationReportDoc {
  translation: {
    characterSheet?: { status: string; engine?: string; reason?: string; attempts?: { mode: string; error?: string }[] };
    quality?: {
      checked: number;
      repaired: { id: string; before: string; after: string }[];
      flagged: { id: string; flags: string[] }[];
      errors?: string[];
    };
    autoFit?: {
      units: number;
      changes: { id: string; before: string; after: string }[];
      rejected: { id: string; reason: string }[];
      stillLong: string[];
    };
  };
  review: {
    skipped?: boolean;
    reason?: string;
    reviewed?: number;
    changes?: { id: string; before: string; after: string }[];
    rejected?: { id: string; reason: string }[];
    failedBatches?: string[][];
  } | null;
}

/** At most `n` items, then "… and K more". */
function capped<T>(items: readonly T[], n: number, line: (item: T) => string): string[] {
  const out = items.slice(0, n).map(line);
  if (items.length > n) out.push(`  … and ${items.length - n} more`);
  return out;
}

/**
 * The app's own translation passes, as a reviewer reads them: was a character
 * sheet built, which lines failed the checks, what the review and auto-fit
 * changed or were refused. Pure.
 */
export function renderTranslationReport(doc: TranslationReportDoc): string {
  const lines: string[] = [];
  const { characterSheet: sheet, quality, autoFit } = doc.translation;
  if (sheet) {
    const by = sheet.engine ? ` with "${sheet.engine}"` : '';
    if (sheet.status === 'failed') {
      const why = (sheet.attempts ?? []).map((a) => `${a.mode}: ${a.error ?? 'failed'}`).join('; ');
      lines.push(
        `Character sheet: FAILED${by}${why ? ` (${why})` : ''}. Names and terms of address may drift — ` +
          'write one with set_translation_context.',
      );
    } else if (sheet.status === 'skipped') {
      lines.push(`Character sheet: skipped${sheet.reason ? ` (${sheet.reason})` : ''}.`);
    } else {
      lines.push(`Character sheet: ${sheet.status}${by}.`);
    }
  }
  if (quality) {
    lines.push(
      `Line checks (${quality.checked} lines): ${quality.repaired.length} repaired, ${quality.flagged.length} still flagged.`,
    );
    lines.push(...capped(quality.flagged, 20, (f) => `  flagged ${f.id}: ${f.flags.join(', ')}`));
    lines.push(...capped(quality.repaired, 10, (r) => `  repaired ${r.id}: "${r.before}" -> "${r.after}"`));
    if (quality.errors?.length) lines.push(`  model errors: ${quality.errors.slice(0, 3).join('; ')}`);
  }
  const review = doc.review;
  if (review?.skipped) {
    lines.push(`Review: skipped${review.reason ? ` (${review.reason})` : ''}.`);
  } else if (review) {
    const changes = review.changes ?? [];
    const rejected = review.rejected ?? [];
    lines.push(
      `Review (${review.reviewed ?? '?'} lines): ${changes.length} changed, ${rejected.length} refused by the checks` +
        `${review.failedBatches?.length ? `, ${review.failedBatches.length} batch(es) got no usable reply` : ''}.`,
    );
    lines.push(...capped(changes, 10, (c) => `  changed ${c.id}: "${c.before}" -> "${c.after}"`));
    lines.push(...capped(rejected, 10, (r) => `  refused ${r.id}: ${r.reason}`));
  }
  if (autoFit) {
    lines.push(
      `Auto-fit (${autoFit.units} over-long unit(s)): ${autoFit.changes.length} line(s) shortened, ` +
        `${autoFit.rejected.length} refused, ${autoFit.stillLong.length} still long.`,
    );
    lines.push(...capped(autoFit.changes, 10, (c) => `  shortened ${c.id}: "${c.before}" -> "${c.after}"`));
    lines.push(...capped(autoFit.rejected, 10, (r) => `  refused ${r.id}: ${r.reason}`));
    if (autoFit.stillLong.length > 0) lines.push(`  still long: ${autoFit.stillLong.slice(0, 20).join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'No translation passes have run yet.';
}

/** The pipeline as a short status block. */
export function renderPipeline(p: PipelineState, now = Date.now()): string {
  // A rough time left (steps do not take equal time): what the field report
  // asked for after a 10-hour dub the agent could only guess the end of.
  const started = p.steps.find((s) => s.startedAt)?.startedAt;
  const elapsedSec = started ? (now - Date.parse(started)) / 1000 : NaN;
  const eta =
    p.status === 'running' && Number.isFinite(elapsedSec) && elapsedSec > 0 && p.progressPercent >= 3 && p.progressPercent < 100
      ? Math.round((elapsedSec * (100 - p.progressPercent)) / p.progressPercent)
      : undefined;
  const lines = [
    `Pipeline: ${p.status}, ${Math.round(p.progressPercent)}%${p.currentStep ? `, at "${p.currentStep}"` : ''}` +
      `${eta !== undefined ? `, about ${eta >= 3600 ? `${Math.floor(eta / 3600)} h ${String(Math.round((eta % 3600) / 60)).padStart(2, '0')} min` : `${Math.max(1, Math.round(eta / 60))} min`} left` : ''}`,
  ];
  for (const s of p.steps) {
    const pct = s.status === 'running' ? ` ${Math.round(s.progressPercent)}%` : '';
    // The step's own words for where it is ("Detecting speakers 3/12").
    const detail = s.status === 'running' && s.detail?.text ? ` (${s.detail.text})` : '';
    lines.push(`  ${s.id.padEnd(13)} ${s.status}${pct}${detail}${s.error ? ` — ${s.error.split('\n')[0]}` : ''}`);
  }
  // What the run did on its own that the result depends on (a CPU fallback,
  // speakers not detected, repaired transcription loops): never only in a log.
  if (p.warnings && p.warnings.length > 0) {
    lines.push('Warnings:', ...p.warnings.map((w) => `  - [${w.code}${w.step ? `, ${w.step}` : ''}] ${w.message}`));
  }
  if (p.awaitingReview && p.heldLines?.length) {
    lines.push(
      `STOPPED BEFORE VOICING: ${p.heldLines.length} line(s) still fail the translation checks (holdFlaggedLines): ` +
        `${p.heldLines.slice(0, 10).join(', ')}${p.heldLines.length > 10 ? ', …' : ''}. ` +
        'get_transcript marks them NEEDS FIX; fix them with set_translations, then call start_dubbing (it voices the lines as they are then).',
    );
  } else if (p.awaitingReview) {
    lines.push(
      'PAUSED FOR REVIEW: translation is done and no voice has been made yet. Review/rewrite lines ' +
        '(get_transcript, set_translations), then call start_dubbing to continue.',
    );
  } else if (p.status === 'paused') {
    lines.push(
      `PAUSED${p.pausedStep ? ` at "${p.pausedStep}"` : ''}${p.pausedAt ? ` since ${p.pausedAt}` : ''}: ` +
        'everything done so far is kept. Call start_dubbing (no fromStep) to continue from there.',
    );
  }
  if (p.error && p.status === 'failed') lines.push(`Error: ${p.error}`);
  return lines.join('\n');
}

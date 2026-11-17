/**
 * Context-aware review of EXISTING translations — the shared core behind:
 *   - the `argos-llm-repair` provider (Argos drafts, LLM repairs), and
 *   - the optional `refine` pipeline step (any translation's output reviewed
 *     by a context-capable LLM after the translation step).
 *
 * The reviewer sees each line's source + current translation plus structured
 * document context (character sheet, rolling window of the preceding reviewed
 * lines, scene breaks) and returns the corrected line — or the input unchanged
 * when it is already right. Research backing: draft + context-aware
 * post-editing holds the best published pronoun-disambiguation scores
 * (Koneru et al., NAACL 2024), and a review pass is where document-level
 * consistency (terms of address, terminology, register) is cheapest to enforce.
 *
 * Failure posture: a malformed/missing reviewed line keeps the current text —
 * a less-polished line beats a broken pipeline. Cancellation propagates.
 *
 * Every proposal is CHECKED before it replaces a draft, because an audit of
 * three real review runs (2026-11) found the reviewer improving most lines but
 * also: moving a name into the neighbouring cue (0271/0272), keeping a meaning
 * reversal, and replying with malformed JSON that silently kept whole batches
 * of drafts. Rejections are returned with their reason so the step can report
 * them instead of losing them.
 */
import {
  AppErrorException,
  normalizeLanguageCode,
  type TranslationDocContext,
  type TranslationInput,
  type TranslationResult,
  type TranslationResultSegment,
} from '@videodubber/shared';
import {
  ASR_SOURCE_NOTE,
  isCancellation,
  parseTranslationReply,
  segmentsReplySchema,
  type ChatOptions,
  type PromptSegment,
} from './llmTranslationProvider.js';
import {
  buildContextHeader,
  collectRollingPairs,
  generateCharacterSheet,
  isSceneBreak,
  MIN_SEGMENTS_FOR_ANALYSIS,
  planContextBatches,
  translationContextEnabled,
  type AnalysisAttempt,
  type RollingPair,
  type TranslationAnalysis,
} from './translationContext.js';
import { checkDubLine, describeFlags, looksUntranslated, normalizeForCompare, qualityScore } from './lineQuality.js';
import { budgetPhrase, countSpeechUnits, segmentFitBudget, withFitWindows } from './speechFit.js';

/** Review batches are smaller than translation batches: each line appears
 * twice (source + current translation), so the same char budget covers fewer
 * lines. */
export const REVIEW_BATCH_SEGMENTS = 16;
export const REVIEW_BATCH_CHARS = 5_000;

/** How the reviewed lines are framed to the model. */
export type ReviewMode =
  /** Drafts from a context-free MT system (Argos/TranslateGemma): expect and
   * fix context damage aggressively. */
  | 'repair'
  /** Output of a (possibly context-aware) translation: polish conservatively —
   * naturalness, cohesion, consistency — change only what improves the dub. */
  | 'refine';

/**
 * Build the review prompt for one batch: each line shows who speaks it, the
 * source and the current translation with its length range; the model returns
 * the corrected translation per id (or the current text verbatim when it is
 * already right). Pure / unit-tested.
 */
export function buildReviewPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  batch: PromptSegment[],
  draftById: ReadonlyMap<string, string>,
  mode: ReviewMode,
  context?: string,
  opts?: { perSecond?: number; insist?: boolean },
): string {
  const vi = targetLanguage.split('-')[0]!.toLowerCase() === 'vi';
  const list = batch
    .map((s) => {
      const src = s.sourceText.replace(/\s*\r?\n\s*/g, ' ');
      const draft = (draftById.get(s.id) ?? '').replace(/\s*\r?\n\s*/g, ' ');
      const budget = segmentFitBudget(s, targetLanguage, opts?.perSecond);
      const hint = budget !== undefined ? `  [length: ${budgetPhrase(budget, targetLanguage)}]` : '';
      // Who speaks decides xưng hô; the review prompt used to drop it even
      // though the translation prompt carried it.
      const who = s.speakerId ? ` (${s.speakerId})` : '';
      return `${s.id}${who}:\n  source: ${src}\n  draft: ${draft}${hint}`;
    })
    .join('\n');
  const hasSpeakers = batch.some((s) => s.speakerId);
  const framing =
    mode === 'repair'
      ? [
          'Each segment below has the original source and a draft translation from a sentence-level MT system that had NO conversation context.',
          'Fix ONLY what the missing context broke, plus outright mistranslations:',
        ]
      : [
          'Each segment below has the original source and the current translation of a dubbing script. Review the WHOLE dialogue and correct each line:',
        ];
  return [
    `You are reviewing machine-translated dubbing lines ("${sourceLanguage}" -> "${targetLanguage}").`,
    ...(opts?.insist
      ? ['IMPORTANT: your previous reply was not valid JSON. Reply with the JSON object only, one entry per segment id.']
      : []),
    ...framing,
    ...(context ? [context] : []),
    '- Meaning first: each translation must say what its source says. Fix mistranslations — a negation dropped or reversed, the wrong subject or object, an idiom read literally into the opposite sense.',
    `- ${ASR_SOURCE_NOTE}`,
    `- Pronouns and terms of address: make them match the speaker relationships (e.g. Vietnamese xưng hô — thầy/cô, anh/chị, em, bạn, con, ta/ngươi — per the context) and keep them consistent across ALL segments.${hasSpeakers ? ' The label in parentheses after a segment id is WHO SPEAKS that line.' : ''}`,
    `- Terminology and names: follow the glossary and keep the same rendering everywhere${vi ? ' — Chinese names in Hán-Việt with Vietnamese letters, never pinyin or Chinese characters' : ''}.`,
    '- Cohesion with the previous lines (connectives, register, tone) and natural SPOKEN phrasing — these lines are performed by a voice, not read.',
    "- Keep each line's content in THAT line. A sentence split across two segments may read awkwardly, but never move words, names or meaning from one segment into another: each segment is spoken at its own moment.",
    '- Length: stay within each line\'s range ("about N, never more than M") and never make a line meaningfully longer than its draft.',
    '- One spoken form only: no alternatives with "/", no notes or explanations.',
    'When a draft is already correct and natural, return it unchanged. Never merge or split segments.',
    'Respond with ONLY a JSON object of the form {"segments":[{"id":"seg_0001","text":"..."}]} — one entry per input id, no prose, no markdown fences.',
    '',
    'Segments:',
    list,
  ].join('\n');
}

/** The chat primitive a reviewer engine must provide. */
export interface ReviewChat {
  chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string>;
  /** Context window in tokens (sizes the analysis transcript). */
  readonly contextTokens?: number;
}

/** Inputs to {@link reviewTranslations}. */
export interface ReviewInput {
  sourceLanguage: string;
  targetLanguage: string;
  /** Segments WITH timing (budgets) — `sourceText` is the original line. */
  segments: PromptSegment[];
  /** Current translation per segment id (the text under review). */
  draftById: ReadonlyMap<string, string>;
  /** Persisted character sheet; when absent one is generated (and returned). */
  documentContext?: TranslationDocContext;
  mode: ReviewMode;
  /** Speaking rate of the dub voice (budget units/s). */
  perSecond?: number;
  /** The caller owns the character sheet: never generate one here. */
  skipAnalysis?: boolean;
  /**
   * Lines per request (default {@link REVIEW_BATCH_SEGMENTS}). Small local
   * models get fewer: Gemma 3 4B answering 16 lines at once returned one
   * line's text under another's id (谢谢师尊 came back as "Không cần nói nhiều").
   */
  batchSegments?: number;
  /**
   * Lines reviewed so far, out of all of them, as batches finish. The step
   * reported nothing of its own: a 16-minute review sat at "refine 0%".
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * Batches an earlier, unfinished run of this same review finished (a pause,
   * a closed app, a crash), by {@link reviewBatchKey}: kept as they were, and
   * still the context for the next batch. Only the pipeline sets it, and only
   * for an unchanged review (pipeline/translationCheckpoint.ts).
   */
  resume?: ReadonlyMap<string, ReviewedBatch>;
  /** Each batch as it finishes (not one whose reply was unusable), so the pipeline can save it. */
  onBatch?: (batch: ReviewedBatch) => void;
}

/** One finished review batch: every line's text after it, the changes kept, the proposals refused. */
export interface ReviewedBatch {
  ids: string[];
  merged: Record<string, string>;
  proposals: Record<string, string>;
  rejected: ReviewRejection[];
}

/** Which batch a saved one is: its lines, in order. */
export function reviewBatchKey(ids: readonly string[]): string {
  return ids.join('\n');
}

/** A line the review actually changed. */
export interface ReviewChange {
  id: string;
  source: string;
  before: string;
  after: string;
}

/** A proposal the checks refused (the draft was kept). */
export interface ReviewRejection {
  id: string;
  proposed: string;
  reason: string;
}

/** Result of a review pass. */
export interface ReviewOutcome {
  segments: TranslationResultSegment[];
  /** Ids whose text actually changed. */
  changedIds: string[];
  /** Every applied change with its before/after text. */
  changes: ReviewChange[];
  /** Proposals the checks refused, with the reason. */
  rejected: ReviewRejection[];
  /** Ids of batches whose reply stayed unusable after the retry (drafts kept). */
  failedBatches: string[][];
  /** Character sheet generated by this pass (only when none was provided). */
  analysis?: TranslationAnalysis;
  /** What the analysis attempts did (absent when none ran). */
  analysisAttempts?: AnalysisAttempt[];
}

// ---- Content-move heuristic ---------------------------------------------------

/** Lowercased word tokens (letters/digits), NFC. */
function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Every run of three consecutive words, joined. */
function trigrams(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

function numbers(text: string): Set<string> {
  return new Set(text.match(/\d+/g) ?? []);
}

/** Does `text` contain `phrase` as whole words (case-insensitive)? */
function containsPhrase(text: string, phrase: string): boolean {
  const t = ` ${words(text).join(' ')} `;
  const p = words(phrase).join(' ');
  return p.length > 0 && t.includes(` ${p} `);
}

/** One line as the move check sees it. */
export interface MoveCheckLine {
  id: string;
  sourceText: string;
  draft: string;
  reviewed: string;
}

/**
 * Lines whose review MOVED content across a cue boundary — a simple,
 * documented heuristic, because the dub plays each line at its own cue time,
 * so a name pulled into the next cue is spoken over the wrong picture and the
 * cue it left loses its meaning (audit 2026-11: "又存有盘古大神的 / 混沌地量"
 * came back as "lại có cả sức mạnh của / Bàn Cổ.").
 *
 * For each pair of ADJACENT lines (a, b), the reviewed `a` took content from
 * `b` when it GAINED (present in a's review, absent from a's draft) an anchor
 * that belongs to b and not to a:
 *   - a glossary target whose source term appears in b's source but not in
 *     a's source (names are the most identifiable content);
 *   - three consecutive words of b's draft (shorter runs coincide by chance —
 *     "của ta", "là một");
 *   - a number from b's source or draft that is in neither of a's.
 * Both ids of every such pair are returned: keeping one side's review and the
 * other's draft would duplicate or drop the moved words.
 */
export function detectContentMoves(
  lines: readonly MoveCheckLine[],
  glossary: readonly { source: string; target: string }[] = [],
): Set<string> {
  const moved = new Set<string>();
  const took = (a: MoveCheckLine, b: MoveCheckLine): boolean => {
    if (a.reviewed === a.draft) return false;
    const gained = (phrase: string): boolean => containsPhrase(a.reviewed, phrase) && !containsPhrase(a.draft, phrase);
    for (const g of glossary) {
      if (!g.source || !g.target) continue;
      if (b.sourceText.includes(g.source) && !a.sourceText.includes(g.source) && gained(g.target)) return true;
    }
    const ownTri = trigrams(a.draft);
    const reviewedTri = trigrams(a.reviewed);
    for (const t of trigrams(b.draft)) {
      if (!ownTri.has(t) && reviewedTri.has(t)) return true;
    }
    const ownNums = new Set([...numbers(a.sourceText), ...numbers(a.draft)]);
    const draftNums = numbers(a.draft);
    for (const n of new Set([...numbers(b.sourceText), ...numbers(b.draft)])) {
      if (!ownNums.has(n) && numbers(a.reviewed).has(n) && !draftNums.has(n)) return true;
    }
    return false;
  };
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (took(a, b) || took(b, a)) {
      moved.add(a.id);
      moved.add(b.id);
    }
  }
  return moved;
}

/**
 * The id of ANOTHER line in the batch (with a different source) whose draft
 * `proposed` reproduces exactly — a reply that put one line's text under
 * another's id. Lines with the same source may legitimately share a rendering
 * (four "在" → four "Có mặt!"). Pure.
 */
export function copiedLine(
  seg: PromptSegment,
  proposed: string,
  batch: readonly PromptSegment[],
  draftById: ReadonlyMap<string, string>,
): string | undefined {
  // `batch` is the window to compare against: the review passes the lines
  // around the batch too, since a model can reach back into the rolling context.
  const key = normalizeForCompare(proposed);
  if (!key) return undefined;
  const ownSource = normalizeForCompare(seg.sourceText);
  for (const other of batch) {
    if (other.id === seg.id || normalizeForCompare(other.sourceText) === ownSource) continue;
    const draft = draftById.get(other.id);
    if (draft !== undefined && normalizeForCompare(draft) === key) return other.id;
  }
  return undefined;
}

/** Lines either side of a reviewed line that its proposal is compared against for copying. */
const COPY_WINDOW = 12;

const ZH_SECOND_PERSON_RE = /[你您]|汝|尔等/u;
const ZH_THIRD_PERSON_RE = /[他她它]/u;
const VI_THIRD_PERSON_RE =
  /(^|[^\p{L}])(anh ấy|chị ấy|cô ấy|ông ấy|bà ấy|em ấy|cậu ấy|hắn|nó|anh ta|chị ta|cô ta|ông ta|bà ta|lão ta|họ|người đó|kẻ đó|gã)(?=$|[^\p{L}])/iu;
/** Unambiguous "you" (anh/chị/em/ông… are also third-person titles, so not these). */
const VI_SECOND_PERSON_RE = /(^|[^\p{L}])(ngươi|các ngươi|mày|chúng mày|các bạn|bạn)(?!\s+ấy)(?=$|[^\p{L}])/iu;

/**
 * zh→vi: did the review turn a third-person reference into "you"? True when
 * the source says 他/她/它 and no 你/您, the draft had a third-person form, and
 * the review introduced an unambiguous second-person one it did not have. The
 * Gemma 3 4B review did exactly this after reading a pronoun plan full of
 * "ngươi": 放过他 "Hãy tha thứ cho anh ấy." → "…cho ngươi", 镇压他千年 →
 * "Ngăn chặn ngươi…". Pure.
 */
export function swapsThirdPersonForYou(sourceText: string, draft: string, reviewed: string): boolean {
  if (!ZH_THIRD_PERSON_RE.test(sourceText) || ZH_SECOND_PERSON_RE.test(sourceText)) return false;
  if (!VI_THIRD_PERSON_RE.test(draft)) return false;
  return VI_SECOND_PERSON_RE.test(reviewed) && !VI_SECOND_PERSON_RE.test(draft);
}

// ---- The review pass ----------------------------------------------------------

/** Reply budget for one review batch (16 lines + JSON). */
const REVIEW_REPLY_TOKENS = 3072;

/**
 * Did the reviewed line grow past what fits? Over its ceiling AND clearly
 * longer than the draft (a draft that was already over is not the review's
 * fault). Without a budget, half again the draft's length. Pure.
 */
export function grewTooLong(
  draft: string,
  reviewed: string,
  targetLanguage: string,
  budgetMax: number | undefined,
): boolean {
  const before = countSpeechUnits(draft, targetLanguage);
  const after = countSpeechUnits(reviewed, targetLanguage);
  if (budgetMax !== undefined) return after > budgetMax && after > Math.ceil(before * 1.2);
  return after > Math.ceil(before * 1.5) + 1;
}

/**
 * Review a whole transcript's translations with document context: optional
 * analysis pass (when no sheet was provided), then scene-aware batches with a
 * rolling window of already-reviewed pairs. Unusable replies (missing, empty,
 * or — across languages — a source echo) keep the current text; a reply with
 * no usable JSON at all is retried once (insisting on JSON) before the batch
 * keeps its drafts. Proposals that fail the line checks, grow past the length
 * ceiling, or move content between adjacent cues keep the draft too.
 */
export async function reviewTranslations(
  input: ReviewInput,
  chat: ReviewChat,
  signal?: AbortSignal,
): Promise<ReviewOutcome> {
  const source = normalizeLanguageCode(input.sourceLanguage);
  const target = normalizeLanguageCode(input.targetLanguage);
  const detectSourceEcho = source.split('-')[0] !== target.split('-')[0];
  const languages = { sourceLanguage: source, targetLanguage: target };

  let analysis: TranslationAnalysis | undefined = input.documentContext;
  let generated: TranslationAnalysis | undefined;
  let analysisAttempts: AnalysisAttempt[] | undefined;
  if (
    translationContextEnabled() &&
    analysis === undefined &&
    input.skipAnalysis !== true &&
    input.segments.length >= MIN_SEGMENTS_FOR_ANALYSIS
  ) {
    const sheet = await generateCharacterSheet(chat, { ...languages, segments: input.segments }, signal);
    generated = sheet.analysis;
    analysisAttempts = sheet.attempts;
    analysis = generated;
  }

  const timed = withFitWindows(input.segments);
  const batches = planContextBatches(timed, {
    maxSegments: Math.max(1, input.batchSegments ?? REVIEW_BATCH_SEGMENTS),
    maxChars: REVIEW_BATCH_CHARS,
  });
  const indexById = new Map(timed.map((s, i) => [s.id, i]));
  const proposals = new Map<string, string>();
  const rejected: ReviewRejection[] = [];
  const failedBatches: string[][] = [];
  const system = 'You are a professional subtitle/dubbing translator. Respond with strict JSON only.';
  let previousBatch: PromptSegment[] | undefined;
  let rolling: RollingPair[] = [];
  let reviewed = 0;
  for (const batch of batches) {
    const ids = batch.map((s) => s.id);
    // Finished before a pause: as it was, and still the next batch's context.
    const saved = input.resume?.get(reviewBatchKey(ids));
    if (saved) {
      for (const [id, text] of Object.entries(saved.proposals)) proposals.set(id, text);
      rejected.push(...saved.rejected);
      rolling = collectRollingPairs(batch, new Map(Object.entries(saved.merged)));
      previousBatch = batch;
      reviewed += batch.length;
      input.onProgress?.(reviewed, timed.length);
      continue;
    }
    const rejectedBefore = rejected.length;
    let unusable = false;
    const context = buildContextHeader({
      analysis,
      previousPairs: rolling,
      sceneBreak: isSceneBreak(previousBatch, batch),
    });
    const ask = async (insist: boolean): Promise<Map<string, string>> =>
      parseTranslationReply(
        await chat.chatComplete(
          system,
          buildReviewPrompt(source, target, batch, input.draftById, input.mode, context || undefined, {
            ...(input.perSecond !== undefined ? { perSecond: input.perSecond } : {}),
            insist,
          }),
          signal,
          { jsonSchema: segmentsReplySchema(ids), maxTokens: REVIEW_REPLY_TOKENS },
        ),
      );
    let byId = await ask(false);
    if (![...byId.keys()].some((id) => ids.includes(id))) {
      // No usable JSON at all. Before, this silently kept 16 drafts; one retry
      // insisting on the format recovers most of those batches.
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Review was cancelled.');
      try {
        byId = await ask(true);
      } catch (err) {
        if (isCancellation(err)) throw err;
        byId = new Map();
      }
      if (![...byId.keys()].some((id) => ids.includes(id))) {
        failedBatches.push(ids);
        unusable = true;
      }
    }

    const mergedById = new Map<string, string>();
    const copyWindow = (id: string): PromptSegment[] => {
      const at = indexById.get(id) ?? 0;
      return timed.slice(Math.max(0, at - COPY_WINDOW), at + COPY_WINDOW + 1);
    };
    for (const seg of batch) {
      const current = input.draftById.get(seg.id) ?? seg.sourceText;
      const reviewed = byId.get(seg.id)?.trim();
      let text = current;
      // A change of punctuation or spacing only is not a change: it bought
      // nothing and would re-synthesize the clip (the 4B review "improved"
      // dozens of lines by dropping their final period).
      const substantive = reviewed !== undefined && normalizeForCompare(reviewed) !== normalizeForCompare(current);
      if (reviewed && reviewed.length > 0 && substantive) {
        const copied = copiedLine(seg, reviewed, copyWindow(seg.id), input.draftById);
        if (detectSourceEcho && looksUntranslated(seg, reviewed)) {
          rejected.push({ id: seg.id, proposed: reviewed, reason: 'echoes the source text' });
        } else if (copied) {
          rejected.push({ id: seg.id, proposed: reviewed, reason: `is another line's text (${copied})` });
        } else if (/^zh/i.test(source) && /^vi/i.test(target) && swapsThirdPersonForYou(seg.sourceText, current, reviewed)) {
          rejected.push({ id: seg.id, proposed: reviewed, reason: 'turns a third-person reference (他/她) into "you"' });
        } else {
          const ctx = { sourceText: seg.sourceText, ...languages };
          const newFlags = checkDubLine(reviewed, ctx);
          const oldFlags = checkDubLine(current, ctx);
          const budget = segmentFitBudget(seg, target, input.perSecond);
          // Refused only for what it BREAKS: a new failed check, or a worse
          // score. A flag the draft already had (a name the checks cannot
          // place) must not block every other improvement to the line.
          const added = newFlags.filter((f) => !oldFlags.includes(f));
          if (added.length > 0 || qualityScore(newFlags) > qualityScore(oldFlags)) {
            rejected.push({
              id: seg.id,
              proposed: reviewed,
              reason: `fails line checks: ${describeFlags(added.length > 0 ? added : newFlags, target)}`,
            });
          } else if (grewTooLong(current, reviewed, target, budget?.max)) {
            rejected.push({
              id: seg.id,
              proposed: reviewed,
              reason: `longer than the line can be spoken in (${countSpeechUnits(reviewed, target)} ${budget?.unit ?? 'units'}, ceiling ${budget?.max ?? '—'})`,
            });
          } else {
            text = reviewed;
            proposals.set(seg.id, reviewed);
          }
        }
      }
      mergedById.set(seg.id, text);
    }
    rolling = collectRollingPairs(batch, mergedById);
    previousBatch = batch;
    // An unusable reply is not saved: a resumed run asks again.
    if (!unusable) {
      input.onBatch?.({
        ids,
        merged: Object.fromEntries(mergedById),
        proposals: Object.fromEntries(ids.filter((id) => proposals.has(id)).map((id) => [id, proposals.get(id)!])),
        rejected: rejected.slice(rejectedBefore),
      });
    }
    reviewed += batch.length;
    input.onProgress?.(reviewed, timed.length);
  }

  // Content that moved between adjacent cues: keep both drafts — unless a
  // draft is itself unusable (Chinese left in, untranslated): then the moved
  // review is the lesser evil, and is kept but reported.
  const moveLines: MoveCheckLine[] = timed.map((s) => {
    const draft = input.draftById.get(s.id) ?? s.sourceText;
    return { id: s.id, sourceText: s.sourceText, draft, reviewed: proposals.get(s.id) ?? draft };
  });
  const moved = detectContentMoves(moveLines, analysis?.glossary ?? []);
  if (moved.size > 0) {
    const segById = new Map(timed.map((s) => [s.id, s]));
    const draftUnusable = (id: string): boolean => {
      const s = segById.get(id)!;
      const flags = checkDubLine(input.draftById.get(id) ?? s.sourceText, { sourceText: s.sourceText, ...languages });
      return flags.includes('untranslated') || flags.includes('wrong-script');
    };
    // Moves are judged per adjacent PAIR; walk the runs of flagged ids.
    const ordered = timed.map((s) => s.id).filter((id) => moved.has(id));
    const runs: string[][] = [];
    for (const id of ordered) {
      const last = runs[runs.length - 1];
      const prevIndex = last ? timed.findIndex((s) => s.id === last[last.length - 1]) : -2;
      const index = timed.findIndex((s) => s.id === id);
      if (last && index === prevIndex + 1) last.push(id);
      else runs.push([id]);
    }
    for (const run of runs) {
      if (run.some(draftUnusable)) continue;
      for (const id of run) {
        const proposed = proposals.get(id);
        if (proposed === undefined) continue;
        proposals.delete(id);
        rejected.push({ id, proposed, reason: 'moves content between neighbouring lines (each line is spoken at its own cue)' });
      }
    }
  }

  const segments: TranslationResultSegment[] = [];
  const changedIds: string[] = [];
  const changes: ReviewChange[] = [];
  for (const seg of timed) {
    const current = input.draftById.get(seg.id) ?? seg.sourceText;
    const text = proposals.get(seg.id) ?? current;
    if (text !== current) {
      changedIds.push(seg.id);
      changes.push({ id: seg.id, source: seg.sourceText, before: current, after: text });
    }
    segments.push({ id: seg.id, translatedText: text });
  }

  return {
    segments,
    changedIds,
    changes,
    rejected,
    failedBatches,
    ...(generated ? { analysis: generated } : {}),
    ...(analysisAttempts ? { analysisAttempts } : {}),
  };
}

/** Convert a TranslationInput's segments to the reviewer's PromptSegment shape. */
export function toPromptSegments(input: TranslationInput): PromptSegment[] {
  return input.segments.map((s) => ({
    id: s.id,
    sourceText: s.sourceText,
    startMs: s.startMs,
    endMs: s.endMs,
    ...(s.speakerId ? { speakerId: s.speakerId } : {}),
  }));
}

/** Assemble a TranslationResult from a review outcome (provider convenience). */
export function reviewToTranslationResult(outcome: ReviewOutcome): TranslationResult {
  return { segments: outcome.segments, ...(outcome.analysis ? { analysis: outcome.analysis } : {}) };
}

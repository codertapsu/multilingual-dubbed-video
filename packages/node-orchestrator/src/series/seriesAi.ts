/**
 * The AI's part in a series: choosing each cut among the candidate pauses,
 * and naming each part. Any refinement-capable translation provider can do
 * it (Claude with a key or through Mother Claude, OpenAI, Gemini, the
 * built-in Gemma), through the same `chatComplete` the review pass uses.
 *
 * Every answer is checked: a cut must be one of the candidates offered, a
 * title must be text. An unusable or missing answer is never fatal; the
 * planner falls back to the best pause and a plain "Part n" title.
 * Prompts stay small (minutes of transcript around one cut), so a local model
 * with an 8k context handles them as well as a cloud one.
 */
import type { SeriesPlanPart } from '@videodubber/shared';

import type { ChatOptions } from '../providers/translation/llmTranslationProvider.js';
import type { CutWindow, PlannerLine } from './seriesPlanner.js';
import { viEstablishedNamesRule } from '../providers/translation/viNames.js';

export interface SeriesChat {
  chatComplete(system: string | undefined, user: string, signal?: AbortSignal, opts?: ChatOptions): Promise<string>;
}

/** m:ss / h:mm:ss. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The JSON object in a reply (models sometimes wrap it in a fence). */
export function parseJsonReply(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Lines between two times as "[m:ss] text", thinned evenly to at most `maxChars`. */
export function transcriptExcerpt(
  lines: readonly (PlannerLine & { speakerId?: string })[],
  fromMs: number,
  toMs: number,
  maxChars: number,
  /** Who each speaker id is (the sheet's cast): lines say who speaks them. */
  speakers?: ReadonlyMap<string, string>,
): string {
  const who = (l: { speakerId?: string }): string => {
    if (!l.speakerId) return '';
    const name = speakers?.get(l.speakerId);
    return name ? `${name}: ` : `${l.speakerId}: `;
  };
  const inside = lines.filter((l) => l.endMs > fromMs && l.startMs < toMs).map((l) => `[${clock(l.startMs)}] ${who(l)}${l.sourceText.trim()}`);
  const total = inside.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return inside.join('\n');
  const keep = Math.max(1, Math.floor((inside.length * maxChars) / total));
  const step = inside.length / keep;
  const out: string[] = [];
  for (let i = 0; i < keep; i++) out.push(inside[Math.floor(i * step)]!);
  return out.join('\n');
}

const CUT_SYSTEM =
  'You split a long video into shorter parts for viewers. Choose the pause where one topic, scene or story beat ends and the next begins, so the part ends at a natural point. Reply with JSON only.';

/** The candidate the AI picks for one cut, or undefined (then the planner's fallback). */
export async function aiChooseCut(
  chat: SeriesChat,
  window: CutWindow,
  lines: readonly PlannerLine[],
  context: { seriesName: string; sourceLanguageName: string },
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (window.candidates.length === 0) return undefined;
  // A joined project's file boundary is where one source video ends: said so,
  // since the transcript alone cannot show it.
  const list = window.candidates
    .map(
      (c, i) =>
        `C${i + 1} at ${clock(c.ms)}${c.boundary ? ' (one source video ends here and the next begins)' : c.score >= 3 ? ' (a scene change or chapter here)' : ''}`,
    )
    .join('\n');
  const transcript = transcriptExcerpt(lines, window.fromMs - 60_000, window.toMs + 60_000, 6000);
  const user =
    `Video: "${context.seriesName}". The cut must be one of these pauses between lines:\n${list}\n\n` +
    `What is said around them (${context.sourceLanguageName}), with times:\n${transcript}\n\n` +
    'Reply {"candidate":"C<n>"} with the pause that best ends a part.';
  const reply = await chat.chatComplete(CUT_SYSTEM, user, signal, {
    jsonSchema: { type: 'object', properties: { candidate: { type: 'string' } }, required: ['candidate'] },
    maxTokens: 64,
  });
  const id = parseJsonReply(reply)?.['candidate'];
  const n = typeof id === 'string' ? Number(/^C?(\d+)$/i.exec(id.trim())?.[1]) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= window.candidates.length ? window.candidates[n - 1]!.ms : undefined;
}

/** The summary's length asked for; a longer one is cut at a sentence or a word ({@link clipText}). */
const SUMMARY_ASK = 250;

/**
 * `text` in at most `max` characters, cut where a sentence ends, else where a
 * word ends (with "…"), never inside a word: 3 of Phong Thủy Thiên Sư's 29
 * summaries ended mid-word at 400 characters (claude-dubber, 2026-11-27). Pure.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(...['. ', '! ', '? ', '… ', '。', '！', '？'].map((end) => head.lastIndexOf(end)));
  if (sentence >= max / 2) return head.slice(0, sentence + 1).trim();
  const space = head.lastIndexOf(' ', max - 1);
  return `${(space > 0 ? head.slice(0, space) : head.slice(0, max - 1)).replace(/[\s,;:–-]+$/u, '')}…`;
}

const TITLE_SYSTEM =
  'You name one part of a long video for viewers who will watch the parts in order. Reply with JSON only.';

/** A part's short title and one-sentence summary in the dub's language, or undefined. */
export async function aiTitlePart(
  chat: SeriesChat,
  part: Pick<SeriesPlanPart, 'index' | 'startMs' | 'endMs'>,
  count: number,
  lines: readonly PlannerLine[],
  context: {
    seriesName: string;
    sourceLanguageName: string;
    targetLanguageName: string;
    /** The codes, for rules of one pair (established Vietnamese names for Chinese ones). */
    targetLanguage?: string;
    sourceLanguage?: string;
    names?: readonly string[];
    /** Who each speaker id is: the summary names who said what (one named the wrong brother, F3). */
    speakers?: ReadonlyMap<string, string>;
  },
  signal?: AbortSignal,
): Promise<{ title: string; summary: string } | undefined> {
  const transcript = transcriptExcerpt(lines, part.startMs, part.endMs, 3500, context.speakers);
  if (!transcript) return undefined;
  // The series' own names (the shared character sheet), so a title says
  // "Lý Vân", as the dub does, not a fresh transliteration of 李云.
  const names = (context.names ?? []).filter((n) => n.trim()).slice(0, 40);
  const user =
    `Video: "${context.seriesName}", part ${part.index} of ${count}. What is said in this part (${context.sourceLanguageName}):\n${transcript}\n\n` +
    (names.length > 0 ? `Write names exactly as the dub does: ${names.join('; ')}.\n` : '') +
    (context.speakers && context.speakers.size > 0 ? 'Each line says who speaks it: in the summary, name who says or does what only as the lines show it.\n' : '') +
    (/^vi\b/i.test(context.targetLanguage ?? '') && /^(zh|yue|cmn|auto)\b/i.test(context.sourceLanguage || 'auto') ? `${viEstablishedNamesRule()}\n` : '') +
    `Write in ${context.targetLanguageName}: a short title for this part (at most 60 characters, no part number) and a one-sentence summary for a post caption (at most ${SUMMARY_ASK} characters). ` +
    'Reply {"title":"...","summary":"..."}.';
  const reply = await chat.chatComplete(TITLE_SYSTEM, user, signal, {
    jsonSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, summary: { type: 'string' } },
      required: ['title', 'summary'],
    },
    maxTokens: 300,
  });
  const parsed = parseJsonReply(reply);
  const title = typeof parsed?.['title'] === 'string' ? clipText(parsed['title'].trim(), 80) : '';
  const summary = typeof parsed?.['summary'] === 'string' ? clipText(parsed['summary'].trim(), 400) : '';
  return title ? { title, summary } : undefined;
}

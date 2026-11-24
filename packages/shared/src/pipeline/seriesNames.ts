/**
 * What the parts of a series are called (models/series.ts): each part's
 * project name (and so its finished files in a chosen folder,
 * pipeline/output.ts), from a template chosen when the series is made, and
 * the plain title a part gets when the AI gave it none. The orchestrator names
 * the parts and the UI shows a live example with these same functions, so the
 * two cannot disagree.
 *
 * WHY: part names were fixed ("<series> - Phần 01"), so the 48 parts of the
 * 27.8-hour series were renamed one request at a time to the pattern the
 * channel posts under, and two parts the AI did not title stayed without a
 * title (claude-dubber report, 2026-11-23).
 *
 * Browser-safe: no node imports (the UI imports it too).
 */
import type { ProjectSettings } from '../models/domain.js';

/**
 * The settings a later season starts from (a series continuing another,
 * models/series.ts): the series' own engines, subtitles, mix and logo, without
 * what belongs to its speakers (matched again by voice print once this
 * video's speakers are detected) or to its picture (blur regions are found
 * per video, with time ranges of that video). New project and the plugin's
 * create_project both start from it. Pure.
 */
export function continuedSeriesSettings(settings: ProjectSettings): Partial<ProjectSettings> {
  const {
    speakerVoices: _voices,
    speakerGenders: _genders,
    diarizeSpeakers: _count,
    defaultMaleVoiceId: _male,
    defaultFemaleVoiceId: _female,
    minorVoices: _minor,
    blurRegions: _blur,
    ...rest
  } = settings;
  return rest;
}

/** The words on a part's cards, in the dub's language. */
export interface SeriesCardWords {
  part: string;
  previously: string;
  next: string;
  end: string;
}

/** The card wording per language (English for the rest). */
export const SERIES_CARD_WORDS: Readonly<Record<string, SeriesCardWords>> = {
  vi: { part: 'Phần', previously: 'Phần trước', next: 'Còn tiếp', end: 'Hết' },
  en: { part: 'Part', previously: 'Previously', next: 'To be continued', end: 'The end' },
  zh: { part: '第', previously: '前情回顾', next: '未完待续', end: '完' },
  ja: { part: 'パート', previously: '前回', next: '続く', end: '終わり' },
  ko: { part: '파트', previously: '지난 이야기', next: '다음 편에 계속', end: '끝' },
  es: { part: 'Parte', previously: 'Anteriormente', next: 'Continuará', end: 'Fin' },
  fr: { part: 'Partie', previously: 'Précédemment', next: 'À suivre', end: 'Fin' },
};

export function seriesCardWords(targetLanguage: string): SeriesCardWords {
  return SERIES_CARD_WORDS[targetLanguage.toLowerCase().split('-')[0] ?? 'en'] ?? SERIES_CARD_WORDS['en']!;
}

/** The placeholders a part name template may use. */
export const PART_NAME_PLACEHOLDERS = ['series', 'n', 'nn', 'total', 'title'] as const;

/** The longest template accepted. */
export const PART_NAME_TEMPLATE_MAX = 200;

/**
 * The names parts had before templates, and still have by default:
 * "<series> - Phần 01" ("<series> - 第1集" in Chinese).
 */
export function defaultPartNameTemplate(targetLanguage: string): string {
  const words = seriesCardWords(targetLanguage);
  return words.part === '第' ? '{series} - 第{n}集' : `{series} - ${words.part} {nn}`;
}

/** Why a template cannot be used (the UI says it in its own words). */
export type PartNameTemplateProblem =
  | { code: 'empty' }
  | { code: 'too-long'; max: number }
  /** Without {n} or {nn} every part would have the same name. */
  | { code: 'no-number' }
  /** A typo such as {N0} or {name}. */
  | { code: 'unknown-placeholder'; placeholder: string };

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** What is wrong with a template, or undefined when it can be used. Pure. */
export function partNameTemplateProblem(template: string): PartNameTemplateProblem | undefined {
  const t = template.trim();
  if (!t) return { code: 'empty' };
  if (t.length > PART_NAME_TEMPLATE_MAX) return { code: 'too-long', max: PART_NAME_TEMPLATE_MAX };
  const names = [...t.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!.trim().toLowerCase());
  const unknown = names.find((n) => !(PART_NAME_PLACEHOLDERS as readonly string[]).includes(n));
  if (unknown !== undefined) return { code: 'unknown-placeholder', placeholder: `{${unknown}}` };
  if (!names.includes('n') && !names.includes('nn')) return { code: 'no-number' };
  return undefined;
}

/** A part's plain title when the AI gave it none: "Phần 42" ("第42集"). Pure. */
export function fallbackPartTitle(n: number, targetLanguage: string): string {
  const words = seriesCardWords(targetLanguage);
  return words.part === '第' ? `第${n}集` : `${words.part} ${n}`;
}

/** The title is only the plain one ("Phần 42"): it says nothing the part number does not. */
export function isFallbackPartTitle(title: string | undefined, n: number, targetLanguage: string): boolean {
  return (title ?? '').trim() === fallbackPartTitle(n, targetLanguage);
}

export interface PartNameInput {
  /** The series' name. */
  series: string;
  /** The part's number as shown (after the parts of a series it continues). */
  n: number;
  /** How many parts the viewer is told there are. */
  total: number;
  title?: string;
  targetLanguage: string;
}

/** Separators that go with a missing title: "…: {title}", "… - {title}", "… ({title})". */
const EMPTY_TITLE_RE = /\s*[-–—:|·,]*\s*[([]?\s*\{\s*title\s*\}\s*[)\]]?/gi;
const EDGE_SEPARATORS_RE = /^[-–—:|·,\s]+|[-–—:|·,\s]+$/g;

/**
 * A part's project name from a template: {series}, {n}, {nn} (two digits at
 * least: 01, 02… as the names always were), {total} and {title}. The default
 * template when none is given or it cannot be used. A part with no title (or
 * only the plain "Phần 42") drops {title} with the separator before it:
 * "{series} - Tập {nn}: {title}" is "Tây Du Ký - Tập 01", not
 * "Tây Du Ký - Tập 01: ". Pure.
 */
export function partName(template: string | undefined, input: PartNameInput): string {
  const fallback = defaultPartNameTemplate(input.targetLanguage);
  const usable = template !== undefined && !partNameTemplateProblem(template) ? template.trim() : fallback;
  const title = isFallbackPartTitle(input.title, input.n, input.targetLanguage) ? '' : (input.title ?? '').trim();
  const values: Record<string, string> = {
    series: input.series.trim(),
    n: String(input.n),
    nn: String(input.n).padStart(2, '0'),
    total: String(input.total),
    title,
  };
  const render = (t: string): string =>
    (title ? t : t.replace(EMPTY_TITLE_RE, ''))
      .replace(PLACEHOLDER_RE, (_m, name: string) => values[name.trim().toLowerCase()] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(EDGE_SEPARATORS_RE, '');
  return render(usable) || render(fallback) || values['nn']!;
}

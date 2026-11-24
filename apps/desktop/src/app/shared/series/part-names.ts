/**
 * The "Part names" field's words: the example names a template gives and
 * what is wrong with one, from the same functions the app names the parts
 * with (shared pipeline/seriesNames.ts). Pure.
 */
import { partName, partNameTemplateProblem } from '@videodubber/shared';

/** A translation key with its parameters. */
export interface KeyedText {
  key: string;
  params: Record<string, string | number>;
}

/**
 * The placeholders as the texts show them ("{series}"): passed in as
 * parameters, since a literal single brace in a translation reads as a
 * forgotten {{ }} (check-i18n), and they are the same in every language.
 */
export const PLACEHOLDER_PARAMS: Readonly<Record<string, string>> = {
  series: '{series}',
  n: '{n}',
  nn: '{nn}',
  total: '{total}',
  title: '{title}',
};

/** What is wrong with a typed template (null when it is empty or usable: empty means the default). */
export function templateProblemText(template: string): KeyedText | null {
  if (!template.trim()) return null;
  const problem = partNameTemplateProblem(template);
  if (!problem) return null;
  switch (problem.code) {
    case 'no-number':
      return { key: 'series.name-template-no-number', params: { ...PLACEHOLDER_PARAMS } };
    case 'unknown-placeholder':
      return { key: 'series.name-template-unknown', params: { ...PLACEHOLDER_PARAMS, placeholder: problem.placeholder } };
    case 'too-long':
      return { key: 'series.name-template-too-long', params: { max: problem.max } };
    default:
      return null;
  }
}

/**
 * The first two names a template gives, the first with a sample title and
 * the second without one, so the example shows how {title} drops out when a
 * part has none. `total` unknown: an example total a little past the start.
 */
export function exampleNames(input: {
  template: string;
  seriesName: string;
  targetLanguage: string;
  firstNumber: number;
  total?: number | null;
  sampleTitle: string;
}): [string, string] {
  const template = input.template.trim() && !partNameTemplateProblem(input.template) ? input.template : undefined;
  const n = Math.max(1, Math.floor(input.firstNumber));
  const total = input.total && input.total >= n + 1 ? input.total : n + 11;
  const base = { series: input.seriesName, total, targetLanguage: input.targetLanguage || 'vi' };
  return [partName(template, { ...base, n, title: input.sampleTitle }), partName(template, { ...base, n: n + 1 })];
}

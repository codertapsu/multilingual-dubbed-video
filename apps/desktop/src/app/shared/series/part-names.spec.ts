import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { PLACEHOLDER_PARAMS, exampleNames, templateProblemText } from './part-names';

/** A dotted key's text in a locale tree (undefined when missing). */
function text(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], tree);
}

describe('the Part names field', () => {
  const base = { seriesName: 'Tây Du Ký', targetLanguage: 'vi-VN', firstNumber: 1, sampleTitle: 'Khởi đầu' };

  it('shows the names the parts will get, as the app names them', () => {
    expect(exampleNames({ ...base, template: '' })).toEqual(['Tây Du Ký - Phần 01', 'Tây Du Ký - Phần 02']);
    expect(exampleNames({ ...base, template: '{series} - Tập {nn}: {title}' })).toEqual(['Tây Du Ký - Tập 01: Khởi đầu', 'Tây Du Ký - Tập 02']);
    // A series continuing another: its numbers carry on.
    expect(exampleNames({ ...base, template: '{series} {n}/{total}', firstNumber: 49, total: 60 })).toEqual(['Tây Du Ký 49/60', 'Tây Du Ký 50/60']);
  });

  it('says what is wrong with a template, and nothing about an empty one', () => {
    expect(templateProblemText('')).toBeNull();
    expect(templateProblemText('{series} - {nn}')).toBeNull();
    expect(templateProblemText('{series} - {title}')).toMatchObject({ key: 'series.name-template-no-number', params: { n: '{n}', nn: '{nn}' } });
    expect(templateProblemText('{series} {so}')).toMatchObject({ key: 'series.name-template-unknown', params: { placeholder: '{so}', series: '{series}' } });
    // An unusable template shows the default's names meanwhile.
    expect(exampleNames({ ...base, template: '{series}' })[0]).toBe('Tây Du Ký - Phần 01');
  });

  it('only uses keys both languages define, with every placeholder they show', () => {
    const lines = [
      templateProblemText('{series}')!,
      templateProblemText('{series} {so}')!,
      templateProblemText(`{n}${'x'.repeat(250)}`)!,
      { key: 'series.name-template-hint', params: { ...PLACEHOLDER_PARAMS } },
      { key: 'series.edit-render-again', params: { n: 3 } },
      { key: 'series.edit-saved', params: { n: 3 } },
    ];
    for (const { key, params } of lines) {
      for (const locale of [en, vi]) {
        const s = text(locale, key);
        expect(typeof s, key).toBe('string');
        // Each {{name}} the text shows is given (a literal "{{n}}" on screen is a bug).
        for (const [, name] of (s as string).matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) expect(params, `${key} {{${name}}}`).toHaveProperty(name!);
      }
    }
  });
});

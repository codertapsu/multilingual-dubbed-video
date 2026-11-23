import { describe, expect, it } from 'vitest';

import { exampleNames, templateProblemText } from './part-names';

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
});

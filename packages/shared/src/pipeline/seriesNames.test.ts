import { describe, expect, it } from 'vitest';

import {
  defaultPartNameTemplate,
  fallbackPartTitle,
  isFallbackPartTitle,
  partName,
  partNameTemplateProblem,
  seriesCardWords,
} from './seriesNames.js';

const vi = { series: 'Xuyên Không Về Đại Tống', total: 48, targetLanguage: 'vi-VN' };

describe('part names from a template', () => {
  it('names parts as they always were when no template is given', () => {
    // The names before 0.18.0: "<series> - Phần 01", "第1集" in Chinese.
    expect(partName(undefined, { ...vi, n: 1 })).toBe('Xuyên Không Về Đại Tống - Phần 01');
    expect(partName(undefined, { ...vi, n: 12 })).toBe('Xuyên Không Về Đại Tống - Phần 12');
    expect(partName(undefined, { series: '西游记', n: 3, total: 10, targetLanguage: 'zh' })).toBe('西游记 - 第3集');
    expect(partName(undefined, { series: 'Journey', n: 7, total: 9, targetLanguage: 'en-US' })).toBe('Journey - Part 07');
    expect(defaultPartNameTemplate('vi')).toBe('{series} - Phần {nn}');
  });

  it('fills every placeholder', () => {
    expect(partName('{series} - Tập {nn}/{total}: {title}', { ...vi, n: 7, title: 'Ngã rẽ' })).toBe(
      'Xuyên Không Về Đại Tống - Tập 07/48: Ngã rẽ',
    );
    expect(partName('[{n}] {title} | {series}', { ...vi, n: 49, total: 60, title: 'Mùa mới' })).toBe(
      '[49] Mùa mới | Xuyên Không Về Đại Tống',
    );
    // Placeholders read the same in capitals: a template typed by hand.
    expect(partName('{SERIES} {NN}', { ...vi, n: 2 })).toBe('Xuyên Không Về Đại Tống 02');
  });

  it('drops a missing title with the separator before it', () => {
    expect(partName('{series} - Tập {nn}: {title}', { ...vi, n: 3 })).toBe('Xuyên Không Về Đại Tống - Tập 03');
    expect(partName('{series} {nn} ({title})', { ...vi, n: 3, title: '  ' })).toBe('Xuyên Không Về Đại Tống 03');
    expect(partName('{title} - {series} {nn}', { ...vi, n: 3 })).toBe('Xuyên Không Về Đại Tống 03');
    // The plain title the AI's silence leaves ("Phần 42") says nothing the number does not.
    expect(partName('{series} - Tập {nn}: {title}', { ...vi, n: 42, title: 'Phần 42' })).toBe('Xuyên Không Về Đại Tống - Tập 42');
  });

  it('falls back to the default when the template cannot be used', () => {
    expect(partName('{series}', { ...vi, n: 5 })).toBe('Xuyên Không Về Đại Tống - Phần 05');
    expect(partName('{series} {name}', { ...vi, n: 5 })).toBe('Xuyên Không Về Đại Tống - Phần 05');
  });

  it('says what is wrong with a template', () => {
    expect(partNameTemplateProblem('{series} - Tập {nn}')).toBeUndefined();
    expect(partNameTemplateProblem('{n}')).toBeUndefined();
    expect(partNameTemplateProblem('  ')).toEqual({ code: 'empty' });
    expect(partNameTemplateProblem('{series} - {title}')).toEqual({ code: 'no-number' });
    expect(partNameTemplateProblem('{series} {N0}')).toEqual({ code: 'unknown-placeholder', placeholder: '{n0}' });
    expect(partNameTemplateProblem(`{n}${'x'.repeat(250)}`)).toMatchObject({ code: 'too-long' });
  });
});

describe('the plain title of a part', () => {
  it('is the part number in the dub language', () => {
    expect(fallbackPartTitle(42, 'vi-VN')).toBe('Phần 42');
    expect(fallbackPartTitle(42, 'zh-CN')).toBe('第42集');
    expect(fallbackPartTitle(42, 'de')).toBe('Part 42');
    expect(isFallbackPartTitle(' Phần 42 ', 42, 'vi')).toBe(true);
    expect(isFallbackPartTitle('Phần 42', 43, 'vi')).toBe(false);
    expect(seriesCardWords('fr-CA').end).toBe('Fin');
  });
});

import { describe, expect, it } from 'vitest';

import { languageName } from './language-name';

describe('languageName', () => {
  it('names a language in the reader’s language', () => {
    expect(languageName('vi-VN', 'en')).toBe('Vietnamese (Vietnam)');
    expect(languageName('en-US', 'vi')).toMatch(/^Tiếng Anh/);
    expect(languageName('zh', 'vi')).toMatch(/^Tiếng Trung/);
  });

  it('starts with a capital letter', () => {
    const name = languageName('fr', 'vi');
    expect(name.charAt(0)).toBe(name.charAt(0).toLocaleUpperCase('vi'));
  });

  it('keeps the fallback for values that are not language tags', () => {
    expect(languageName('auto', 'vi', 'Tự nhận diện')).toBe('Tự nhận diện');
    expect(languageName('', 'vi', 'x')).toBe('x');
    expect(languageName(undefined, 'vi')).toBe('');
  });
});

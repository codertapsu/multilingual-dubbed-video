import { describe, it, expect } from 'vitest';
import {
  normalizeLanguageCode,
  toWhisperLanguage,
  toArgosLanguage,
  isValidLanguageCode,
  COMMON_LANGUAGES,
} from './normalize.js';

describe('normalizeLanguageCode', () => {
  it('lowercases a bare primary subtag', () => {
    expect(normalizeLanguageCode('EN')).toBe('en');
    expect(normalizeLanguageCode('Fr')).toBe('fr');
  });

  it('uppercases the region subtag', () => {
    expect(normalizeLanguageCode('en-us')).toBe('en-US');
    expect(normalizeLanguageCode('vi-vn')).toBe('vi-VN');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLanguageCode('  en-US  ')).toBe('en-US');
  });

  it('accepts underscore separators', () => {
    expect(normalizeLanguageCode('en_US')).toBe('en-US');
  });

  it('titlecases a script subtag', () => {
    expect(normalizeLanguageCode('zh-hant')).toBe('zh-Hant');
    expect(normalizeLanguageCode('zh-HANT')).toBe('zh-Hant');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeLanguageCode('')).toBe('');
    expect(normalizeLanguageCode('   ')).toBe('');
  });

  describe('vi-VI special rule', () => {
    it('normalizes vi-VI to vi-VN', () => {
      expect(normalizeLanguageCode('vi-VI')).toBe('vi-VN');
    });
    it('normalizes vi-vi (lowercase) to vi-VN', () => {
      expect(normalizeLanguageCode('vi-vi')).toBe('vi-VN');
    });
    it('normalizes VI-VI to vi-VN', () => {
      expect(normalizeLanguageCode('VI-VI')).toBe('vi-VN');
    });
    it('normalizes vi_vi (underscore) to vi-VN', () => {
      expect(normalizeLanguageCode('vi_vi')).toBe('vi-VN');
    });
    it('leaves a correct vi-VN unchanged', () => {
      expect(normalizeLanguageCode('vi-VN')).toBe('vi-VN');
    });
  });
});

describe('toWhisperLanguage', () => {
  it('strips the region subtag', () => {
    expect(toWhisperLanguage('vi-VN')).toBe('vi');
    expect(toWhisperLanguage('en-US')).toBe('en');
  });
  it('lowercases the base subtag', () => {
    expect(toWhisperLanguage('EN')).toBe('en');
  });
  it('applies the vi-VI rule before reducing', () => {
    expect(toWhisperLanguage('vi-VI')).toBe('vi');
  });
  it('returns empty for empty input', () => {
    expect(toWhisperLanguage('')).toBe('');
  });
});

describe('toArgosLanguage', () => {
  it('strips the region subtag', () => {
    expect(toArgosLanguage('vi-VN')).toBe('vi');
    expect(toArgosLanguage('en-US')).toBe('en');
  });
  it('matches toWhisperLanguage behavior', () => {
    expect(toArgosLanguage('FR-fr')).toBe(toWhisperLanguage('FR-fr'));
  });
});

describe('isValidLanguageCode', () => {
  it('accepts plain primary subtags', () => {
    expect(isValidLanguageCode('en')).toBe(true);
    expect(isValidLanguageCode('vi')).toBe(true);
  });
  it('accepts language-region codes', () => {
    expect(isValidLanguageCode('en-US')).toBe(true);
    expect(isValidLanguageCode('vi-VN')).toBe(true);
  });
  it('accepts language-script codes', () => {
    expect(isValidLanguageCode('zh-Hant')).toBe(true);
  });
  it('rejects empty and malformed codes', () => {
    expect(isValidLanguageCode('')).toBe(false);
    expect(isValidLanguageCode('e')).toBe(false);
    expect(isValidLanguageCode('english')).toBe(false);
    expect(isValidLanguageCode('123')).toBe(false);
  });
});

describe('COMMON_LANGUAGES', () => {
  it('includes the required curated codes', () => {
    const codes = COMMON_LANGUAGES.map((l) => l.code);
    for (const required of [
      'en',
      'en-US',
      'vi-VN',
      'es',
      'fr',
      'de',
      'ja',
      'ko',
      'zh',
      'pt',
      'ru',
      'ar',
      'hi',
      'id',
      'th',
    ]) {
      expect(codes).toContain(required);
    }
  });

  it('uses already-normalized codes', () => {
    for (const lang of COMMON_LANGUAGES) {
      expect(normalizeLanguageCode(lang.code)).toBe(lang.code);
    }
  });
});

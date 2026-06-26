import { describe, expect, it } from 'vitest';

import { listOmnivoiceForLanguage } from './omnivoicesCatalog.js';

const EXPECTED_IDS = [
  'omnivoice-female-calm',
  'omnivoice-male-warm',
  'omnivoice-female-bright',
  'omnivoice-male-neutral',
];

describe('OmniVoice designed-voice catalog', () => {
  it('returns the same 4 designed voices for every language (multilingual)', () => {
    for (const lang of ['en-US', 'vi-VN', 'zh-CN', 'ja-JP', 'ar-SA']) {
      const voices = listOmnivoiceForLanguage(lang);
      expect(voices.map((v) => v.id)).toEqual(EXPECTED_IDS);
      // language is echoed onto each voice; not per-voice downloads.
      expect(voices.every((v) => v.language === lang)).toBe(true);
      expect(voices.every((v) => v.approxSizeMb === 0 && v.url === '' && v.configUrl === '')).toBe(true);
    }
  });

  it('has exactly one recommended default (female-calm)', () => {
    const voices = listOmnivoiceForLanguage('en-US');
    const recommended = voices.filter((v) => v.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.id).toBe('omnivoice-female-calm');
  });

  it('returns nothing for an empty language', () => {
    expect(listOmnivoiceForLanguage('')).toEqual([]);
  });
});

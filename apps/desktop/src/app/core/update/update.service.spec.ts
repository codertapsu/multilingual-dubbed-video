import { describe, expect, it } from 'vitest';

import { downloadPercent, formatMegabytes } from './update.service';

describe('downloadPercent', () => {
  it('is null while the size is unknown', () => {
    expect(downloadPercent({ downloaded: 5_000_000, total: null })).toBeNull();
    expect(downloadPercent({ downloaded: 5_000_000, total: 0 })).toBeNull();
  });

  it('rounds down, so 100 means every byte is here', () => {
    expect(downloadPercent({ downloaded: 283_999_999, total: 284_000_000 })).toBe(99);
    expect(downloadPercent({ downloaded: 284_000_000, total: 284_000_000 })).toBe(100);
  });

  it('never leaves 0..100', () => {
    expect(downloadPercent({ downloaded: 300, total: 200 })).toBe(100);
  });
});

describe('formatMegabytes', () => {
  it('uses the reader’s decimal separator', () => {
    expect(formatMegabytes(84_200_000, 'en')).toBe('84.2 MB');
    expect(formatMegabytes(84_200_000, 'vi')).toBe('84,2 MB');
  });

  it('drops the decimal from 100 MB up', () => {
    expect(formatMegabytes(283_600_000, 'en')).toBe('284 MB');
  });
});

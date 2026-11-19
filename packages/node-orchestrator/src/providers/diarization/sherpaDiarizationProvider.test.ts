import { describe, expect, it } from 'vitest';

import { diarizationTimeoutMs } from './sherpaDiarizationProvider.js';

describe('diarizationTimeoutMs', () => {
  const base = 30 * 60_000;
  const hours = (h: number): number => h * 3600 * 32_000; // bytes of 16 kHz mono 16-bit

  it('keeps the usual timeout for ordinary videos', () => {
    expect(diarizationTimeoutMs(base, hours(0.5))).toBe(base);
    expect(diarizationTimeoutMs(base, 0)).toBe(base);
  });

  it('grows with a long recording instead of failing a working request', () => {
    // 3 h of audio: 0.6 x 180 min + 5 min = 113 min.
    expect(diarizationTimeoutMs(base, hours(3))).toBe(113 * 60_000);
  });
});

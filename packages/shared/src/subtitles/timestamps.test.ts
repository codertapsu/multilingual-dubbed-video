import { describe, it, expect } from 'vitest';
import { toSrtTimestamp, toVttTimestamp } from './timestamps.js';

describe('toSrtTimestamp', () => {
  it('formats 0ms as 00:00:00,000', () => {
    expect(toSrtTimestamp(0)).toBe('00:00:00,000');
  });

  it('formats sub-second values with zero-padded milliseconds', () => {
    expect(toSrtTimestamp(7)).toBe('00:00:00,007');
    expect(toSrtTimestamp(42)).toBe('00:00:00,042');
    expect(toSrtTimestamp(999)).toBe('00:00:00,999');
  });

  it('formats 3661001ms as 01:01:01,001', () => {
    // 1h + 1m + 1s + 1ms
    expect(toSrtTimestamp(3661001)).toBe('01:01:01,001');
  });

  it('uses a comma before milliseconds', () => {
    expect(toSrtTimestamp(1500)).toBe('00:00:01,500');
    expect(toSrtTimestamp(1500)).toContain(',');
  });

  it('supports hours beyond 24', () => {
    const ms = 25 * 3600 * 1000; // 25 hours
    expect(toSrtTimestamp(ms)).toBe('25:00:00,000');
  });

  it('clamps negative input to zero', () => {
    expect(toSrtTimestamp(-100)).toBe('00:00:00,000');
  });

  it('rounds fractional milliseconds', () => {
    expect(toSrtTimestamp(123.6)).toBe('00:00:00,124');
  });
});

describe('toVttTimestamp', () => {
  it('formats 0ms as 00:00:00.000', () => {
    expect(toVttTimestamp(0)).toBe('00:00:00.000');
  });

  it('formats 3661001ms as 01:01:01.001', () => {
    expect(toVttTimestamp(3661001)).toBe('01:01:01.001');
  });

  it('uses a dot before milliseconds (not a comma)', () => {
    const s = toVttTimestamp(1500);
    expect(s).toBe('00:00:01.500');
    expect(s).toContain('.');
    expect(s).not.toContain(',');
  });

  it('handles sub-second values', () => {
    expect(toVttTimestamp(5)).toBe('00:00:00.005');
  });
});

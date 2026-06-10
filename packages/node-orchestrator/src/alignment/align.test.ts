import { describe, expect, it } from 'vitest';
import { alignSegment, alignSegments, summarizeAlignment, type AlignInputSegment, type AlignSettings } from './align.js';

const SETTINGS: AlignSettings = { maxSpeedRatio: 1.15, allowedOverflowMs: 300 };

function seg(generatedDurationMs: number, startMs = 0, endMs = 1000): AlignInputSegment {
  return { segmentId: 'seg_0001', startMs, endMs, audioPath: '/tmp/seg_0001.wav', generatedDurationMs };
}

describe('alignSegment', () => {
  it('places a fitting segment at natural speed (status ok)', () => {
    const a = alignSegment(seg(800, 0, 1000), SETTINGS);
    expect(a.status).toBe('ok');
    expect(a.speedRatio).toBe(1);
    expect(a.overflowMs).toBe(0);
    expect(a.placedDurationMs).toBe(800);
    expect(a.startMs).toBe(0);
  });

  it('treats an exactly-fitting segment as ok', () => {
    const a = alignSegment(seg(1000, 0, 1000), SETTINGS);
    expect(a.status).toBe('ok');
    expect(a.speedRatio).toBe(1);
    expect(a.overflowMs).toBe(0);
  });

  it('speeds up within the cap to fit (needs-review, no overflow)', () => {
    // window 1000ms, generated 1100ms -> required ratio 1.1 (<=1.15) -> fits.
    const a = alignSegment(seg(1100, 0, 1000), SETTINGS);
    expect(a.status).toBe('needs-review');
    expect(a.speedRatio).toBeCloseTo(1.1, 5);
    expect(a.placedDurationMs).toBe(1000);
    expect(a.overflowMs).toBe(0);
  });

  it('caps speed at maxSpeedRatio and allows overflow within budget', () => {
    // window 1000ms, generated 1300ms. Required ratio 1.3 capped to 1.15.
    // placed = 1300/1.15 = ~1130 -> overflow ~130ms <= 300 allowed.
    const a = alignSegment(seg(1300, 0, 1000), SETTINGS);
    expect(a.status).toBe('needs-review');
    expect(a.speedRatio).toBeCloseTo(1.15, 5);
    expect(a.placedDurationMs).toBe(Math.round(1300 / 1.15));
    expect(a.overflowMs).toBe(Math.round(1300 / 1.15) - 1000);
    expect(a.overflowMs).toBeLessThanOrEqual(SETTINGS.allowedOverflowMs);
  });

  it('marks timing-conflict when it cannot fit even at max speed + overflow', () => {
    // window 1000ms, generated 2000ms. capped 1.15 -> placed ~1739 -> overflow 739 > 300.
    const a = alignSegment(seg(2000, 0, 1000), SETTINGS);
    expect(a.status).toBe('timing-conflict');
    expect(a.speedRatio).toBeCloseTo(1.15, 5);
    expect(a.overflowMs).toBeGreaterThan(SETTINGS.allowedOverflowMs);
  });

  it('never compresses beyond maxSpeedRatio', () => {
    const a = alignSegment(seg(5000, 0, 1000), { maxSpeedRatio: 1.15, allowedOverflowMs: 0 });
    expect(a.speedRatio).toBeLessThanOrEqual(1.15);
  });

  it('honors a larger allowedOverflowMs budget (accepts as needs-review)', () => {
    const a = alignSegment(seg(2000, 0, 1000), { maxSpeedRatio: 1.15, allowedOverflowMs: 1000 });
    expect(a.status).toBe('needs-review');
  });

  it('handles a zero-length window as a timing-conflict when audio exists', () => {
    const a = alignSegment(seg(500, 1000, 1000), SETTINGS);
    expect(a.status).toBe('timing-conflict');
    expect(a.speedRatio).toBe(1);
  });

  it('keeps integer millisecond timings', () => {
    const a = alignSegment(seg(1234, 0, 999), SETTINGS);
    expect(Number.isInteger(a.placedDurationMs)).toBe(true);
    expect(Number.isInteger(a.overflowMs)).toBe(true);
  });

  it('respects maxSpeedRatio <= 1 as no compression', () => {
    const a = alignSegment(seg(1500, 0, 1000), { maxSpeedRatio: 1, allowedOverflowMs: 0 });
    expect(a.speedRatio).toBe(1);
    expect(a.status).toBe('timing-conflict');
  });
});

describe('alignSegments + summarizeAlignment', () => {
  it('summarizes a mixed batch correctly', () => {
    const inputs: AlignInputSegment[] = [
      { segmentId: 'seg_0001', startMs: 0, endMs: 1000, audioPath: 'a', generatedDurationMs: 800 }, // ok
      { segmentId: 'seg_0002', startMs: 1000, endMs: 2000, audioPath: 'b', generatedDurationMs: 1100 }, // needs-review + atempo
      { segmentId: 'seg_0003', startMs: 2000, endMs: 3000, audioPath: 'c', generatedDurationMs: 5000 }, // timing-conflict
    ];
    const aligned = alignSegments(inputs, SETTINGS);
    const summary = summarizeAlignment(aligned);
    expect(summary.total).toBe(3);
    expect(summary.ok).toBe(1);
    expect(summary.needsReview).toBe(1);
    expect(summary.timingConflicts).toBe(1);
    expect(summary.needsAtempo).toBeGreaterThanOrEqual(1);
  });
});

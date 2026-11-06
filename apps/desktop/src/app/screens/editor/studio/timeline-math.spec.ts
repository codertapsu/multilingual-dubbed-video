import { describe, expect, it } from 'vitest';
import {
  MIN_SEGMENT_MS,
  charsPerSecond,
  clampZoom,
  constrainDrag,
  constrainGroupMove,
  fitZoom,
  formatRulerLabel,
  majorStepMs,
  parseTimecode,
  rulerTicks,
  snapTo,
  spanIndexAt,
  visibleSpans,
  type Span,
} from './timeline-math';

const spans: Span[] = [
  { id: 'a', startMs: 0, endMs: 1000 },
  { id: 'b', startMs: 1500, endMs: 2500 },
  { id: 'c', startMs: 3000, endMs: 4000 },
];

describe('zoom', () => {
  it('clamps to the supported range and fits a duration to a width', () => {
    expect(clampZoom(0)).toBe(0.05);
    // "Fit" must be able to show a two-hour video on a laptop-width timeline.
    expect(fitZoom(2 * 3600 * 1000, 1400)).toBeLessThan(0.2);
    expect(clampZoom(10_000)).toBe(800);
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(fitZoom(10_000, 1000)).toBeCloseTo(98, 5);
  });
});

describe('ruler', () => {
  it('keeps labelled ticks at least ~90 px apart', () => {
    expect(majorStepMs(100)).toBe(1000);
    expect(majorStepMs(10)).toBe(10_000);
    expect(majorStepMs(800)).toBe(200);
  });

  it('marks majors among minors', () => {
    const { stepMs, ticks } = rulerTicks(0, 3000, 100);
    expect(stepMs).toBe(1000);
    expect(ticks.filter((t) => t.major).map((t) => t.ms)).toEqual([0, 1000, 2000, 3000]);
    expect(ticks.length).toBeGreaterThan(4);
  });

  it('labels with the precision the step needs', () => {
    expect(formatRulerLabel(65_000, 5000)).toBe('1:05');
    expect(formatRulerLabel(3_750_000, 60_000)).toBe('1:02:30');
    expect(formatRulerLabel(5_250, 500)).toBe('0:05.2');
    expect(formatRulerLabel(5_250, 50)).toBe('0:05.25');
  });
});

describe('parseTimecode', () => {
  it('accepts the forms an editor types', () => {
    expect(parseTimecode('1:02.345')).toBe(62_345);
    expect(parseTimecode('01:02:03.004')).toBe(3_723_004);
    expect(parseTimecode('62.5')).toBe(62_500);
    expect(parseTimecode('62,5')).toBe(62_500);
    expect(parseTimecode('1500ms')).toBe(1500);
  });

  it('rejects what is not a time', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1.5:20')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
  });
});

describe('constrainDrag (mirrors the server invariants)', () => {
  it('moves a line freely between its neighbours', () => {
    expect(constrainDrag(spans, 1, 'move', 200, 10_000)).toEqual({ startMs: 1700, endMs: 2700 });
  });

  it('stops a move at the neighbour — never past it, never overlapping', () => {
    expect(constrainDrag(spans, 1, 'move', -5000, 10_000)).toEqual({ startMs: 1000, endMs: 2000 });
    expect(constrainDrag(spans, 1, 'move', 5000, 10_000)).toEqual({ startMs: 2000, endMs: 3000 });
  });

  it('keeps the first line inside the media start and the last inside its end', () => {
    expect(constrainDrag(spans, 0, 'move', -300, 10_000).startMs).toBe(0);
    expect(constrainDrag(spans, 2, 'move', 99_000, 4500)).toEqual({ startMs: 3500, endMs: 4500 });
  });

  it('trims an edge but never below the minimum duration', () => {
    expect(constrainDrag(spans, 1, 'start', 2000, 10_000)).toEqual({ startMs: 2500 - MIN_SEGMENT_MS, endMs: 2500 });
    expect(constrainDrag(spans, 1, 'end', -2000, 10_000)).toEqual({ startMs: 1500, endMs: 1500 + MIN_SEGMENT_MS });
    expect(constrainDrag(spans, 1, 'end', 900, 10_000)).toEqual({ startMs: 1500, endMs: 3000 });
  });

  it('lets an overlap from the recogniser shrink but never grow', () => {
    const overlapping: Span[] = [
      { id: 'a', startMs: 0, endMs: 1800 },
      { id: 'b', startMs: 1500, endMs: 2500 },
    ];
    expect(constrainDrag(overlapping, 1, 'move', -400, 10_000).startMs).toBe(1500);
    expect(constrainDrag(overlapping, 1, 'move', 400, 10_000).startMs).toBe(1900);
  });
});

describe('constrainGroupMove', () => {
  it('moves selected neighbours together, limited only by unselected lines', () => {
    const sel = new Set(['a', 'b']);
    expect(constrainGroupMove(spans, sel, 400, 10_000)).toBe(400);
    expect(constrainGroupMove(spans, sel, 900, 10_000)).toBe(500); // b's end meets c
    expect(constrainGroupMove(spans, sel, -100, 10_000)).toBe(0); // a is at 0
  });

  it('respects the media end for the last line', () => {
    expect(constrainGroupMove(spans, new Set(['c']), 5000, 4200)).toBe(200);
  });
});

describe('lookup + windowing', () => {
  it('binary-searches the span at a time', () => {
    expect(spanIndexAt(spans, -5)).toBe(-1);
    expect(spanIndexAt(spans, 1600)).toBe(1);
    expect(spanIndexAt(spans, 99_999)).toBe(2);
  });

  it('returns only what intersects the visible window, including a long line that started earlier', () => {
    const long: Span[] = [
      { id: 'long', startMs: 0, endMs: 9000 },
      { id: 'x', startMs: 9500, endMs: 9800 },
      { id: 'y', startMs: 20_000, endMs: 21_000 },
    ];
    expect(visibleSpans(long, 5000, 9600).map((s) => s.id)).toEqual(['long', 'x']);
    expect(visibleSpans(long, 12_000, 15_000)).toEqual([]);
  });
});

describe('snapTo', () => {
  it('snaps to the nearest candidate within the threshold, else leaves it', () => {
    expect(snapTo(1010, [0, 1000, 2000], 20)).toEqual({ ms: 1000, snapped: 1000 });
    expect(snapTo(1050, [0, 1000, 2000], 20)).toEqual({ ms: 1050 });
  });
});

describe('charsPerSecond', () => {
  it('measures reading speed, collapsing whitespace', () => {
    expect(charsPerSecond('Xin  chào   bạn', 1000)).toBe(12);
    expect(charsPerSecond('abc', 0)).toBe(0);
  });
});

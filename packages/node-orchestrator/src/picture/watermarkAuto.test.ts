import { describe, expect, it } from 'vitest';
import type { WatermarkProposal } from '@videodubber/shared';

import { autoBlurRegions, describeMarks, faintMarks, sanitizeWatermarkAuto } from './watermarkAuto.js';

const mark = (over: Partial<WatermarkProposal> = {}): WatermarkProposal => ({
  x: 0.7,
  y: 0.02,
  w: 0.28,
  h: 0.06,
  mode: 'blur',
  corner: 'top-right',
  confidence: 0.83,
  ...over,
});

describe('sanitizeWatermarkAuto', () => {
  it('keeps a known way to hide, a strength 1-10, and takes true for a plain blur', () => {
    expect(sanitizeWatermarkAuto(true)).toEqual({ mode: 'blur' });
    expect(sanitizeWatermarkAuto({})).toEqual({ mode: 'blur' });
    expect(sanitizeWatermarkAuto({ mode: 'pixelate', strength: 14.2 })).toEqual({ mode: 'pixelate', strength: 10 });
    expect(sanitizeWatermarkAuto({ mode: 'delogo', strength: 0 })).toEqual({ mode: 'delogo', strength: 1 });
  });

  it('is off for null, false and anything it cannot read', () => {
    for (const off of [null, false, undefined, 'blur', [], { mode: 'smudge' }]) expect(sanitizeWatermarkAuto(off)).toBeUndefined();
  });
});

describe('autoBlurRegions', () => {
  it('hides only the clear marks, the way the setting asks, keeping a joined file\'s times', () => {
    const regions = autoBlurRegions(
      { regions: [mark(), mark({ corner: 'bottom-left', confidence: 0.31 }), mark({ startMs: 600_000, endMs: 1_200_000, fileName: 'P2.mp4' })] },
      { mode: 'pixelate', strength: 7 },
    );
    expect(regions).toEqual([
      { x: 0.7, y: 0.02, w: 0.28, h: 0.06, mode: 'pixelate', strength: 7 },
      { x: 0.7, y: 0.02, w: 0.28, h: 0.06, startMs: 600_000, endMs: 1_200_000, mode: 'pixelate', strength: 7 },
    ]);
    // What the setting hides is boxes, not proposals: no corner or confidence reaches the render.
    expect(regions[0]).not.toHaveProperty('confidence');
  });
});

describe('describeMarks / faintMarks', () => {
  it('says where the clear marks are, and how many were too faint', () => {
    const d = { regions: [mark(), mark({ corner: 'bottom-left', confidence: 0.4 }), mark({ corner: 'top-left', fileName: 'P3.mp4', confidence: 0.5 })] };
    expect(describeMarks(d)).toBe('2 watermarks at the top right (clear: 83 %), the top left of P3.mp4 (clear: 50 %)');
    expect(faintMarks(d)).toBe(1);
    expect(describeMarks({ regions: [] })).toBe('no watermark');
  });
});

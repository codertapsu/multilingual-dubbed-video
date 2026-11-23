import { describe, expect, it } from 'vitest';

import {
  applyDetection,
  clampBox,
  coverModeOf,
  coverPatch,
  defaultBand,
  dragBandEdge,
  keyDelta,
  moveBand,
  moveBox,
  pictureChanged,
  resizeBox,
  shownBand,
  toSettingsRegions,
  withCoverMode,
  MIN_BAND,
  MIN_BOX,
} from './picture-geometry';

describe('boxes', () => {
  const mark = { x: 0.66, y: 0.014, w: 0.31, h: 0.04 };

  it('a drag slides along the frame edge instead of leaving it', () => {
    expect(moveBox(mark, 0.1, -0.1)).toEqual({ x: 0.69, y: 0, w: 0.31, h: 0.04 });
    expect(moveBox(mark, -2, 2)).toEqual({ x: 0, y: 0.96, w: 0.31, h: 0.04 });
  });

  it('a resize stays inside the frame and never goes under the smallest box', () => {
    expect(resizeBox(mark, 0.5, 0.01)).toEqual({ x: 0.66, y: 0.014, w: 0.34, h: 0.05 });
    expect(resizeBox(mark, -1, -1)).toEqual({ x: 0.66, y: 0.014, w: MIN_BOX, h: MIN_BOX });
  });

  it('a box from outside is put back inside', () => {
    expect(clampBox({ x: 0.95, y: -0.1, w: 0.2, h: 0 })).toEqual({ x: 0.8, y: 0, w: 0.2, h: MIN_BOX });
  });
});

describe('the band', () => {
  const band = { y: 0.755, h: 0.06 };

  it('moves whole, inside the frame', () => {
    expect(moveBand(band, 0.1)).toEqual({ y: 0.855, h: 0.06 });
    expect(moveBand(band, 1)).toEqual({ y: 0.94, h: 0.06 });
  });

  it('its top edge keeps the bottom in place; its bottom edge keeps the top', () => {
    expect(dragBandEdge(band, 'top', -0.03)).toEqual({ y: 0.725, h: 0.09 });
    expect(dragBandEdge(band, 'top', 0.5)).toEqual({ y: 0.805, h: MIN_BAND });
    expect(dragBandEdge(band, 'bottom', 0.02)).toEqual({ y: 0.755, h: 0.08 });
    expect(dragBandEdge(band, 'bottom', 1)).toEqual({ y: 0.755, h: 0.245 });
  });

  it('is drawn where it was placed, else over the bottom strip; not at all when off', () => {
    expect(shownBand({ coverOriginal: 'blur', coverBand: band })).toEqual(band);
    expect(shownBand({ coverOriginal: true })).toEqual({ y: 0.82, h: 0.18 });
    expect(shownBand({ coverOriginal: 'solid', coverHeightPercent: 25 })).toEqual({ y: 0.75, h: 0.25 });
    expect(shownBand({ coverOriginal: false, coverBand: band })).toBeUndefined();
    expect(defaultBand()).toEqual({ y: 0.82, h: 0.18 });
  });
});

describe('the way the band hides', () => {
  it('true from before 0.18 reads as solid and stays true until changed', () => {
    expect(coverModeOf({ coverOriginal: true })).toBe('solid');
    expect(withCoverMode({ coverOriginal: true }, 'solid')).toEqual({ coverOriginal: true });
    expect(withCoverMode({ coverOriginal: true, coverBand: { y: 0.7, h: 0.1 } }, 'blur')).toEqual({ coverOriginal: 'blur', coverBand: { y: 0.7, h: 0.1 } });
    expect(withCoverMode(undefined, 'off')).toEqual({});
    expect(withCoverMode({ coverOriginal: 'blur', subtitlesInBand: true }, 'off')).toEqual({ coverOriginal: false, subtitlesInBand: true });
  });

  it('the patch clears what is not set (null), so Save really removes it', () => {
    expect(coverPatch({ coverOriginal: 'blur' })).toEqual({ coverOriginal: 'blur', coverBand: null, coverStrength: null, subtitlesInBand: null });
    expect(coverPatch(undefined)).toEqual({ coverOriginal: false, coverBand: null, coverStrength: null, subtitlesInBand: null });
  });
});

describe('a detection taken into the editor', () => {
  const regions = [{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur' as const, corner: 'top-right' as const, confidence: 0.82 }];
  const band = { y: 0.755, h: 0.06, confidence: 0.8, method: 'speech' as const };

  it('its boxes, and its band blurred unless the user chose a way already', () => {
    expect(applyDetection({ regions, band }, undefined)).toEqual({ regions, style: { coverOriginal: 'blur', coverBand: { y: 0.755, h: 0.06 } } });
    expect(applyDetection({ regions, band }, { coverOriginal: true, position: 'raised' }).style).toEqual({
      coverOriginal: true,
      position: 'raised',
      coverBand: { y: 0.755, h: 0.06 },
    });
  });

  it('no band found leaves the choice alone', () => {
    expect(applyDetection({ regions: [] }, { coverOriginal: false })).toEqual({ regions: [], style: { coverOriginal: false } });
  });

  it('only what the render reads is saved, and a change is noticed', () => {
    expect(toSettingsRegions(regions)).toEqual([{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur' }]);
    const saved = { regions: toSettingsRegions(regions), style: { coverOriginal: 'blur' as const } };
    expect(pictureChanged({ regions, style: { coverOriginal: 'blur' } }, saved)).toBe(false);
    expect(pictureChanged({ regions, style: { coverOriginal: 'blur', coverStrength: 7 } }, saved)).toBe(true);
    expect(pictureChanged({ regions: [], style: { coverOriginal: 'blur' } }, saved)).toBe(true);
  });
});

describe('keys', () => {
  it('arrows move a little, Shift more; other keys nothing', () => {
    expect(keyDelta('ArrowLeft', false)).toEqual({ dx: -0.005, dy: 0 });
    expect(keyDelta('ArrowDown', true)).toEqual({ dx: 0, dy: 0.02 });
    expect(keyDelta('Enter', false)).toBeUndefined();
  });
});

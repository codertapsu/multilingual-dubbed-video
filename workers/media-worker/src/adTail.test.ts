import { describe, expect, it } from 'vitest';

import { findLateOverlay, overlayShown, tailGrid, type TailFrame } from './adTail.js';

const W = 160;
const H = 90;
const MIN = 60_000;

/** A pseudo-random generator, so every run sees the same frames. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A frame of moving picture: soft blobs that differ from frame to frame. */
function scene(seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(W * H);
  const blobs = Array.from({ length: 6 }, () => ({ x: r() * W, y: r() * H, v: 40 + r() * 180, s: 8 + r() * 20 }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 60;
      for (const b of blobs) if (Math.hypot(x - b.x, y - b.y) < b.s) v = b.v;
      out[y * W + x] = Math.min(255, Math.round(v + r() * 6));
    }
  }
  return out;
}

/** The advert's banner drawn over a frame: a white box with dark "text" strokes, the same every time. */
function withBanner(frame: Uint8Array, box = { x: 16, y: 50, w: 128, h: 34 }): Uint8Array {
  const out = new Uint8Array(frame);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const stroke = (x % 7 < 2 && (y - box.y) % 11 < 8) || ((y - box.y) % 11 === 4 && x % 13 < 9);
      out[y * W + x] = stroke ? 30 : 235;
    }
  }
  return out;
}

/** `n` frames a minute apart over an hour, the tail from minute `from`. */
function video(n: number, frame: (i: number) => Uint8Array): TailFrame[] {
  return Array.from({ length: n }, (_, i) => ({ atMs: Math.round(((i + 0.5) * 60 * MIN) / n), data: frame(i) }));
}

describe('an advert tail (2026-11-27: 人间斩妖录, 代号：001)', () => {
  it('finds a banner that appears after the drama and stays to the end, over moving footage', () => {
    // An hour, 60 frames: the drama for 20 minutes, then the banner over footage.
    const frames = video(60, (i) => (i < 20 ? scene(i) : withBanner(scene(1000 + i))));
    const found = findLateOverlay(frames, W, H, { videoMs: 60 * MIN });
    expect(found).toBeDefined();
    expect(found!.index).toBe(20);
    expect(found!.tailPresence).toBeGreaterThanOrEqual(0.95);
    expect(found!.headPresence).toBeLessThanOrEqual(0.05);
    // The box is the banner's, give or take a few pixels.
    expect(found!.x).toBeGreaterThanOrEqual(12);
    expect(found!.y).toBeGreaterThanOrEqual(46);
    expect(found!.x + found!.w).toBeLessThanOrEqual(148);
    // One more frame tells whether it shows.
    expect(overlayShown(withBanner(scene(77)), W, found!)).toBeGreaterThan(0.5);
    expect(overlayShown(scene(78), W, found!)).toBeLessThan(0.5);
  });

  it('finds a tail that is one still picture to the end', () => {
    const still = withBanner(scene(4242));
    const frames = video(60, (i) => (i < 30 ? scene(i) : still));
    expect(findLateOverlay(frames, W, H, { videoMs: 60 * MIN })?.index).toBe(30);
  });

  it('finds nothing in a video without a tail, with the banner throughout, or with a late small mark', () => {
    expect(findLateOverlay(video(60, (i) => scene(i)), W, H, { videoMs: 60 * MIN })).toBeUndefined();
    // The banner from the start: no drama before it, so not an advert tail.
    expect(findLateOverlay(video(60, (i) => withBanner(scene(i))), W, H, { videoMs: 60 * MIN })).toBeUndefined();
    // A joined source whose second file has another uploader's mark: far too small.
    const mark = { x: 120, y: 4, w: 30, h: 8 };
    expect(findLateOverlay(video(60, (i) => (i < 30 ? scene(i) : withBanner(scene(i), mark))), W, H, { videoMs: 60 * MIN })).toBeUndefined();
  });

  it('needs ten minutes of drama before it and a tail of ten minutes and a sixth of the video', () => {
    // The banner from minute 5: too early to tell the drama from it.
    expect(findLateOverlay(video(60, (i) => (i < 5 ? scene(i) : withBanner(scene(i)))), W, H, { videoMs: 60 * MIN })).toBeUndefined();
    // The last 6 minutes only: not a tail of the size the uploads carry.
    expect(findLateOverlay(video(60, (i) => (i < 54 ? scene(i) : withBanner(scene(i)))), W, H, { videoMs: 60 * MIN })).toBeUndefined();
  });

  it('looks at frames halved down to 360 pixels at most', () => {
    expect(tailGrid(640, 360)).toEqual({ width: 320, height: 180, factor: 2 });
    expect(tailGrid(160, 90)).toEqual({ width: 160, height: 90, factor: 1 });
    expect(tailGrid(360, 640)).toEqual({ width: 180, height: 320, factor: 2 });
  });
});

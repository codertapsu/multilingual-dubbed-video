import { describe, expect, it } from 'vitest';

import { findStaticMarks, findSubtitleBand, labelTimes, quantile, rowStrokeProfile, type RowProfile } from './pictureAnalysis.js';

// Synthetic frames shaped like the 27.8-hour series (portrait, analysed at
// 360×640): a changing picture, a semi-transparent mark top right in every
// frame, and Chinese-like hardsubs at 76–79 % of the height while someone
// speaks (now and then on two lines).
const W = 360;
const H = 640;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillRect(f: Uint8Array, x: number, y: number, w: number, h: number, v: number): void {
  for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) f[yy * W + xx] = v;
}

/** A different scene every frame: a base tone, blocks of other tones (sharp edges), noise. */
function scene(r: () => number): Uint8Array {
  const f = new Uint8Array(W * H).fill(Math.floor(30 + r() * 150));
  for (let i = 0; i < 40; i++) {
    fillRect(f, Math.floor(r() * W), Math.floor(r() * H), Math.floor(8 + r() * 120), Math.floor(8 + r() * 160), Math.floor(r() * 200));
  }
  for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(255, f[i]! + Math.floor((r() - 0.5) * 16)));
  return f;
}

/** The mark's strokes: eight "letters" of three strokes each, at x 245–345, y 15–28. */
const MARK: [number, number, number, number][] = [];
for (let i = 0; i < 8; i++) {
  const x = 245 + i * 12;
  MARK.push([x, 15, 2, 13], [x + 6, 15, 2, 13], [x, 21, 8, 2]);
}

/** Semi-transparent white mark: half the picture shows through. */
function stampMark(f: Uint8Array): void {
  for (const [x, y, w, h] of MARK) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) f[yy * W + xx] = Math.round(0.5 * f[yy * W + xx]! + 0.5 * 255);
  }
}

/** One line of hardsub text: white strokes with a black outline, a new "sentence" every time. */
function stampLine(f: Uint8Array, r: () => number, top: number): void {
  const chars = 8 + Math.floor(r() * 8);
  const cw = 18;
  let x = Math.round((W - chars * cw) / 2);
  for (let c = 0; c < chars; c++, x += cw) {
    for (let s = 0; s < 3; s++) {
      const vertical = r() < 0.5;
      const sx = x + 2 + Math.floor(r() * 12);
      const sy = top + 1 + Math.floor(r() * 12);
      const [w, h] = vertical ? [2, 6 + Math.floor(r() * 10)] : [6 + Math.floor(r() * 10), 2];
      fillRect(f, sx - 1, sy - 1, w + 2, Math.min(h, top + 19 - sy) + 2, 15);
      fillRect(f, sx, sy, w, Math.min(h, top + 19 - sy), 240);
    }
  }
}

interface Clip {
  frames: Uint8Array[];
  labels: ('speech' | 'silence')[];
}

function clip(opts: { mark: boolean; subs: boolean; count?: number; seed?: number }): Clip {
  const r = rng(opts.seed ?? 7);
  const frames: Uint8Array[] = [];
  const labels: ('speech' | 'silence')[] = [];
  for (let i = 0; i < (opts.count ?? 100); i++) {
    const f = scene(r);
    const speaking = i % 3 !== 0;
    if (opts.subs && speaking) {
      stampLine(f, r, 488);
      if (i % 10 === 1) stampLine(f, r, 464);
    }
    if (opts.mark) stampMark(f);
    frames.push(f);
    labels.push(speaking ? 'speech' : 'silence');
  }
  return { frames, labels };
}

const profilesOf = (c: Clip, labelled: boolean): RowProfile[] =>
  c.frames.map((f, i) => ({ atMs: i * 1000, rows: rowStrokeProfile(f, W, H), ...(labelled ? { label: c.labels[i]! } : {}) }));

describe('findStaticMarks', () => {
  it('finds a still semi-transparent mark in its corner, padded around it', () => {
    const marks = findStaticMarks(clip({ mark: true, subs: true }).frames, W, H);
    expect(marks).toHaveLength(1);
    const m = marks[0]!;
    expect(m.corner).toBe('top-right');
    // The strokes span x 245–339, y 15–27; the box holds all of them.
    expect(m.x).toBeLessThanOrEqual(245);
    expect(m.y).toBeLessThanOrEqual(15);
    expect(m.x + m.w).toBeGreaterThanOrEqual(340);
    expect(m.y + m.h).toBeGreaterThanOrEqual(28);
    // ... and not much more (padding is a third of its height).
    expect(m.x).toBeGreaterThan(225);
    expect(m.w).toBeLessThan(140);
    expect(m.h).toBeLessThan(30);
    expect(m.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('never takes the changing hardsubs for a mark, also from 40 frames (a file of a joined source)', () => {
    expect(findStaticMarks(clip({ mark: false, subs: true }).frames, W, H)).toEqual([]);
    // Fewer frames leave the line's top and bottom edges a weak mean edge in
    // both bottom corners; it runs on past the corners, so it is no mark.
    for (const seed of [21, 22, 23]) expect(findStaticMarks(clip({ mark: false, subs: true, count: 40, seed }).frames, W, H)).toEqual([]);
    const withMark = findStaticMarks(clip({ mark: true, subs: true, count: 40, seed: 21 }).frames, W, H);
    expect(withMark.map((m) => m.corner)).toEqual(['top-right']);
  });

  it('finds nothing on a clean clip', () => {
    expect(findStaticMarks(clip({ mark: false, subs: false, seed: 11 }).frames, W, H)).toEqual([]);
  });

  it('a letterbox edge (a still line across the corner) is not a mark', () => {
    const c = clip({ mark: false, subs: false, seed: 3 });
    for (const f of c.frames) fillRect(f, 0, 0, W, 40, 0);
    expect(findStaticMarks(c.frames, W, H)).toEqual([]);
  });

  it('says nothing from too few frames', () => {
    expect(findStaticMarks(clip({ mark: true, subs: false, count: 5 }).frames, W, H)).toEqual([]);
  });
});

describe('findSubtitleBand', () => {
  it('finds the hardsub rows from speech against silence, tall enough for two lines', () => {
    const band = findSubtitleBand(profilesOf(clip({ mark: true, subs: true }), true), H);
    expect(band).toBeDefined();
    expect(band!.method).toBe('speech');
    // One line spans rows 488–507; one frame in ten has a second at 464–483.
    expect(band!.bottom).toBeGreaterThanOrEqual(505);
    expect(band!.bottom).toBeLessThanOrEqual(516);
    expect(band!.top).toBeLessThanOrEqual(468);
    expect(band!.top).toBeGreaterThanOrEqual(452);
    expect(band!.twoLineShare).toBeGreaterThan(0);
    expect(band!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('a two-line Latin or Vietnamese subtitle: the second line two x-heights up still counts', () => {
    // Dense rows are a line's x-height (8 rows), with sparse ascenders and
    // accents above; the next line's x-height starts 22 rows higher.
    const latin = (f: Uint8Array, r: () => number, top: number): void => {
      let x = 60;
      for (let c = 0; c < 14; c++, x += 17) {
        for (let s = 0; s < 4; s++) {
          const sx = x + Math.floor(r() * 12);
          fillRect(f, sx - 1, top + 6, 4, 9, 15);
          fillRect(f, sx, top + 7, 2, 7, 240);
        }
        if (r() < 0.4) {
          fillRect(f, x + 3, top, 4, 6, 15);
          fillRect(f, x + 4, top + 1, 2, 4, 240);
        }
      }
    };
    const r = rng(9);
    const profiles: RowProfile[] = [];
    for (let i = 0; i < 100; i++) {
      const f = scene(r);
      const speaking = i % 3 !== 0;
      if (speaking) {
        latin(f, r, 500);
        if (i % 10 === 1 || i % 10 === 4) latin(f, r, 478);
      }
      profiles.push({ atMs: i * 1000, rows: rowStrokeProfile(f, W, H), label: speaking ? 'speech' : 'silence' });
    }
    const band = findSubtitleBand(profiles, H)!;
    expect(band.method).toBe('speech');
    expect(band.top).toBeLessThanOrEqual(486);
    expect(band.top).toBeGreaterThanOrEqual(470);
    expect(band.bottom).toBeGreaterThanOrEqual(513);
    expect(band.bottom).toBeLessThanOrEqual(522);
    expect(band.twoLineShare).toBeGreaterThan(0);
  });

  it('finds the band from the picture alone without a transcript, less sure', () => {
    const band = findSubtitleBand(profilesOf(clip({ mark: true, subs: true }), false), H);
    expect(band).toBeDefined();
    expect(band!.method).toBe('appearance');
    expect(band!.bottom).toBeGreaterThanOrEqual(505);
    expect(band!.bottom).toBeLessThanOrEqual(516);
    expect(band!.top).toBeLessThanOrEqual(490);
  });

  it('finds nothing on a clean clip, with or without a transcript', () => {
    const c = clip({ mark: true, subs: false, seed: 5 });
    expect(findSubtitleBand(profilesOf(c, true), H)).toBeUndefined();
    expect(findSubtitleBand(profilesOf(c, false), H)).toBeUndefined();
  });
});

describe('labelTimes', () => {
  it('speech inside a line (away from its edges), silence away from every line, neither in between', () => {
    const lines = [
      { startMs: 1000, endMs: 3000 },
      { startMs: 2500, endMs: 8000 },
      { startMs: 20_000, endMs: 21_000 },
    ];
    expect(labelTimes([1050, 2000, 7000, 8300, 9000, 15_000, 19_700, 20_500, 30_000], lines)).toEqual([
      undefined,
      'speech',
      'speech',
      undefined,
      'silence',
      'silence',
      undefined,
      'speech',
      'silence',
    ]);
  });
});

describe('quantile', () => {
  it('nearest rank on a sorted copy', () => {
    const v = Float32Array.from([5, 1, 4, 2, 3]);
    expect(quantile(v, 0)).toBe(1);
    expect(quantile(v, 0.5)).toBe(3);
    expect(quantile(v, 1)).toBe(5);
    expect(Array.from(v)).toEqual([5, 1, 4, 2, 3]);
  });
});

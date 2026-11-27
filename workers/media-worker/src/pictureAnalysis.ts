/**
 * Finding a watermark and the source's own subtitles in a video's frames,
 * without AI and without an image library: statistics over small grey frames
 * (frameSample.ts). All pure; pictureDetect.ts samples the frames and runs
 * these.
 *
 * A WATERMARK ("玄荒漫剧 bilibili", top right of every frame of the 27.8-hour
 * series) is the one thing in a corner that never moves. Per pixel, over ~100
 * frames spread across the video:
 *   - the mean of the signed gradient: the mark's edges add up (always the
 *     same direction), the changing picture's cancel out (Dekel et al., "On
 *     the Effectiveness of Visible Watermarks", 2017: the median gradient of
 *     many marked images is the mark's). A semi-transparent mark still adds
 *     up; only its strength drops;
 *   - edge persistence: the share of frames with an edge there, which drops
 *     a static stretch of the film that is only a part of the frames.
 * A pixel is the mark's when both stand out from the rest of its corner
 * (robust threshold: median + 6 MADs). The marked pixels are grouped (letters
 * and words close together are one mark), and the strongest group of each
 * corner, padded, is the box. Hardsubs change every line: their gradients
 * cancel and their edges come and go, so they never pass. Lines (a
 * letterbox's edge) and groups spanning a whole corner are not marks.
 *
 * The SUBTITLE BAND: per row, the density of "stroke edges" (a sharp step
 * next to a bright pixel: white or yellow text with a dark outline), in
 * frames while someone speaks against frames in silence (the transcript says
 * which). Rows where text appears with speech are the band; each speech frame
 * then gives its own text's rows, and the band's height is their 95th
 * percentile, so two-line subtitles fit (claude-dubber report, 2026-11-23).
 * Without a transcript, rows whose stroke density comes and goes (75th
 * against 10th percentile over the frames), below the top third: less sure.
 */
import type { PictureCorner } from '@videodubber/shared';

/** The corners searched for a mark: 40 % of the width by 25 % of the height each. */
export const CORNER_WIDTH = 0.4;
export const CORNER_HEIGHT = 0.25;
const CORNERS: readonly PictureCorner[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
/** Fewer frames than this say nothing about what stays still. */
export const MIN_MARK_FRAMES = 8;

/** A mark found in a corner, in analysis pixels (padded). */
export interface MarkFinding {
  corner: PictureCorner;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–1. */
  confidence: number;
  /** Mean coherent edge strength of its pixels (grey levels per pixel). */
  strength: number;
  /** Share of the frames its pixels had an edge in. */
  persistence: number;
  /** How much of its pixels' gradient pointed the same way across frames (0–1). */
  alignment: number;
}

export interface MarkOptions {
  /** A per-frame |gx|+|gy| at least this is an edge (grey levels). Default 20. */
  edgeThreshold?: number;
  /** Share of the frames a mark's edge must show in. Default 0.4. */
  minPersistence?: number;
  /** The coherence threshold never goes below this. Default 6. */
  minCoherence?: number;
  /** Robust threshold: median + k·MAD of the corner's coherence. Default 6. */
  madK?: number;
  /** How much of the frames' gradient must point the mean's way (0–1). Default 0.35. */
  minAlignment?: number;
  /** Marks below this confidence are not reported. Default 0.35. */
  minConfidence?: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** The value at quantile `q` (0–1) of `values` (sorted copy; nearest rank). */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  return sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]!;
}

/** The bounds of a corner's search area: [x0, x1) × [y0, y1). */
export function cornerBounds(corner: PictureCorner, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const cw = Math.round(width * CORNER_WIDTH);
  const ch = Math.round(height * CORNER_HEIGHT);
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  return { x0: left ? 0 : width - cw, x1: left ? cw : width, y0: top ? 0 : height - ch, y1: top ? ch : height };
}

interface Group {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
  sumC: number;
  sumP: number;
  sumA: number;
}

/** 8-connected groups of set pixels of a `w`×`h` mask. */
function components(mask: Uint8Array, C: Float32Array, P: Float32Array, A: Float32Array, w: number, h: number): Group[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const groups: Group[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const g: Group = { x0: w, y0: h, x1: -1, y1: -1, count: 0, sumC: 0, sumP: 0, sumA: 0 };
    while (top > 0) {
      const i = stack[--top]!;
      const x = i % w;
      const y = (i - x) / w;
      g.x0 = Math.min(g.x0, x);
      g.x1 = Math.max(g.x1, x);
      g.y0 = Math.min(g.y0, y);
      g.y1 = Math.max(g.y1, y);
      g.count++;
      g.sumC += C[i]!;
      g.sumP += P[i]!;
      g.sumA += A[i]!;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    groups.push(g);
  }
  return groups;
}

/** Groups whose boxes are within `gx`/`gy` pixels of each other, as one (letters into words, words into a mark). */
function mergeClose(groups: Group[], gx: number, gy: number): Group[] {
  const out = groups.map((g) => ({ ...g }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) - 1);
        const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1);
        if (dx <= gx && dy <= gy) {
          out[i] = {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
            count: a.count + b.count,
            sumC: a.sumC + b.sumC,
            sumP: a.sumP + b.sumP,
            sumA: a.sumA + b.sumA,
          };
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/** The mark of one corner, or undefined. */
function markInCorner(
  frames: readonly Uint8Array[],
  W: number,
  H: number,
  corner: PictureCorner,
  opts: MarkOptions,
): MarkFinding | undefined {
  const { x0, y0, x1, y1 } = cornerBounds(corner, W, H);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw < 8 || ch < 8) return undefined;
  const n = frames.length;
  const edgeT = opts.edgeThreshold ?? 20;
  const sgx = new Float32Array(cw * ch);
  const sgy = new Float32Array(cw * ch);
  const smag = new Float32Array(cw * ch);
  const edges = new Uint16Array(cw * ch);
  const ya = Math.max(y0, 1);
  const yb = Math.min(y1, H - 1);
  const xa = Math.max(x0, 1);
  const xb = Math.min(x1, W - 1);
  for (const f of frames) {
    for (let y = ya; y < yb; y++) {
      const row = y * W;
      const local = (y - y0) * cw - x0;
      for (let x = xa; x < xb; x++) {
        const gx = f[row + x + 1]! - f[row + x - 1]!;
        const gy = f[row + W + x]! - f[row - W + x]!;
        const i = local + x;
        sgx[i]! += gx;
        sgy[i]! += gy;
        smag[i]! += Math.sqrt(gx * gx + gy * gy);
        if (Math.abs(gx) + Math.abs(gy) >= edgeT) edges[i]!++;
      }
    }
  }
  // C: the mean gradient's strength. A: how much of each frame's gradient
  // points that way (1 = always the same edge). Hardsubs have a weak mean
  // edge too, at the top and bottom of their line (the text is darker or
  // lighter on average than the picture), but under strokes that point every
  // way: A tells the two apart where C alone cannot.
  const C = new Float32Array(cw * ch);
  const A = new Float32Array(cw * ch);
  const P = new Float32Array(cw * ch);
  for (let i = 0; i < C.length; i++) {
    const sum = Math.hypot(sgx[i]!, sgy[i]!);
    C[i] = sum / n;
    A[i] = smag[i]! > 0 ? sum / smag[i]! : 0;
    P[i] = edges[i]! / n;
  }
  const med = quantile(C, 0.5);
  const dev = new Float32Array(C.length);
  for (let i = 0; i < C.length; i++) dev[i] = Math.abs(C[i]! - med);
  const mad = quantile(dev, 0.5);
  const tC = Math.max(opts.minCoherence ?? 6, med + (opts.madK ?? 6) * 1.4826 * mad);
  const minP = opts.minPersistence ?? 0.4;
  const minA = opts.minAlignment ?? 0.35;
  const mask = new Uint8Array(C.length);
  for (let i = 0; i < C.length; i++) mask[i] = C[i]! >= tC && P[i]! >= minP && A[i]! >= minA ? 1 : 0;

  const groups = mergeClose(
    components(mask, C, P, A, cw, ch),
    Math.max(3, Math.round(W * 0.035)),
    Math.max(2, Math.round(H * 0.012)),
  );
  const minPixels = Math.max(10, Math.round(W * H * 0.0001));
  // The corner's sides toward the middle of the picture, and how near one a
  // group may come (its strongest pixels can stop short of the side the
  // shape itself crosses).
  const innerX = corner.endsWith('left') ? cw - 1 : 0;
  const innerY = corner.startsWith('top') ? ch - 1 : 0;
  const nearX = Math.max(2, Math.round(0.06 * cw));
  const nearY = Math.max(2, Math.round(0.06 * ch));
  let best: Group | undefined;
  for (const g of groups) {
    const bw = g.x1 - g.x0 + 1;
    const bh = g.y1 - g.y0 + 1;
    if (g.count < minPixels) continue;
    // A line (a letterbox's edge, a border) or the whole corner is not a mark.
    if ((bh <= 3 && bw >= 8 * bh) || (bw <= 3 && bh >= 8 * bw)) continue;
    if (bw >= 0.9 * cw || bh >= 0.9 * ch) continue;
    if (g.count / (bw * bh) < 0.03) continue;
    // What runs into the corner's inner side goes on past it: something
    // centred, like the edges of a subtitle line (it showed in both bottom
    // corners at 40 frames), not a corner's mark.
    if (
      Math.abs(g.x0 - innerX) <= nearX ||
      Math.abs(g.x1 - innerX) <= nearX ||
      Math.abs(g.y0 - innerY) <= nearY ||
      Math.abs(g.y1 - innerY) <= nearY
    ) {
      continue;
    }
    if (!best || g.sumC > best.sumC) best = g;
  }
  if (!best) return undefined;

  const strength = best.sumC / best.count;
  const persistence = best.sumP / best.count;
  const alignment = best.sumA / best.count;
  const confidence =
    clamp01(
      0.2 +
        0.4 * clamp01((strength / tC - 1) / 1.5) +
        0.3 * clamp01((persistence - minP) / (0.95 - minP)) +
        0.1 * clamp01(best.count / 150),
    ) * clamp01(n / 30);
  if (confidence < (opts.minConfidence ?? 0.35)) return undefined;

  // Padded: the mark's glow and soft edges reach past its strongest edges,
  // whose rows start below the mark's top (a fifth of its height left the
  // top of "VD bilibili" out). The box a third wider than the mark of
  // 2026-11-27 ("红果山大王 bilibili", 0.32 × 0.18 for 0.18 × 0.06) came from
  // the advert tail's frames, now left out (adTail.ts): 0.21 × 0.11.
  const bh = best.y1 - best.y0 + 1;
  const pad = Math.max(2, Math.round(0.35 * bh));
  const left = Math.max(0, x0 + best.x0 - pad);
  const top = Math.max(0, y0 + best.y0 - pad);
  const right = Math.min(W, x0 + best.x1 + 1 + pad);
  const bottom = Math.min(H, y0 + best.y1 + 1 + pad);
  return {
    corner,
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
    confidence: Math.round(confidence * 100) / 100,
    strength: Math.round(strength * 10) / 10,
    persistence: Math.round(persistence * 100) / 100,
    alignment: Math.round(alignment * 100) / 100,
  };
}

/**
 * The still marks in the corners of `frames` (`width`×`height` grey bytes
 * each), best first; at most one per corner. Pure.
 */
export function findStaticMarks(frames: readonly Uint8Array[], width: number, height: number, opts: MarkOptions = {}): MarkFinding[] {
  if (frames.length < MIN_MARK_FRAMES) return [];
  const out: MarkFinding[] = [];
  for (const corner of CORNERS) {
    const found = markInCorner(frames, width, height, corner, opts);
    if (found) out.push(found);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------- subtitles

/** A step at least this sharp next to a pixel at least this bright is a subtitle stroke's edge. */
const STROKE_STEP = 64;
const STROKE_BRIGHT = 160;

/**
 * Per row, the share of the row's pixel steps that are subtitle stroke edges
 * (white or yellow text with a dark outline). Pure.
 */
export function rowStrokeProfile(frame: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(height);
  if (width < 2) return out;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < width - 1; x++) {
      const a = frame[row + x]!;
      const b = frame[row + x + 1]!;
      if (Math.abs(a - b) >= STROKE_STEP && (a >= STROKE_BRIGHT || b >= STROKE_BRIGHT)) count++;
    }
    out[y] = count / (width - 1);
  }
  return out;
}

/** A frame's row profile, and whether someone speaks then. */
export interface RowProfile {
  atMs: number;
  rows: Float32Array;
  label?: 'speech' | 'silence';
}

/**
 * Which of `timesMs` fall while someone speaks (inside a line, `insetMs` from
 * its edges) or in silence (`gapMs` from every line); in between, neither.
 * `lines` in the same time as the frames. Pure.
 */
export function labelTimes(
  timesMs: readonly number[],
  lines: readonly { startMs: number; endMs: number }[],
  opts: { insetMs?: number; gapMs?: number } = {},
): ('speech' | 'silence' | undefined)[] {
  const inset = opts.insetMs ?? 120;
  const gap = opts.gapMs ?? 500;
  const sorted = lines.filter((l) => l.endMs > l.startMs).sort((a, b) => a.startMs - b.startMs);
  // Running maximum of the ends, so a line inside a longer one is still covered.
  const maxEnd: number[] = [];
  for (const [i, l] of sorted.entries()) maxEnd.push(Math.max(l.endMs, i > 0 ? maxEnd[i - 1]! : -Infinity));
  return timesMs.map((t) => {
    // Last line starting at or before t + gap.
    let lo = 0;
    let hi = sorted.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.startMs <= t + gap) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let near = false;
    for (let i = at; i >= 0; i--) {
      const l = sorted[i]!;
      if (maxEnd[i]! < t - gap) break;
      if (t >= l.startMs + inset && t <= l.endMs - inset) return 'speech';
      if (t >= l.startMs - gap && t <= l.endMs + gap) near = true;
    }
    return near ? undefined : 'silence';
  });
}

/** The band found, in analysis rows (inclusive). */
export interface BandFinding {
  top: number;
  bottom: number;
  /** 0–1. */
  confidence: number;
  method: 'speech' | 'appearance';
  /** Share of the frames with text whose text was taller than 1.6 lines. */
  twoLineShare: number;
  /** Frames the text was found in. */
  framesWithText: number;
  /** Index (in the profiles given) of the frame with the most text in the band: a good preview. */
  bestIndex?: number;
}

export interface BandOptions {
  /** The peak must reach this (share of a row's steps). Defaults: 0.02 with speech, 0.03 without. */
  minContrast?: number;
}

function meanRows(profiles: readonly RowProfile[], height: number): Float32Array {
  const out = new Float32Array(height);
  for (const p of profiles) for (let y = 0; y < height; y++) out[y]! += p.rows[y]!;
  for (let y = 0; y < height; y++) out[y]! /= Math.max(1, profiles.length);
  return out;
}

/**
 * Per row, how far a frame in silence strays from the silent mean: 2.5
 * standard deviations. A lift below it is the picture, not text.
 */
function rowNoise(silence: readonly RowProfile[], base: Float32Array, height: number): Float32Array {
  const out = new Float32Array(height);
  if (silence.length < 2) return out;
  for (const p of silence) for (let y = 0; y < height; y++) out[y]! += (p.rows[y]! - base[y]!) ** 2;
  for (let y = 0; y < height; y++) out[y] = 2.5 * Math.sqrt(out[y]! / (silence.length - 1));
  return out;
}

function quantileRows(profiles: readonly RowProfile[], height: number, q: number): Float32Array {
  const out = new Float32Array(height);
  const col = new Float64Array(profiles.length);
  for (let y = 0; y < height; y++) {
    for (const [i, p] of profiles.entries()) col[i] = p.rows[y]!;
    out[y] = quantile(col, q);
  }
  return out;
}

/**
 * The band of the source's own subtitles over `profiles` (rows of a
 * `height`-row frame), or undefined when no text comes and goes. Speech
 * against silence first (the transcript's lines); when that finds nothing,
 * the picture alone: a transcript that misses lines labels frames with
 * subtitles "silence" and cancels the difference (《反相之地》 after its
 * loop check removed ~780 real lines: white subtitles at 92–96 % of the
 * height, "no band found"; claude-dubber, 2026-11-25). Pure.
 */
export function findSubtitleBand(profiles: readonly RowProfile[], height: number, opts: BandOptions = {}): BandFinding | undefined {
  const bySpeech = profiles.filter((p) => p.label === 'speech').length >= 6 && profiles.filter((p) => p.label === 'silence').length >= 4;
  const found = bandOf(profiles, height, opts, bySpeech);
  if (found || !bySpeech) return found;
  return bandOf(profiles, height, opts, false);
}

function bandOf(profiles: readonly RowProfile[], height: number, opts: BandOptions, bySpeech: boolean): BandFinding | undefined {
  const H = height;
  const speech = profiles.filter((p) => p.label === 'speech');
  const silence = profiles.filter((p) => p.label === 'silence');
  let base: Float32Array;
  let lift: Float32Array;
  let frames: readonly RowProfile[];
  let from: number;
  if (bySpeech) {
    base = meanRows(silence, H);
    const s = meanRows(speech, H);
    lift = new Float32Array(H);
    for (let y = 0; y < H; y++) lift[y] = s[y]! - base[y]!;
    frames = speech;
    from = 0;
  } else {
    if (profiles.length < 12) return undefined;
    base = quantileRows(profiles, H, 0.1);
    const high = quantileRows(profiles, H, 0.75);
    lift = new Float32Array(H);
    for (let y = 0; y < H; y++) lift[y] = high[y]! - base[y]!;
    frames = profiles;
    // Without speech to tell text from picture, only where subtitles go.
    from = Math.round(H * 0.3);
  }
  // Smoothed over three rows.
  const d = new Float32Array(H);
  for (let y = 0; y < H; y++) d[y] = (lift[Math.max(0, y - 1)]! + lift[y]! + lift[Math.min(H - 1, y + 1)]!) / 3;
  let peak = from;
  for (let y = from; y < H; y++) if (d[y]! > d[peak]!) peak = y;
  const dMax = d[peak]!;
  const searched = d.subarray(from);
  const typical = quantile(Float32Array.from(searched, Math.abs), 0.75);
  if (dMax < (opts.minContrast ?? (bySpeech ? 0.02 : 0.03)) || dMax < 2.5 * typical) return undefined;

  // The core: the rows around the peak that stay above a third of it.
  const keep = 0.35 * dMax;
  let c0 = peak;
  let c1 = peak;
  while (c0 - 1 >= from && (d[c0 - 1]! >= keep || (c0 - 2 >= from && d[c0 - 2]! >= keep))) c0--;
  while (c1 + 1 < H && (d[c1 + 1]! >= keep || (c1 + 2 < H && d[c1 + 2]! >= keep))) c1++;
  const coreH = c1 - c0 + 1;
  if (coreH > 0.25 * H) return undefined;

  // Each frame's own text, line by line: rows near the core with a clear
  // lift over the baseline (and over the row's own noise in silence: a busy
  // picture lifts rows at random), small dips inside a line bridged, runs
  // too short to be a line dropped, then the line over the core joined by
  // the lines stacked within about two line heights of it. Line-aware
  // because the gap between two lines depends on the script: CJK glyphs fill
  // their em box (a small gap), a Latin or Vietnamese line's dense rows are
  // its x-height, and the gap to the next line was twice that (seen on the
  // scratch backend's two-line test subtitles).
  const wTop = Math.max(0, c0 - 3 * coreH - 2);
  const wBottom = Math.min(H - 1, c1 + coreH + 2);
  const theta = Math.max(0.008, 0.4 * dMax);
  const noise = bySpeech ? rowNoise(silence, base, H) : undefined;
  const bridge = Math.max(1, Math.round(0.35 * coreH));
  const minRun = Math.max(2, Math.round(0.4 * coreH));
  const reach = Math.max(3, Math.round(2.2 * coreH));
  const extents: { top: number; bottom: number; index: number; mass: number }[] = [];
  for (const p of frames) {
    const runs: [number, number][] = [];
    let start = -1;
    let last = -1;
    for (let y = wTop; y <= wBottom; y++) {
      if (p.rows[y]! - base[y]! < Math.max(theta, noise ? noise[y]! : 0)) continue;
      if (start >= 0 && y - last > bridge + 1) {
        runs.push([start, last]);
        start = -1;
      }
      if (start < 0) start = y;
      last = y;
    }
    if (start >= 0) runs.push([start, last]);
    let core: [number, number] | undefined;
    let coreOverlap = 0;
    for (const r of runs) {
      const overlap = Math.min(r[1], c1) - Math.max(r[0], c0) + 1;
      if (overlap > coreOverlap) {
        core = r;
        coreOverlap = overlap;
      }
    }
    if (!core || core[1] - core[0] + 1 < 2) continue;
    const block: [number, number] = [core[0], core[1]];
    const lines = runs.filter((r) => r !== core && r[1] - r[0] + 1 >= minRun);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of lines) {
        if (r[1] < block[0] && block[0] - r[1] - 1 <= reach) {
          block[0] = r[0];
          grew = true;
        } else if (r[0] > block[1] && r[0] - block[1] - 1 <= reach) {
          block[1] = r[1];
          grew = true;
        }
      }
    }
    let mass = 0;
    for (let y = block[0]; y <= block[1]; y++) mass += p.rows[y]! - base[y]!;
    extents.push({ top: block[0], bottom: block[1], index: profiles.indexOf(p), mass });
  }

  let top = c0;
  let bottom = c1;
  let twoLineShare = 0;
  if (extents.length >= 3) {
    const heights = extents.map((e) => e.bottom - e.top + 1);
    bottom = Math.round(quantile(extents.map((e) => e.bottom), 0.95));
    top = Math.min(Math.round(quantile(extents.map((e) => e.top), 0.05)), bottom - Math.round(quantile(heights, 0.95)) + 1);
    const medH = quantile(heights, 0.5);
    twoLineShare = heights.filter((h) => h > 1.6 * medH).length / heights.length;
    const margin = Math.max(1, Math.round(0.2 * medH));
    top -= margin;
    bottom += margin;
  } else {
    top -= Math.max(1, Math.round(0.2 * coreH));
    bottom += Math.max(1, Math.round(0.2 * coreH));
  }
  top = Math.max(0, top);
  bottom = Math.min(H - 1, bottom);

  const strength = clamp01(dMax / (bySpeech ? 0.06 : 0.12));
  const coverage = clamp01(extents.length / Math.max(1, frames.length) / 0.5);
  const enough = clamp01(frames.length / 20);
  const confidence = (0.5 * strength + 0.3 * coverage + 0.2 * enough) * (bySpeech ? 1 : 0.8) * (extents.length >= 3 ? 1 : 0.5);
  const best = extents.reduce<(typeof extents)[number] | undefined>((a, e) => (!a || e.mass > a.mass ? e : a), undefined);
  return {
    top,
    bottom,
    confidence: Math.round(confidence * 100) / 100,
    method: bySpeech ? 'speech' : 'appearance',
    twoLineShare: Math.round(twoLineShare * 100) / 100,
    framesWithText: extents.length,
    ...(best ? { bestIndex: best.index } : {}),
  };
}

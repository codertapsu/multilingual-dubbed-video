/**
 * An ADVERT TAIL: uploads titled "全集免费" ("the whole series free") that are
 * the drama only at the start, then hours of an advert for the full version
 * ("点击评论区蓝色链接 可免费观看完整版": click the blue link in the comments)
 * to the end. Behind its banner the picture may be one still image with songs
 * (人间斩妖录, drama to 47:20 of 4:06:21) or moving nature footage with a voice
 * reading the advert (代号：001, drama to 44:07 of 3:55:33): a test for a
 * frozen picture misses the second (claude-dubber, 2026-11-27). What they
 * share is the BANNER: the same text box, absent from the drama, then in
 * every frame to the end. Left in, the subtitle band locked onto the banner,
 * the spot check called the tail a broken source, and a series planned parts
 * of nothing but the advert.
 *
 * So, over the small grey frames the picture detection samples (frameSample.ts),
 * per pixel: the share of frames AFTER a split with an edge there, of frames
 * BEFORE it, and how much its gradient points the same way after it (a
 * still banner's strokes always do; moving footage behind it does not). A
 * split with a large block of such pixels, appearing after a stretch without
 * it and staying to the end, is an advert tail. A watermark that changes
 * between the files of a joined source is far too small to pass. All pure;
 * pictureDetect.ts samples the frames, finds the exact second it starts, and
 * leaves the tail out of the watermark and band searches.
 */

/** A frame as sampled: its time (ms of the input) and `width`×`height` grey bytes. */
export interface TailFrame {
  atMs: number;
  data: Uint8Array;
}

/** An advert tail found in frames, in the frames' own pixels. */
export interface LateOverlay {
  /** The first frame (by time) that carries it; the frame before it does not. */
  index: number;
  /** The banner's box, in the frames' pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of the frames after the split with the banner's edges, and before it (0–1). */
  tailPresence: number;
  headPresence: number;
  /** 0–1. */
  confidence: number;
  /** The banner's pixels on the analysis grid, to tell whether one more frame shows it (overlayShown). */
  pixels: Uint32Array;
  /** The analysis grid: the frames halved `factor` times over. */
  grid: { width: number; height: number; factor: number };
}

export interface LateOverlayOptions {
  /** At least this much picture before the tail (ms). Default 10 min. */
  minHeadMs?: number;
  /** At least this much tail (ms), and at least `minTailShare` of the whole. Default 10 min, 0.15. */
  minTailMs?: number;
  minTailShare?: number;
  /** The video's length (ms); default the last frame's time. */
  videoMs?: number;
}

/** A per-pixel |gx|+|gy| at least this, on the halved grid, is an edge (grey levels). */
const EDGE = 20;
/** The banner's pixels: an edge in this share of the last frames at least... */
const END_SHARE = 0.9;
/** ...and in this share of the first frames (or of the drama's) at most. */
const HEAD_SHARE = 0.2;
/** How much of the frames' gradient must point the mean's way where it shows (0–1). */
const ALIGNED = 0.5;
/** A banner is a large block: this share of the grid's pixels at least, its box this share of the frame. */
const MIN_PIXEL_SHARE = 0.004;
const MIN_BOX_AREA = 0.04;
/** A frame shows the banner when this share of its pixels has an edge. */
export const SHOWN_SHARE = 0.5;
/** From its first frame on, at least this share of the frames show it (a flash or a dissolve may hide it once). */
const STAYS = 0.85;

/** The analysis grid for `width`×`height` frames: halved while the long side is over 360. Pure. */
export function tailGrid(width: number, height: number): { width: number; height: number; factor: number } {
  let factor = 1;
  while (Math.max(width, height) / factor > 360 && factor < 8) factor *= 2;
  return { width: Math.floor(width / factor), height: Math.floor(height / factor), factor };
}

/** A frame averaged down onto the grid. Pure. */
export function toGrid(data: Uint8Array, width: number, grid: { width: number; height: number; factor: number }): Uint8Array {
  const { factor: f } = grid;
  if (f === 1) return data;
  const out = new Uint8Array(grid.width * grid.height);
  const area = f * f;
  for (let gy = 0; gy < grid.height; gy++) {
    for (let gx = 0; gx < grid.width; gx++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (gy * f + dy) * width + gx * f;
        for (let dx = 0; dx < f; dx++) sum += data[row + dx]!;
      }
      out[gy * grid.width + gx] = Math.round(sum / area);
    }
  }
  return out;
}

/** The signed gradients of a grid frame (0 on its border). Pure. */
function gradients(g: Uint8Array, w: number, h: number): { gx: Int16Array; gy: Int16Array } {
  const gx = new Int16Array(w * h);
  const gy = new Int16Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = g[i + 1]! - g[i - 1]!;
      gy[i] = g[i + w]! - g[i - w]!;
    }
  }
  return { gx, gy };
}

/**
 * The share of the banner's pixels with an edge in one more frame
 * (`width`×`height` grey bytes, the size the banner was found at). Pure.
 */
export function overlayShown(data: Uint8Array, width: number, overlay: Pick<LateOverlay, 'pixels' | 'grid'>): number {
  const { grid, pixels } = overlay;
  if (pixels.length === 0) return 0;
  const g = toGrid(data, width, grid);
  const w = grid.width;
  let shown = 0;
  for (const i of pixels) {
    const gx = g[i + 1]! - g[i - 1]!;
    const gy = g[i + w]! - g[i - w]!;
    if (Math.abs(gx) + Math.abs(gy) >= EDGE) shown++;
  }
  return shown / pixels.length;
}

/**
 * The pixels of a still block: an edge in at least END_SHARE of the frames
 * `shows`, in at most HEAD_SHARE of the frames `hides`, its gradient always
 * the same way where it shows. Pure.
 */
function stillPixels(
  grads: readonly { gx: Int16Array; gy: Int16Array }[],
  shows: readonly number[],
  hides: readonly number[],
  P: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < P; i++) {
    let on = 0;
    let sx = 0;
    let sy = 0;
    let mag = 0;
    for (const f of shows) {
      const gx = grads[f]!.gx[i]!;
      const gy = grads[f]!.gy[i]!;
      if (Math.abs(gx) + Math.abs(gy) >= EDGE) on++;
      sx += gx;
      sy += gy;
      mag += Math.sqrt(gx * gx + gy * gy);
    }
    if (on < END_SHARE * shows.length || mag <= 0 || Math.hypot(sx, sy) / mag < ALIGNED) continue;
    let off = 0;
    for (const f of hides) if (Math.abs(grads[f]!.gx[i]!) + Math.abs(grads[f]!.gy[i]!) >= EDGE) off++;
    if (off > HEAD_SHARE * hides.length) continue;
    out.push(i);
  }
  return out;
}

/** The share of `pixels` with an edge in one frame's gradients. Pure. */
function presenceOf(g: { gx: Int16Array; gy: Int16Array }, pixels: readonly number[]): number {
  let on = 0;
  for (const i of pixels) if (Math.abs(g.gx[i]!) + Math.abs(g.gy[i]!) >= EDGE) on++;
  return pixels.length > 0 ? on / pixels.length : 0;
}

/**
 * The advert tail in `frames` (sorted by time, `width`×`height` grey bytes
 * each), or undefined. In two steps: the banner as the video's last frames
 * show it and its first ten minutes do not; then, frame by frame, how much of
 * it shows, and the frame from which it stays. One step (a split with the
 * most such pixels) put the start of both field tails at ~12 min instead of
 * 44 and 47: with the banner on 80 % of the frames, any earlier split still
 * passed. Pure.
 */
export function findLateOverlay(
  frames: readonly TailFrame[],
  width: number,
  height: number,
  opts: LateOverlayOptions = {},
): LateOverlay | undefined {
  const n = frames.length;
  if (n < 12) return undefined;
  const grid = tailGrid(width, height);
  const W = grid.width;
  const H = grid.height;
  const P = W * H;
  const videoMs = opts.videoMs ?? frames[n - 1]!.atMs;
  const minHead = opts.minHeadMs ?? 10 * 60_000;
  const minTail = Math.max(opts.minTailMs ?? 10 * 60_000, (opts.minTailShare ?? 0.15) * videoMs);
  const first = frames.flatMap((f, i) => (f.atMs < minHead ? [i] : []));
  const last = frames.flatMap((f, i) => (f.atMs >= videoMs - minTail ? [i] : []));
  if (first.length < 2 || last.length < 3) return undefined;
  const grads = frames.map((f) => gradients(toGrid(f.data, width, grid), W, H));
  const minPixels = Math.max(60, Math.round(MIN_PIXEL_SHARE * P));

  // 1. The banner, as the end shows it and the start does not.
  const banner = stillPixels(grads, last, first, P);
  if (banner.length < minPixels) return undefined;

  // 2. From which frame it stays: the most contrast between before and after.
  const presence = grads.map((g) => presenceOf(g, banner));
  const shown = presence.map((p) => p >= SHOWN_SHARE);
  let best: { k: number; score: number } | undefined;
  for (let k = 1; k < n; k++) {
    if (!shown[k] || frames[k]!.atMs < minHead || videoMs - frames[k]!.atMs < minTail) continue;
    const after = shown.slice(k);
    const before = shown.slice(0, k);
    if (after.filter(Boolean).length < STAYS * after.length) continue;
    if (before.filter(Boolean).length > HEAD_SHARE * before.length) continue;
    const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const score = mean(presence.slice(k)) - mean(presence.slice(0, k));
    if (!best || score > best.score + 1e-9) best = { k, score };
  }
  if (!best) return undefined;
  const k = best.k;

  // 3. The banner again, from the whole tail against the whole drama: its pixels and box.
  const tailIdx = Array.from({ length: n - k }, (_, i) => k + i);
  const headIdx = Array.from({ length: k }, (_, i) => i);
  const again = stillPixels(grads, tailIdx, headIdx, P);
  const pixels = again.length >= minPixels ? again : banner;
  const xs = pixels.map((i) => i % W).sort((a, b) => a - b);
  const ys = pixels.map((i) => Math.floor(i / W)).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]!;
  const x0 = q(xs, 0.02);
  const y0 = q(ys, 0.02);
  const bw = q(xs, 0.98) - x0 + 1;
  const bh = q(ys, 0.98) - y0 + 1;
  if ((bw * bh) / P < MIN_BOX_AREA) return undefined;
  const tailPresence = shown.slice(k).filter(Boolean).length / (n - k);
  const headPresence = shown.slice(0, k).filter(Boolean).length / k;
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const confidence = clamp01(
    0.45 * clamp01((tailPresence - STAYS) / (1 - STAYS)) + 0.35 * clamp01(1 - headPresence / HEAD_SHARE) + 0.2 * clamp01(pixels.length / (4 * minPixels)),
  );
  const f = grid.factor;
  return {
    index: k,
    x: x0 * f,
    y: y0 * f,
    w: bw * f,
    h: bh * f,
    tailPresence: Math.round(tailPresence * 100) / 100,
    headPresence: Math.round(headPresence * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    pixels: Uint32Array.from(pixels),
    grid,
  };
}

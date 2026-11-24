/**
 * Hiding parts of the picture in the render: watermarks (`settings.blurRegions`)
 * and the band over the source's own subtitles (`burnSubtitleStyle.coverOriginal:
 * 'blur'`). The 27.8-hour series asked for both: "玄荒漫剧 bilibili" top right
 * in every frame, and Chinese hardsubs at 76–81 % of the height under the
 * Vietnamese subtitles (claude-dubber report, 2026-11-23).
 *
 * Each region is its own small chain, in the existing filter graph and BEFORE
 * anything is drawn (overlay.ts): subtitles, title cards and the logo go on
 * top of the blurred picture, never under it.
 *
 *   blur / pixelate:  [in]split[m][c];[c]crop,<effect>[e];[m][e]overlay=x:y[out]
 *   delogo:           [in]delogo=x:y:w:h[out]
 *
 * Recipes, as for the logo (overlay.ts):
 *   - a region that holds only for a while moves its patch off-screen outside
 *     that time (`x='if(between(t,a,b),X,-overlay_w-10)'`) instead of switching
 *     the overlay with `enable=`; delogo, a one-input filter, uses `enable=`;
 *   - pixelation is a scale down (area average) and back up (nearest
 *     neighbour): every ffmpeg has it, unlike the `pixelize` filter (6.0+);
 *   - sizes and positions are even (yuv420p), and the blur radius stays under
 *     what boxblur accepts for the patch's chroma planes (half its size), or
 *     the render fails with "Invalid chroma_param radius value".
 *
 * All pure; render.ts / overlay.ts put the pieces in the graph.
 */
import type { BlurRegion, SubtitleStyle } from '@videodubber/shared';

import { coverBandRect, coverModeOf } from './ass.js';

/** A region on the picture, resolved: pixels, and the render's own time. */
export interface PixelRegion {
  mode: BlurRegion['mode'];
  /** Even pixel position and size on the picture. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1–10. */
  strength: number;
  /** Render (output) time, ms; absent = from the start / to the end. */
  fromMs?: number;
  toMs?: number;
}

/** Default strength of a region or the blurred band. */
export const DEFAULT_PICTURE_STRENGTH = 5;
/** Smallest patch side in pixels: below it a blur or a block is meaningless. */
const MIN_SIDE = 8;

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Seconds with millisecond precision, for ffmpeg. */
function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/** A strength 1–10 (5 when missing or out of range). Pure. */
export function pictureStrength(n: unknown): number {
  return finite(n) ? Math.round(clamp(n, 1, 10)) : DEFAULT_PICTURE_STRENGTH;
}

/**
 * A 0–1 rectangle in even pixels on a `width`x`height` picture, inside it, at
 * least {@link MIN_SIDE} on each side; undefined when it is not a rectangle.
 * Pure.
 */
export function pixelRect(
  r: Pick<BlurRegion, 'x' | 'y' | 'w' | 'h'>,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | undefined {
  if (![r.x, r.y, r.w, r.h].every(finite) || r.w <= 0 || r.h <= 0) return undefined;
  const W = Math.max(2, Math.floor(width / 2) * 2);
  const H = Math.max(2, Math.floor(height / 2) * 2);
  const x0 = clamp(r.x, 0, 1) * W;
  const y0 = clamp(r.y, 0, 1) * H;
  const x1 = clamp(r.x + r.w, 0, 1) * W;
  const y1 = clamp(r.y + r.h, 0, 1) * H;
  // Outward to even pixels: a mark is never cut short by the rounding.
  let x = Math.floor(x0 / 2) * 2;
  let y = Math.floor(y0 / 2) * 2;
  let w = Math.ceil(x1 / 2) * 2 - x;
  let h = Math.ceil(y1 / 2) * 2 - y;
  if (w < MIN_SIDE) {
    w = Math.min(W, MIN_SIDE);
    x = Math.min(x, W - w);
  }
  if (h < MIN_SIDE) {
    h = Math.min(H, MIN_SIDE);
    y = Math.min(y, H - h);
  }
  return { x, y, w, h };
}

/**
 * When a region holds in the render's own time, or null when it never does
 * there. Region times are the input video's; a part renders a window
 * (`range`), so they move by its start and are clipped to it. Pure.
 */
export function regionWindow(
  r: Pick<BlurRegion, 'startMs' | 'endMs'>,
  range?: { startMs: number; endMs: number },
  durationMs?: number,
): { fromMs?: number; toMs?: number } | null {
  const offset = range ? range.startMs : 0;
  const length = range ? range.endMs - range.startMs : durationMs && durationMs > 0 ? durationMs : undefined;
  let from = finite(r.startMs) ? r.startMs - offset : undefined;
  let to = finite(r.endMs) ? r.endMs - offset : undefined;
  if (to !== undefined && to <= 0) return null;
  if (from !== undefined && length !== undefined && from >= length) return null;
  if (from !== undefined && to !== undefined && to <= from) return null;
  if (from !== undefined && from <= 0) from = undefined;
  if (to !== undefined && length !== undefined && to >= length) to = undefined;
  return { ...(from !== undefined ? { fromMs: Math.round(from) } : {}), ...(to !== undefined ? { toMs: Math.round(to) } : {}) };
}

/**
 * The regions of a render in pixels and render time, invalid and out-of-window
 * ones dropped. Pure.
 */
export function resolveRegions(
  regions: readonly BlurRegion[] | undefined,
  width: number,
  height: number,
  opts: { range?: { startMs: number; endMs: number }; durationMs?: number } = {},
): PixelRegion[] {
  const out: PixelRegion[] = [];
  for (const r of regions ?? []) {
    if (!r || (r.mode !== 'blur' && r.mode !== 'pixelate' && r.mode !== 'delogo')) continue;
    const rect = pixelRect(r, width, height);
    if (!rect) continue;
    const when = regionWindow(r, opts.range, opts.durationMs);
    if (!when) continue;
    out.push({ mode: r.mode, ...rect, strength: pictureStrength(r.strength), ...when });
  }
  return out;
}

/**
 * The blurred band over the source's own subtitles as a region (full width,
 * the whole render), or undefined when the style does not ask for one. The
 * same rectangle the solid band draws (ass.ts coverBandRect). Pure.
 */
export function blurBandRegion(style: SubtitleStyle | undefined, width: number, height: number): PixelRegion | undefined {
  if (coverModeOf(style) !== 'blur') return undefined;
  const band = coverBandRect(style, width, height);
  if (!band) return undefined;
  const rect = pixelRect({ x: 0, y: band.top / height, w: 1, h: band.height / height }, width, height);
  return rect ? { mode: 'blur', ...rect, strength: pictureStrength(style?.coverStrength) } : undefined;
}

/**
 * Box-blur radii for a patch at a strength: from 8 % (strength 1) to 40 %
 * (10) of its shorter side, at most what boxblur accepts (half the plane's
 * shorter side; a quarter of the patch for 4:2:0 chroma). Pure.
 */
export function blurRadii(strength: number, w: number, h: number): { luma: number; chroma: number; power: number } {
  const side = Math.min(w, h);
  const s = pictureStrength(strength);
  const luma = clamp(Math.round(side * (0.044 + 0.036 * s)), 1, Math.max(1, Math.floor(side / 2)));
  const chroma = clamp(Math.round(luma / 2), 1, Math.max(1, Math.floor(side / 4)));
  return { luma, chroma, power: s >= 7 ? 3 : 2 };
}

/** Pixelation block size: from 6 % (strength 1) to 33 % (10) of the patch's shorter side. Pure. */
export function pixelBlock(strength: number, w: number, h: number): number {
  const side = Math.min(w, h);
  return clamp(Math.round(side * (0.03 + 0.03 * pictureStrength(strength))), 2, side);
}

/** The time condition of a region, for ffmpeg expressions; undefined = always. */
function timeCondition(r: PixelRegion): string | undefined {
  if (r.fromMs !== undefined && r.toMs !== undefined) return `between(t,${sec(r.fromMs)},${sec(r.toMs)})`;
  if (r.fromMs !== undefined) return `gte(t,${sec(r.fromMs)})`;
  if (r.toMs !== undefined) return `lt(t,${sec(r.toMs)})`;
  return undefined;
}

/**
 * delogo interpolates from the pixels around its rectangle, which must lie
 * inside the frame with a pixel to spare on every side (a rectangle touching
 * the edge fails the render: "Logo area is outside of the frame").
 */
function delogoRect(r: PixelRegion, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const x = clamp(r.x, 1, Math.max(1, width - 4));
  const y = clamp(r.y, 1, Math.max(1, height - 4));
  return { x, y, w: Math.max(2, Math.min(r.x + r.w, width - 2) - x), h: Math.max(2, Math.min(r.y + r.h, height - 2) - y) };
}

/**
 * The filter-graph chains hiding `regions`, from `[input]` to `[output]`
 * (joined with `;`), or undefined when there is nothing to hide. Pure.
 */
export function buildRegionFilters(
  regions: readonly PixelRegion[],
  width: number,
  height: number,
  labels: { input: string; output: string },
): string | undefined {
  if (regions.length === 0) return undefined;
  const chains: string[] = [];
  let current = labels.input;
  regions.forEach((r, i) => {
    const out = i === regions.length - 1 ? labels.output : `pr${i}`;
    const cond = timeCondition(r);
    if (r.mode === 'delogo') {
      const d = delogoRect(r, width, height);
      chains.push(`[${current}]delogo=x=${d.x}:y=${d.y}:w=${d.w}:h=${d.h}${cond ? `:enable='${cond}'` : ''}[${out}]`);
    } else {
      let effect: string;
      if (r.mode === 'pixelate') {
        const b = pixelBlock(r.strength, r.w, r.h);
        effect = `scale=${Math.max(1, Math.ceil(r.w / b))}:${Math.max(1, Math.ceil(r.h / b))}:flags=area,scale=${r.w}:${r.h}:flags=neighbor`;
      } else {
        const { luma, chroma, power } = blurRadii(r.strength, r.w, r.h);
        effect = `boxblur=luma_radius=${luma}:luma_power=${power}:chroma_radius=${chroma}:chroma_power=${power}`;
      }
      // Single quotes keep the commas inside the expression from splitting the graph.
      const x = cond ? `'if(${cond},${r.x},-overlay_w-10)'` : `${r.x}`;
      chains.push(
        `[${current}]split=2[pr${i}m][pr${i}c];` +
          `[pr${i}c]crop=${r.w}:${r.h}:${r.x}:${r.y},${effect}[pr${i}e];` +
          `[pr${i}m][pr${i}e]overlay=x=${x}:y=${r.y}${cond ? ':eval=frame' : ''}[${out}]`,
      );
    }
    current = out;
  });
  return chains.join(';');
}

/**
 * Everything a render hides, resolved: the watermark regions, then the
 * blurred band. Pure.
 */
export function pictureRegionsFor(
  input: { blurRegions?: readonly BlurRegion[]; burnSubtitleStyle?: SubtitleStyle; range?: { startMs: number; endMs: number } },
  width: number,
  height: number,
  durationMs?: number,
): PixelRegion[] {
  const regions = resolveRegions(input.blurRegions, width, height, {
    ...(input.range ? { range: input.range } : {}),
    ...(durationMs ? { durationMs } : {}),
  });
  const band = blurBandRegion(input.burnSubtitleStyle, width, height);
  return band ? [...regions, band] : regions;
}

/** True when a render hides any part of the picture (so it must re-encode). Pure. */
export function hidesPicture(input: { blurRegions?: readonly BlurRegion[]; burnSubtitleStyle?: SubtitleStyle }): boolean {
  return (input.blurRegions?.length ?? 0) > 0 || coverModeOf(input.burnSubtitleStyle) === 'blur';
}

/**
 * The ffmpeg filters hiding `regions` takes beyond the ones every build has:
 * boxblur and delogo exist only in GPL builds. The bundled ffmpeg is one (it
 * carries x264); an FFMPEG_PATH build may not be. Pure.
 */
export function requiredPictureFilters(regions: readonly PixelRegion[]): string[] {
  const out = new Set<string>();
  for (const r of regions) {
    if (r.mode === 'blur') out.add('boxblur');
    if (r.mode === 'delogo') out.add('delogo');
  }
  return [...out];
}

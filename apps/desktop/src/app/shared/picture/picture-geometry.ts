/**
 * The picture editor's rules (shared/picture/picture-editor.component.ts), pure
 * and unit-tested: boxes and the band in 0–1 of the frame, moved and resized
 * by a drag or the arrow keys, always inside the frame and never smaller than
 * something the render can hide. The detection's proposals become settings
 * here too.
 *
 * The render takes the same 0–1 values (media worker pictureFilters.ts), so
 * what the user sees on the frame is what gets hidden, at any resolution.
 */
import type { BlurRegion, PictureDetection, SubtitleStyle, WatermarkProposal } from '@videodubber/shared';

/** A box in 0–1 of the frame. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A full-width band: its top and height, 0–1 of the frame height. */
export interface Band {
  y: number;
  h: number;
}

/** A region as the editor lists it: what is saved, plus what the detection said about it. */
export type EditorRegion = BlurRegion & Partial<Pick<WatermarkProposal, 'confidence' | 'corner' | 'fileName'>>;

/** The smallest box: 2 % of the frame each way. */
export const MIN_BOX = 0.02;
/** The thinnest band: 1 % of the height. */
export const MIN_BAND = 0.01;
/** The bottom strip a band without a place of its own covers (ass.ts DEFAULT_COVER_HEIGHT_PERCENT). */
export const BOTTOM_STRIP = 0.18;
/** One arrow-key step, and with Shift. */
export const KEY_STEP = 0.005;
export const KEY_STEP_LARGE = 0.02;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** A box inside the frame, at least {@link MIN_BOX} each way. Pure. */
export function clampBox(b: Box): Box {
  const w = clamp(b.w, MIN_BOX, 1);
  const h = clamp(b.h, MIN_BOX, 1);
  return { x: r4(clamp(b.x, 0, 1 - w)), y: r4(clamp(b.y, 0, 1 - h)), w: r4(w), h: r4(h) };
}

/** `b` moved by (dx, dy), sliding along the frame's edge rather than out of it. Pure. */
export function moveBox(b: Box, dx: number, dy: number): Box {
  return clampBox({ ...b, x: b.x + dx, y: b.y + dy });
}

/** `b` resized from its bottom-right corner by (dx, dy): at least {@link MIN_BOX}, inside the frame. Pure. */
export function resizeBox(b: Box, dx: number, dy: number): Box {
  return { x: b.x, y: b.y, w: r4(clamp(b.w + dx, MIN_BOX, 1 - b.x)), h: r4(clamp(b.h + dy, MIN_BOX, 1 - b.y)) };
}

/** A band inside the frame, at least {@link MIN_BAND} high. Pure. */
export function clampBand(b: Band): Band {
  const h = clamp(b.h, MIN_BAND, 1);
  return { y: r4(clamp(b.y, 0, 1 - h)), h: r4(h) };
}

/** The band moved by `dy`. Pure. */
export function moveBand(b: Band, dy: number): Band {
  return clampBand({ ...b, y: b.y + dy });
}

/** The band with one edge dragged by `dy`: the top keeps the bottom where it is, the bottom keeps the top. Pure. */
export function dragBandEdge(b: Band, edge: 'top' | 'bottom', dy: number): Band {
  if (edge === 'bottom') return { y: b.y, h: r4(clamp(b.h + dy, MIN_BAND, 1 - b.y)) };
  const bottom = b.y + b.h;
  const y = clamp(b.y + dy, 0, bottom - MIN_BAND);
  return { y: r4(y), h: r4(bottom - y) };
}

/** A new box in the middle of the frame, to drag onto what should be hidden. */
export function newBox(): EditorRegion {
  return { x: 0.4, y: 0.45, w: 0.2, h: 0.1, mode: 'blur' };
}

/** A band placed by hand: the bottom strip, where most videos burn their subtitles. */
export function defaultBand(): Band {
  return { y: r4(1 - BOTTOM_STRIP), h: BOTTOM_STRIP };
}

/** How a style hides the source's subtitles, as the editor offers it. Pure. */
export function coverModeOf(style: SubtitleStyle | undefined): 'off' | 'solid' | 'blur' {
  const c = style?.coverOriginal;
  return c === 'blur' ? 'blur' : c === true || c === 'solid' ? 'solid' : 'off';
}

/**
 * `style` with the band's mode set; its place, strength and "our subtitles
 * in it" stay, so switching back finds them again. An unchanged solid band
 * keeps the value it had (`true` from before 0.18). Pure.
 */
export function withCoverMode(style: SubtitleStyle | undefined, mode: 'off' | 'solid' | 'blur'): SubtitleStyle {
  const s = { ...style };
  if (mode === coverModeOf(s)) return s;
  return { ...s, coverOriginal: mode === 'off' ? false : mode };
}

/** Where the band is drawn on the frame: its own place, else the bottom strip. Pure. */
export function shownBand(style: SubtitleStyle | undefined): Band | undefined {
  if (coverModeOf(style) === 'off') return undefined;
  if (style?.coverBand) return clampBand(style.coverBand);
  const pct = style?.coverHeightPercent;
  const h = typeof pct === 'number' && pct > 0 ? Math.min(0.6, pct / 100) : BOTTOM_STRIP;
  return { y: r4(1 - h), h: r4(h) };
}

/** The regions to save: only what the render reads. Pure. */
export function toSettingsRegions(regions: readonly EditorRegion[]): BlurRegion[] {
  return regions.map((r) => ({
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    ...(r.startMs !== undefined ? { startMs: r.startMs } : {}),
    ...(r.endMs !== undefined ? { endMs: r.endMs } : {}),
    mode: r.mode,
    ...(r.strength !== undefined ? { strength: r.strength } : {}),
  }));
}

/**
 * A detection taken into the editor: its boxes replace the list, and a band
 * it found is where the band goes, blurred unless the user already chose a
 * way to hide it. What it did not find leaves the choice alone. Pure.
 */
export function applyDetection(
  detection: Pick<PictureDetection, 'regions' | 'band'>,
  style: SubtitleStyle | undefined,
): { regions: EditorRegion[]; style: SubtitleStyle | undefined } {
  const regions = detection.regions.map((m) => ({ ...m }));
  if (!detection.band) return { regions, style };
  const mode = coverModeOf(style);
  return {
    regions,
    style: { ...withCoverMode(style, mode === 'off' ? 'blur' : mode), coverBand: { y: detection.band.y, h: detection.band.h } },
  };
}

/**
 * The band fields of `style` as a settings patch: what is not set is sent as
 * null, so the saved style loses it too (the orchestrator merges otherwise).
 * Pure.
 */
export function coverPatch(style: SubtitleStyle | undefined): Record<string, unknown> {
  return {
    coverOriginal: style?.coverOriginal ?? false,
    coverBand: style?.coverBand ?? null,
    coverStrength: style?.coverStrength ?? null,
    subtitlesInBand: style?.subtitlesInBand ?? null,
  };
}

/** True when the regions or the band differ between two states (what Save would change). Pure. */
export function pictureChanged(
  a: { regions: readonly EditorRegion[]; style: SubtitleStyle | undefined },
  b: { regions: readonly EditorRegion[]; style: SubtitleStyle | undefined },
): boolean {
  return (
    JSON.stringify(toSettingsRegions(a.regions)) !== JSON.stringify(toSettingsRegions(b.regions)) ||
    JSON.stringify(coverPatch(a.style)) !== JSON.stringify(coverPatch(b.style))
  );
}

/** 0–1 as a whole percent. Pure. */
export function percent(n: number): number {
  return Math.round(n * 100);
}

/** A key on a focused box or band: how far it moves or grows, or undefined for other keys. Pure. */
export function keyDelta(key: string, large: boolean): { dx: number; dy: number } | undefined {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 };
    case 'ArrowRight':
      return { dx: step, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -step };
    case 'ArrowDown':
      return { dx: 0, dy: step };
    default:
      return undefined;
  }
}

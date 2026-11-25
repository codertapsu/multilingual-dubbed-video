/**
 * Burned-in subtitles as a generated ASS script.
 *
 * WHY: the burn used to hand ffmpeg the .srt and let libass apply its built-in
 * SRT style — a 384x288 canvas scaled to the frame: ~40 px Arial at 720p, a
 * 2.5 px outline, no shadow, 25 px from the bottom. That strip is exactly where
 * many Chinese sources carry their own burned-in subtitles, so the dub's line
 * landed on top of the original's. An ASS script whose canvas IS the video's
 * pixel size (PlayResX/PlayResY = width/height) lets us place and size the text
 * deliberately, add a soft shadow, raise it above the original's strip, or
 * cover that strip with a band — identically at 480p and 4K.
 *
 * The SRT/VTT the pipeline exports are untouched; this script exists only for
 * the burn. Everything here is pure and unit-tested.
 */

import type { SubtitleStyle } from '@videodubber/shared';
import { BUNDLED_FONT_CELL_RATIO, BUNDLED_FONT_FAMILY, DEFAULT_FONT_CELL_RATIO } from './fonts.js';
import { hexToAssColor } from './subtitles.js';

/** One timed cue; `text` lines are separated by "\n". */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMING = /(\d+:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function timeToMs(h: string | undefined, m: string, s: string, frac: string): number {
  const hours = h ? Number(h.slice(0, -1)) : 0;
  // "5" after the separator is 500 ms, not 5 ms.
  const ms = Number(frac.padEnd(3, '0'));
  return ((hours * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

/**
 * Parse SubRip or WebVTT cues. Pure. A block is a cue when one of its lines
 * holds a `-->` timing (VTT cue settings after it are ignored); everything else
 * (the WEBVTT header, NOTE/STYLE blocks, stray numbers) is skipped. Cue text
 * keeps its line breaks.
 */
export function parseSubtitleCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = TIMING.exec(lines[at]!);
    if (!m) continue;
    const startMs = timeToMs(m[1], m[2]!, m[3]!, m[4]!);
    const endMs = timeToMs(m[5], m[6]!, m[7]!, m[8]!);
    const text = lines
      .slice(at + 1)
      .join('\n')
      .trim();
    if (text === '' || endMs <= startMs) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

/** ASS timestamp `H:MM:SS.cc` (centiseconds), clamped to the format's 9:59:59.99. Pure. */
export function formatAssTime(ms: number): string {
  const cs = Math.min(3_599_999, Math.max(0, Math.round(ms / 10)));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': '\u00A0', '&quot;': '"' };

/**
 * Cue text -> ASS event text. Pure.
 * - <i>/<b>/<u> become ASS overrides; any other tag (<font>, VTT <c.x>, <v Name>,
 *   inline timestamps) is dropped, and the few HTML entities VTT uses decoded.
 * - `{` and `}` would open an override block and swallow the words between
 *   them, so they are escaped as `\{` `\}` (libass prints them literally —
 *   checked on the bundled ffmpeg).
 * - A backslash before n, N, h, { or } would read as an ASS escape; a word
 *   joiner after it keeps it a plain backslash. `<` too: the tag after it
 *   (<i>) becomes `{\i1}`, and `C:\<i>…` read as an escaped `\{`, showing the
 *   tag as text and dropping the backslash.
 * - Line breaks become `\N`.
 */
export function cueTextToAss(text: string): string {
  let t = text
    .replace(/\\(?=[nNh{}<])/g, '\\\u2060')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
  t = t.replace(/<(\/?)([ibu])>/gi, (_m, close: string, tag: string) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`);
  t = t.replace(/<\/?[a-zA-Z][^<>]*>|<\d{1,2}:\d{2}[:.\d]*>/g, '');
  t = t.replace(/&(amp|lt|gt|nbsp|quot);/g, (e) => ENTITIES[e] ?? e);
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\\N');
}

/** Text size default: em height in % of the frame's shorter side. */
export const DEFAULT_SIZE_PERCENT = 5.5;
/** Outline width default, as a fraction of the em size (≈3 px at 720p). */
const OUTLINE_PER_EM = 0.08;
/** Soft shadow: offset and blur as fractions of the em size; 55% opaque black. */
const SHADOW_OFFSET_PER_EM = 0.06;
const SHADOW_BLUR_PER_EM = 0.1;
const SHADOW_ALPHA = 0x73;
/** Bottom margin (text block to frame edge), % of height. */
const BOTTOM_MARGIN_PERCENT = 4.5;
/**
 * `raised`: the text block's bottom edge, % of height above the frame bottom.
 * Chinese hardsubs on the reference 720p source span 632-700 px (12% to 3% from
 * the bottom); 18% leaves a clear gap above a two-line original.
 */
const RAISED_MARGIN_PERCENT = 18;
/** Side margins, % of width; long lines wrap inside them. */
const SIDE_MARGIN_PERCENT = 6;
/**
 * Band defaults (see SubtitleStyle.coverOpacity / coverHeightPercent). Opaque:
 * at 0.9 and 0.96 the source's white hardsub still ghosted through on a real
 * 720p frame, and at 0.96 the band already looks black, so translucency bought
 * nothing but the leak.
 */
export const DEFAULT_COVER_OPACITY = 1;
export const DEFAULT_COVER_HEIGHT_PERCENT = 18;
/** libass line advance ≈ the font's hhea ascent-descent: 1.265 em for the bundled font. */
const LINE_HEIGHT_PER_EM = 1.265;
/** Legacy sizes were on libass' 288-line SRT canvas. */
const LEGACY_CANVAS = 288;

/** Everything the ASS document needs, in script (= video) pixels. */
export interface AssLayout {
  width: number;
  height: number;
  fontName: string;
  /** ASS `Fontsize` (the font's ascent+descent cell, VSFilter semantics). */
  fontSize: number;
  primaryColour: string;
  outlineColour: string;
  outline: number;
  shadowOffset: number;
  shadowBlur: number;
  /** ASS numpad alignment: 2 bottom, 5 middle, 8 top (all centered). */
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
  band?: { top: number; height: number; opacity: number };
}

function finite(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * How the source's own subtitles are hidden: `solid` (the opaque band drawn
 * with the burned-in subtitles; `true` is the same), `blur` (a picture filter,
 * pictureFilters.ts), or not at all. Pure.
 */
export function coverModeOf(style: SubtitleStyle | undefined): 'solid' | 'blur' | undefined {
  const c = style?.coverOriginal;
  return c === true || c === 'solid' ? 'solid' : c === 'blur' ? 'blur' : undefined;
}

/** The dub's text size on a `w`x`h` frame: its em (px), ASS Fontsize and family. */
function textMetrics(s: SubtitleStyle, w: number, h: number): { em: number; fontSize: number; fontName: string } {
  const shortSide = Math.min(w, h);
  const fontName = (s.fontFamily?.trim() || BUNDLED_FONT_FAMILY).replace(/,/g, ' ');
  const cellRatio = fontName === BUNDLED_FONT_FAMILY ? BUNDLED_FONT_CELL_RATIO : DEFAULT_FONT_CELL_RATIO;
  // Size: sizePercent (em), else the legacy 288-canvas fontSize (an ASS cell
  // size already, so no cell conversion), else the default em.
  if (finite(s.sizePercent) && s.sizePercent > 0) {
    const em = (s.sizePercent / 100) * shortSide;
    return { em, fontSize: em * cellRatio, fontName };
  }
  if (finite(s.fontSize) && s.fontSize > 0) {
    const fontSize = (s.fontSize / LEGACY_CANVAS) * shortSide;
    return { em: fontSize / cellRatio, fontSize, fontName };
  }
  const em = (DEFAULT_SIZE_PERCENT / 100) * shortSide;
  return { em, fontSize: em * cellRatio, fontName };
}

/**
 * Where the band over the source's own subtitles is on a `width`x`height`
 * frame, in pixels (full width), or undefined when the style hides nothing.
 * One rectangle for both ways of hiding: the solid band draws it, the blurred
 * band blurs it. Pure.
 *
 * `coverBand` (0–1, found by the picture detection) places it anywhere: the
 * 27.8-hour series' hardsubs sit at 76–81 % of the height, not at the bottom
 * edge. Without it, the bottom strip as before: `coverHeightPercent` high and
 * tall enough for two lines of the dub's text sitting on it.
 */
export function coverBandRect(style: SubtitleStyle | undefined, width: number, height: number): { top: number; height: number } | undefined {
  const s = style ?? {};
  if (!coverModeOf(s)) return undefined;
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const b = s.coverBand;
  if (b && finite(b.y) && finite(b.h) && b.h > 0 && b.y >= 0 && b.y < 1) {
    const top = Math.min(h - 2, Math.max(0, Math.round(b.y * h)));
    return { top, height: Math.min(h - top, Math.max(2, Math.round(Math.min(1, b.h) * h))) };
  }
  const { em } = textMetrics(s, w, h);
  const pct = finite(s.coverHeightPercent) && s.coverHeightPercent > 0 ? Math.min(60, s.coverHeightPercent) : DEFAULT_COVER_HEIGHT_PERCENT;
  // Tall enough for the requested strip AND for two lines of the dub's text
  // sitting on it (bottom margin + two lines + a little air).
  const bottomMargin = (BOTTOM_MARGIN_PERCENT / 100) * h;
  const bandHeight = Math.round(Math.min(h, Math.max((pct / 100) * h, bottomMargin + 2 * em * LINE_HEIGHT_PER_EM + 0.3 * em)));
  return { top: h - bandHeight, height: bandHeight };
}

/** The gap kept between the dub's text and a band it stays clear of, % of the height. */
const CLEAR_GAP_PERCENT = 2;

/**
 * The video's own burned-in subtitles as a rectangle to keep clear of, in
 * pixels, when they sit in the lower half of the picture: a band at the top
 * never meets a dub drawn at the bottom. Pure.
 */
export function sourceBandRect(band: { y: number; h: number } | undefined, height: number): { top: number; height: number } | undefined {
  if (!band || !finite(band.y) || !finite(band.h) || band.h <= 0 || band.y < 0.5 || band.y >= 1) return undefined;
  const h = Math.max(16, Math.round(height));
  const top = Math.min(h - 2, Math.round(band.y * h));
  return { top, height: Math.min(h - top, Math.max(2, Math.round(Math.min(1, band.h) * h))) };
}

/**
 * Lay out burned subtitles for a `width`x`height` frame (display orientation).
 * `sourceBand`: where the video's own subtitles are (RenderFinalVideoInput
 * .sourceSubtitleBand), kept clear of when they are not covered. Pure; see
 * SubtitleStyle for what each field means and its default.
 */
export function computeAssLayout(
  style: SubtitleStyle | undefined,
  width: number,
  height: number,
  opts: { sourceBand?: { y: number; h: number } } = {},
): AssLayout {
  const s = style ?? {};
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const shortSide = Math.min(w, h);
  const { em, fontSize, fontName } = textMetrics(s, w, h);

  const outline = finite(s.outlineWidth) && s.outlineWidth >= 0
    ? (s.outlineWidth / LEGACY_CANVAS) * shortSide
    : em * OUTLINE_PER_EM;

  // Nothing chosen is `auto`; the legacy `alignment` still says top or centre
  // (its `bottom` was only ever the default).
  const chosen = s.position === 'auto' ? undefined : s.position;
  const position = chosen ?? (s.alignment === 'top' ? 'top' : s.alignment === 'center' ? 'center' : 'auto');
  const bottomMargin = (BOTTOM_MARGIN_PERCENT / 100) * h;

  // The band over the source's subtitles: drawn here when solid; a blurred
  // one is the filter graph's, but the text still keeps clear of it (raised)
  // or goes inside it, the same either way.
  const cover = coverBandRect(s, w, h);
  let band: AssLayout['band'];
  if (cover && coverModeOf(s) === 'solid') {
    const opacity = finite(s.coverOpacity) ? Math.min(1, Math.max(0, s.coverOpacity)) : DEFAULT_COVER_OPACITY;
    band = { top: cover.top, height: cover.height, opacity };
  }

  // The video's own subtitles, left in view (not covered): kept clear of.
  const own = cover ? undefined : sourceBandRect(opts.sourceBand, h);
  const above = (r: { top: number }): number => h - r.top + (CLEAR_GAP_PERCENT / 100) * h;

  let alignment = 2;
  let marginV = bottomMargin;
  if (s.subtitlesInBand && cover) {
    // Where the source's own subtitles were: one line centred in the band,
    // or two when the band is tall enough for two (a second line grows
    // upward, as the source's own did).
    const line = em * LINE_HEIGHT_PER_EM;
    const lines = cover.height >= 2 * line ? 2 : 1;
    marginV = h - (cover.top + cover.height) + Math.max(0, (cover.height - lines * line) / 2);
  } else if (position === 'top') {
    alignment = 8;
  } else if (position === 'center') {
    alignment = 5;
    marginV = 0;
  } else if (position === 'raised') {
    // Above the original's strip — and above the band when one is drawn, so
    // the text never straddles its edge, or the video's own subtitles when
    // they were found higher than the strip.
    marginV = Math.max((RAISED_MARGIN_PERCENT / 100) * h, cover ? above(cover) : 0, own ? above(own) : 0);
  } else if (position === 'auto' && own) {
    // Just above the video's own subtitles: on landscape sources their line
    // sits exactly where the bottom strip draws, and every line of a dub
    // overlapped until the user raised them by hand (claude-dubber, 2026-11-25).
    marginV = above(own);
  }

  return {
    width: w,
    height: h,
    fontName,
    fontSize: round1(fontSize),
    primaryColour: hexToAssColor(s.primaryColor || '#FFFFFF'),
    outlineColour: hexToAssColor(s.outlineColor || '#000000'),
    outline: round1(outline),
    shadowOffset: round1(em * SHADOW_OFFSET_PER_EM),
    shadowBlur: round1(em * SHADOW_BLUR_PER_EM),
    alignment,
    marginL: Math.round((SIDE_MARGIN_PERCENT / 100) * w),
    marginR: Math.round((SIDE_MARGIN_PERCENT / 100) * w),
    marginV: Math.round(marginV),
    ...(band ? { band } : {}),
  };
}

const STYLE_FORMAT =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, ' +
  'Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, ' +
  'MarginR, MarginV, Encoding';

/** ASS alpha byte for an opacity 0..1 (ASS alpha is inverted: 00 = opaque). */
function assAlpha(opacity: number): string {
  return Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

/**
 * The whole ASS script. Pure.
 *
 * Three layers, back to front:
 *   0 `Band`   — optional full-width drawing over the bottom strip, for the
 *                whole video (`endMs`).
 *   1 `Shadow` — each line again, fill and outline transparent, only its
 *                shadow drawn and blurred: the soft shadow.
 *   2 `Text`   — each line with a crisp, solid outline and no shadow.
 * A single layer cannot do both: `\blur` softens the outline along with the
 * shadow. Shadow and Text share font, size, outline and margins, so libass lays
 * both copies out identically, and layers never push each other aside.
 */
export function buildAssDocument(cues: SubtitleCue[], layout: AssLayout, endMs: number): string {
  const L = layout;
  const style = (name: string, primary: string, outlineColour: string, back: string, outline: number, shadow: number, alignment: number, mv: number): string =>
    `Style: ${name},${L.fontName},${L.fontSize},${primary},&HFF0000FF,${outlineColour},${back},0,0,0,0,100,100,0,0,1,` +
    `${outline},${shadow},${alignment},${L.marginL},${L.marginR},${mv},1`;
  const transparent = '&HFF000000';
  const shadowColour = `&H${SHADOW_ALPHA.toString(16).toUpperCase()}000000`;

  const lines: string[] = [
    '[Script Info]',
    '; Generated by VideoDubber for a burned-in render.',
    'ScriptType: v4.00+',
    `PlayResX: ${L.width}`,
    `PlayResY: ${L.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    STYLE_FORMAT,
    style('Text', L.primaryColour, L.outlineColour, transparent, L.outline, 0, L.alignment, L.marginV),
    style('Shadow', transparent, transparent, shadowColour, L.outline, L.shadowOffset, L.alignment, L.marginV),
    style('Band', '&H00000000', transparent, transparent, 0, 0, 7, 0),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  if (L.band) {
    const { top, height, opacity } = L.band;
    lines.push(
      `Dialogue: 0,${formatAssTime(0)},${formatAssTime(endMs)},Band,,0,0,0,,` +
        `{\\pos(0,${top})\\1a&H${assAlpha(opacity)}&\\p1}m 0 0 l ${L.width} 0 ${L.width} ${height} 0 ${height}{\\p0}`,
    );
  }
  for (const cue of cues) {
    const text = cueTextToAss(cue.text);
    // Nothing visible once override blocks are gone ("<i></i>"): skip it.
    if (text.replace(/(?<!\\)\{[^}]*\}/g, '').replace(/\\N/g, '').trim() === '') continue;
    const start = formatAssTime(cue.startMs);
    let end = formatAssTime(cue.endMs);
    // Sub-centisecond cues would round to zero length and never show.
    if (end === start) end = formatAssTime(cue.startMs + 10);
    lines.push(`Dialogue: 1,${start},${end},Shadow,,0,0,0,,{\\blur${L.shadowBlur}}${text}`);
    lines.push(`Dialogue: 2,${start},${end},Text,,0,0,0,,${text}`);
  }
  return lines.join('\n') + '\n';
}

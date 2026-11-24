/**
 * What a render draws over the picture besides subtitles: a logo (branding),
 * and a series part's opening and closing (a darker recap, text cards, fades),
 * and cutting a part's window out of the whole video.
 *
 * All pure (the argument builders are unit-tested); render.ts runs them.
 *
 * Recipes from ffmpeg-skill, tested there:
 *   - the logo's size comes from the probed picture, not `scale2ref` (gone in
 *     newer ffmpeg);
 *   - outside its periods the logo is moved off-screen
 *     (`x='if(between(t,a,b),X,-overlay_w)'`) instead of switched with
 *     `enable=`, which mis-times frames at the edges;
 *   - text is drawn by libass (`subtitles=` on a generated .ass), never
 *     `drawtext`, whose font paths break on Windows and which shapes
 *     Vietnamese badly;
 *   - the window is cut with `-ss`/`-t` before `-i`, an accurate seek when the
 *     video is re-encoded (it always is on this path).
 */
import type { RenderCard, RenderEffects, RenderLogo, SubtitleExportMode } from '@videodubber/shared';

import { formatAssTime } from './ass.js';
import { buildRegionFilters, type PixelRegion } from './pictureFilters.js';
import { buildSubtitlesFilter } from './subtitles.js';

/** Seconds with millisecond precision, for ffmpeg. */
function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/** An even pixel count (yuv420p wants even sizes). */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Where and how big the logo is on a WxH picture. Pure. */
export function logoPlacement(
  logo: Pick<RenderLogo, 'corner' | 'widthPct' | 'marginPct'>,
  width: number,
  height: number,
): { widthPx: number; x: string; y: string } {
  const widthPx = even((width * Math.min(50, Math.max(2, logo.widthPct))) / 100);
  const margin = Math.round((Math.min(width, height) * Math.min(20, Math.max(0, logo.marginPct))) / 100);
  const right = logo.corner.endsWith('right');
  const bottom = logo.corner.startsWith('bottom');
  return {
    widthPx,
    x: right ? `main_w-overlay_w-${margin}` : `${margin}`,
    y: bottom ? `main_h-overlay_h-${margin}` : `${margin}`,
  };
}

/**
 * The logo's part of a filtergraph: scale and fade the image at `logoLabel`,
 * then lay it on `baseLabel` as `outLabel`. Periods move it off-screen
 * outside them. Pure.
 */
export function buildLogoFilter(
  logo: RenderLogo,
  width: number,
  height: number,
  labels: { logo: string; base: string; out: string },
): string {
  const { widthPx, x, y } = logoPlacement(logo, width, height);
  const opacity = Math.min(1, Math.max(0.05, logo.opacity)).toFixed(2);
  const periods = (logo.periods ?? []).filter((p) => p.endMs > p.startMs);
  const shown = periods.map((p) => `between(t,${sec(p.startMs)},${sec(p.endMs)})`).join('+');
  // Single quotes keep the commas inside the expressions from splitting the graph.
  const xExpr = logo.periods ? (shown ? `if(gt(${shown},0),${x},-overlay_w-10)` : '-overlay_w-10') : x;
  return (
    `[${labels.logo}]scale=${widthPx}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${opacity}[lgs];` +
    `[${labels.base}][lgs]overlay=x='${xExpr}':y='${y}':eval=frame[${labels.out}]`
  );
}

/** Text for an ASS Dialogue line: braces and line breaks made literal. */
function assText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim();
}

/**
 * The cards of a part (title, "Phần trước", "Còn tiếp") as an ASS script on
 * the video's pixel grid, in the subtitle font. Boxes at half opacity, short
 * fades. Pure.
 */
export function buildCardsAss(cards: readonly RenderCard[], width: number, height: number, fontFamily: string): string {
  const title = Math.round(height * 0.062);
  const label = Math.round(height * 0.036);
  const end = Math.round(height * 0.05);
  const m = Math.round(Math.min(width, height) * 0.04);
  // Above where subtitles sit, so a card never covers a line.
  const endMargin = Math.round(height * 0.2);
  const style = (name: string, size: number, bold: number, align: number, marginV: number): string =>
    `Style: ${name},${fontFamily},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${bold},0,0,0,100,100,0,0,3,${Math.max(4, Math.round(size * 0.35))},0,${align},${m},${m},${marginV},1`;
  const lines = cards
    .filter((c) => c.endMs > c.startMs && c.text.trim())
    .map((c) => {
      const s = c.kind === 'title' ? 'Title' : c.kind === 'label' ? 'Label' : 'End';
      return `Dialogue: 0,${formatAssTime(c.startMs)},${formatAssTime(c.endMs)},${s},,0,0,0,,{\\fad(250,250)}${assText(c.text)}`;
    });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Title', title, -1, 5, m),
    style('Label', label, 0, 7, m),
    style('End', end, -1, 2, endMargin),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
    '',
  ].join('\n');
}

/** Everything {@link buildFilteredRenderArgs} needs, resolved. */
export interface FilteredRenderContext {
  inputVideoPath: string;
  audioPath: string;
  outputPath: string;
  mode: SubtitleExportMode;
  /** The styled ASS to burn (burned-in mode). */
  burnScriptPath?: string;
  /** The subtitle to embed as a soft track (embedded-soft mode). */
  softSubtitlePath?: string;
  fontsDir?: string;
  /** Picture size, for the logo. */
  width: number;
  height: number;
  /** Output length, for the closing fade. */
  durationMs: number;
  logo?: RenderLogo;
  range?: { startMs: number; endMs: number };
  effects?: RenderEffects;
  /** The cards' ASS script (effects.cards), written by the caller. */
  cardsScriptPath?: string;
  /**
   * Parts of the picture to hide (watermarks, the blurred band over the
   * source's subtitles; pictureFilters.ts), in pixels and render time. Hidden
   * FIRST, so the subtitles, cards and logo are drawn on the clean picture.
   */
  regions?: readonly PixelRegion[];
  /**
   * The longest the output may run: the picture's length. Without it a mix
   * that runs long made the video longer than its picture (claude-dubber
   * report, 2026-11-23). A part (`range`) is capped at its window instead.
   */
  maxDurationMs?: number;
  videoCodec: string;
  videoCodecArgs: string[];
  audioArgs: readonly string[];
  metadataArgs: readonly string[];
  platform?: NodeJS.Platform;
}

/** The argv of a render that re-encodes the picture with overlays. Pure. */
export function buildFilteredRenderArgs(ctx: FilteredRenderContext): string[] {
  const args: string[] = ['-y'];
  if (ctx.range) args.push('-ss', sec(ctx.range.startMs), '-t', sec(ctx.range.endMs - ctx.range.startMs));
  args.push('-i', ctx.inputVideoPath, '-i', ctx.audioPath);
  let next = 2;
  const logoIndex = ctx.logo ? next++ : -1;
  if (ctx.logo) args.push('-i', ctx.logo.imagePath);
  const softIndex = ctx.mode === 'embedded-soft' && ctx.softSubtitlePath ? next : -1;
  if (softIndex >= 0) args.push('-i', ctx.softSubtitlePath!);

  const fx = ctx.effects ?? {};
  const picture: string[] = [];
  if (ctx.mode === 'burned-in' && ctx.burnScriptPath) {
    picture.push(buildSubtitlesFilter(ctx.burnScriptPath, undefined, ctx.platform, ctx.fontsDir));
  }
  if (fx.darkenUntilMs && fx.darkenUntilMs > 0) {
    picture.push(`eq=brightness=-0.07:saturation=0.8:enable='lt(t,${sec(fx.darkenUntilMs)})'`);
  }
  if (ctx.cardsScriptPath) picture.push(buildSubtitlesFilter(ctx.cardsScriptPath, undefined, ctx.platform, ctx.fontsDir));

  const graph: string[] = [];
  const hidden = ctx.regions ? buildRegionFilters(ctx.regions, ctx.width, ctx.height, { input: '0:v', output: 'vh' }) : undefined;
  if (hidden) graph.push(hidden);
  graph.push(`[${hidden ? 'vh' : '0:v'}]${picture.length > 0 ? picture.join(',') : 'null'}[v0]`);
  let current = 'v0';
  if (ctx.logo) {
    graph.push(buildLogoFilter(ctx.logo, ctx.width, ctx.height, { logo: `${logoIndex}:v`, base: current, out: 'v1' }));
    current = 'v1';
  }
  const fades: string[] = [];
  if (fx.fadeInMs && fx.fadeInMs > 0) fades.push(`fade=t=in:st=0:d=${sec(fx.fadeInMs)}`);
  if (fx.fadeOutMs && fx.fadeOutMs > 0 && ctx.durationMs > fx.fadeOutMs) {
    fades.push(`fade=t=out:st=${sec(ctx.durationMs - fx.fadeOutMs)}:d=${sec(fx.fadeOutMs)}`);
  }
  if (fades.length > 0) {
    graph.push(`[${current}]${fades.join(',')}[vf]`);
    current = 'vf';
  }
  const audioFades: string[] = [];
  if (fx.fadeInMs && fx.fadeInMs > 0) audioFades.push(`afade=t=in:st=0:d=${sec(fx.fadeInMs)}`);
  if (fx.fadeOutMs && fx.fadeOutMs > 0 && ctx.durationMs > fx.fadeOutMs) {
    audioFades.push(`afade=t=out:st=${sec(ctx.durationMs - fx.fadeOutMs)}:d=${sec(fx.fadeOutMs)}`);
  }
  if (audioFades.length > 0) graph.push(`[1:a]${audioFades.join(',')}[af]`);

  args.push('-filter_complex', graph.join(';'), '-map', `[${current}]`, '-map', audioFades.length > 0 ? '[af]' : '1:a:0');
  if (softIndex >= 0) args.push('-map', `${softIndex}:0`);
  // The window's audio is exactly the part's length; never run past it. A
  // whole video never runs past its picture.
  if (ctx.range) args.push('-t', sec(ctx.range.endMs - ctx.range.startMs));
  else if (ctx.maxDurationMs && ctx.maxDurationMs > 0) args.push('-t', sec(ctx.maxDurationMs));
  args.push('-c:v', ctx.videoCodec, ...ctx.videoCodecArgs, ...ctx.audioArgs);
  if (softIndex >= 0) args.push('-c:s', 'mov_text');
  args.push(...ctx.metadataArgs, ctx.outputPath);
  return args;
}

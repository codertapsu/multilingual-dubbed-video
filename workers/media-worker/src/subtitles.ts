/**
 * Subtitle helpers for the FFmpeg `subtitles=` filter (libass burn-in).
 *
 * The `subtitles=` filter has *two* levels of escaping to worry about:
 *   1. The filtergraph value level: characters like ':' (option separator),
 *      '\' and "'" are special and must be escaped.
 *   2. On Windows, the drive-letter colon (C:\path) collides with the
 *      filtergraph option separator and needs special handling.
 *
 * We build the value that goes after `subtitles=` and rely on the caller to
 * wrap the whole filter in single quotes when assembling the -vf string is NOT
 * done via shell (we always spawn with argv arrays, so there is no shell, but
 * libass still parses the filter value, hence the escaping below).
 *
 * All functions here are pure and unit-tested.
 */

import type { SubtitleStyle } from '@videodubber/shared';

/**
 * Escape a subtitle file path for use inside the `subtitles=<path>` filter
 * value. We do NOT add surrounding quotes; we escape the characters libass /
 * the filtergraph parser treat as special.
 *
 * Rules (matching ffmpeg's filtergraph escaping):
 *   - backslash  \  -> \\        (escape first so we don't double-escape)
 *   - colon      :  -> \:        (filter option separator)
 *   - single '   '  -> \'        (string delimiter)
 *   - left [     [  -> \[
 *   - right ]    ]  -> \]
 *   - comma      ,  -> \,        (filter separator)
 * On Windows we additionally normalize backslashes in the drive path to
 * forward slashes first (libass accepts forward slashes on Windows), which
 * sidesteps the messy `C\:\\...` form.
 */
export function escapeSubtitlePathForFilter(
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let p = inputPath;

  if (platform === 'win32') {
    // Convert C:\Users\foo\sub.srt -> C:/Users/foo/sub.srt
    p = p.replace(/\\/g, '/');
    // The remaining drive colon (C:/...) must be escaped for the filtergraph.
    // We escape ALL colons below, which covers the drive colon too.
  }

  // Order matters: backslash first.
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

/**
 * Convert a #RRGGBB (or #RGB / RRGGBB) hex color to the libass/ASS color
 * format `&HAABBGGRR` (alpha 00 = fully opaque in ASS).
 *
 * ASS stores colors as &HAABBGGRR where AA is the *inverse* alpha (00 opaque,
 * FF transparent). We default to fully opaque (00).
 */
export function hexToAssColor(hex: string, alpha = 0x00): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    // Expand shorthand #rgb -> #rrggbb
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    // Fall back to white on malformed input rather than producing garbage.
    h = 'FFFFFF';
  }
  const rr = h.slice(0, 2);
  const gg = h.slice(2, 4);
  const bb = h.slice(4, 6);
  const aa = clampByte(alpha).toString(16).padStart(2, '0').toUpperCase();
  // ASS order is BGR.
  return `&H${aa}${bb.toUpperCase()}${gg.toUpperCase()}${rr.toUpperCase()}`;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Map our SubtitleStyle.alignment to the ASS numpad alignment code.
 * ASS numpad layout (libass `Alignment`):
 *   7 8 9   (top:    left/center/right)
 *   4 5 6   (center: left/center/right)
 *   1 2 3   (bottom: left/center/right)
 * We use horizontally-centered values:
 *   bottom -> 2, center -> 5, top -> 8
 */
export function alignmentToAssCode(alignment: SubtitleStyle['alignment']): number {
  switch (alignment) {
    case 'top':
      return 8;
    case 'center':
      return 5;
    case 'bottom':
    default:
      return 2;
  }
}

/**
 * Build the `force_style` string for the subtitles filter from a SubtitleStyle.
 * Example: "FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,Outline=2,Alignment=2"
 *
 * Note: force_style values themselves should not contain commas/colons; font
 * names with spaces are fine. We sanitize the font name by stripping commas.
 */
export function buildBurnSubtitlesStyle(style: SubtitleStyle): string {
  const fontName = (style.fontFamily || 'Arial').replace(/,/g, ' ').trim();
  const fontSize = Number.isFinite(style.fontSize) ? Math.round(style.fontSize) : 24;
  const primary = hexToAssColor(style.primaryColor || '#FFFFFF');
  const outlineColor = hexToAssColor(style.outlineColor || '#000000');
  const outlineWidth = Number.isFinite(style.outlineWidth)
    ? Math.max(0, style.outlineWidth)
    : 2;
  const alignment = alignmentToAssCode(style.alignment);

  return [
    `FontName=${fontName}`,
    `FontSize=${fontSize}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outlineColor}`,
    `BorderStyle=1`,
    `Outline=${outlineWidth}`,
    `Alignment=${alignment}`,
  ].join(',');
}

/**
 * Build the full `subtitles=...` filter value (path + optional force_style).
 * Returns just the filter string (no `-vf`); render.ts inserts it.
 */
export function buildSubtitlesFilter(
  subtitlePath: string,
  style?: SubtitleStyle,
  platform: NodeJS.Platform = process.platform,
): string {
  const escaped = escapeSubtitlePathForFilter(subtitlePath, platform);
  let filter = `subtitles=${escaped}`;
  if (style) {
    // force_style is itself passed as a single value; wrap in single quotes so
    // its internal commas are treated as style fields, not filter separators.
    filter += `:force_style='${buildBurnSubtitlesStyle(style)}'`;
  }
  return filter;
}

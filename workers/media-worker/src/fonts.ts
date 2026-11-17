/**
 * The font burned-in subtitles are drawn with.
 *
 * WHY BUNDLE ONE: the burn asked libass for a family by name and took whatever
 * the OS resolved — Arial through DirectWrite on Windows, an unchecked chain on
 * macOS. A family that is missing, or present without the Vietnamese letters,
 * silently becomes a substitute, and stacked diacritics (ễ, ộ, ữ) are where
 * substitutes break. A file we ship renders identically on every machine.
 *
 * Be Vietnam Pro SemiBold: SIL OFL 1.1 (license in assets/licenses/
 * BeVietnamPro-OFL.txt — NOT beside the font: libass tries to load every file
 * in its fonts dir, and the "Error opening memory font 'OFL.txt'" it logged on
 * every burn became the reported reason for any hardware-encoder fallback),
 * designed for Vietnamese (every precomposed letter + the combining tone marks
 * verified in its cmap), 137 KB. SemiBold because a subtitle sits on moving
 * video behind an outline, where Regular strokes thin out.
 * Source: github.com/google/fonts ofl/bevietnampro/BeVietnamPro-SemiBold.ttf
 * (upstream github.com/bettergui/BeVietnamPro @ 804e62d8), git blob
 * b25bad31fe8984d5db6cbce61a23323bbb68bc97,
 * sha256 bd8e27eb02720b9d91e59e4f10a90878643219f25ce6a8d9a4f06a8a88d3bb71.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Family name libass matches (the font's name ID 1). */
export const BUNDLED_FONT_FAMILY = 'Be Vietnam Pro SemiBold';

/** File name inside the fonts directory. */
export const BUNDLED_FONT_FILE = 'BeVietnamPro-SemiBold.ttf';

/**
 * (usWinAscent + usWinDescent) / unitsPerEm of the bundled font = (1261+265)/1000.
 *
 * libass sizes text the VSFilter way: the ASS `Fontsize` is that whole
 * ascent+descent cell, not the em. Be Vietnam Pro reserves room for stacked
 * Vietnamese marks, so its cell is 1.53 em against Arial's 1.12 — the same
 * nominal size drew the letters 27% smaller than ffmpeg's old default. Sizes
 * are therefore specified as an em height and converted with this ratio
 * (a unit test reads the real font file so a swapped font cannot drift).
 */
export const BUNDLED_FONT_CELL_RATIO = 1.526;

/** Cell ratio assumed for any other family: Arial's, the font the old burn used. */
export const DEFAULT_FONT_CELL_RATIO = 1.117;

/**
 * Family used when the bundled file cannot be reached (no fonts dir handed in,
 * e.g. a packaged build whose fonts resource is missing). Asking libass for "Be
 * Vietnam Pro SemiBold" there would get an OS substitute drawn at Be Vietnam
 * Pro's 1.53-em cell size — 37% too large. Arial (Liberation Sans on Linux,
 * metric-compatible) is what the burn used before, sized correctly.
 */
export const FALLBACK_FONT_FAMILY = 'Arial';

/** The directory the bundled font lives in, next to this package (dev / unpacked). */
export function packagedFontsDir(): string | undefined {
  let here: string;
  try {
    // Inside the orchestrator's single-file SEA bundle import.meta.url is empty
    // and fileURLToPath throws: there is no package directory to look in, and
    // the orchestrator must pass the bundled resource path instead.
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  return join(here, '..', 'assets', 'fonts');
}

function isDirectory(dir: string | undefined): dir is string {
  if (!dir) return false;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The fonts directory to hand libass, or undefined (libass then only has the
 * system fonts). First that exists: the caller's `explicit` dir, the
 * VIDEODUBBER_FONTS_DIR env var (set by the packaged app, like
 * VIDEODUBBER_ENGINE_SRC_DIR), then this package's own assets/fonts (dev).
 */
export function resolveFontsDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [explicit, env.VIDEODUBBER_FONTS_DIR?.trim() || undefined, packagedFontsDir()];
  return candidates.find(isDirectory);
}

/** The font a burn will actually ask libass for, and where it comes from. */
export interface BurnFont {
  family: string;
  /** The fonts directory handed to libass, when one was found. */
  fontsDir?: string;
}

/**
 * Pick the burn's font: the caller's family when it set one (system fonts plus
 * `fontsDir`), else the bundled family when its file is in `fontsDir`, else
 * {@link FALLBACK_FONT_FAMILY}. Pure apart from one existsSync.
 */
export function chooseBurnFont(fontsDir: string | undefined, requestedFamily?: string): BurnFont {
  const dir = fontsDir ? { fontsDir } : {};
  if (requestedFamily?.trim()) return { family: requestedFamily.trim(), ...dir };
  if (fontsDir && existsSync(join(fontsDir, BUNDLED_FONT_FILE))) return { family: BUNDLED_FONT_FAMILY, fontsDir };
  return { family: FALLBACK_FONT_FAMILY, ...dir };
}

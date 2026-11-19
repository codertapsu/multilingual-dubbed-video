/**
 * Logo & greeting ("Logo & lời chào"): a brand kit of logos and spoken
 * greetings in Settings, and a project's choice of them. Both are optional and
 * applied only when mixing (the greeting) and rendering (the logo): nothing
 * before them (speech-to-text, translation, voices, timing) changes.
 */

/** Which corner the logo sits in. */
export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** A stretch of the video, in ms. */
export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/** The logo a project draws over its video. */
export interface LogoSettings {
  /** Brand kit asset (`logo_<hex>`); the project keeps its own copy. */
  assetId: string;
  /** Default top right: subtitles sit at the bottom. */
  corner: LogoCorner;
  /** Width as a share of the video's width, in % (default 10). */
  widthPct: number;
  /** Distance from the edges, in % of the shorter side (default 4). */
  marginPct: number;
  /** 0..1 (default 0.85). */
  opacity: number;
  /** When it shows: the whole video, chosen periods, or S seconds every M minutes. */
  show: 'always' | 'periods' | 'interval';
  periods?: TimeSpan[];
  showSec?: number;
  everyMin?: number;
}

/** The spoken greeting a project plays ("Chào mừng các bạn đến với kênh…"). */
export interface GreetingSettings {
  /** Brand kit asset (`greeting_<hex>`); the project keeps its own copy. */
  assetId: string;
  /** In the first quiet moment of the opening (never before the video starts). */
  atStart: boolean;
  /** How far into the video the opening one may come, in s (default 60). */
  startWindowSec: number;
  /** During the video: off, auto (about one per 10 minutes, at most 6), or how many. */
  repeat: 'off' | 'auto' | number;
  /** Added to the asset's level, in dB (default 0: it was matched to dubbed speech). */
  gainDb: number;
}

export interface BrandingSettings {
  logo?: LogoSettings;
  greeting?: GreetingSettings;
}

/** A brand kit item (GET /branding). */
export interface BrandAsset {
  id: string;
  kind: 'logo' | 'greeting';
  name: string;
  /** The file: a PNG for a logo, a 48 kHz stereo WAV for a greeting. */
  path: string;
  createdAt: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** A greeting spoken by one of the app's voices: what it says and with which voice. */
  text?: string;
  voiceId?: string;
}

/** Where a greeting plays in a project (`audio/greeting_plan.json`). */
export interface GreetingPlacement {
  atMs: number;
  kind: 'opening' | 'repeat';
  /** Placed or moved by the user: kept as it is when the plan is made again. */
  manual?: boolean;
}

export interface GreetingPlan {
  assetId: string;
  durationMs: number;
  placements: GreetingPlacement[];
  /** Repeats asked for (after "auto" is worked out), and how many quiet moments fitted. */
  requested: number;
  found: number;
  /** The opening greeting had no quiet moment in its window, so it does not play. */
  openingSkipped?: boolean;
}

/**
 * When the logo shows, as windows of the video (ms); undefined = the whole
 * video. "Every M minutes for S seconds" starts at 0. Pure.
 */
export function logoPeriods(logo: Pick<LogoSettings, 'show' | 'periods' | 'showSec' | 'everyMin'>, durationMs: number): TimeSpan[] | undefined {
  if (logo.show === 'always') return undefined;
  if (logo.show === 'periods') {
    return (logo.periods ?? [])
      .map((p) => ({ startMs: Math.max(0, p.startMs), endMs: Math.min(durationMs, p.endMs) }))
      .filter((p) => p.endMs > p.startMs)
      .sort((a, b) => a.startMs - b.startMs);
  }
  const every = Math.max(1, logo.everyMin ?? 5) * 60_000;
  const show = Math.max(1, logo.showSec ?? 10) * 1000;
  const out: TimeSpan[] = [];
  for (let t = 0; t < durationMs; t += every) out.push({ startMs: t, endMs: Math.min(durationMs, t + show) });
  return out;
}

/** Defaults for a new logo choice. */
export const DEFAULT_LOGO: Omit<LogoSettings, 'assetId'> = {
  corner: 'top-right',
  widthPct: 10,
  marginPct: 4,
  opacity: 0.85,
  show: 'always',
};

/** Defaults for a new greeting choice. */
export const DEFAULT_GREETING: Omit<GreetingSettings, 'assetId'> = {
  atStart: true,
  startWindowSec: 60,
  repeat: 'off',
  gainDb: 0,
};

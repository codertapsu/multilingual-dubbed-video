/**
 * A project's branding settings from outside (the app, the plugin), kept to
 * what makes sense: known corners and modes, numbers in range, at most a few
 * hundred periods. Anything else is dropped, never stored. Pure.
 */
import {
  DEFAULT_GREETING,
  DEFAULT_LOGO,
  type BrandingSettings,
  type GreetingSettings,
  type LogoCorner,
  type LogoSettings,
  type TimeSpan,
} from '@videodubber/shared';

const CORNERS: readonly LogoCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function spans(v: unknown): TimeSpan[] {
  if (!Array.isArray(v)) return [];
  return v
    .flatMap((p: unknown) => {
      const s = Number((p as TimeSpan)?.startMs);
      const e = Number((p as TimeSpan)?.endMs);
      return Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 ? [{ startMs: Math.round(s), endMs: Math.round(e) }] : [];
    })
    .slice(0, 300);
}

export function sanitizeLogo(raw: unknown): LogoSettings | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r['assetId'] !== 'string' || !/^logo_[a-f0-9]{6,}$/.test(r['assetId'])) return undefined;
  const show = r['show'] === 'periods' || r['show'] === 'interval' ? r['show'] : 'always';
  return {
    assetId: r['assetId'],
    corner: CORNERS.includes(r['corner'] as LogoCorner) ? (r['corner'] as LogoCorner) : DEFAULT_LOGO.corner,
    widthPct: num(r['widthPct'], 2, 50, DEFAULT_LOGO.widthPct),
    marginPct: num(r['marginPct'], 0, 20, DEFAULT_LOGO.marginPct),
    opacity: num(r['opacity'], 0.05, 1, DEFAULT_LOGO.opacity),
    show,
    ...(show === 'periods' ? { periods: spans(r['periods']) } : {}),
    ...(show === 'interval'
      ? { showSec: Math.round(num(r['showSec'], 1, 600, 10)), everyMin: Math.round(num(r['everyMin'], 1, 120, 5)) }
      : {}),
  };
}

export function sanitizeGreeting(raw: unknown): GreetingSettings | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r['assetId'] !== 'string' || !/^greeting_[a-f0-9]{6,}$/.test(r['assetId'])) return undefined;
  const repeat = r['repeat'] === 'auto' || r['repeat'] === 'off' ? r['repeat'] : Math.round(num(r['repeat'], 0, 20, 0));
  return {
    assetId: r['assetId'],
    atStart: typeof r['atStart'] === 'boolean' ? r['atStart'] : DEFAULT_GREETING.atStart,
    startWindowSec: Math.round(num(r['startWindowSec'], 5, 600, DEFAULT_GREETING.startWindowSec)),
    repeat: repeat === 0 ? 'off' : repeat,
    gainDb: num(r['gainDb'], -20, 20, DEFAULT_GREETING.gainDb),
  };
}

/** Undefined (no branding) when neither a logo nor a greeting is chosen. */
export function sanitizeBranding(raw: unknown): BrandingSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const logo = sanitizeLogo(r['logo']);
  const greeting = sanitizeGreeting(r['greeting']);
  return logo || greeting ? { ...(logo ? { logo } : {}), ...(greeting ? { greeting } : {}) } : undefined;
}

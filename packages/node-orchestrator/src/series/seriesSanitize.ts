import type { SeriesSettings } from '@videodubber/shared';

/** Series settings from outside (New project, the plugin), kept in range. Pure. */
export function sanitizeSeriesSettings(raw: Partial<SeriesSettings> | undefined, fallbackAi: string): SeriesSettings {
  const num = (v: unknown, lo: number, hi: number, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const minMinutes = Math.round(num(raw?.minMinutes, 5, 120, 15));
  const maxMinutes = Math.round(num(raw?.maxMinutes, minMinutes, 180, Math.max(minMinutes, 20)));
  return {
    minMinutes,
    maxMinutes,
    aiProviderId: typeof raw?.aiProviderId === 'string' && raw.aiProviderId.trim() ? raw.aiProviderId.trim() : fallbackAi,
    recapSec: num(raw?.recapSec, 0, 8, 4),
    autoStart: raw?.autoStart === true,
  };
}

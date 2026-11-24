import { partNameTemplateProblem, type SeriesSettings } from '@videodubber/shared';

/** Series settings from outside (New project, the plugin), kept in range. Pure. */
export function sanitizeSeriesSettings(raw: Partial<SeriesSettings> | undefined, fallbackAi: string): SeriesSettings {
  const num = (v: unknown, lo: number, hi: number, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const minMinutes = Math.round(num(raw?.minMinutes, 5, 120, 15));
  const maxMinutes = Math.round(num(raw?.maxMinutes, minMinutes, 180, Math.max(minMinutes, 20)));
  // The choices added in 0.18.0 are all optional: absent, a series is named
  // and numbered as before (a template that cannot be used is dropped, so the
  // parts keep the default names rather than all sharing one).
  const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const whole = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = Number(v);
    return v !== undefined && v !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
  };
  const nameTemplate =
    typeof raw?.nameTemplate === 'string' && !partNameTemplateProblem(raw.nameTemplate) ? raw.nameTemplate.trim() : undefined;
  const seriesName = text(raw?.seriesName, 200);
  const partNumberOffset = whole(raw?.partNumberOffset, 1, 100_000);
  const totalParts = whole(raw?.totalParts, 1, 100_000);
  const continues = text(raw?.continues, 200);
  return {
    minMinutes,
    maxMinutes,
    aiProviderId: typeof raw?.aiProviderId === 'string' && raw.aiProviderId.trim() ? raw.aiProviderId.trim() : fallbackAi,
    recapSec: num(raw?.recapSec, 0, 8, 4),
    autoStart: raw?.autoStart === true,
    ...(nameTemplate ? { nameTemplate } : {}),
    ...(seriesName ? { seriesName } : {}),
    ...(partNumberOffset ? { partNumberOffset } : {}),
    ...(totalParts ? { totalParts } : {}),
    ...(continues ? { continues } : {}),
  };
}

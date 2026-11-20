/**
 * Which AI chooses a series' cuts when a form opens: the one used last time,
 * when it is still set up; else Claude through Mother Claude; else the first
 * one set up (docs/plans/batch-downloads-branding-series.md, 3.1). The
 * plugin's own default, Claude through Mother Claude, is the server's.
 * Remembered on this computer only (localStorage): a choice, not a setting.
 */
import type { SeriesAiOption } from '@videodubber/shared';

export const SERIES_AI_KEY = 'vd.series-ai';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // private mode, or a webview without storage
  }
}

export function defaultSeriesAi(options: readonly SeriesAiOption[]): string {
  const ready = options.filter((o) => o.ready);
  const last = storage()?.getItem(SERIES_AI_KEY) ?? null;
  return (ready.find((o) => o.id === last) ?? ready.find((o) => o.viaMotherClaude) ?? ready[0])?.id ?? '';
}

/** Keep the AI a series was just made with, for the next one. */
export function rememberSeriesAi(id: string): void {
  try {
    if (id) storage()?.setItem(SERIES_AI_KEY, id);
  } catch {
    /* not kept: the next form starts from the usual default */
  }
}

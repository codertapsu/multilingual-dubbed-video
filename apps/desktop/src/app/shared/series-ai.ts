/**
 * Which AI chooses a series' cuts when a form opens: the one the user chose
 * last time, when it is still set up; else the built-in Gemma chat model on
 * this computer; else none, and the form asks (a cloud AI is used only when
 * the user chooses it: the user's rule, 2026-11-25). Remembered on this
 * computer only (localStorage): a choice, not a setting.
 */
import { defaultSeriesAiId, type SeriesAiOption } from '@videodubber/shared';

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
  return ready.find((o) => o.id === last)?.id ?? defaultSeriesAiId(ready) ?? '';
}

/** Keep the AI a series was just made with, for the next one. */
export function rememberSeriesAi(id: string): void {
  try {
    if (id) storage()?.setItem(SERIES_AI_KEY, id);
  } catch {
    /* not kept: the next form starts from the usual default */
  }
}

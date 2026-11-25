/**
 * create_project and join_videos made from a preset (`presetId`), and the
 * series they ask for. Pure, except {@link findPreset}.
 *
 * WHY (claude-dubber, 2026-11-25): every job the agent makes for the user is a
 * create_project or a join_videos of the same preset, and it retyped the
 * preset's languages, engines, voices and series choices into each call; one
 * forgotten field dubbed a 30-hour series with the defaults. With `presetId`
 * the app lays the call's own choices over the preset (POST /projects), and a
 * long video takes the preset's series block by itself.
 */
import { isBuiltinPresetId, type DubPreset } from '@videodubber/shared';

import { VideoDubberApiError, type VideoDubberApi } from './api.js';

/** The series options create_project and join_videos take. */
export interface SeriesArgs {
  minMinutes?: number;
  maxMinutes?: number;
  ai?: string;
  recapSec?: number;
  autoStart?: boolean;
  nameTemplate?: string;
  perFile?: boolean;
}

/** The defaults a series asked for without a preset gets (create_project's documented ones). */
export const SERIES_ARG_DEFAULTS = { minMinutes: 15, maxMinutes: 20, recapSec: 4, autoStart: true } as const;

/**
 * The series block of a create_project / join_videos call, as POST /projects
 * takes it. With a preset, only what the call gives: the app lays it over the
 * preset's series block. Without one, the documented defaults fill the rest
 * and `defaultAi` is the AI that plans the cuts unless the call names one.
 */
export function seriesRequest(series: SeriesArgs | undefined, opts: { preset: boolean; defaultAi?: string }): Record<string, unknown> | undefined {
  if (!series) return undefined;
  const ai = series.ai?.trim() || (opts.preset ? undefined : opts.defaultAi);
  const nameTemplate = series.nameTemplate?.trim();
  if (opts.preset) {
    return {
      ...(series.minMinutes !== undefined ? { minMinutes: series.minMinutes } : {}),
      ...(series.maxMinutes !== undefined ? { maxMinutes: series.maxMinutes } : {}),
      ...(ai ? { aiProviderId: ai } : {}),
      ...(series.recapSec !== undefined ? { recapSec: series.recapSec } : {}),
      ...(series.autoStart !== undefined ? { autoStart: series.autoStart } : {}),
      ...(nameTemplate ? { nameTemplate } : {}),
      ...(series.perFile ? { perFile: true } : {}),
    };
  }
  const minMinutes = series.minMinutes ?? SERIES_ARG_DEFAULTS.minMinutes;
  return {
    minMinutes,
    maxMinutes: Math.max(minMinutes, series.maxMinutes ?? SERIES_ARG_DEFAULTS.maxMinutes),
    ...(ai ? { aiProviderId: ai } : {}),
    recapSec: series.recapSec ?? SERIES_ARG_DEFAULTS.recapSec,
    autoStart: series.autoStart ?? SERIES_ARG_DEFAULTS.autoStart,
    ...(nameTemplate ? { nameTemplate } : {}),
    ...(series.perFile ? { perFile: true } : {}),
  };
}

/**
 * Why a call cannot be made without a dub language, or undefined when it has
 * one. A user's preset carries its languages; a built-in one (builtin:…) works
 * for any language, so the call names them.
 */
export function missingLanguage(targetLanguage: string | undefined, presetId: string | undefined): string | undefined {
  if (targetLanguage?.trim()) return undefined;
  if (presetId?.trim() && !isBuiltinPresetId(presetId)) return undefined;
  return presetId?.trim()
    ? `Nothing was made: the built-in preset "${presetId.trim()}" works for any language, so say which one to dub into (targetLanguage, e.g. "vi-VN") and which the video speaks (sourceLanguage).`
    : 'Nothing was made: say which language to dub into (targetLanguage, e.g. "vi-VN"), or give a presetId from list_presets.';
}

/** A built-in preset in list_presets: its id, name and what it gains and costs. */
export function describeBuiltinPreset(p: DubPreset): string {
  return `- ${p.id} "${p.name}": ${(p.builtin?.tradeoffs ?? []).map((t) => t.text.replace(/\.$/, '')).join('; ')}.`;
}

/** A preset's series block in words, for list_presets: "series of 30-40 min parts for videos over 60 min, AI anthropic, …". */
export function describePresetSeries(series: NonNullable<DubPreset['series']>): string {
  const min = series.minMinutes ?? SERIES_ARG_DEFAULTS.minMinutes;
  const max = series.maxMinutes ?? SERIES_ARG_DEFAULTS.maxMinutes;
  const longer = series.longerThanMinutes ?? max * 1.5;
  return [
    `series of ${min}-${max} min parts for videos over ${Math.round(longer)} min`,
    ...(series.aiProviderId ? [`AI ${series.aiProviderId}`] : []),
    ...(series.nameTemplate ? [`parts named "${series.nameTemplate}"`] : []),
    ...(series.recapSec !== undefined ? [`${series.recapSec} s recap`] : []),
    series.autoStart === false ? 'stops at review of the cuts' : 'parts start by themselves when the analysis is clean',
  ].join(', ');
}

/**
 * The preset with this id: the user's, or a built-in one worked out for the
 * call's languages. Throws a readable error when there is none.
 */
export async function findPreset(
  api: VideoDubberApi,
  presetId: string,
  signal: AbortSignal,
  languages: { sourceLanguage?: string; targetLanguage?: string } = {},
): Promise<DubPreset> {
  if (isBuiltinPresetId(presetId)) {
    const q = new URLSearchParams({ sourceLanguage: languages.sourceLanguage ?? '', targetLanguage: languages.targetLanguage ?? '' });
    const builtins = await api.get<DubPreset[]>(`/presets/builtin?${q}`, { signal });
    const found = builtins.find((p) => p.id === presetId.trim());
    if (found) return found;
    throw new VideoDubberApiError(
      404,
      'INVALID_EDIT',
      `Nothing was made: there is no built-in preset "${presetId}".`,
      `The built-in presets are ${builtins.map((p) => p.id).join(', ')}.`,
    );
  }
  const list = await api.get<DubPreset[]>('/presets', { signal });
  const preset = list.find((p) => p.id === presetId.trim());
  if (!preset) {
    throw new VideoDubberApiError(
      404,
      'INVALID_EDIT',
      `Nothing was made: there is no preset "${presetId}".`,
      list.length === 0 ? 'The user has no presets yet: give targetLanguage and settings instead.' : "list_presets shows the user's presets.",
    );
  }
  return preset;
}

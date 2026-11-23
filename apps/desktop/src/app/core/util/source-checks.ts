import type { MediaInfo } from '../models';

/**
 * The source checks as the screens show them (docs/plans/
 * production-requests-2026-11-23.md 1.1 and 1.6): the audio's drift against
 * the picture, and whether the transcript spot check runs. Mirrors the
 * runner's own rules (pipeline/spotCheck.ts, pipeline/audioDrift.ts), so a
 * checkbox never says something the dub will not do.
 */

type AudioDrift = NonNullable<MediaInfo['audioDrift']>;

/** Languages the spot check compares: it counts Chinese, Japanese and Korean characters. */
const CJK_LANGUAGES: ReadonlySet<string> = new Set(['zh', 'ja', 'ko', 'yue', 'cmn']);

/** Without the setting, the spot check runs on videos longer than this. */
export const SPOT_CHECK_DEFAULT_FROM_MS = 2 * 3_600_000;

/** From this much longer than the picture, the drift is a warning (the runner's AUDIO_DRIFT_WARN_MS). */
const DRIFT_WARN_MS = 500;

/** Whether the spot check can do anything for this spoken language. Pure. */
export function spotCheckApplies(sourceLanguage: string | undefined): boolean {
  return !!sourceLanguage && CJK_LANGUAGES.has(sourceLanguage.split('-')[0]!.toLowerCase());
}

/** Whether the spot check runs: the project's setting, else on above 2 hours. Pure. */
export function spotCheckOn(setting: boolean | undefined, durationMs: number | undefined): boolean {
  return setting ?? (durationMs ?? 0) > SPOT_CHECK_DEFAULT_FROM_MS;
}

/** The measured drift as one line of the project's info: an i18n key, its params, and whether it was re-timed. */
export interface AudioDriftView {
  key: string;
  params: { seconds: string };
  retimed: boolean;
}

/** The project's measured drift for the screens; undefined before the audio was extracted. Pure. */
export function audioDriftView(drift: AudioDrift | undefined): AudioDriftView | undefined {
  if (!drift) return undefined;
  const sec = (ms: number, digits: number): string => (Math.abs(ms) / 1000).toFixed(digits);
  if (drift.driftMs >= DRIFT_WARN_MS) {
    return { key: 'source-checks.drift-longer', params: { seconds: sec(drift.driftMs, 1) }, retimed: true };
  }
  if (drift.driftMs <= -DRIFT_WARN_MS) {
    return { key: 'source-checks.drift-shorter', params: { seconds: sec(drift.driftMs, 1) }, retimed: false };
  }
  return { key: 'source-checks.drift-match', params: { seconds: `${drift.driftMs >= 0 ? '+' : '-'}${sec(drift.driftMs, 2)}` }, retimed: false };
}

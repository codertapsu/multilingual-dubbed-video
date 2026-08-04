/**
 * UI formatting helpers. Pure functions, no Angular deps so they're trivially
 * testable and reusable across components.
 */
import type {
  PipelineStepId,
  ProcessingMode,
  SubtitleExportMode,
} from '../models';

/** Format a duration in ms as `mm:ss.mmm` (or `hh:mm:ss.mmm` past an hour). */
export function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00.000';
  const totalMs = Math.round(ms);
  const millis = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const pad3 = (n: number) => n.toString().padStart(3, '0');

  const tail = `${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}`;
  return hours > 0 ? `${pad2(hours)}:${tail}` : tail;
}

/** Format a coarse duration in ms as a friendly `Hh Mm Ss` / `Mm Ss` string. */
export function formatDurationCoarse(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/** Format a byte count as a human-readable size. */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Friendly label for each subtitle export mode (used in radios/selects). */
export const SUBTITLE_EXPORT_MODE_LABELS: Record<SubtitleExportMode, string> = {
  none: 'opt.subtitle.none',
  'srt-file': 'opt.subtitle.srt-file',
  'vtt-file': 'opt.subtitle.vtt-file',
  'embedded-soft': 'opt.subtitle.embedded-soft',
  'burned-in': 'opt.subtitle.burned-in',
};

/** Short helper text shown under each subtitle mode option. */
export const SUBTITLE_EXPORT_MODE_HINTS: Record<SubtitleExportMode, string> = {
  none: 'opt.subtitle-hint.none',
  'srt-file': 'opt.subtitle-hint.srt-file',
  'vtt-file': 'opt.subtitle-hint.vtt-file',
  'embedded-soft': 'opt.subtitle-hint.embedded-soft',
  'burned-in': 'opt.subtitle-hint.burned-in',
};

export const ALL_SUBTITLE_EXPORT_MODES: readonly SubtitleExportMode[] = [
  'none',
  'srt-file',
  'vtt-file',
  'embedded-soft',
  'burned-in',
] as const;

/** Friendly label for processing modes. */
export const PROCESSING_MODE_LABELS: Record<ProcessingMode, string> = {
  local: 'opt.processing.local',
  'cloud-enhanced': 'opt.processing.cloud-enhanced',
};

/**
 * TRANSLATION KEYS, not display text — every consumer must pipe them through
 * `| translate`. They used to be English literals, which meant the pipeline
 * step names, subtitle modes and processing modes stayed English no matter what
 * language the user picked, and check-i18n could not see the problem because
 * nothing here looks like a translate call.
 */
export const PIPELINE_STEP_LABELS: Record<PipelineStepId, string> = {
  'probe-video': 'opt.step.probe-video',
  'extract-audio': 'opt.step.extract-audio',
  stt: 'opt.step.stt',
  translation: 'opt.step.translation',
  refine: 'opt.step.refine',
  tts: 'opt.step.tts',
  alignment: 'opt.step.alignment',
  'audio-mix': 'opt.step.audio-mix',
  render: 'opt.step.render',
};

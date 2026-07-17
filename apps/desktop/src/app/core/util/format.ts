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
  none: 'No subtitles',
  'srt-file': 'Sidecar .srt file',
  'vtt-file': 'Sidecar .vtt file',
  'embedded-soft': 'Embedded soft subtitles (toggleable)',
  'burned-in': 'Burned-in (always visible)',
};

/** Short helper text shown under each subtitle mode option. */
export const SUBTITLE_EXPORT_MODE_HINTS: Record<SubtitleExportMode, string> = {
  none: 'Audio dub only, no caption file.',
  'srt-file': 'A separate translated.srt next to the video.',
  'vtt-file': 'A separate translated.vtt (web) next to the video.',
  'embedded-soft': 'Soft subtitle track muxed into the container.',
  'burned-in': 'Rendered permanently into the video pixels.',
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
  local: 'Local (offline)',
  'cloud-enhanced': 'Cloud-enhanced',
};

/** Human labels for the 9 pipeline steps (mirrors PIPELINE_STEP_DEFS). */
export const PIPELINE_STEP_LABELS: Record<PipelineStepId, string> = {
  'probe-video': 'Probe video',
  'extract-audio': 'Extract audio',
  stt: 'Transcribe (STT)',
  translation: 'Translate',
  refine: 'Review & refine',
  tts: 'Synthesize speech (TTS)',
  alignment: 'Align timing',
  'audio-mix': 'Mix audio',
  render: 'Render final video',
};

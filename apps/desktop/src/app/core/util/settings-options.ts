/**
 * Display metadata + option lists for the editable project settings shown in the
 * editor's "Project settings / re-dub" panel. Mirrors the labels the new-project
 * wizard uses (kept in sync by hand), plus the mapping from a changed setting to
 * the earliest pipeline stage that must re-run — so the editor can recommend the
 * right "Re-dub from …" stage.
 */
import type {
  OriginalAudioMode,
  PipelineStepId,
  ProjectSettings,
  RenderQuality,
  TimeStretchEngine,
} from '../models';

export const ORIGINAL_AUDIO_MODE_LABELS: Record<OriginalAudioMode, string> = {
  keep: 'Keep in background (ducked under the dub)',
  'replace-vocals': 'Replace voices, keep music & effects',
  remove: 'Remove original audio completely',
};

export const RENDER_QUALITY_LABELS: Record<RenderQuality, string> = {
  quality: 'Best quality (software H.264)',
  fast: 'Fast (hardware encode)',
};

export const TIME_STRETCH_ENGINE_LABELS: Record<TimeStretchEngine, string> = {
  'ffmpeg-atempo': 'ffmpeg atempo (default)',
  rubberband: 'Rubber Band (higher quality)',
  auto: 'Auto (best available)',
};

/** Ducking presets (mirrors the wizard's `duckingOptions`). */
export const DUCKING_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: -6, label: 'Subtle (−6 dB)' },
  { value: -12, label: 'Standard (−12 dB)' },
  { value: -18, label: 'Strong (−18 dB)' },
  { value: -24, label: 'Very strong (−24 dB)' },
];

/** Max speech-speed presets (mirrors the wizard's `speedOptions`). */
export const SPEED_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1.3, label: '1.3× — most natural' },
  { value: 1.6, label: '1.6× — balanced' },
  { value: 1.8, label: '1.8× — tighter fit' },
  { value: 2.0, label: '2.0× — fit everything' },
];

/**
 * Map a TTS provider id to the `engine` param of GET /setup/voices so the editor
 * can list that engine's installed voices. Cloud / unknown providers return null
 * (no installed-voice list — the project's default voice is used).
 */
export function ttsEngineParam(
  providerId: string | undefined,
): 'piper' | 'neural-v2' | 'neural-v3' | 'omnivoice' | null {
  switch (providerId) {
    case 'piper-local':
      return 'piper';
    case 'omnivoice':
      return 'omnivoice';
    case 'neural-tts':
      return 'neural-v3';
    case 'neural-tts-v2':
      return 'neural-v2';
    default:
      return null;
  }
}

/**
 * The earliest pipeline stage that must re-run when a given setting changes.
 * Settings not listed don't by themselves require a re-dub (e.g. processingMode).
 */
export const SETTING_AFFECTS_STEP: Partial<Record<keyof ProjectSettings, PipelineStepId>> = {
  sourceLanguage: 'stt',
  sttProviderId: 'stt',
  sttModel: 'stt',
  targetLanguage: 'translation',
  translationProviderId: 'translation',
  autoFitOverflow: 'translation',
  ttsProviderId: 'tts',
  ttsVoiceId: 'tts',
  maxSpeedRatio: 'alignment',
  allowedOverflowMs: 'alignment',
  timeStretchEngine: 'alignment',
  forcedAlignment: 'alignment',
  includeOriginalBackgroundAudio: 'audio-mix',
  duckOriginalAudio: 'audio-mix',
  duckingLevelDb: 'audio-mix',
  originalAudioMode: 'audio-mix',
  ttsGainDb: 'audio-mix',
  renderQuality: 'render',
  subtitleExportMode: 'render',
};

/** The user-facing re-dub stages, earliest → latest (subset of pipeline steps). */
export const REDUB_STAGES: readonly PipelineStepId[] = [
  'stt',
  'translation',
  'tts',
  'alignment',
  'audio-mix',
  'render',
];

/**
 * Given the set of changed setting keys, the earliest stage that must re-run
 * (or null when nothing relevant changed). Used to recommend a "Re-dub from …".
 */
export function earliestStepForChanges(changedKeys: readonly (keyof ProjectSettings)[]): PipelineStepId | null {
  let best: number | null = null;
  for (const key of changedKeys) {
    const step = SETTING_AFFECTS_STEP[key];
    if (!step) continue;
    const idx = REDUB_STAGES.indexOf(step);
    if (idx >= 0 && (best === null || idx < best)) best = idx;
  }
  return best === null ? null : REDUB_STAGES[best];
}

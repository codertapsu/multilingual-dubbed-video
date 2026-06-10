/**
 * Core domain types: language codes, project settings, projects, transcripts,
 * TTS/alignment segments, and subtitle styling.
 */

import type { MediaInfo } from './media.js';

/**
 * A BCP-47-ish language code such as `"en"`, `"en-US"`, or `"vi-VN"`.
 *
 * Always normalize with `normalizeLanguageCode` before persisting or comparing.
 */
export type LanguageCode = string;

/** How (if at all) subtitles are emitted in the final render. */
export type SubtitleExportMode =
  | 'none'
  | 'srt-file'
  | 'vtt-file'
  | 'embedded-soft'
  | 'burned-in';

/** Whether processing stays fully local or may use cloud providers. */
export type ProcessingMode = 'local' | 'cloud-enhanced';

/** Identifier for each ordered step of the dubbing pipeline. */
export type PipelineStepId =
  | 'probe-video'
  | 'extract-audio'
  | 'stt'
  | 'translation'
  | 'tts'
  | 'alignment'
  | 'audio-mix'
  | 'render';

/** Visual styling for burned-in subtitles. */
export interface SubtitleStyle {
  /** Font family name. */
  fontFamily: string;
  /** Font size in points. */
  fontSize: number;
  /** Primary text color (e.g. "#FFFFFF"). */
  primaryColor: string;
  /** Outline/border color (e.g. "#000000"). */
  outlineColor: string;
  /** Outline width in pixels. */
  outlineWidth: number;
  /** Vertical placement of the subtitle block. */
  alignment: 'bottom' | 'top' | 'center';
}

/** All user-configurable settings for a dubbing project. */
export interface ProjectSettings {
  /** Source (spoken) language of the input video. */
  sourceLanguage: LanguageCode;
  /** Target (dubbed) language. */
  targetLanguage: LanguageCode;
  /** How subtitles are exported in the final render. */
  subtitleExportMode: SubtitleExportMode;
  /** Local-only vs cloud-enhanced processing. */
  processingMode: ProcessingMode;
  /** Selected speech-to-text provider id. */
  sttProviderId: string;
  /** Selected translation provider id. */
  translationProviderId: string;
  /** Selected text-to-speech provider id. */
  ttsProviderId: string;
  /** Optional explicit TTS voice id. */
  ttsVoiceId?: string;
  /** Optional STT model override (e.g. "small", "medium"). */
  sttModel?: string;
  /** Keep the original background audio underneath the dub. */
  includeOriginalBackgroundAudio: boolean;
  /** Duck (lower) the original audio while the dub plays. */
  duckOriginalAudio: boolean;
  /** Ducking level in decibels (negative = quieter). */
  duckingLevelDb: number;
  /** Gain applied to the synthesized TTS track in decibels. */
  ttsGainDb: number;
  /** Maximum allowed time-stretch ratio for fitting TTS to a window. */
  maxSpeedRatio: number;
  /** Allowed overflow past a segment window before it is flagged, in ms. */
  allowedOverflowMs: number;
  /** Optional style for burned-in subtitles. */
  burnSubtitleStyle?: SubtitleStyle;
}

/** Lifecycle status of a project. */
export type ProjectStatus = 'created' | 'running' | 'paused' | 'failed' | 'completed';

/** A dubbing project: input, workspace, settings, and current status. */
export interface Project {
  /** Unique project id. */
  id: string;
  /** Human-friendly project name. */
  name: string;
  /** Absolute path to the input video file. */
  inputVideoPath: string;
  /** Absolute path to the per-project workspace directory. */
  workspaceDir: string;
  /** Absolute path to the directory that receives final outputs. */
  outputDir: string;
  /** Project settings. */
  settings: ProjectSettings;
  /** Current lifecycle status. */
  status: ProjectStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
  /** Cached media probe result, if available. */
  mediaInfo?: MediaInfo;
}

/** A single word with timing inside a transcript segment. */
export interface TranscriptWord {
  /** The word text (verbatim). */
  word: string;
  /** Word start time in integer milliseconds. */
  startMs: number;
  /** Word end time in integer milliseconds. */
  endMs: number;
  /** Optional confidence in the range 0..1. */
  confidence?: number;
}

/** A transcribed (and optionally translated) caption segment. */
export interface TranscriptSegment {
  /** Stable id, zero-padded e.g. "seg_0001". */
  id: string;
  /** Ordinal index of the segment (0-based). */
  index: number;
  /** Segment start time in integer milliseconds. */
  startMs: number;
  /** Segment end time in integer milliseconds. */
  endMs: number;
  /** Original transcribed text. */
  sourceText: string;
  /** Translated text, when translation has run. */
  translatedText?: string;
  /** Optional diarization speaker id. */
  speakerId?: string;
  /** Optional segment-level confidence in 0..1. */
  confidence?: number;
  /** Optional per-word timings. */
  words?: TranscriptWord[];
}

/** A synthesized speech clip for a single segment. */
export interface TtsSegment {
  /** Id of the source transcript segment. */
  segmentId: string;
  /** The text that was synthesized. */
  text: string;
  /** Absolute path to the generated WAV file. */
  audioPath: string;
  /** Measured duration of the generated audio in integer milliseconds. */
  durationMs: number;
  /** Intended placement start in the final timeline, in ms. */
  startMs: number;
  /** Intended placement end in the final timeline, in ms. */
  endMs: number;
  /** Speed ratio applied during synthesis, if any. */
  speedRatio?: number;
}

/** Outcome classification after fitting a TTS clip into its window. */
export type AlignmentStatus = 'ok' | 'needs-review' | 'timing-conflict';

/** A TTS clip placed onto the final timeline with fit metadata. */
export interface AlignedSegment {
  /** Id of the source transcript segment. */
  segmentId: string;
  /** Placement start in the final timeline, in ms. */
  startMs: number;
  /** Placement end in the final timeline, in ms. */
  endMs: number;
  /** Absolute path to the (possibly re-timed) audio clip. */
  audioPath: string;
  /** Duration of the generated clip before fitting, in ms. */
  generatedDurationMs: number;
  /** Duration actually placed on the timeline, in ms. */
  placedDurationMs: number;
  /** Applied time-stretch ratio (1.0 = unchanged). */
  speedRatio: number;
  /** Amount the clip exceeded its window, in ms (0 if it fit). */
  overflowMs: number;
  /** Alignment quality classification. */
  status: AlignmentStatus;
  /** Optional human-readable note about the alignment decision. */
  note?: string;
}

/** Input to create a new project. */
export interface CreateProjectInput {
  /** Project name. */
  name: string;
  /** Absolute path to the input video file. */
  inputVideoPath: string;
  /** Initial project settings. */
  settings: ProjectSettings;
  /** Optional explicit output directory. */
  outputDir?: string;
}

/**
 * The editor's timeline document: GET/PATCH /projects/:id/timeline.
 *
 * Everything the multi-track editor draws, in one response — the cues, the
 * synthesis units they were voiced in (a unit is ONE clip on the dub track and
 * may span several cues), each unit's fit, the voice-synced subtitle timing,
 * and the media the preview plays. One fetch keeps the tracks consistent with
 * each other: the editor never shows a clip from one read next to cues from
 * another.
 */
import type { AlignedSegment, TranscriptSegment } from './domain.js';

/** A cue with its unit's alignment merged in (only on the unit's FIRST member). */
export type TimelineSegment = TranscriptSegment & { alignment?: AlignedSegment };

/** One synthesized clip on the dub track. */
export interface TimelineUnit {
  /** Unit id == first member's segment id (it names the WAV). */
  id: string;
  /** Member cue ids, in order (one for an ungrouped line). */
  segmentIds: string[];
  /** Window start (first member's start), ms. */
  startMs: number;
  /** Window end (last member's end), ms. */
  endMs: number;
  /** How the clip was fitted, once alignment has run. */
  alignment?: AlignedSegment;
}

/** The media the editor previews and draws (paths are inside the projects dir). */
export interface TimelineMedia {
  /** Total media duration (ms), when probed. */
  durationMs?: number;
  /** The project's copy of the input video — the preview source. */
  videoPath: string;
  /** Video frame size, when probed (drives the preview aspect ratio). */
  width?: number;
  height?: number;
  /** Frames per second, when probed (drives frame-stepping). */
  fps?: number;
  /** Full-rate original audio (exists after extract-audio). */
  originalAudioPath?: string;
  /** The rendered dub, when a render has completed. */
  outputPath?: string;
}

export interface TimelineDocument {
  projectId: string;
  /** Every cue, in timeline order. */
  segments: TimelineSegment[];
  /** Synthesis units in timeline order; empty before TTS has run. */
  units: TimelineUnit[];
  /** True once translation produced translated.json (else cues are source-only). */
  translated: boolean;
  /** True once alignment produced placements (the dub track has clips). */
  aligned: boolean;
  /** Voice-synced subtitle timing for cues inside merged units (display only). */
  cueOverrides: Record<string, { startMs: number; endMs: number }>;
  media: TimelineMedia;
}

/** GET /projects/:id/waveform — the original audio's envelope. */
export interface TimelineWaveform {
  track: 'original';
  peaksPerSecond: number;
  durationMs: number;
  /** Base64 of an Int8Array of interleaved [min, max] pairs (-127..127). */
  peaks: string;
}

/** GET /projects/:id/filmstrip — one sprite sheet of evenly spaced thumbnails. */
export interface TimelineFilmstrip {
  /** Absolute path of the sprite JPEG (served by /file). */
  path: string;
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Media time between consecutive thumbnails (ms). */
  intervalMs: number;
}

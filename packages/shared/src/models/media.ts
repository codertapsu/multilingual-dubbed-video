/**
 * Media-probing and rendering types.
 *
 * These describe what FFprobe reports about an input file and the inputs/
 * outputs of the FFmpeg-backed {@link MediaService}.
 */

/** Information about a single video stream in a media container. */
export interface VideoStreamInfo {
  /** Stream index within the container. */
  index: number;
  /** Codec name, e.g. "h264". */
  codec: string;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Frames per second (may be fractional). */
  fps: number;
  /** Optional bitrate in kilobits per second. */
  bitrateKbps?: number;
}

/** Information about a single audio stream in a media container. */
export interface AudioStreamInfo {
  /** Stream index within the container. */
  index: number;
  /** Codec name, e.g. "aac". */
  codec: string;
  /** Number of audio channels (1 = mono, 2 = stereo). */
  channels: number;
  /** Sample rate in Hz, e.g. 48000. */
  sampleRate: number;
  /** Optional bitrate in kilobits per second. */
  bitrateKbps?: number;
  /** Optional ISO language tag attached to the stream metadata. */
  language?: string;
}

/** Aggregated probe result for an input media file. */
export interface MediaInfo {
  /** Total duration in integer milliseconds. */
  durationMs: number;
  /** Container/format name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  /** Optional file size in bytes. */
  sizeBytes?: number;
  /** Whether the file contains at least one audio stream. */
  hasAudio: boolean;
  /** All detected video streams. */
  videoStreams: VideoStreamInfo[];
  /** All detected audio streams. */
  audioStreams: AudioStreamInfo[];
}

/** Result of extracting an audio track from a video. */
export interface AudioExtractResult {
  /** Absolute path to the extracted WAV file. */
  audioPath: string;
  /** Output sample rate in Hz. */
  sampleRate: number;
  /** Output channel count. */
  channels: number;
  /** Extracted audio duration in integer milliseconds. */
  durationMs: number;
}

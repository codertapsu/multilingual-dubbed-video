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
  /** What the container says this stream lasts, ms (its own duration, or Matroska's DURATION tag). */
  durationMs?: number;
  /** When the stream starts, ms of the container's clock. */
  startMs?: number;
  /** A cover picture (an MP3's album art), not a picture that plays. */
  attachedPicture?: boolean;
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
  /**
   * What the container says this stream lasts, ms. Not how much audio it
   * holds: P4 of the 27.8-hour series claimed 9826.354 s against its
   * picture's 9826.357 s while holding 4.8 s more samples (see AudioDrift).
   */
  durationMs?: number;
  /** When the stream starts, ms of the container's clock. */
  startMs?: number;
}

/**
 * How long the source's audio really is against its picture, measured when
 * the audio is extracted (docs/plans/production-requests-2026-11-23.md, 1.1).
 *
 * From the DECODED sample count (packets × frame size − the encoder's
 * priming, or a full decode when the codec's frame size varies), never from
 * the container's durations, which agreed with the picture on the source
 * whose audio was 4.8 s too long. The extraction re-times every audio track
 * to the picture's clock and cuts it to the picture's length either way; this
 * says by how much the source was off.
 */
export interface AudioDrift {
  /** `audioMs − pictureMs`: positive = the audio is longer than the picture. */
  driftMs: number;
  /** The audio's decoded length, ms. */
  audioMs: number;
  /** The picture's length (for a series part: its window's share of it), ms. */
  pictureMs: number;
  /** `packets`: packets × frame size − priming; `decode`: the samples of a full decode, counted. */
  method: 'packets' | 'decode';
  /** What the container claimed for the audio, ms, when it said. */
  claimedAudioMs?: number;
  /** The window measured (a series part), ms of the input; absent = the whole input. */
  range?: { startMs: number; endMs: number };
  /** How it was counted, for the log and support: packets × frame size − priming, or the samples decoded. */
  count?: {
    codec: string;
    sampleRate: number;
    packets?: number;
    frameSize?: number;
    primingSamples?: number;
    samples?: number;
  };
  /** ISO-8601. */
  measuredAt: string;
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
  /** The container's start time, ms (ffmpeg times every stream from it). */
  startMs?: number;
  /** The audio against the picture, measured by the extract-audio step (absent before it ran). */
  audioDrift?: AudioDrift;
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

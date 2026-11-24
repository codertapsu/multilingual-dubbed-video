/**
 * Media probing via ffprobe.
 *
 * Produces a MediaInfo from ffprobe's JSON output. The arg-builder and the
 * JSON->MediaInfo parser are pure functions (no spawning) so they can be unit
 * tested without ffprobe installed.
 */

import {
  AppErrorException,
  type AudioStreamInfo,
  type MediaInfo,
  type VideoStreamInfo,
} from '@videodubber/shared';
import { assertInputReadable, runFfprobe, type RunOptions } from './exec.js';

/** Build the ffprobe argv array for a full format+streams JSON probe. */
export function buildProbeArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // `-i` keeps the path strictly as an input operand (never option-parsed).
    '-i',
    inputPath,
  ];
}

/** Minimal shape of the ffprobe JSON we consume. */
interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  duration?: string;
  start_time?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}
interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  start_time?: string;
  size?: string;
  bit_rate?: string;
}
interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/** Parse "num/den" (e.g. "30000/1001") into a rounded-ish fps number. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed === '0/0' || trimmed === '') return 0;
  const [numStr, denStr] = trimmed.split('/');
  const num = Number(numStr);
  const den = denStr === undefined ? 1 : Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  const fps = num / den;
  // Round to 3 decimals to avoid noise like 29.999999.
  return Math.round(fps * 1000) / 1000;
}

/** Convert a bitrate-in-bits string ("128000") to kbps, or undefined. */
function toKbps(bitRate: string | undefined): number | undefined {
  if (!bitRate) return undefined;
  const bits = Number(bitRate);
  if (!Number.isFinite(bits) || bits <= 0) return undefined;
  return Math.round(bits / 1000);
}

/** ffprobe seconds ("9826.357000") to whole ms; undefined for "N/A" or nothing. */
function secondsToMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const sec = Number(value);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : undefined;
}

/**
 * A stream's own duration in ms: ffprobe's `duration`, else the DURATION tag
 * Matroska/WebM files carry per track ("00:00:10.000000000"). Pure.
 */
export function streamDurationMs(stream: { duration?: string; tags?: Record<string, string> }): number | undefined {
  const own = secondsToMs(stream.duration);
  if (own !== undefined && own > 0) return own;
  const tag = stream.tags?.DURATION ?? stream.tags?.duration;
  const m = tag?.trim().match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return undefined;
  const ms = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * How long the picture lasts on the clock every extracted audio track uses,
 * ms; undefined for audio-only input (or a picture of unknown length). Pure.
 *
 * ffmpeg times every stream from the container's start, so a picture that
 * starts after it (an MPEG-TS whose video opens later than its audio) ends
 * that much later on the audio's clock. A cover picture (an MP3's album art)
 * is not a picture that plays.
 */
export function pictureDurationMs(info: MediaInfo): number | undefined {
  const video = info.videoStreams.find((v) => v.attachedPicture !== true);
  if (!video) return undefined;
  const length = video.durationMs ?? (info.durationMs > 0 ? info.durationMs : undefined);
  if (length === undefined || !(length > 0)) return undefined;
  const offset = video.startMs !== undefined && info.startMs !== undefined ? Math.max(0, video.startMs - info.startMs) : 0;
  return Math.round(offset + length);
}

/**
 * Pure transform: ffprobe JSON (already parsed) -> MediaInfo.
 * Throws UNSUPPORTED_MEDIA if the JSON has no usable streams/format.
 */
export function ffprobeJsonToMediaInfo(json: FfprobeJson, inputPath: string): MediaInfo {
  const streams = json.streams ?? [];
  const format = json.format ?? {};

  if (streams.length === 0 && !format.format_name) {
    throw new AppErrorException({
      code: 'UNSUPPORTED_MEDIA',
      message: `ffprobe reported no usable streams for: ${inputPath}`,
      remediation: 'The file may be corrupt or an unsupported container/codec.',
      docsRef: 'docs/TROUBLESHOOTING.md#media',
    });
  }

  const durationSec = Number(format.duration);
  const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0;
  // Per stream, what the container claims: the picture's length cuts the
  // audio (pictureDurationMs), and the audio's claim is logged beside what it
  // really holds (drift.ts). Only set when known, so older readers see no change.
  const timing = (s: FfprobeStream): { durationMs?: number; startMs?: number } => {
    const d = streamDurationMs(s);
    const start = secondsToMs(s.start_time);
    return { ...(d !== undefined ? { durationMs: d } : {}), ...(start !== undefined ? { startMs: start } : {}) };
  };
  const formatStartMs = secondsToMs(format.start_time);

  const videoStreams: VideoStreamInfo[] = streams
    .filter((s) => s.codec_type === 'video')
    .map((s) => ({
      index: s.index ?? 0,
      codec: s.codec_name ?? 'unknown',
      width: s.width ?? 0,
      height: s.height ?? 0,
      // Prefer avg_frame_rate, fall back to r_frame_rate.
      fps: parseFrameRate(s.avg_frame_rate) || parseFrameRate(s.r_frame_rate),
      bitrateKbps: toKbps(s.bit_rate),
      ...timing(s),
      ...(s.disposition?.attached_pic === 1 ? { attachedPicture: true } : {}),
    }));

  const audioStreams: AudioStreamInfo[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index ?? 0,
      codec: s.codec_name ?? 'unknown',
      channels: s.channels ?? 0,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : 0,
      bitrateKbps: toKbps(s.bit_rate),
      language: s.tags?.language ?? s.tags?.LANGUAGE,
      ...timing(s),
    }));

  return {
    durationMs,
    container: format.format_name ?? 'unknown',
    sizeBytes: format.size ? Number(format.size) : undefined,
    hasAudio: audioStreams.length > 0,
    videoStreams,
    audioStreams,
    ...(formatStartMs !== undefined ? { startMs: formatStartMs } : {}),
  };
}

/** Probe a media file and return its MediaInfo. */
export async function probe(inputPath: string, opts: RunOptions = {}): Promise<MediaInfo> {
  assertInputReadable(inputPath);
  const { stdout } = await runFfprobe(buildProbeArgs(inputPath), opts);

  let json: FfprobeJson;
  try {
    json = JSON.parse(stdout) as FfprobeJson;
  } catch (err) {
    throw new AppErrorException({
      code: 'UNSUPPORTED_MEDIA',
      message: `Failed to parse ffprobe output for: ${inputPath}`,
      cause: err instanceof Error ? err.message : String(err),
      docsRef: 'docs/TROUBLESHOOTING.md#media',
    });
  }

  return ffprobeJsonToMediaInfo(json, inputPath);
}

/** Quick helper: just the duration in ms (used after extraction/render). */
export async function probeDurationMs(inputPath: string, opts: RunOptions = {}): Promise<number> {
  const info = await probe(inputPath, opts);
  return info.durationMs;
}

/** The first video stream as the filtergraph will SEE it. */
export interface VideoGeometry {
  /** Display-oriented width (after ffmpeg's autorotation). */
  width: number;
  /** Display-oriented height. */
  height: number;
  /** Average frame rate (30 when unknown). */
  fps: number;
  /** Container duration in ms (0 when unknown). */
  durationMs: number;
}

/** ffprobe argv for {@link probeVideoGeometry}. Pure. */
export function buildVideoGeometryArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration',
    '-print_format',
    'json',
    '-i',
    inputPath,
  ];
}

/**
 * Parse {@link buildVideoGeometryArgs} output. Pure.
 *
 * A phone video stores 1920x1080 plus a 90° display matrix; ffmpeg autorotates
 * while decoding, so the subtitle filter draws on a 1080x1920 frame. Sizing the
 * subtitle canvas from the stored size would squash the text into the wrong
 * aspect. Rotation comes from the display-matrix side data (ffmpeg 5+) or the
 * legacy `rotate` tag.
 */
export function parseVideoGeometry(json: unknown): VideoGeometry | undefined {
  const j = json as {
    streams?: Array<{
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      side_data_list?: Array<{ rotation?: number | string }>;
      tags?: { rotate?: string };
    }>;
    format?: { duration?: string };
  };
  const s = j?.streams?.[0];
  if (!s || !s.width || !s.height) return undefined;
  const rotation = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0);
  const quarterTurn = Number.isFinite(rotation) && Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const durationSec = Number(j.format?.duration);
  return {
    width: quarterTurn ? s.height : s.width,
    height: quarterTurn ? s.width : s.height,
    fps: parseFrameRate(s.avg_frame_rate) || parseFrameRate(s.r_frame_rate) || 30,
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
  };
}

/** Probe the display geometry of `inputPath`'s first video stream. */
export async function probeVideoGeometry(inputPath: string, opts: RunOptions = {}): Promise<VideoGeometry> {
  const { stdout } = await runFfprobe(buildVideoGeometryArgs(inputPath), opts);
  let geometry: VideoGeometry | undefined;
  try {
    geometry = parseVideoGeometry(JSON.parse(stdout));
  } catch {
    geometry = undefined;
  }
  if (!geometry) {
    throw new AppErrorException({
      code: 'UNSUPPORTED_MEDIA',
      message: `No video stream to burn subtitles into: ${inputPath}`,
      remediation: 'Burned-in subtitles need a video track. Choose an .srt/.vtt export for audio-only input.',
      docsRef: 'docs/TROUBLESHOOTING.md#media',
    });
  }
  return geometry;
}

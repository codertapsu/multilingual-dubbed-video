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
import { assertInputReadable, runFfprobe } from './exec.js';

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
  tags?: Record<string, string>;
}
interface FfprobeFormat {
  format_name?: string;
  duration?: string;
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
    }));

  return {
    durationMs,
    container: format.format_name ?? 'unknown',
    sizeBytes: format.size ? Number(format.size) : undefined,
    hasAudio: audioStreams.length > 0,
    videoStreams,
    audioStreams,
  };
}

/** Probe a media file and return its MediaInfo. */
export async function probe(inputPath: string): Promise<MediaInfo> {
  assertInputReadable(inputPath);
  const { stdout } = await runFfprobe(buildProbeArgs(inputPath));

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
export async function probeDurationMs(inputPath: string): Promise<number> {
  const info = await probe(inputPath);
  return info.durationMs;
}

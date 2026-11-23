/**
 * Joining several videos into one (New project → "Join several videos").
 *
 * WHY THIS IS THE APP'S JOB: the 27.8-hour series (claude-dubber report,
 * 2026-11-23) was five Bilibili files joined by hand into one 18.2 GB source,
 * and the hand-made join is where it broke. The files mixed 44.1 and 48 kHz
 * audio, P4's audio clock ran fast (423,392 AAC packets = 9831.2 s of sound
 * under timestamps ending at 9826.33 s), and one `aresample=async=1` over the
 * whole joined sound garbled P3/P4: the content shifted, then two hours of
 * silence. Every file's sound must follow ITS OWN picture.
 *
 * How a join is built, in one ffmpeg pass:
 *  - The picture, when every file was encoded alike (`copy`): copied as it is
 *    through the concat demuxer, each file listed with its exact length, so
 *    the next file starts where this one's picture ends. Otherwise
 *    (`reencode`): each file decoded, fitted to one frame size and rate, cut
 *    to a whole number of frames, concatenated and encoded once.
 *  - The sound of each file, decoded on its own:
 *    `aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=<span×48000>`
 *    re-times it to its timestamps (P4's extra 4.8 s are squeezed out, a late
 *    start padded), pads a short track and cuts it to exactly that file's
 *    picture length. Then the files' sounds are concatenated. A file's sound
 *    can never run into the next file's picture.
 *
 * `-copyts` (copy mode only): the concat demuxer's start time counts the first
 * file's AAC priming (−1024 samples), and ffmpeg's default shift to zero then
 * delayed the whole copied picture 21 ms against the sound (measured with
 * ffmpeg 8.1.1: video start 0.021 s without it, 0.000 s with it). Each audio
 * input is instead moved to its own file's start with `-itsoffset`, which is
 * what the default shift does for a lone input.
 *
 * Arg builders and parsers are pure (join.test.ts); join.real.test.ts runs a
 * real join of generated clips when ffmpeg is on the PATH.
 */

import { rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppErrorException, type RenderQuality } from '@videodubber/shared';
import { writeAtomically } from './atomic.js';
import {
  cachedHardwareEncoderProbe,
  encodeWithFallback,
  LIBX264,
  planVideoEncode,
  type VideoEncodePlan,
  type VideoEncodeReport,
  type VideoEncoderChoice,
} from './encoder.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, runFfprobe, type RunOptions } from './exec.js';
import { parseFrameRate } from './probe.js';

/** The joined sound's sample rate: every file's audio is converted to it. */
export const JOIN_AUDIO_RATE = 48_000;

/**
 * Most compensation `aresample` may apply, in samples per second (2 % at 48
 * kHz). P4's fast clock needed ~24 samples/s; a larger difference is squeezed
 * at this rate and the rest trimmed by `min_hard_comp`.
 */
export const JOIN_ASYNC = 1000;

// ------------------------------------------------------------------ probing

/** A file's picture, as the compatibility check compares it. */
export interface JoinVideoInfo {
  codec: string;
  profile?: string;
  /** Coded size. */
  width: number;
  height: number;
  /** Display rotation, 0 / 90 / 180 / 270. */
  rotation: number;
  /** Base frame rate (r_frame_rate), e.g. 25 or 29.97. */
  fps: number;
  /** The same as ffprobe wrote it ("30000/1001"), for an exact `fps` filter. */
  fpsText?: string;
  pixFmt?: string;
  /** Sample aspect ratio ("1:1"); absent when square or unknown. */
  sar?: string;
  /** Hash of the codec's setup data (SPS/PPS…): equal when encoded alike. */
  extradataHash?: string;
  bitrateKbps?: number;
  /** Frames in the stream, when the container counts them (MP4 does; Matroska does not). */
  frames?: number;
}

/** A file's sound. */
export interface JoinAudioInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  bitrateKbps?: number;
}

/** One file of a join, as {@link probeJoinFile} reads it. */
export interface JoinProbe {
  path: string;
  sizeBytes: number;
  /** The container's start time (s); every timestamp of the file counts from it. */
  startSec: number;
  /**
   * The file's length in the joined video (s): where its picture ends,
   * counted from the file's start. Its sound is cut to exactly this.
   */
  spanSec: number;
  /** Where its sound ends, counted from the file's start (s), when known. */
  audioSpanSec?: number;
  video?: JoinVideoInfo;
  audio?: JoinAudioInfo;
}

/** ffprobe argv for {@link probeJoinFile}: streams + format, with a hash of each codec's setup data. Pure. */
export function buildJoinProbeArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_data_hash',
    'SHA256',
    '-i',
    inputPath,
  ];
}

interface FfprobeJoinStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  start_time?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  nb_frames?: string;
  extradata_hash?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number | string }>;
  tags?: Record<string, string>;
}

interface FfprobeJoinJson {
  streams?: FfprobeJoinStream[];
  format?: { start_time?: string; duration?: string; size?: string };
}

const num = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === '' || v === 'N/A') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Matroska's per-stream `DURATION` tag ("01:02:03.500000000"), in seconds. Pure. */
export function parseDurationTag(tag: string | undefined): number | undefined {
  const m = tag ? /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(tag.trim()) : null;
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const kbps = (bits: string | undefined): number | undefined => {
  const b = num(bits);
  return b !== undefined && b > 0 ? Math.round(b / 1000) : undefined;
};

/** A stream's end, counted from the file's start (s). */
function streamEnd(s: FfprobeJoinStream, fileStart: number, fileDuration: number | undefined): number | undefined {
  const start = num(s.start_time) ?? fileStart;
  const duration =
    num(s.duration) ??
    parseDurationTag(s.tags?.DURATION ?? s.tags?.duration) ??
    (fileDuration !== undefined ? fileDuration - (start - fileStart) : undefined);
  if (duration === undefined) return undefined;
  const end = start - fileStart + duration;
  return end > 0 ? end : undefined;
}

/**
 * {@link buildJoinProbeArgs} output → {@link JoinProbe}. Pure.
 *
 * The span is where the PICTURE ends, not the container's duration: the
 * container counts the longest stream, so a file whose audio runs past its
 * picture (or whose audio clock runs fast) would push every later file late.
 */
export function parseJoinProbe(json: unknown, path: string, sizeBytes = 0): JoinProbe {
  const j = (json ?? {}) as FfprobeJoinJson;
  const streams = j.streams ?? [];
  const fileStart = num(j.format?.start_time) ?? 0;
  const fileDuration = num(j.format?.duration);
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');

  let video: JoinVideoInfo | undefined;
  if (v && v.width && v.height) {
    const rawRotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
    const rotation = Number.isFinite(rawRotation) ? (((Math.round(rawRotation / 90) * 90) % 360) + 360) % 360 : 0;
    const rText = parseFrameRate(v.r_frame_rate) ? v.r_frame_rate : parseFrameRate(v.avg_frame_rate) ? v.avg_frame_rate : undefined;
    const sar = v.sample_aspect_ratio && v.sample_aspect_ratio !== '1:1' && v.sample_aspect_ratio !== '0:1' ? v.sample_aspect_ratio : undefined;
    video = {
      codec: v.codec_name ?? 'unknown',
      ...(v.profile ? { profile: v.profile } : {}),
      width: v.width,
      height: v.height,
      rotation,
      fps: parseFrameRate(v.r_frame_rate) || parseFrameRate(v.avg_frame_rate),
      ...(rText ? { fpsText: rText } : {}),
      ...(v.pix_fmt ? { pixFmt: v.pix_fmt } : {}),
      ...(sar ? { sar } : {}),
      ...(v.extradata_hash ? { extradataHash: v.extradata_hash } : {}),
      ...(kbps(v.bit_rate) !== undefined ? { bitrateKbps: kbps(v.bit_rate) } : {}),
      ...((num(v.nb_frames) ?? 0) > 0 ? { frames: num(v.nb_frames)! } : {}),
    };
  }
  const audio: JoinAudioInfo | undefined = a
    ? {
        codec: a.codec_name ?? 'unknown',
        sampleRate: num(a.sample_rate) ?? 0,
        channels: a.channels ?? 0,
        ...(kbps(a.bit_rate) !== undefined ? { bitrateKbps: kbps(a.bit_rate) } : {}),
      }
    : undefined;

  const videoEnd = v ? streamEnd(v, fileStart, fileDuration) : undefined;
  const audioEnd = a ? streamEnd(a, fileStart, fileDuration) : undefined;
  return {
    path,
    sizeBytes: sizeBytes || num(j.format?.size) || 0,
    startSec: fileStart,
    spanSec: videoEnd ?? fileDuration ?? 0,
    ...(audioEnd !== undefined ? { audioSpanSec: audioEnd } : {}),
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
  };
}

/** Probe one file for a join (streams, lengths, setup-data hashes). */
export async function probeJoinFile(inputPath: string, opts: RunOptions = {}): Promise<JoinProbe> {
  assertInputReadable(inputPath);
  const { stdout } = await runFfprobe(buildJoinProbeArgs(inputPath), opts);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new AppErrorException({
      code: 'UNSUPPORTED_MEDIA',
      message: `Could not read the streams of ${inputPath}.`,
      cause: err instanceof Error ? err.message : String(err),
      docsRef: 'docs/TROUBLESHOOTING.md#media',
    });
  }
  let size = 0;
  try {
    size = statSync(inputPath).size;
  } catch {
    /* the probe's own size, if any */
  }
  return parseJoinProbe(json, inputPath, size);
}

// ------------------------------------------------------------ compatibility

/** A way a file differs from the first, so its picture cannot be copied as it is. */
export interface JoinMismatch {
  field: 'codec' | 'profile' | 'resolution' | 'frame-rate' | 'pixel-format' | 'encoding';
  /** The file that differs (0-based). */
  index: number;
  value: string;
  expected: string;
}

/** The size a viewer sees ("1080×1920"), rotation applied. Pure. */
export function displaySize(v: Pick<JoinVideoInfo, 'width' | 'height' | 'rotation'>): { width: number; height: number } {
  return v.rotation % 180 === 90 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
}

const sizeLabel = (v: JoinVideoInfo): string => {
  const d = displaySize(v);
  return `${d.width}×${d.height}${v.rotation ? ` (stored ${v.width}×${v.height}, turned ${v.rotation}°)` : ''}${v.sar ? ` SAR ${v.sar}` : ''}`;
};

const fpsLabel = (fps: number): string => `${Math.round(fps * 1000) / 1000} fps`;

/**
 * Same base frame rate, within a hundredth of a frame per second (29.97 as
 * rounded vs 30000/1001), while 30 vs 29.97 and 60 vs 59.94 stay different.
 * Pure.
 */
export function sameFrameRate(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return a === b;
  return Math.abs(a - b) <= Math.max(0.01, Math.max(a, b) * 0.0002);
}

/**
 * Codecs whose packets the concat demuxer converts to carry their own setup
 * data (`auto_convert`: h264_mp4toannexb), so files encoded with different
 * settings still decode after a copy. Other codecs keep only the first file's
 * setup data in the joined file, and a file encoded differently would not
 * decode after it.
 */
const SELF_DESCRIBING_COPY = new Set(['h264']);

/**
 * How each file differs from the first in what a picture copy needs to be
 * equal: codec, profile, size (with rotation and pixel shape), frame rate,
 * pixel format, and, outside H.264, the encoder's setup data. Files without a
 * picture are left out (the check refuses them on their own). Pure.
 */
export function compareJoinFiles(files: readonly JoinProbe[]): JoinMismatch[] {
  const first = files[0]?.video;
  if (!first) return [];
  const out: JoinMismatch[] = [];
  files.forEach((f, index) => {
    const v = f.video;
    if (index === 0 || !v) return;
    if (v.codec !== first.codec) out.push({ field: 'codec', index, value: v.codec, expected: first.codec });
    else if ((v.profile ?? '') !== (first.profile ?? '')) {
      out.push({ field: 'profile', index, value: v.profile ?? '?', expected: first.profile ?? '?' });
    }
    if (v.width !== first.width || v.height !== first.height || v.rotation !== first.rotation || (v.sar ?? '') !== (first.sar ?? '')) {
      out.push({ field: 'resolution', index, value: sizeLabel(v), expected: sizeLabel(first) });
    }
    if (!sameFrameRate(v.fps, first.fps)) out.push({ field: 'frame-rate', index, value: fpsLabel(v.fps), expected: fpsLabel(first.fps) });
    if ((v.pixFmt ?? '') !== (first.pixFmt ?? '')) {
      out.push({ field: 'pixel-format', index, value: v.pixFmt ?? '?', expected: first.pixFmt ?? '?' });
    }
    if (
      v.codec === first.codec &&
      !SELF_DESCRIBING_COPY.has(v.codec) &&
      v.extradataHash &&
      first.extradataHash &&
      v.extradataHash !== first.extradataHash
    ) {
      out.push({ field: 'encoding', index, value: 'encoded with other settings', expected: 'the first file\'s settings' });
    }
  });
  return out;
}

/** The frame a re-encoding join fits every file to. */
export interface JoinTarget {
  width: number;
  height: number;
  fps: number;
  /** The rate as an exact fraction for ffmpeg ("30000/1001"). */
  fpsText: string;
}

/**
 * The size and frame rate most of the video already has (by duration; a tie
 * goes to the larger), so the fewest minutes are rescaled. Even sizes (4:2:0
 * needs them). Pure.
 */
export function joinTarget(files: readonly JoinProbe[]): JoinTarget | undefined {
  const sizes = new Map<string, { width: number; height: number; sec: number }>();
  const rates = new Map<string, { fps: number; text: string; sec: number }>();
  for (const f of files) {
    if (!f.video) continue;
    const d = displaySize(f.video);
    const sk = `${d.width}x${d.height}`;
    const s = sizes.get(sk) ?? { ...d, sec: 0 };
    s.sec += Math.max(f.spanSec, 0.001);
    sizes.set(sk, s);
    const text = f.video.fpsText ?? String(f.video.fps || 25);
    const fps = f.video.fps || 25;
    const rk = String(Math.round(fps * 1000));
    const r = rates.get(rk) ?? { fps, text, sec: 0 };
    r.sec += Math.max(f.spanSec, 0.001);
    rates.set(rk, r);
  }
  const size = [...sizes.values()].sort((a, b) => b.sec - a.sec || b.width * b.height - a.width * a.height)[0];
  const rate = [...rates.values()].sort((a, b) => b.sec - a.sec || b.fps - a.fps)[0];
  if (!size || !rate) return undefined;
  const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(size.width), height: even(size.height), fps: rate.fps, fpsText: rate.text };
}

/** Codecs the joined MP4 can hold as they are; anything else is copied into Matroska. */
const MP4_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4']);

/** The joined file's extension: MP4 unless a copied picture's codec does not fit in one. Pure. */
export function joinOutputExtension(mode: 'copy' | 'reencode', videoCodec: string | undefined): 'mp4' | 'mkv' {
  return mode === 'copy' && videoCodec && !MP4_VIDEO_CODECS.has(videoCodec) ? 'mkv' : 'mp4';
}

/**
 * The joined sound's AAC bitrate: at least 192 kb/s (one generation of AAC
 * over a 128 kb/s source stays transparent), more when a source had more,
 * at most 320. Pure.
 */
export function joinAudioBitrateKbps(files: readonly JoinProbe[]): number {
  const most = Math.max(0, ...files.map((f) => f.audio?.bitrateKbps ?? 0));
  return Math.min(320, Math.max(192, Math.ceil(most / 32) * 32));
}

// ------------------------------------------------------------------ the plan

/** One file as the join command uses it. */
export interface JoinPlanFile {
  path: string;
  /** The container's start (s): its timestamps count from it. */
  startSec: number;
  /** Its length in the joined video (s). */
  spanSec: number;
  hasAudio: boolean;
  /** Frames of its picture in the joined video (how far the join is, see {@link joinPosition}). */
  frames: number;
}

/** Everything the join command needs. */
export interface JoinPlan {
  mode: 'copy' | 'reencode';
  files: JoinPlanFile[];
  /** reencode: the frame every file is fitted to. */
  target?: JoinTarget;
}

/** The frame rate as a number from its fraction ("30000/1001" → 29.97…). Pure. */
function fpsValue(target: JoinTarget): number {
  const exact = parseFrameRate(target.fpsText);
  const [n, d] = target.fpsText.split('/').map(Number);
  return n && d ? n / d : exact || target.fps;
}

/**
 * A file's length as the joined video gives it. A copy keeps the picture's own
 * length, rounded UP to the microsecond the concat list is written in (never
 * into the next file). A re-encode cuts the picture to a whole number of
 * frames at the target rate, at least one, so frames and sound end together.
 * Pure.
 */
export function joinSpanSec(spanSec: number, mode: 'copy' | 'reencode', target?: JoinTarget): number {
  if (mode === 'reencode' && target) {
    const fps = fpsValue(target);
    const frames = Math.max(1, Math.round(spanSec * fps));
    return Math.round((frames / fps) * 1e6) / 1e6;
  }
  // Less a nanosecond: 9826.357 s is 9826357000.000002 µs in floating point,
  // which must not round up a whole microsecond.
  return Math.ceil(spanSec * 1e6 - 1e-3) / 1e6;
}

/** Samples of `spanSec` at the joined rate: the exact length a file's sound is cut to. Pure. */
export function joinEndSample(spanSec: number, rate = JOIN_AUDIO_RATE): number {
  return Math.max(1, Math.round(spanSec * rate));
}

/**
 * The plan for these files: their spans as the joined video gives them (see
 * {@link joinSpanSec}). `target` is required for a re-encode. Pure.
 */
export function planJoin(files: readonly JoinProbe[], mode: 'copy' | 'reencode', target?: JoinTarget): JoinPlan {
  if (mode === 'reencode' && !target) throw new Error('A re-encoding join needs a target frame.');
  return {
    mode,
    files: files.map((f) => {
      const spanSec = joinSpanSec(f.spanSec, mode, target);
      // A copy writes the file's own frames (MP4 counts them); a re-encode
      // writes exactly span × rate of them.
      const frames =
        mode === 'reencode' && target
          ? Math.round(spanSec * fpsValue(target))
          : (f.video?.frames ?? Math.max(1, Math.round(spanSec * (f.video?.fps || 25))));
      return { path: f.path, startSec: f.startSec, spanSec, hasAudio: f.audio !== undefined, frames };
    }),
    ...(mode === 'reencode' && target ? { target } : {}),
  };
}

/** Where each file starts in the joined video and how long it is, in ms (Project.inputFiles). Pure. */
export function joinBoundariesMs(plan: Pick<JoinPlan, 'files'>): { startMs: number; durationMs: number }[] {
  let at = 0;
  return plan.files.map((f) => {
    const startMs = Math.round(at * 1000);
    at += f.spanSec;
    return { startMs, durationMs: Math.round(at * 1000) - startMs };
  });
}

// ------------------------------------------------------------------ commands

/**
 * A path quoted for an ffconcat `file` line: inside single quotes everything is
 * literal (Windows backslashes, spaces, brackets, any script), and a single
 * quote is closed, escaped and reopened. Pure.
 */
export function quoteConcatPath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * The concat demuxer's list: every file with its exact length (`duration`),
 * so the next file's picture starts where this one's ends, not where its
 * longest stream does. Pure.
 */
export function buildConcatList(files: readonly Pick<JoinPlanFile, 'path' | 'spanSec'>[]): string {
  const lines = ['ffconcat version 1.0'];
  for (const f of files) {
    lines.push(`file ${quoteConcatPath(f.path)}`, `duration ${f.spanSec.toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * One file's sound, made exactly `spanSec` long at 48 kHz stereo: re-timed
 * to its own timestamps, padded, cut. `input` null: the file has no sound, so
 * it gets silence of its picture's length. Pure.
 */
export function joinAudioChain(input: string | null, spanSec: number, label: string, rate = JOIN_AUDIO_RATE): string {
  const end = joinEndSample(spanSec, rate);
  if (input === null) return `anullsrc=channel_layout=stereo:sample_rate=${rate},atrim=end_sample=${end}[${label}]`;
  return `${input}aformat=channel_layouts=stereo,aresample=${rate}:async=${JOIN_ASYNC}:first_pts=0,apad,atrim=end_sample=${end}[${label}]`;
}

/**
 * One file's picture for a re-encode: fitted inside the target frame (black
 * bars, never stretched), square pixels, the target rate, 8-bit 4:2:0, cut to
 * its span (a whole number of frames, see {@link joinSpanSec}). Pure.
 */
export function joinVideoChain(input: string, target: JoinTarget, spanSec: number, label: string): string {
  const { width: w, height: h } = target;
  return (
    `${input}scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${target.fpsText},format=yuv420p,` +
    `trim=end=${spanSec.toFixed(6)}[${label}]`
  );
}

/** Which ffmpeg input carries each file's sound (null: none) and the picture, for a plan. Pure. */
export function joinInputs(plan: JoinPlan): { paths: string[]; audio: (number | null)[]; video: (number | null)[] } {
  const paths: string[] = [];
  const audio: (number | null)[] = [];
  const video: (number | null)[] = [];
  // Copy mode: input 0 is the concat list (the picture); each file with sound
  // is opened again for its sound alone.
  const first = plan.mode === 'copy' ? 1 : 0;
  for (const f of plan.files) {
    if (plan.mode === 'reencode') {
      video.push(first + paths.length);
      audio.push(f.hasAudio ? first + paths.length : null);
      paths.push(f.path);
    } else {
      video.push(null);
      audio.push(f.hasAudio ? first + paths.length : null);
      if (f.hasAudio) paths.push(f.path);
    }
  }
  return { paths, audio, video };
}

/** The `-filter_complex` graph of a join (sound always; the picture too for a re-encode). Pure. */
export function buildJoinFilterComplex(plan: JoinPlan): string {
  const { audio, video } = joinInputs(plan);
  const chains: string[] = [];
  const order: string[] = [];
  plan.files.forEach((f, k) => {
    if (plan.mode === 'reencode') {
      chains.push(joinVideoChain(`[${video[k]}:V:0]`, plan.target!, f.spanSec, `v${k}`));
      order.push(`[v${k}]`);
    }
    const a = audio[k];
    chains.push(joinAudioChain(a === null || a === undefined ? null : `[${a}:a:0]`, f.spanSec, `a${k}`));
    order.push(`[a${k}]`);
  });
  const n = plan.files.length;
  const concat =
    plan.mode === 'reencode'
      ? `${order.join('')}concat=n=${n}:v=1:a=1[vout][aout]`
      : `${order.join('')}concat=n=${n}:v=0:a=1[aout]`;
  return [...chains, concat].join(';');
}

export interface BuildJoinArgsOptions {
  plan: JoinPlan;
  /** Copy mode: the concat list written by {@link buildConcatList}. */
  listPath?: string;
  outputPath: string;
  /** Re-encode: the video encoder (default x264). */
  encoder?: VideoEncoderChoice;
  audioBitrateKbps?: number;
}

/** The common head: quiet, machine-readable progress on stdout once a second. */
const PROGRESS_ARGS = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1'];

/**
 * The whole join command, argv. Pure.
 *
 * Copy: `-copyts`, the concat list as input 0 (picture copied), each file
 * with sound opened again for its sound alone (`-discard:v all`: its picture
 * is not even read) and moved to its own start (`-itsoffset`).
 * Re-encode: each file once, picture and sound through the graph.
 */
export function buildJoinArgs(opts: BuildJoinArgsOptions): string[] {
  const { plan } = opts;
  if (plan.files.length < 2) throw new Error('A join needs at least two files.');
  const { paths } = joinInputs(plan);
  const audioArgs = ['-c:a', 'aac', '-b:a', `${opts.audioBitrateKbps ?? 192}k`];
  const tail = ['-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '4096', opts.outputPath];
  if (plan.mode === 'copy') {
    if (!opts.listPath) throw new Error('A copying join needs its concat list.');
    const inputs: string[] = [];
    for (const f of plan.files) {
      if (!f.hasAudio) continue;
      if (Math.abs(f.startSec) > 1e-6) inputs.push('-itsoffset', (-f.startSec).toFixed(6));
      inputs.push('-discard:v', 'all', '-i', f.path);
    }
    return [
      ...PROGRESS_ARGS,
      '-copyts',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      opts.listPath,
      ...inputs,
      '-filter_complex',
      buildJoinFilterComplex(plan),
      '-map',
      '0:V:0',
      '-map',
      '[aout]',
      '-c:v',
      'copy',
      ...audioArgs,
      ...tail,
    ];
  }
  if (!plan.target) throw new Error('A re-encoding join needs a target frame.');
  const encoder = opts.encoder ?? LIBX264;
  return [
    ...PROGRESS_ARGS,
    ...paths.flatMap((p) => ['-i', p]),
    '-filter_complex',
    buildJoinFilterComplex(plan),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    encoder.codec,
    ...encoder.args,
    ...audioArgs,
    ...tail,
  ];
}

// ------------------------------------------------------------------ progress

/** One block of ffmpeg's `-progress` output. */
export interface FfmpegProgress {
  /**
   * How far the output is, in ms. NOT usable with `-copyts`: ffmpeg then
   * counts from the position of its first report (`copy_ts_first_pts`), so a
   * copying join that finishes inside one report says 0, and a long one says
   * a minute or more too little.
   */
  outTimeMs: number;
  /** Frames of the (first) video stream written so far. */
  frame?: number;
  /** × real time (1.5 = 90 s of video per minute), when ffmpeg says. */
  speed?: number;
  /** The last block (`progress=end`). */
  end: boolean;
}

/**
 * Reads ffmpeg's `-progress` lines (`key=value`, a block ending with
 * `progress=continue|end`). `out_time_us` (and the misnamed `out_time_ms`,
 * also microseconds) may be `N/A` at first. Pure apart from its own state.
 */
export class FfmpegProgressParser {
  private outUs: number | undefined;
  private frame: number | undefined;
  private speed: number | undefined;

  /** Feed one line; returns a record when a block ends. */
  push(line: string): FfmpegProgress | undefined {
    const eq = line.indexOf('=');
    if (eq <= 0) return undefined;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'out_time_us' || (key === 'out_time_ms' && this.outUs === undefined)) {
      const us = Number(value);
      if (Number.isFinite(us) && us >= 0) this.outUs = us;
    } else if (key === 'frame') {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0) this.frame = n;
    } else if (key === 'speed') {
      const s = Number.parseFloat(value.replace(/x$/, ''));
      this.speed = Number.isFinite(s) && s > 0 ? s : undefined;
    } else if (key === 'progress') {
      const out: FfmpegProgress = {
        outTimeMs: Math.round((this.outUs ?? 0) / 1000),
        ...(this.frame !== undefined ? { frame: this.frame } : {}),
        ...(this.speed !== undefined ? { speed: this.speed } : {}),
        end: value === 'end',
      };
      this.outUs = undefined;
      return out;
    }
    return undefined;
  }
}

/**
 * How far a join is (0..1) and which file it is on, from a progress block.
 * By frames written, which both modes know exactly per file (a copy's
 * `out_time` is unusable under `-copyts`, see {@link FfmpegProgress}); by
 * `out_time` only when ffmpeg reports no frames. Pure.
 */
export function joinPosition(plan: Pick<JoinPlan, 'files'>, p: FfmpegProgress): { fraction: number; fileIndex: number } {
  const last = Math.max(0, plan.files.length - 1);
  if (p.end) return { fraction: 1, fileIndex: last };
  const byFrames = p.frame !== undefined && p.frame > 0;
  const totals = plan.files.map((f) => (byFrames ? f.frames : f.spanSec * 1000));
  const total = totals.reduce((a, b) => a + b, 0);
  const done = byFrames ? p.frame! : p.outTimeMs;
  if (!(total > 0)) return { fraction: 0, fileIndex: 0 };
  let at = 0;
  let fileIndex = last;
  for (let i = 0; i < totals.length; i++) {
    if (done < at + totals[i]!) {
      fileIndex = i;
      break;
    }
    at += totals[i]!;
  }
  return { fraction: Math.min(1, Math.max(0, done / total)), fileIndex };
}

// ------------------------------------------------------------------ running

export interface JoinVideosOptions {
  plan: JoinPlan;
  /** The joined file. Written as `<name>.partial.<ext>` and renamed only once complete (and verified). */
  outputPath: string;
  /** Re-encode: the encoders to use (default x264 alone). */
  encoder?: VideoEncodePlan;
  audioBitrateKbps?: number;
  onProgress?: (p: FfmpegProgress) => void;
  /** Checks the finished file before it is published; throw to refuse it (it is then removed). */
  verify?: (partialPath: string) => Promise<void>;
}

/** The concat list's path beside the output (`original.join.ffconcat`). Pure. */
export function joinListPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.join.ffconcat`);
}

/**
 * Join the plan's files into `outputPath`, whole or not at all: ffmpeg writes
 * the partial, `verify` checks it, and only then is it renamed into place
 * (atomic.ts). A cancel kills ffmpeg and removes the partial.
 */
export async function joinVideos(opts: JoinVideosOptions, run: RunOptions = {}): Promise<{ encoder?: VideoEncodeReport }> {
  const { plan } = opts;
  for (const f of plan.files) assertInputReadable(f.path);
  assertOutputWritable(opts.outputPath);
  const parser = new FfmpegProgressParser();
  const onLog = (line: string): void => {
    run.onLog?.(line);
    const p = parser.push(line);
    if (p) opts.onProgress?.(p);
  };
  const once = (encoder: VideoEncoderChoice | undefined, listPath: string | undefined) =>
    writeAtomically(opts.outputPath, async (partial) => {
      const args = buildJoinArgs({
        plan,
        ...(listPath ? { listPath } : {}),
        outputPath: partial,
        ...(encoder ? { encoder } : {}),
        ...(opts.audioBitrateKbps ? { audioBitrateKbps: opts.audioBitrateKbps } : {}),
      });
      await runFfmpeg(args, { ...run, onLog });
      await opts.verify?.(partial);
    });

  if (plan.mode === 'copy') {
    const listPath = joinListPathFor(opts.outputPath);
    writeFileSync(listPath, buildConcatList(plan.files), 'utf8');
    try {
      await once(undefined, listPath);
    } finally {
      try {
        rmSync(listPath, { force: true });
      } catch {
        /* a leftover list is harmless */
      }
    }
    return {};
  }
  const { report } = await encodeWithFallback(opts.encoder ?? { primary: LIBX264 }, (encoder) => once(encoder, undefined), run.signal);
  return { encoder: report };
}

/** The encoders a re-encoding join uses here, as the render chooses them (encoder.ts). */
export async function joinEncodePlan(quality: RenderQuality | undefined, target: JoinTarget): Promise<VideoEncodePlan> {
  const wants = quality === 'fast' || quality === 'auto' || quality === undefined;
  const probe = wants ? await cachedHardwareEncoderProbe() : undefined;
  return planVideoEncode(quality ?? 'auto', probe, { width: target.width, height: target.height, fps: target.fps });
}

// -------------------------------------------------------------- cost estimate

/**
 * ffmpeg argv: encode `seconds` of `file` from `fromSec` exactly as a
 * re-encoding join would (same chain, same encoder), without sound. Pure.
 */
export function buildJoinSampleArgs(
  file: Pick<JoinPlanFile, 'path'>,
  target: JoinTarget,
  encoder: VideoEncoderChoice,
  fromSec: number,
  seconds: number,
  outputPath: string,
): string[] {
  const chain = joinVideoChain('', target, seconds, 'v').replace(/\[v\]$/, '');
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-ss',
    Math.max(0, fromSec).toFixed(3),
    '-t',
    seconds.toFixed(3),
    '-i',
    file.path,
    '-an',
    '-vf',
    chain,
    '-c:v',
    encoder.codec,
    ...encoder.args,
    outputPath,
  ];
}

/** What a test encode measured: × real time, and bytes per second of video. */
export interface JoinEncodeSample {
  speed: number;
  bytesPerSec: number;
  encoder: string;
}

/**
 * Time a short encode of `file` the way a re-encoding join would do it, to
 * tell the user what the re-encode costs BEFORE they agree to it (a 27.8-hour
 * source at an unknown speed is not a question anyone can answer). Encodes a
 * few seconds from the middle of the file to `scratchPath` and removes it.
 */
export async function measureJoinEncode(
  file: Pick<JoinPlanFile, 'path' | 'spanSec'>,
  target: JoinTarget,
  plan: VideoEncodePlan,
  scratchPath: string,
  opts: RunOptions = {},
  seconds = 4,
): Promise<JoinEncodeSample> {
  assertInputReadable(file.path);
  const length = Math.min(seconds, Math.max(0.5, file.spanSec));
  const from = Math.max(0, file.spanSec / 2 - length / 2);
  const tryOne = async (encoder: VideoEncoderChoice): Promise<JoinEncodeSample> => {
    const t0 = performance.now();
    try {
      await runFfmpeg(buildJoinSampleArgs(file, target, encoder, from, length, scratchPath), { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 });
      const elapsed = Math.max(0.001, (performance.now() - t0) / 1000);
      const size = statSync(scratchPath).size;
      return { speed: length / elapsed, bytesPerSec: size / length, encoder: encoder.codec };
    } finally {
      try {
        rmSync(scratchPath, { force: true });
      } catch {
        /* scratch */
      }
    }
  };
  const { result } = await encodeWithFallback(plan, tryOne, opts.signal);
  return result;
}

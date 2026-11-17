/**
 * H.264 encoder choice for the burned-in re-encode (the only render that is not
 * a stream copy).
 *
 * WHY A PROBE: the encoder used to be picked by NAME — present in
 * `ffmpeg -encoders` meant usable. The bundled ffmpeg 9.0.2 lists NVENC, QSV
 * and AMF on every machine, so an AMD- or Intel-only PC asking for "fast" got
 * h264_nvenc, which failed the render with no retry. Now each candidate must
 * finish a 0.2 s synthetic encode WITH THE EXACT ARGS the render will use; the
 * first that does wins, and the answer is cached for the process. Measured on
 * an RTX 3050 (driver 621.24): NVENC passes in ~0.25 s; QSV/AMF fail in
 * ~0.1 s each ("Error creating a MFX session", "amfrt64.dll failed to open").
 *
 * Quality settings, measured on 120 s of a real 720p30 burned-subtitle render
 * (VMAF against a lossless render of the same frames; libx264 medium CRF 20 =
 * VMAF 96.35 at 3.26 Mb/s in 19.4 s):
 *   NVENC p4 vbr cq23  -> VMAF 97.12, 3.66 Mb/s, 4.1 s   <- chosen
 *   NVENC p4 vbr cq24  -> VMAF 96.78, 3.26 Mb/s
 *   NVENC p5 vbr cq23  -> VMAF 97.14, 3.66 Mb/s, 6.9 s (70% slower, no gain)
 *   + spatial AQ / lookahead -> lower VMAF at a higher bitrate (4.27 Mb/s)
 * cq 23 keeps a margin over x264 because VMAF does not reward x264's psy
 * tuning; the cost is ~12% more bytes. QSV/AMF/VideoToolbox could not be
 * measured on that machine: their values follow the same "constant quality
 * just above the x264 match" reasoning and are marked as such below.
 *
 * Every encoder gets an 8-bit 4:2:0 pixel format: a 10-bit source otherwise
 * makes NVENC open a high-10 H.264 session, which it cannot do ("No capable
 * devices found") — reproduced on that machine, fixed by `-pix_fmt yuv420p`.
 */

import { AppErrorException, toAppError, type RenderQuality } from '@videodubber/shared';
import { listFfmpegEncoders, resolveFfmpegBinary, runFfmpeg } from './exec.js';

/** Frame size + rate of the video being encoded (bitrate-based modes need it). */
export interface EncodeGeometry {
  width: number;
  height: number;
  fps: number;
}

/** A concrete encoder invocation: `-c:v <codec> ...args`. */
export interface VideoEncoderChoice {
  codec: string;
  hardware: boolean;
  args: string[];
}

/** A hardware encoder the probe may try. */
export interface HardwareEncoderCandidate {
  codec: string;
  /**
   * VideoToolbox only. Constant quality (`-q:v`) exists on Apple Silicon; Intel
   * Macs are expected to reject it, so they get an average bitrate instead.
   */
  rateControl?: 'quality' | 'bitrate';
}

/** The software encoder: today's `quality` setting, and every fallback. */
export const LIBX264: VideoEncoderChoice = {
  codec: 'libx264',
  hardware: false,
  args: ['-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'],
};

/**
 * Hardware candidates in preference order. Pure.
 * macOS: VideoToolbox (quality mode first on arm64, bitrate mode as the second
 * try — also what an x64 build under Rosetta lands on). Elsewhere: NVIDIA,
 * then Intel, then AMD.
 */
export function hardwareEncoderCandidates(platform: NodeJS.Platform, arch: string): HardwareEncoderCandidate[] {
  if (platform === 'darwin') {
    const bitrate: HardwareEncoderCandidate = { codec: 'h264_videotoolbox', rateControl: 'bitrate' };
    return arch === 'arm64' ? [{ codec: 'h264_videotoolbox', rateControl: 'quality' }, bitrate] : [bitrate];
  }
  return [{ codec: 'h264_nvenc' }, { codec: 'h264_qsv' }, { codec: 'h264_amf' }];
}

/**
 * Average bitrate for VideoToolbox's bitrate mode, in kb/s. Pure.
 * x264 CRF 20 spent 0.118 bit/pixel on the measured 720p30 source; a hardware
 * H.264 encoder needs more for the same picture, so 0.2 bit/pixel (5.5 Mb/s at
 * 720p30, 12.4 Mb/s at 1080p30), clamped to a sane range. Not measured on an
 * Intel Mac.
 */
export function videoToolboxBitrateKbps(g: EncodeGeometry): number {
  const fps = Number.isFinite(g.fps) && g.fps > 0 ? g.fps : 30;
  const kbps = Math.round((Math.max(1, g.width) * Math.max(1, g.height) * fps * 0.2) / 1000);
  return Math.min(50_000, Math.max(1_500, kbps));
}

/** Quality-tuned args for one hardware candidate (see the module doc). Pure. */
export function hardwareEncoderArgs(candidate: HardwareEncoderCandidate, geometry: EncodeGeometry): string[] {
  switch (candidate.codec) {
    case 'h264_nvenc':
      // Measured (module doc). `-b:v 0` makes the CQ target pure; without it
      // NVENC's 2 Mb/s default bitrate is also handed to the rate control.
      return ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      // ICQ (global_quality without a bitrate). Not measured: no Intel GPU on
      // the reference machine. nv12 is QSV's only 8-bit input format (asking
      // for yuv420p just makes ffmpeg auto-select nv12 with a warning).
      return ['-preset', 'medium', '-global_quality', '22', '-pix_fmt', 'nv12'];
    case 'h264_amf':
      // Constant QP, the rate control every AMF generation has. Not measured:
      // no AMD GPU on the reference machine.
      return [
        '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp',
        '-qp_i', '20', '-qp_p', '22', '-qp_b', '24', '-pix_fmt', 'yuv420p',
      ];
    case 'h264_videotoolbox':
      // Not measured on a Mac. 55 is the value shipped before this change.
      return candidate.rateControl === 'bitrate'
        ? ['-b:v', `${videoToolboxBitrateKbps(geometry)}k`, '-pix_fmt', 'yuv420p']
        : ['-q:v', '55', '-pix_fmt', 'yuv420p'];
    default:
      return ['-pix_fmt', 'yuv420p'];
  }
}

/** The probe encodes a small synthetic picture: big enough for every encoder's minimum size. */
const PROBE_GEOMETRY: EncodeGeometry = { width: 320, height: 240, fps: 30 };

/** ffmpeg argv for the 0.2 s synthetic test encode of `candidate`. Pure. */
export function buildEncoderProbeArgs(candidate: HardwareEncoderCandidate): string[] {
  const { width, height, fps } = PROBE_GEOMETRY;
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=0.2`,
    '-an',
    '-c:v',
    candidate.codec,
    ...hardwareEncoderArgs(candidate, PROBE_GEOMETRY),
    '-f',
    'null',
    '-',
  ];
}

/** One candidate the probe looked at. */
export interface EncoderProbeAttempt {
  codec: string;
  rateControl?: 'quality' | 'bitrate';
  ok: boolean;
  /** Wall time of the test encode (0 when it was not attempted). */
  ms: number;
  /** Why it was rejected (first meaningful ffmpeg line). */
  error?: string;
}

/** What the probe found: the first working candidate, and why the others lost. */
export interface HardwareEncoderProbe {
  selected?: HardwareEncoderCandidate;
  attempts: EncoderProbeAttempt[];
}

/** Injectable I/O for {@link probeHardwareEncoders} (tests). */
export interface EncoderProbeDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Encoder names this ffmpeg lists (skips candidates it was built without). */
  listEncoders?: () => Promise<Set<string>>;
  /** Run one test encode; resolve = works, reject = does not. */
  tryEncode?: (args: string[]) => Promise<unknown>;
  now?: () => number;
}

/** A line that reports something failing. */
const FAILURE_LINE = /error|fail|unknown encoder|not supported|no capable|invalid|cannot|could not|unable/i;
/** Hardware encoders and their runtimes, as they name themselves in stderr. */
const HARDWARE_TOKEN = /nvenc|nvcuda|nvencodeapi|qsv|mfx|amf|amfrt|videotoolbox|vaapi|cuda/i;
/** Hardware-encoder failures that do not always carry the encoder's tag. */
const KNOWN_ENCODER_FAILURE =
  /no capable devices|openencodesession|mfx session|compression session|error while opening encoder|could not open encoder|unknown encoder|encoder not found/i;
/** libass reports on fonts at every burn; never an encoder's fault. */
const LIBASS_NOISE = /parsed_subtitles|libass|fontselect|memory font|loading font/i;
/** Failures another encoder would hit just the same: the disk, the input, permissions. */
const NOT_THE_ENCODER = /no space left on device|permission denied|invalid data found when processing input|error opening input|no such file or directory/i;

/** ffmpeg's stderr lines from a failure, minus libass's font chatter. */
function stderrLines(err: unknown): string[] {
  return `${toAppError(err).cause ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !LIBASS_NOISE.test(l));
}

/** Does this line blame the (hardware) encoder? */
function blamesEncoder(line: string, codec?: string): boolean {
  if (KNOWN_ENCODER_FAILURE.test(line)) return true;
  return FAILURE_LINE.test(line) && (HARDWARE_TOKEN.test(line) || (codec !== undefined && line.includes(codec)));
}

/**
 * The most useful line of an ffmpeg failure, without its `[h264_amf @ 0x…]`
 * prefix: the first line that blames the encoder, else the first that names a
 * failure, else the last line. The render runs at ffmpeg's default verbosity,
 * so its stderr opens with the version banner — "the first line" would always
 * be that — and with libass's font loading, whose "Error opening memory font"
 * was reported as the reason for every hardware fallback. Pure.
 */
export function summarizeEncoderError(err: unknown, codec?: string): string {
  const lines = stderrLines(err);
  const line =
    lines.find((l) => blamesEncoder(l, codec)) ?? lines.find((l) => FAILURE_LINE.test(l)) ?? lines[lines.length - 1];
  return (line ? line.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim() : toAppError(err).message).slice(0, 200);
}

/**
 * Try each hardware candidate for this platform in order; the first that
 * completes a real test encode is selected. Never throws.
 */
export async function probeHardwareEncoders(deps: EncoderProbeDeps = {}): Promise<HardwareEncoderProbe> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const listEncoders = deps.listEncoders ?? (() => listFfmpegEncoders());
  const tryEncode = deps.tryEncode ?? ((args: string[]) => runFfmpeg(args, { timeoutMs: 20_000 }));
  const now = deps.now ?? Date.now;

  let listed: Set<string>;
  try {
    listed = await listEncoders();
  } catch {
    listed = new Set();
  }
  const attempts: EncoderProbeAttempt[] = [];
  for (const candidate of hardwareEncoderCandidates(platform, arch)) {
    const base = { codec: candidate.codec, ...(candidate.rateControl ? { rateControl: candidate.rateControl } : {}) };
    if (!listed.has(candidate.codec)) {
      attempts.push({ ...base, ok: false, ms: 0, error: 'not in this ffmpeg build' });
      continue;
    }
    const t0 = now();
    try {
      await tryEncode(buildEncoderProbeArgs(candidate));
      attempts.push({ ...base, ok: true, ms: now() - t0 });
      return { selected: candidate, attempts };
    } catch (err) {
      attempts.push({ ...base, ok: false, ms: now() - t0, error: summarizeEncoderError(err, candidate.codec) });
    }
  }
  return { attempts };
}

const probeCache = new Map<string, Promise<HardwareEncoderProbe>>();

/**
 * {@link probeHardwareEncoders} once per process (per ffmpeg binary): the GPU
 * does not change mid-run, and every render would otherwise pay ~0.1-0.3 s per
 * candidate. The probe takes no cancellation signal on purpose, so a cancelled
 * render can never cache a "no hardware" answer.
 */
export function cachedHardwareEncoderProbe(): Promise<HardwareEncoderProbe> {
  const key = `${resolveFfmpegBinary()}|${process.platform}|${process.arch}`;
  const cached = probeCache.get(key);
  if (cached) return cached;
  // Concurrent renders share one probe; only a WORKING encoder is remembered.
  // "None works" can be temporary — the app's own CUDA engines filling the
  // card, another program holding the NVENC sessions — and remembering it
  // would put every later render of the session on x264. A failed probe costs
  // ~0.1 s per candidate, so it is simply tried again next render.
  const fresh = probeHardwareEncoders().then((probe) => {
    if (!probe.selected) probeCache.delete(key);
    return probe;
  });
  probeCache.set(key, fresh);
  return fresh;
}

/** Test seam: forget the cached probe. */
export function resetHardwareEncoderProbeCache(): void {
  probeCache.clear();
}

/** True when this render quality wants a hardware encoder (and so a probe). */
export function wantsHardwareEncoder(quality: RenderQuality | undefined): boolean {
  return quality === 'fast' || quality === 'auto';
}

/** The encoder to run first, and the one to retry with if it fails. */
export interface VideoEncodePlan {
  primary: VideoEncoderChoice;
  fallback?: VideoEncoderChoice;
}

/**
 * Choose the encoder(s) for a re-encode. Pure given the probe result.
 * `quality` (and unset) is x264 exactly as before; `fast`/`auto` use the
 * probed hardware encoder with x264 as the retry, or x264 alone when the probe
 * found nothing that works.
 */
export function planVideoEncode(
  quality: RenderQuality | undefined,
  probe: HardwareEncoderProbe | undefined,
  geometry: EncodeGeometry,
): VideoEncodePlan {
  const selected = probe?.selected;
  if (!wantsHardwareEncoder(quality) || !selected) return { primary: LIBX264 };
  return {
    primary: { codec: selected.codec, hardware: true, args: hardwareEncoderArgs(selected, geometry) },
    fallback: LIBX264,
  };
}

/** Which encoder produced the video, for the run log. */
export interface VideoEncodeReport {
  codec: string;
  hardware: boolean;
  /** Set when the planned hardware encoder failed and x264 re-did the encode. */
  fallbackFrom?: string;
  fallbackReason?: string;
}

/**
 * True for a failure the other encoder might not have: ffmpeg exited non-zero
 * AND its stderr blames the hardware encoder. Any non-zero exit used to count,
 * so a full disk, a corrupt input or a libass error during the hardware try
 * started a second, minutes-long x264 encode that failed the same way. Never
 * for cancel/timeout, a missing ffmpeg, or a filesystem error while publishing
 * the output (a rename that failed after a good encode).
 */
export function isEncoderFailure(err: unknown, codec?: string): boolean {
  if (!(err instanceof AppErrorException) || err.code !== 'UNKNOWN') return false;
  const lines = stderrLines(err);
  if (lines.some((l) => NOT_THE_ENCODER.test(l))) return false;
  return lines.some((l) => blamesEncoder(l, codec));
}

/**
 * Run `attempt` with the plan's primary encoder; if that fails like an encoder
 * failure, run it ONCE more with the fallback. `attempt` owns the atomic write,
 * so the failed try's partial file is already gone when the retry starts and
 * the destination only ever receives a complete encode.
 */
export async function encodeWithFallback<T>(
  plan: VideoEncodePlan,
  attempt: (encoder: VideoEncoderChoice) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ result: T; report: VideoEncodeReport }> {
  try {
    const result = await attempt(plan.primary);
    return { result, report: { codec: plan.primary.codec, hardware: plan.primary.hardware } };
  } catch (err) {
    if (!plan.fallback || signal?.aborted || !isEncoderFailure(err, plan.primary.codec)) throw err;
    const fallbackReason = summarizeEncoderError(err, plan.primary.codec);
    const result = await attempt(plan.fallback);
    return {
      result,
      report: {
        codec: plan.fallback.codec,
        hardware: plan.fallback.hardware,
        fallbackFrom: plan.primary.codec,
        fallbackReason,
      },
    };
  }
}

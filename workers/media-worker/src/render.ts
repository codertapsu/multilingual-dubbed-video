/**
 * Final video render.
 *
 * Muxes the source video with the dubbed audio. Subtitle handling depends on
 * RenderFinalVideoInput.subtitleExportMode:
 *
 *   none / srt-file / vtt-file:
 *     - copy the video stream (-c:v copy), encode audio (aac 192k)
 *     - -map 0:v:0 (video from input video) -map 1:a:0 (audio from dub)
 *     - for srt-file / vtt-file ALSO copy the sidecar subtitle next to the
 *       output and report its path in sidecarSubtitlePaths.
 *
 *   embedded-soft:
 *     - add the subtitle as a soft text stream: -map 2 -c:s mov_text (mp4).
 *
 *   burned-in:
 *     - re-encode the video with -vf subtitles=<escaped>:force_style=...
 *       (burning requires re-encode), aac audio.
 *
 * Arg-builders are pure (testable); renderFinalVideo spawns + probes duration.
 */

import { copyFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  AppErrorException,
  type RenderFinalVideoInput,
  type RenderFinalVideoResult,
  type RenderQuality,
  type SubtitleExportMode,
  type SubtitleStyle,
} from '@videodubber/shared';
import {
  assertInputReadable,
  assertOutputWritable,
  ffmpegHasFilter,
  listFfmpegEncoders,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { probeDurationMs } from './probe.js';
import { buildSubtitlesFilter } from './subtitles.js';

/**
 * Choose the H.264 video encoder for a re-encode (burned-in subtitles).
 * `quality` always uses software x264 (best size/quality). `fast` prefers a
 * hardware encoder when one is available for the platform:
 *   macOS  -> h264_videotoolbox
 *   others -> h264_nvenc (NVIDIA)
 * Falls back to libx264 when the requested hardware encoder is absent.
 *
 * Pure given `available` (the set of ffmpeg encoder names present).
 */
export function selectVideoCodec(
  quality: RenderQuality | undefined,
  platform: NodeJS.Platform,
  available: Set<string>,
): { codec: string; extraArgs: string[] } {
  if (quality === 'fast') {
    const hw = platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc';
    if (available.has(hw)) {
      // VideoToolbox uses -q:v (constant quality, Apple Silicon); NVENC uses -cq.
      const extraArgs = hw === 'h264_videotoolbox' ? ['-q:v', '55'] : ['-rc', 'vbr', '-cq', '23'];
      return { codec: hw, extraArgs };
    }
  }
  return { codec: 'libx264', extraArgs: ['-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'] };
}

/** Inputs needed to construct the ffmpeg argv (already-validated paths). */
export interface RenderArgsContext {
  inputVideoPath: string;
  audioPath: string;
  outputPath: string;
  subtitleExportMode: SubtitleExportMode;
  /** Path to the subtitle to embed/burn (required for embedded-soft/burned-in). */
  subtitlePath?: string;
  burnSubtitleStyle?: SubtitleStyle;
  copyVideoStream?: boolean;
  /** Platform override for subtitle path escaping (tests). */
  platform?: NodeJS.Platform;
  /** Video encoder for the burned-in re-encode (default libx264). */
  videoCodec?: string;
  /** Encoder-specific args (preset/crf for x264, q/cq for HW). */
  videoCodecArgs?: string[];
}

const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '192k'] as const;

/**
 * Build the ffmpeg argv array for a render. Pure function.
 * Throws TTS_VOICE_MISSING-adjacent config errors? No — it validates that a
 * subtitle path is present when the mode requires one (UNSUPPORTED_MEDIA is the
 * wrong code; we use UNKNOWN with a clear remediation, surfaced before spawn).
 */
export function buildRenderArgs(ctx: RenderArgsContext): string[] {
  const {
    inputVideoPath,
    audioPath,
    outputPath,
    subtitleExportMode,
    subtitlePath,
    burnSubtitleStyle,
    platform,
  } = ctx;
  const copyVideo = ctx.copyVideoStream !== false; // default true except burned-in
  // Encoder for re-encodes: default to software x264 unless the caller resolved
  // a hardware encoder (renderQuality "fast").
  const videoCodec = ctx.videoCodec ?? 'libx264';
  const videoCodecArgs = ctx.videoCodecArgs ?? ['-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];

  switch (subtitleExportMode) {
    case 'burned-in': {
      if (!subtitlePath) {
        throw missingSubtitle('burned-in');
      }
      // Burning requires a video re-encode; -c:v copy is impossible here.
      const filter = buildSubtitlesFilter(subtitlePath, burnSubtitleStyle, platform);
      return [
        '-y',
        '-i',
        inputVideoPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        filter,
        '-c:v',
        videoCodec,
        ...videoCodecArgs,
        ...AUDIO_ARGS,
        outputPath,
      ];
    }

    case 'embedded-soft': {
      if (!subtitlePath) {
        throw missingSubtitle('embedded-soft');
      }
      // Soft subtitle stream muxed in as mov_text (mp4-compatible).
      return [
        '-y',
        '-i',
        inputVideoPath,
        '-i',
        audioPath,
        '-i',
        subtitlePath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-map',
        '2:0',
        '-c:v',
        copyVideo ? 'copy' : 'libx264',
        ...AUDIO_ARGS,
        '-c:s',
        'mov_text',
        outputPath,
      ];
    }

    case 'none':
    case 'srt-file':
    case 'vtt-file':
    default: {
      // No subtitle inside the container; sidecar (if any) is copied separately.
      return [
        '-y',
        '-i',
        inputVideoPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        copyVideo ? 'copy' : 'libx264',
        ...AUDIO_ARGS,
        outputPath,
      ];
    }
  }
}

function missingSubtitle(mode: SubtitleExportMode): AppErrorException {
  return new AppErrorException({
    code: 'UNKNOWN',
    message: `subtitleExportMode "${mode}" requires a subtitlePath, but none was provided.`,
    remediation: 'Generate translated subtitles before rendering, or use mode "none".',
    docsRef: 'docs/TROUBLESHOOTING.md#subtitles',
  });
}

/**
 * Compute the sidecar destination path next to the output video for srt/vtt
 * file modes: <outputBasename>.srt / .vtt. Pure helper.
 */
export function sidecarDestinationPath(
  outputPath: string,
  mode: SubtitleExportMode,
): string | undefined {
  if (mode !== 'srt-file' && mode !== 'vtt-file') return undefined;
  const dir = dirname(outputPath);
  const base = basename(outputPath, extname(outputPath));
  const ext = mode === 'srt-file' ? '.srt' : '.vtt';
  return join(dir, `${base}${ext}`);
}

/** Render the final video and report duration + any sidecar subtitle paths. */
export async function renderFinalVideo(
  input: RenderFinalVideoInput,
  runOpts: RunOptions = {},
): Promise<RenderFinalVideoResult> {
  assertInputReadable(input.inputVideoPath);
  assertInputReadable(input.audioPath);
  assertOutputWritable(input.outputPath);

  // Burned-in subtitles use the libavfilter "subtitles" filter, which is only
  // present in an FFmpeg built with libass. Detect a missing filter up front so
  // we fail with a clear, actionable error instead of an opaque ffmpeg exit code.
  if (input.subtitleExportMode === 'burned-in') {
    if (!(await ffmpegHasFilter('subtitles', runOpts))) {
      throw new AppErrorException({
        code: 'FFMPEG_FILTER_MISSING',
        message:
          'Burned-in subtitles require an FFmpeg built with libass (the "subtitles" filter), which this FFmpeg lacks.',
        remediation:
          'Install an FFmpeg built with libass (macOS: `brew install ffmpeg-full`, then set FFMPEG_PATH/FFPROBE_PATH to it), or choose a different subtitle mode (embedded-soft / srt-file / vtt-file).',
        docsRef: 'docs/TROUBLESHOOTING.md#ffmpeg-filter-missing',
      });
    }
  }

  if (
    (input.subtitleExportMode === 'embedded-soft' ||
      input.subtitleExportMode === 'burned-in' ||
      input.subtitleExportMode === 'srt-file' ||
      input.subtitleExportMode === 'vtt-file') &&
    input.subtitlePath
  ) {
    assertInputReadable(input.subtitlePath);
  }

  // Resolve the re-encode codec only when we actually re-encode (burned-in).
  // For "fast" we pick a hardware encoder if this ffmpeg build has one.
  let videoCodec: string | undefined;
  let videoCodecArgs: string[] | undefined;
  if (input.subtitleExportMode === 'burned-in') {
    const encoders = await listFfmpegEncoders(runOpts);
    const sel = selectVideoCodec(input.renderQuality, process.platform, encoders);
    videoCodec = sel.codec;
    videoCodecArgs = sel.extraArgs;
  }

  const args = buildRenderArgs({
    inputVideoPath: input.inputVideoPath,
    audioPath: input.audioPath,
    outputPath: input.outputPath,
    subtitleExportMode: input.subtitleExportMode,
    subtitlePath: input.subtitlePath,
    burnSubtitleStyle: input.burnSubtitleStyle,
    // burned-in must re-encode; everything else may copy unless caller forbids.
    copyVideoStream:
      input.subtitleExportMode === 'burned-in' ? false : input.copyVideoStream,
    ...(videoCodec ? { videoCodec } : {}),
    ...(videoCodecArgs ? { videoCodecArgs } : {}),
  });

  await runFfmpeg(args, runOpts);

  // Copy sidecar subtitle next to the output for srt-file / vtt-file modes.
  const sidecarSubtitlePaths: string[] = [];
  const sidecarDest = sidecarDestinationPath(input.outputPath, input.subtitleExportMode);
  if (sidecarDest && input.subtitlePath) {
    assertInputReadable(input.subtitlePath);
    copyFileSync(input.subtitlePath, sidecarDest);
    sidecarSubtitlePaths.push(sidecarDest);
  }

  const durationMs = await probeDurationMs(input.outputPath);

  return {
    outputPath: input.outputPath,
    durationMs,
    sidecarSubtitlePaths,
  };
}

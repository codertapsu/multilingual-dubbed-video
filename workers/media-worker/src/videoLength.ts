/**
 * How long the PICTURE of a video runs, for the render's cap (`-t`).
 *
 * WHY: the mix's `amix` runs to its longest input and the render had no `-t`,
 * so an `original.wav` holding more samples than the picture (P4 of the
 * 27.8-hour series: +4.81 s over 2.73 h) made the finished video longer than
 * its picture, a frozen last frame under the tail of the sound (claude-dubber
 * report, 2026-11-23). The container's duration is no guide: it is the
 * longest stream's, the very audio that ran long.
 *
 * The video stream's own duration (MP4/MOV), else its DURATION tag
 * (Matroska/WebM write one per stream), else the container's (no worse than
 * before: no cap at all).
 */
import { runFfprobe, type RunOptions } from './exec.js';

/** ffprobe argv for {@link probeVideoLengthMs}. Pure. */
export function buildVideoLengthArgs(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=duration:stream_tags=DURATION:format=duration',
    '-print_format',
    'json',
    '-i',
    inputPath,
  ];
}

/** `HH:MM:SS.fraction` (a Matroska DURATION tag) -> ms, or undefined. */
function clockToMs(v: string | undefined): number | undefined {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v?.trim() ?? '');
  if (!m) return undefined;
  const ms = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : undefined;
}

/** Seconds as ffprobe prints them -> ms, or undefined. */
function secondsToMs(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

/** Parse {@link buildVideoLengthArgs} output: the picture's length in ms, 0 when unknown. Pure. */
export function parseVideoLengthMs(json: unknown): number {
  const j = json as { streams?: Array<{ duration?: string; tags?: Record<string, string> }>; format?: { duration?: string } };
  const s = j?.streams?.[0];
  if (!s) return 0;
  const tag = s.tags ? Object.entries(s.tags).find(([k]) => k.toUpperCase() === 'DURATION')?.[1] : undefined;
  return secondsToMs(s.duration) ?? clockToMs(tag) ?? secondsToMs(j.format?.duration) ?? 0;
}

/** The picture's length of `inputPath` in ms; 0 when it cannot be told (then nothing is capped). */
export async function probeVideoLengthMs(inputPath: string, opts: RunOptions = {}): Promise<number> {
  try {
    const { stdout } = await runFfprobe(buildVideoLengthArgs(inputPath), opts);
    return parseVideoLengthMs(JSON.parse(stdout));
  } catch (err) {
    // A cancel is a cancel; anything else only means "no cap", as before.
    if (opts.signal?.aborted) throw err;
    return 0;
  }
}

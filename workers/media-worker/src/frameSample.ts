/**
 * Small grey frames sampled over a video, for the picture detection
 * (pictureDetect.ts): no image library, only ffmpeg's `rawvideo` (one byte of
 * luma per pixel) read back as bytes.
 *
 * One short ffmpeg run per frame, each a FAST seek: `-noaccurate_seek` with
 * `-skip_frame nokey` decodes only the keyframe at or before the time asked,
 * ~0.1 s a frame on a 1080×1920 source, where an accurate seek decodes up to a
 * whole GOP (seconds) to reach the exact frame. So the frame is not exactly at
 * the time asked: its real time is read back from `showinfo` (the first frame
 * it reports, with timestamps counted from the seek point), and that is the
 * time the band detection compares with the transcript. Two times inside one
 * GOP give the same keyframe; the copy is dropped.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException } from '@videodubber/shared';

import { runFfmpeg, type RunOptions } from './exec.js';

/** One grey frame: `width`×`height` bytes of luma, at `atMs` of the input video. */
export interface GrayFrame {
  atMs: number;
  data: Uint8Array;
}

/** Seconds with millisecond precision, for ffmpeg. */
const sec = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * The analysis size for a `width`×`height` picture: its longer side at most
 * `longSide` (640: a 13-px-tall watermark and a 19-px subtitle line on a
 * portrait 1080×1920), even, the aspect kept. Pure.
 */
export function analysisSize(width: number, height: number, longSide = 640): { width: number; height: number } {
  const w = Math.max(2, width);
  const h = Math.max(2, height);
  const k = Math.min(1, longSide / Math.max(w, h));
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

/** The ffmpeg argv for one grey frame at (the keyframe before) `atMs`. Pure. */
export function buildFrameSampleArgs(input: string, atMs: number, size: { width: number; height: number }, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-ss',
    sec(atMs),
    '-noaccurate_seek',
    // Decoder option, so before -i: only keyframes are decoded.
    '-skip_frame',
    'nokey',
    '-i',
    input,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `showinfo,scale=${size.width}:${size.height}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-y',
    output,
  ];
}

/**
 * The time (s, from the seek point; negative = before it) of the frame
 * written: the FIRST frame `showinfo` reports (the graph may pass a few more
 * before ffmpeg stops). Pure.
 */
export function parseFirstFrameTime(stderr: string): number | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const m = /pts_time:\s*(-?[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?)/.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/**
 * Times spread evenly over `[startMs, endMs)` (each in the middle of its
 * share). Pure.
 */
export function spreadTimes(startMs: number, endMs: number, count: number): number[] {
  const span = Math.max(0, endMs - startMs);
  const n = Math.max(1, Math.floor(count));
  if (span <= 0) return [Math.max(0, startMs)];
  return Array.from({ length: n }, (_, i) => Math.round(startMs + ((i + 0.5) * span) / n));
}

/**
 * Grey frames of `input` near `timesMs` (sorted by real time, copies
 * dropped), at `size`. A time ffmpeg cannot give a frame for (past the end,
 * a broken GOP) is skipped. `onFrame` reports progress after each attempt.
 */
export async function sampleGrayFrames(
  input: string,
  timesMs: readonly number[],
  size: { width: number; height: number },
  opts: RunOptions & { onFrame?: (done: number, total: number) => void } = {},
): Promise<GrayFrame[]> {
  const { onFrame, ...run } = opts;
  const scratch = mkdtempSync(join(tmpdir(), 'vd-frames-'));
  const bytes = size.width * size.height;
  const frames: GrayFrame[] = [];
  const seen = new Set<number>();
  try {
    for (const [i, t] of timesMs.entries()) {
      if (run.signal?.aborted) break;
      const out = join(scratch, `f${i}.gray`);
      try {
        const { stderr } = await runFfmpeg(buildFrameSampleArgs(input, t, size, out), { timeoutMs: 60_000, ...run });
        const data = readFileSync(out);
        const rel = parseFirstFrameTime(stderr);
        const atMs = Math.max(0, Math.round(t + (rel ?? 0) * 1000));
        if (data.length === bytes && !seen.has(atMs)) {
          seen.add(atMs);
          frames.push({ atMs, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
        }
      } catch (err) {
        if (run.signal?.aborted) throw err;
        // No frame here (past the end, a damaged spot): the others still count.
      } finally {
        rmSync(out, { force: true });
      }
      onFrame?.(i + 1, timesMs.length);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (run.signal?.aborted) throw new AppErrorException('CANCELLED', 'The picture detection was cancelled.');
  return frames.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Single pictures of a video, for two uses that need few frames, not a pass
 * over the whole film:
 *
 * - The post's thumbnail: one JPEG from the finished video, taken where no
 *   subtitle is on screen (the orchestrator picks the moment), written
 *   atomically beside the video like every other output.
 * - Scene changes near the places a long video could be cut into parts
 *   (series/): `select='gt(scene,…)'` over a few seconds around each candidate
 *   pause, decoded at 160 px. A cut on a change of shot reads as a chapter; a
 *   cut inside one shot reads as an interruption. Measured only around the
 *   candidates: a two-hour film decoded in full would cost minutes for a
 *   handful of seconds that matter.
 */
import { writeAtomically } from './atomic.js';
import { assertInputReadable, assertOutputWritable, runFfmpeg, type RunOptions } from './exec.js';

/** Seconds, as ffmpeg takes them. */
const sec = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);

/** A thumbnail is at most this wide (a post shows less; a phone screen is ~1080). */
export const THUMBNAIL_MAX_WIDTH = 1280;

/** How different two frames must be to count as a change of shot (ffmpeg's scene score, 0..1). */
export const SCENE_THRESHOLD = 0.35;

/** The ffmpeg argv for one JPEG at `atMs`. Pure. */
export function buildThumbnailArgs(input: string, atMs: number, output: string): string[] {
  return [
    '-y',
    '-ss',
    sec(atMs),
    '-i',
    input,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-vf',
    `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
    '-q:v',
    '3',
    output,
  ];
}

/** One JPEG of `input` at `atMs`, written atomically to `output`. */
export async function renderThumbnail(input: string, atMs: number, output: string, opts: RunOptions = {}): Promise<{ path: string }> {
  assertInputReadable(input);
  assertOutputWritable(output);
  await writeAtomically(output, (partial) => runFfmpeg(buildThumbnailArgs(input, atMs, partial), opts));
  return { path: output };
}

/** A stretch of the video, in ms. */
export interface FrameSpan {
  startMs: number;
  endMs: number;
}

/** The ffmpeg argv that prints a `showinfo` line for every change of shot in `span`. Pure. */
export function buildSceneArgs(input: string, span: FrameSpan, threshold = SCENE_THRESHOLD): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    sec(span.startMs),
    '-t',
    sec(Math.max(1, span.endMs - span.startMs)),
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `scale=160:-2,select='gt(scene,${threshold})',showinfo`,
    '-f',
    'null',
    '-',
  ];
}

/**
 * The changes of shot `showinfo` reported, in ms of the whole video. With the
 * seek before `-i`, timestamps restart at the seek point, so `offsetMs` (the
 * span's start) is added back. Pure.
 */
export function parseSceneTimes(stderr: string, offsetMs: number): number[] {
  const out: number[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('showinfo')) continue;
    const m = /pts_time:\s*(-?[0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (!m) continue;
    const t = Number(m[1]);
    if (Number.isFinite(t) && t >= 0) out.push(Math.round(offsetMs + t * 1000));
  }
  return out;
}

/** Overlapping or touching spans as one, sorted. Pure. */
export function mergeSpans(spans: readonly FrameSpan[]): FrameSpan[] {
  const sorted = spans
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .map((s) => ({ startMs: Math.max(0, s.startMs), endMs: s.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: FrameSpan[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/**
 * The changes of shot inside the given spans of `input` (ms of the whole
 * video, sorted). One short ffmpeg run per merged span, one after another.
 */
export async function detectSceneChanges(
  input: string,
  spans: readonly FrameSpan[],
  opts: RunOptions & { threshold?: number } = {},
): Promise<number[]> {
  assertInputReadable(input);
  const { threshold, ...run } = opts;
  const found: number[] = [];
  for (const span of mergeSpans(spans)) {
    if (run.signal?.aborted) break;
    const { stderr } = await runFfmpeg(buildSceneArgs(input, span, threshold), run);
    for (const t of parseSceneTimes(stderr, span.startMs)) if (t <= span.endMs) found.push(t);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

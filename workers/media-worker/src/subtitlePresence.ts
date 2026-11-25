/**
 * When the source's own burned-in subtitles are on screen.
 *
 * The band they sit in (picture detection's, or the one the user set) is read
 * at five frames a second, shrunk to a strip of 640×32 grey pixels, and each
 * frame is scored without any OCR: bright pixels on a sharp horizontal step
 * are text strokes, and the columns holding them tell one subtitle from the
 * next (a new subtitle is a new set of columns). claude-dubber's detector
 * (tools/subtitle_presence.py), from which the measures and thresholds come,
 * separated the 4,066 subtitles of 《反相之地》 this way in about five minutes
 * for 4 h of video, with no text found on bright backgrounds; the 777 with no
 * transcript line under them were the speech the loop check had lost
 * (2026-11-25). Pure helpers, plus one streaming ffmpeg pass.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { AppErrorException } from '@videodubber/shared';

import { assertInputReadable, resolveFfmpegBinary, type RunOptions } from './exec.js';
import { probeVideoGeometry } from './probe.js';

/** Frames read per second. */
export const PRESENCE_FPS = 5;
/** The strip each frame's band is shrunk to. */
export const PRESENCE_WIDTH = 640;
export const PRESENCE_HEIGHT = 32;
/** A text pixel is at least this bright… */
const TEXT_BRIGHT = 200;
/** …and this much brighter than the pixel two to its left or right (a stroke's edge). */
const TEXT_STEP = 90;
/** A frame shows a subtitle with this many stroke pixels in this many columns. */
const MIN_EDGES = 50;
const MIN_COLUMNS = 10;
/** Two frames show the same subtitle when their columns overlap this much (Jaccard). */
const SAME_TEXT = 0.55;
/** A subtitle may flicker off for this long and still be one. */
const MAX_GAP_MS = 450;
/** A subtitle is on screen for at least two frames: one is a flash of the picture. */
const MIN_FRAMES = 2;

/** One frame's band: how much text it shows, and where. */
export interface BandScore {
  /** Stroke pixels: bright, on a sharp horizontal step. */
  edges: number;
  /** Columns holding one. */
  columns: number;
  /** Those columns, one bit each (for "is this the same subtitle"). */
  signature: Uint8Array;
}

/** Score one grey `width`×`height` strip (see the module doc). Pure. */
export function scoreBand(frame: Uint8Array, width: number, height: number): BandScore {
  const signature = new Uint8Array(Math.ceil(width / 8));
  let edges = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = frame[row + x]!;
      if (v < TEXT_BRIGHT) continue;
      const left = x >= 2 ? v - frame[row + x - 2]! : 0;
      const right = x + 2 < width ? v - frame[row + x + 2]! : 0;
      if (left >= TEXT_STEP || right >= TEXT_STEP) {
        edges += 1;
        signature[x >> 3]! |= 1 << (x & 7);
      }
    }
  }
  let columns = 0;
  for (const byte of signature) columns += bitCount(byte);
  return { edges, columns, signature };
}

function bitCount(byte: number): number {
  let n = byte;
  let c = 0;
  while (n) {
    n &= n - 1;
    c += 1;
  }
  return c;
}

/** Whether a frame shows a subtitle. Pure. */
export function showsText(score: Pick<BandScore, 'edges' | 'columns'>): boolean {
  return score.edges >= MIN_EDGES && score.columns >= MIN_COLUMNS;
}

/** Share of the columns two frames have in common (1 when both are empty). Pure. */
export function sameColumns(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    both += bitCount(x & y);
    either += bitCount(x | y);
  }
  return either === 0 ? 1 : both / either;
}

/** A subtitle on screen: from its first frame to the end of its last. */
export interface SubtitleEvent {
  startMs: number;
  endMs: number;
}

/**
 * The subtitles in a run of scored frames (`frameMs` apart, in time order):
 * frames with text that follow each other (within {@link MAX_GAP_MS}) and keep
 * their columns are one subtitle; a new set of columns starts the next. A
 * subtitle seen in only one frame is dropped. Pure.
 */
export function subtitleEvents(frames: readonly { atMs: number; score: BandScore }[], frameMs: number): SubtitleEvent[] {
  const out: SubtitleEvent[] = [];
  let open: { startMs: number; lastMs: number; signature: Uint8Array; columns: number; frames: number } | undefined;
  const close = (): void => {
    if (open && open.frames >= MIN_FRAMES) out.push({ startMs: open.startMs, endMs: Math.round(open.lastMs + frameMs) });
    open = undefined;
  };
  for (const { atMs, score } of frames) {
    if (!showsText(score)) continue;
    if (open && atMs - open.lastMs <= MAX_GAP_MS && sameColumns(open.signature, score.signature) >= SAME_TEXT) {
      open.lastMs = atMs;
      open.frames += 1;
      // The widest view of the subtitle is the one to compare the next frame with.
      if (score.columns > open.columns) {
        open.signature = score.signature;
        open.columns = score.columns;
      }
      continue;
    }
    close();
    open = { startMs: atMs, lastMs: atMs, signature: score.signature, columns: score.columns, frames: 1 };
  }
  close();
  return out;
}

/** The band to read, as shares of the picture (x and w default to the middle 80 %). */
export interface PresenceBand {
  y: number;
  h: number;
  x?: number;
  w?: number;
}

/** The crop of a `width`×`height` picture that holds the band, in even pixels (ffmpeg's yuv crops want them). Pure. */
export function bandCrop(band: PresenceBand, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const even = (v: number): number => Math.max(0, Math.floor(v / 2) * 2);
  const share = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
  const x = even(share(band.x, 0.1) * width);
  const y = even(share(band.y, 0.9) * height);
  const w = Math.max(16, even(Math.min(width - x, share(band.w, 0.8) * width)));
  const h = Math.max(8, even(Math.min(height - y, share(band.h, 0.06) * height)));
  return { x, y, w, h };
}

/** The ffmpeg arguments: the window, five frames a second, the band as grey 640×32 raw frames on stdout. Pure. */
export function buildPresenceArgs(input: string, crop: { x: number; y: number; w: number; h: number }, window: { startMs: number; endMs?: number }): string[] {
  const seconds = (ms: number): string => (ms / 1000).toFixed(3);
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    // Only the frames others are built from are decoded: five a second are read anyway.
    '-skip_frame',
    'noref',
    ...(window.startMs > 0 ? ['-ss', seconds(window.startMs)] : []),
    ...(window.endMs !== undefined ? ['-t', seconds(Math.max(1, window.endMs - window.startMs))] : []),
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=${PRESENCE_FPS},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${PRESENCE_WIDTH}:${PRESENCE_HEIGHT}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ];
}

/** What to read. */
export interface SubtitlePresenceInput {
  videoPath: string;
  band: PresenceBand;
  /** The window of the input (ms); default all of it. */
  startMs?: number;
  endMs?: number;
}

/** When subtitles were on screen, in the input's time. */
export interface SubtitlePresence {
  fps: number;
  startMs: number;
  endMs: number;
  /** Frames read. */
  frames: number;
  /** Frames that showed text. */
  framesWithText: number;
  events: SubtitleEvent[];
}

export interface SubtitlePresenceOptions extends RunOptions {
  /** 0–1 as the frames are read (when the window's length is known). */
  onProgress?: (fraction: number) => void;
}

/**
 * Run ffmpeg and hand every raw frame of `frameBytes` it writes to `onFrame`
 * (numbered from 0), streamed: a 4-hour video is 72,000 frames, never all in
 * memory. `expected` frames, when known, drive `onProgress`.
 */
function streamFrames(
  args: string[],
  frameBytes: number,
  onFrame: (frame: Uint8Array, k: number) => void,
  opts: RunOptions & { onProgress?: (fraction: number) => void; expected?: number; what: string },
): Promise<number> {
  const { onProgress, expected, what, ...run } = opts;
  return new Promise<number>((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(new AppErrorException('CANCELLED', `${what} was cancelled before it started.`));
      return;
    }
    const child = spawn(resolveFfmpegBinary(), args, { shell: false, windowsHide: true });
    let pending: Buffer = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    let lastReport = -1;
    let count = 0;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AppErrorException('WORKER_TIMEOUT', `${what} took too long.`)));
    }, run.timeoutMs ?? 10 * 60_000);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => reject(new AppErrorException('CANCELLED', `${what} was cancelled.`)));
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      try {
        while (pending.length - at >= frameBytes) {
          onFrame(new Uint8Array(pending.buffer, pending.byteOffset + at, frameBytes), count);
          count += 1;
          at += frameBytes;
        }
      } catch (err) {
        child.kill('SIGKILL');
        finish(() => reject(err));
        return;
      }
      pending = Buffer.from(pending.subarray(at));
      if (expected && onProgress) {
        const step = Math.floor((count / expected) * 50);
        if (step !== lastReport) {
          lastReport = step;
          onProgress(Math.min(1, count / expected));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new AppErrorException('FFMPEG_NOT_FOUND', 'ffmpeg was not found.')
            : new AppErrorException('UNKNOWN', `Could not start ffmpeg: ${err.message}`),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (code !== 0) {
          reject(new AppErrorException('UNSUPPORTED_MEDIA', `ffmpeg could not read the picture (${what}).`, { cause: stderr.trim().slice(-800) }));
          return;
        }
        resolve(count);
      }),
    );
  });
}

/** Decoding is the cost: allow a slow machine a quarter of real time, never under ten minutes. */
function decodeTimeoutMs(startMs: number, endMs: number | undefined): number {
  return Math.max(10 * 60_000, Math.round(((endMs ?? startMs + 3_600_000) - startMs) / 4));
}

/**
 * Read the band over the window and return its subtitles. One ffmpeg pass,
 * streamed: a 4-hour video is 72,000 small frames, never all in memory.
 */
export async function scanSubtitlePresence(input: SubtitlePresenceInput, opts: SubtitlePresenceOptions = {}): Promise<SubtitlePresence> {
  assertInputReadable(input.videoPath);
  const { onProgress, ...run } = opts;
  const geometry = await probeVideoGeometry(input.videoPath, run);
  const startMs = Math.max(0, Math.round(input.startMs ?? 0));
  const endMs = input.endMs !== undefined ? Math.round(input.endMs) : geometry.durationMs > 0 ? Math.round(geometry.durationMs) : undefined;
  const crop = bandCrop(input.band, geometry.width, geometry.height);
  const args = buildPresenceArgs(input.videoPath, crop, { startMs, ...(endMs !== undefined ? { endMs } : {}) });
  const frameMs = 1000 / PRESENCE_FPS;
  const expected = endMs !== undefined ? Math.max(1, Math.round(((endMs - startMs) / 1000) * PRESENCE_FPS)) : undefined;

  const scored: { atMs: number; score: BandScore }[] = [];
  let withText = 0;
  await streamFrames(
    args,
    PRESENCE_WIDTH * PRESENCE_HEIGHT,
    (frame, k) => {
      const score = scoreBand(frame, PRESENCE_WIDTH, PRESENCE_HEIGHT);
      if (showsText(score)) withText += 1;
      scored.push({ atMs: Math.round(startMs + k * frameMs), score });
    },
    {
      ...run,
      timeoutMs: run.timeoutMs ?? decodeTimeoutMs(startMs, endMs),
      ...(onProgress ? { onProgress } : {}),
      ...(expected ? { expected } : {}),
      what: 'Reading the subtitles in the picture',
    },
  );

  const lastMs = scored.length > 0 ? scored[scored.length - 1]!.atMs + frameMs : startMs;
  return {
    fps: PRESENCE_FPS,
    startMs,
    endMs: Math.round(endMs ?? lastMs),
    frames: scored.length,
    framesWithText: withText,
    events: subtitleEvents(scored, frameMs),
  };
}

// ---- The frames the subtitle reader reads (ocr-rapid) ------------------------

/** The band's frames are cut at most this tall for reading (a 4K band is shrunk; a 1080p one kept). */
export const READ_MAX_HEIGHT = 96;

/** The size the band is cut at for reading: its own pixels up to {@link READ_MAX_HEIGHT} high, even. Pure. */
export function readSize(crop: { w: number; h: number }, maxHeight = READ_MAX_HEIGHT): { width: number; height: number } {
  const height = Math.max(16, Math.floor(Math.min(crop.h, maxHeight) / 2) * 2);
  const width = Math.max(16, Math.floor(Math.round((crop.w * height) / Math.max(1, crop.h)) / 2) * 2);
  return { width, height };
}

/** What to cut. */
export interface BandFramesInput {
  videoPath: string;
  band: PresenceBand;
  /** One frame per time (ms of the input), e.g. one inside each subtitle. */
  timesMs: readonly number[];
  /** The raw file written: the frames one after another, width × height grey bytes each. */
  outputPath: string;
}

/** What was cut. */
export interface BandFrames {
  width: number;
  height: number;
  /** Frames in the file. */
  count: number;
  /** For each time asked, the frame of the file that shows it (several times can share one). */
  indexOf: number[];
}

/**
 * One grey frame of the band for each time asked, at reading size, into one
 * raw file (no image encoding on either side: the reader maps the file). One
 * pass at five frames a second over the span the times cover, keeping the
 * frame nearest each time.
 */
export async function readBandFrames(input: BandFramesInput, opts: SubtitlePresenceOptions = {}): Promise<BandFrames> {
  assertInputReadable(input.videoPath);
  const { onProgress, ...run } = opts;
  if (input.timesMs.length === 0) {
    writeFileSync(input.outputPath, new Uint8Array(0));
    return { width: 0, height: 0, count: 0, indexOf: [] };
  }
  const geometry = await probeVideoGeometry(input.videoPath, run);
  const crop = bandCrop(input.band, geometry.width, geometry.height);
  const size = readSize(crop);
  const frameMs = 1000 / PRESENCE_FPS;
  const startMs = Math.max(0, Math.floor((Math.min(...input.timesMs) - frameMs) / frameMs) * frameMs);
  const endMs = Math.max(...input.timesMs) + 2 * frameMs;
  // Which stream frame each time wants, and which file frame each kept stream frame becomes.
  const wanted = input.timesMs.map((t) => Math.max(0, Math.round((t - startMs) / frameMs)));
  const keep = [...new Set(wanted)].sort((a, b) => a - b);
  const fileIndex = new Map(keep.map((k, i) => [k, i]));
  const lastWanted = keep[keep.length - 1]!;
  const args = buildPresenceArgs(input.videoPath, crop, { startMs, endMs }).map((a) =>
    a.startsWith(`fps=${PRESENCE_FPS},crop=`) ? a.replace(/scale=\d+:\d+:flags=area/, `scale=${size.width}:${size.height}:flags=area`) : a,
  );
  const fd = openSync(input.outputPath, 'w');
  let written = 0;
  let lastFrame: Uint8Array | undefined;
  try {
    await streamFrames(
      args,
      size.width * size.height,
      (frame, k) => {
        if (fileIndex.has(k)) {
          writeSync(fd, frame);
          written += 1;
        }
        lastFrame = k >= lastWanted - 2 ? Uint8Array.from(frame) : lastFrame;
      },
      {
        ...run,
        timeoutMs: run.timeoutMs ?? decodeTimeoutMs(startMs, endMs),
        ...(onProgress ? { onProgress } : {}),
        expected: Math.max(1, lastWanted + 1),
        what: "Cutting the subtitles' frames",
      },
    );
    // A time at the very end can fall past the last frame decoded: it gets the last one.
    while (written < keep.length && lastFrame) {
      writeSync(fd, lastFrame);
      written += 1;
    }
  } finally {
    closeSync(fd);
  }
  if (written < keep.length) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', `Only ${written} of the ${keep.length} subtitle frames could be cut from the picture.`);
  }
  return { width: size.width, height: size.height, count: keep.length, indexOf: wanted.map((k) => fileIndex.get(k)!) };
}

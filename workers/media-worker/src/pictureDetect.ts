/**
 * Picture detection, end to end: sample small grey frames over a video
 * (frameSample.ts), find a still watermark in the corners and the band of the
 * source's own subtitles (pictureAnalysis.ts), and write a frame to check it
 * by eye with the boxes drawn on it. No AI: a moving mark, or a second
 * opinion on a box, is for an AI the user asks (the MCP hands it the
 * preview's path).
 *
 * A source joined from several files (Project.inputFiles) is looked at file
 * by file: each upload can carry its own mark, so each box keeps the time of
 * the file it was found in, and boxes found in the same place in files next
 * to each other become one. The band is one for the whole video.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AdTailFinding, PictureDetection, WatermarkProposal } from '@videodubber/shared';

import { findLateOverlay, overlayShown, SHOWN_SHARE, type LateOverlay } from './adTail.js';
import { writeAtomically } from './atomic.js';
import { assertInputReadable, runFfmpeg, type RunOptions } from './exec.js';
import { analysisSize, sampleGrayFrames, spreadTimes, type GrayFrame } from './frameSample.js';
import { findStaticMarks, findSubtitleBand, labelTimes, rowStrokeProfile, type RowProfile } from './pictureAnalysis.js';
import { probeVideoGeometry } from './probe.js';
import { probeVideoLengthMs } from './videoLength.js';

/** What to look at. Times are the input video's (ms). */
export interface DetectPictureInput {
  videoPath: string;
  /**
   * Where to look: one window per file of a joined source (with its name),
   * else one; `endMs` absent = to the end. Absent: the whole video.
   */
  segments?: { startMs: number; endMs?: number; fileName?: string }[];
  /** The transcript's lines: frames while someone speaks against frames in silence find the band. */
  lines?: { startMs: number; endMs: number }[];
  /** Look for watermarks (default true) / the subtitle band (default true). */
  watermark?: boolean;
  band?: boolean;
  /** Frames to look at in all (default 100); at least 40 per file of a joined source. */
  frames?: number;
  /**
   * Look for an advert tail (adTail.ts). Default: when what is looked at
   * starts at the video's start and lasts 20 minutes at least (a series
   * part, a window of its parent, is never asked).
   */
  adTail?: boolean;
  /** Where `frame.jpg` and `preview.jpg` go; absent: no pictures are written. */
  outputDir?: string;
}

export interface DetectPictureOptions extends RunOptions {
  /** 0–1 and what it is doing, after each frame. */
  onProgress?: (fraction: number, message: string) => void;
}

/** The long side of the frames written for the eye (and the editor's picture). */
export const FRAME_LONG_SIDE = 960;

const sec = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(3);
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Boxes and a band drawn on a frame, in that frame's pixels. */
export interface FrameDrawing {
  boxes: { x: number; y: number; w: number; h: number }[];
  band?: { y: number; h: number };
}

/**
 * The ffmpeg argv for one JPEG of `input` at `atMs` (an accurate seek), at
 * `size`, with `draw`'s boxes (red) and band (yellow) on it. drawbox, not
 * drawtext: no font to find. Pure.
 */
export function buildPictureFrameArgs(
  input: string,
  atMs: number,
  size: { width: number; height: number },
  output: string,
  draw?: FrameDrawing,
): string[] {
  const vf = [`scale=${size.width}:${size.height}:flags=bicubic`, 'setsar=1'];
  const t = Math.max(2, Math.round(Math.min(size.width, size.height) / 240));
  for (const b of draw?.boxes ?? []) vf.push(`drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=red@0.95:t=${t}`);
  if (draw?.band) vf.push(`drawbox=x=0:y=${draw.band.y}:w=iw:h=${draw.band.h}:color=yellow@0.95:t=${t}`);
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-ss',
    sec(atMs),
    '-i',
    input,
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    vf.join(','),
    '-q:v',
    '3',
    '-update',
    '1',
    '-y',
    output,
  ];
}

/**
 * Boxes found in several files of a joined source as regions: the same place
 * (same corner, overlapping by half) in files next to each other is one
 * region over their time; a region over every file has no time at all. Pure.
 */
export function mergeAcrossSegments(
  found: readonly { segment: { startMs: number; endMs: number; fileName?: string }; marks: readonly WatermarkProposal[] }[],
): WatermarkProposal[] {
  if (found.length <= 1) return found[0]?.marks.map(({ startMs: _s, endMs: _e, fileName: _f, ...m }) => m) ?? [];
  const iou = (a: WatermarkProposal, b: WatermarkProposal): number => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  };
  // A mark found at the same place in most files of a join is the uploader's,
  // and a file where nothing at all was found missed it: it takes the mark
  // too. Phong Thủy Thiên Sư's P1 (1920x804, padded into the 1920x822 join)
  // showed "每天看亿会 bilibili" where P2–P4 did, and was left unblurred
  // (claude-dubber, 2026-11-27). A file with marks of its own elsewhere keeps
  // only those: it may come from another uploader.
  const places: { mark: WatermarkProposal; segments: Set<number> }[] = [];
  for (const [si, { marks }] of found.entries()) {
    for (const m of marks) {
      const place = places.find((p) => p.mark.corner === m.corner && iou(p.mark, m) >= 0.5);
      if (place) place.segments.add(si);
      else places.push({ mark: m, segments: new Set([si]) });
    }
  }
  const usual = places.filter((p) => p.segments.size >= 2 && p.segments.size * 2 > found.length).map((p) => p.mark);
  const filled = found.map((f) => (f.marks.length === 0 && usual.length > 0 ? { ...f, marks: usual } : f));

  const open: { region: WatermarkProposal; lastSegment: number; files: string[] }[] = [];
  for (const [si, { segment, marks }] of filled.entries()) {
    for (const m of marks) {
      const same = open.find((o) => o.lastSegment === si - 1 && o.region.corner === m.corner && iou(o.region, m) >= 0.5);
      if (same) {
        const r = same.region;
        const x0 = Math.min(r.x, m.x);
        const y0 = Math.min(r.y, m.y);
        same.region = {
          ...r,
          x: x0,
          y: y0,
          w: round4(Math.max(r.x + r.w, m.x + m.w) - x0),
          h: round4(Math.max(r.y + r.h, m.y + m.h) - y0),
          endMs: segment.endMs,
          confidence: Math.max(r.confidence, m.confidence),
        };
        same.lastSegment = si;
        if (segment.fileName) same.files.push(segment.fileName);
      } else {
        open.push({
          region: { ...m, startMs: segment.startMs, endMs: segment.endMs },
          lastSegment: si,
          files: segment.fileName ? [segment.fileName] : [],
        });
      }
    }
  }
  const first = found[0]!.segment.startMs;
  const last = found[found.length - 1]!.segment.endMs;
  return open.map(({ region, files }) => {
    const { startMs, endMs, fileName: _f, ...rest } = region;
    if (startMs === first && endMs === last) return rest;
    return { ...rest, ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}), ...(files.length > 0 ? { fileName: files.join(', ') } : {}) };
  });
}

/** Write one JPEG of `videoPath` at `atMs` (long side {@link FRAME_LONG_SIDE}), atomically. */
export async function renderPictureFrame(
  videoPath: string,
  atMs: number,
  output: string,
  opts: RunOptions & { draw?: FrameDrawing; size?: { width: number; height: number } } = {},
): Promise<{ path: string; width: number; height: number }> {
  const { draw, size: given, ...run } = opts;
  assertInputReadable(videoPath);
  let size = given;
  if (!size) {
    const g = await probeVideoGeometry(videoPath, run);
    size = analysisSize(g.width, g.height, FRAME_LONG_SIDE);
  }
  const at = size;
  await writeAtomically(output, (partial) => runFfmpeg(buildPictureFrameArgs(videoPath, atMs, at, partial, draw), run));
  return { path: output, ...at };
}

/** Look for watermarks and the subtitle band in `input.videoPath`. */
export async function detectPicture(input: DetectPictureInput, opts: DetectPictureOptions = {}): Promise<PictureDetection> {
  const { onProgress, ...run } = opts;
  assertInputReadable(input.videoPath);
  const geometry = await probeVideoGeometry(input.videoPath, run);
  const videoMs = (await probeVideoLengthMs(input.videoPath, run)) || geometry.durationMs;
  const wantMarks = input.watermark !== false;
  const wantBand = input.band !== false;

  const asked = input.segments?.length ? input.segments : [{ startMs: 0 }];
  const segments = asked
    .map((s) => ({
      startMs: Math.max(0, s.startMs),
      endMs: Math.min(s.endMs ?? (videoMs || s.startMs + 1), videoMs || Number.MAX_SAFE_INTEGER),
      ...(s.fileName ? { fileName: s.fileName } : {}),
    }))
    .filter((s) => s.endMs > s.startMs);
  const total = Math.max(8, Math.round(input.frames ?? 100));
  const perSegment = segments.length > 1 ? Math.max(40, Math.ceil(total / segments.length)) : total;
  const size = analysisSize(geometry.width, geometry.height);

  const sampled: GrayFrame[][] = [];
  let looked = 0;
  for (const [si, segment] of segments.entries()) {
    const frames = await sampleGrayFrames(input.videoPath, spreadTimes(segment.startMs, segment.endMs, perSegment), size, {
      ...run,
      onFrame: (done, of) =>
        onProgress?.(
          (si + done / of) / segments.length,
          segments.length > 1 ? `Looking at frames of ${segment.fileName ?? `file ${si + 1}`} (${done}/${of})` : `Looking at frames (${done}/${of})`,
        ),
    });
    looked += frames.length;
    sampled.push(frames);
  }

  // An advert tail first: its frames stay out of the watermark and band
  // search, which locked onto its banner (y 0.51 for subtitles at 0.88).
  const notes: string[] = [];
  const first = segments[0]?.startMs ?? 0;
  const last = segments[segments.length - 1]?.endMs ?? 0;
  const lookForTail = input.adTail ?? (first === 0 && last - first >= TAIL_MIN_VIDEO_MS);
  let adTail: AdTailFinding | undefined;
  if (lookForTail) {
    const all = sampled.flat().sort((a, b) => a.atMs - b.atMs);
    const overlay = findLateOverlay(all, size.width, size.height, { videoMs: last });
    if (overlay) {
      const fromMs = await refineTailStart(input.videoPath, overlay, size, all[overlay.index - 1]!.atMs, all[overlay.index]!.atMs, run);
      adTail = {
        fromMs,
        box: { x: round4(overlay.x / size.width), y: round4(overlay.y / size.height), w: round4(overlay.w / size.width), h: round4(overlay.h / size.height) },
        confidence: overlay.confidence,
      };
      notes.push(
        `From ${clockOf(fromMs)} to the end the same block stays on the picture, as an advert's banner does: those frames were left out of the watermark and subtitle search.`,
      );
    }
  }
  const drama = (frames: readonly GrayFrame[]): GrayFrame[] => (adTail ? frames.filter((f) => f.atMs < adTail.fromMs) : [...frames]);

  const found: { segment: (typeof segments)[number]; marks: WatermarkProposal[] }[] = [];
  const profiles: RowProfile[] = [];
  for (const [si, segment] of segments.entries()) {
    const frames = drama(sampled[si] ?? []);
    if (wantMarks) {
      const marks = findStaticMarks(
        frames.map((f) => f.data),
        size.width,
        size.height,
      ).map<WatermarkProposal>((m) => ({
        x: round4(m.x / size.width),
        y: round4(m.y / size.height),
        w: round4(m.w / size.width),
        h: round4(m.h / size.height),
        mode: 'blur',
        corner: m.corner,
        confidence: m.confidence,
      }));
      found.push({ segment, marks });
    }
    if (wantBand) for (const f of frames) profiles.push({ atMs: f.atMs, rows: rowStrokeProfile(f.data, size.width, size.height) });
  }

  const regions = wantMarks ? mergeAcrossSegments(found).sort((a, b) => b.confidence - a.confidence) : [];
  if (wantMarks && regions.length === 0) notes.push('No still mark stood out in the corners of the picture.');

  let band: PictureDetection['band'];
  let bandBest: number | undefined;
  if (wantBand) {
    if (input.lines?.length) {
      const labels = labelTimes(
        profiles.map((p) => p.atMs),
        input.lines,
      );
      profiles.forEach((p, i) => {
        const label = labels[i];
        if (label) p.label = label;
      });
    }
    const finding = findSubtitleBand(profiles, size.height);
    if (finding) {
      band = {
        y: round4(finding.top / size.height),
        h: round4((finding.bottom - finding.top + 1) / size.height),
        confidence: finding.confidence,
        method: finding.method,
        ...(finding.twoLineShare > 0 ? { twoLineShare: finding.twoLineShare } : {}),
      };
      bandBest = finding.bestIndex;
      if (finding.method === 'appearance') {
        notes.push(
          input.lines?.length
            ? "Speech against silence (the transcript's lines) showed no band, so it was found from the picture alone: check it. Lines missing from the transcript where subtitles show are a sign that speech was lost."
            : 'No transcript yet: the band was found from the picture alone. Check it (after speech-to-text, detecting again compares speech with silence).',
        );
      }
    } else {
      notes.push('No subtitles of the source came and went in the picture.');
    }
  }
  if (looked < 20) notes.push(`Only ${looked} different frames could be read: a short video or one with few keyframes; the result is less sure.`);

  // The frame to check by eye: the one with the most subtitle text in the
  // band, else the middle of what was looked at.
  const frameAtMs =
    bandBest !== undefined && profiles[bandBest]
      ? profiles[bandBest]!.atMs
      : profiles.length > 0
        ? profiles[Math.floor(profiles.length / 2)]!.atMs
        : Math.round((segments[0]?.startMs ?? 0) + ((segments[0]?.endMs ?? 0) - (segments[0]?.startMs ?? 0)) / 2);

  let framePath: string | undefined;
  let previewPath: string | undefined;
  if (input.outputDir) {
    mkdirSync(input.outputDir, { recursive: true });
    const out = analysisSize(geometry.width, geometry.height, FRAME_LONG_SIDE);
    framePath = (await renderPictureFrame(input.videoPath, frameAtMs, join(input.outputDir, 'frame.jpg'), { ...run, size: out })).path;
    const px = (v: number, of: number): number => Math.max(0, Math.round(v * of));
    previewPath = (
      await renderPictureFrame(input.videoPath, frameAtMs, join(input.outputDir, 'preview.jpg'), {
        ...run,
        size: out,
        draw: {
          boxes: regions.map((r) => ({ x: px(r.x, out.width), y: px(r.y, out.height), w: px(r.w, out.width), h: px(r.h, out.height) })),
          ...(band ? { band: { y: px(band.y, out.height), h: px(band.h, out.height) } } : {}),
        },
      })
    ).path;
  }

  return {
    at: new Date().toISOString(),
    videoWidth: geometry.width,
    videoHeight: geometry.height,
    regions,
    ...(band ? { band } : {}),
    ...(previewPath ? { previewPath } : {}),
    ...(framePath ? { framePath } : {}),
    frameAtMs,
    frames: looked,
    notes,
    ...(adTail ? { adTail } : {}),
    ...(lookForTail ? { tailChecked: true } : {}),
  };
}

/** A video this long at least is looked at for an advert tail (10 min of drama, 10 of tail). */
export const TAIL_MIN_VIDEO_MS = 20 * 60_000;

const clockOf = (ms: number): string => {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s2 = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s2}` : `${m}:${s2}`;
};

/**
 * The second an advert tail starts, between a frame without its banner
 * (`beforeMs`) and one with it (`afterMs`): halved with one more frame at a
 * time, to two seconds or the keyframes allow. The frame read is the
 * keyframe at or before the time asked (frameSample.ts), so a span with no
 * keyframe inside moves the lower end up. Answers the first time known to
 * show the banner.
 */
export async function refineTailStart(
  videoPath: string,
  overlay: Pick<LateOverlay, 'pixels' | 'grid'>,
  size: { width: number; height: number },
  beforeMs: number,
  afterMs: number,
  run: RunOptions = {},
): Promise<number> {
  let lo = beforeMs;
  let hi = afterMs;
  for (let step = 0; step < 10 && hi - lo > 2000; step++) {
    const mid = Math.round((lo + hi) / 2);
    const [frame] = await sampleGrayFrames(videoPath, [mid], size, run);
    if (!frame || frame.atMs <= lo) {
      lo = mid;
      continue;
    }
    if (frame.atMs >= hi) {
      lo = mid;
      continue;
    }
    if (overlayShown(frame.data, size.width, overlay) >= SHOWN_SHARE) hi = frame.atMs;
    else lo = frame.atMs;
  }
  return hi;
}

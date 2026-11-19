/**
 * Build a single full-length WAV ("tts_full.wav") from per-segment TTS audio.
 *
 * Each aligned segment's audio is placed at its `startMs` on a common timeline.
 * Between/around segments there is silence. The result is exactly
 * `totalDurationMs` long, 48kHz stereo.
 *
 * Strategy:
 *   For N segments, build a filtergraph:
 *     [i]adelay=startMs|startMs[ai]   for each input i
 *     mix all [ai] with amix=inputs=N:normalize=0:dropout_transition=0
 *     then apad to total + atrim to total to pin the exact length.
 *
 * Robustness: amix with a very large number of inputs is fragile and the
 * filtergraph string can blow up. When there are more than MAX_INPUTS_PER_MIX
 * segments we mix in chunks: each chunk produces an intermediate WAV, then the
 * intermediates are amix'd together. The chunking is recursive-friendly but we
 * keep it to a single extra level which is plenty (e.g. 64*64 = 4096 segments).
 * The chunks are independent, so they are mixed several at a time
 * (concurrency.ts); the final mix still takes them in chunk order.
 *
 * An intermediate covers only its chunk's stretch of the timeline (from its
 * first clip to where its last one ends) and is placed there in the final mix.
 * Each used to be as long as the whole video, so scratch space grew with the
 * square of the length: a two-hour dub (2,400 lines) needed over 50 GiB.
 *
 * Arg-builders are pure and unit-tested. The orchestrator passes already-
 * aligned segments (with absolute audio paths). Segments with an empty/missing
 * audioPath are skipped (they contribute only silence).
 */

import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException, type AlignedSegment, type TimeStretchEngine } from '@videodubber/shared';
import { writeAtomically } from './atomic.js';
import { defaultMixConcurrency, mapWithConcurrency } from './concurrency.js';
import {
  assertInputReadable,
  assertOutputWritable,
  runFfmpeg,
  type RunOptions,
} from './exec.js';
import { probeDurationMs } from './probe.js';
import {
  buildRubberbandFilterChain,
  detectStretchCapabilities,
  shouldUseRubberband,
  stretchWithRubberbandCli,
  type StretchCapabilities,
} from './stretch.js';

/** Max real audio inputs to feed a single amix node before chunking. */
export const MAX_INPUTS_PER_MIX = 32;

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // pcm_s16le

/**
 * Estimate peak temp-dir bytes the CHUNKED timeline build will occupy. Each
 * chunk's intermediate covers its own stretch of the timeline, and consecutive
 * chunks hardly overlap, so the level-1 intermediates together are about one
 * timeline long, and the level-2 ones (when there are any) another. Returns 0
 * for the single-pass path (no intermediates). Pure / unit-tested.
 */
export function estimateTimelineTmpBytes(clipCount: number, totalDurationMs: number): number {
  if (clipCount <= MAX_INPUTS_PER_MIX) return 0;
  const bytesPerFullWav = Math.ceil((Math.max(0, totalDurationMs) / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  const level1 = Math.ceil(clipCount / MAX_INPUTS_PER_MIX);
  const levels = level1 > MAX_INPUTS_PER_MIX ? 2 : 1;
  // Level-1 + level-2 intermediates coexist on disk; add 20% headroom.
  return Math.ceil(levels * bytesPerFullWav * 1.2);
}

/**
 * Fail fast with a clear error if the system temp dir lacks room for the
 * chunked-build intermediates, instead of a cryptic ENOSPC partway through.
 * Skipped silently when `statfs` is unavailable on the platform.
 */
function assertTmpSpace(requiredBytes: number): void {
  if (requiredBytes <= 0) return;
  let availBytes: number;
  try {
    const s = statfsSync(tmpdir());
    availBytes = s.bavail * s.bsize;
  } catch {
    return; // statfs unsupported here — don't block the build on a missing guard
  }
  if (availBytes < requiredBytes) {
    const gib = (n: number): string => (n / 1024 ** 3).toFixed(1);
    throw new AppErrorException({
      code: 'OUTPUT_NOT_WRITABLE',
      message:
        `Not enough temp space to build the long-video TTS timeline: need ~${gib(requiredBytes)} GiB ` +
        `free in ${tmpdir()}, found ~${gib(availBytes)} GiB.`,
      remediation:
        'Free space in your system temp directory (or set TMPDIR to a larger volume), then retry the audio-mix step.',
      docsRef: 'docs/TROUBLESHOOTING.md#output',
    });
  }
}

/** A placed clip: a source WAV that starts at `startMs` on the timeline. */
export interface TimelineClip {
  audioPath: string;
  startMs: number;
  /**
   * Optional tempo factor (>1 = faster/shorter) applied BEFORE the clip is
   * delayed into place. Used by alignment to fit slightly-too-long TTS into its
   * subtitle window. Omitted/1 = no time-stretch.
   */
  speedRatio?: number;
  /**
   * Measured clip duration in ms (pre-stretch). When present, a short fade-out
   * is placed at the clip tail (join smoothing); without it only the fade-in
   * is applied.
   */
  durationMs?: number;
  /**
   * Resolved stretch mechanism for this clip (set by {@link buildTtsTimeline}
   * from the engine policy + detected capabilities). Default `atempo`.
   */
  stretchWith?: 'atempo' | 'rubberband';
  /**
   * The part of the source that plays, in ms of the source (the orchestrator's
   * clipSpeech.ts: edge silence off, a botched clip's trailing noise cut). Cut
   * first in the chain, so the fades, the stretch and the placement all apply
   * to the speech alone; `durationMs` is then the kept length. Both or neither.
   */
  trimStartMs?: number;
  trimEndMs?: number;
  /**
   * An intermediate of the chunked build: already trimmed, faded and
   * stretched, so it is only placed (no fade of its own).
   */
  premixed?: boolean;
  /** Level change for this clip, in dB (a greeting's own gain); 0/absent = none. */
  gainDb?: number;
}

/**
 * The `atrim` fragment that keeps only a clip's trim window (trailing-comma-
 * terminated, or '' when the clip plays whole or the window is malformed). The
 * PTS reset makes the kept part start at t=0, where the fade-in expects it. Pure.
 */
export function buildTrimChain(trimStartMs?: number, trimEndMs?: number): string {
  if (trimStartMs === undefined || trimEndMs === undefined) return '';
  if (!Number.isFinite(trimStartMs) || !Number.isFinite(trimEndMs)) return '';
  const start = Math.max(0, trimStartMs);
  if (!(trimEndMs > start)) return '';
  return `atrim=start=${msToSec(start)}:end=${msToSec(trimEndMs)},asetpts=PTS-STARTPTS,`;
}

/**
 * Join-smoothing micro-fades: equal short ramps at each clip's head and tail
 * kill DC steps/clicks where clips meet silence or each other, without being
 * audible as fades. Skipped entirely on clips too short to carry them.
 */
export const FADE_IN_MS = 12;
export const FADE_OUT_MS = 18;
const MIN_FADEABLE_MS = 80;

/**
 * Build the micro-fade fragment for a clip (trailing-comma-terminated, or ''
 * when the clip is too short / has unknown duration for a tail fade). Fades are
 * applied BEFORE any time-stretch, so timings refer to the natural clip. Pure.
 */
export function buildFadeChain(durationMs?: number): string {
  const fadeIn = `afade=t=in:d=${(FADE_IN_MS / 1000).toFixed(3)},`;
  if (durationMs === undefined || !Number.isFinite(durationMs)) return fadeIn;
  if (durationMs < MIN_FADEABLE_MS) return '';
  const outStart = Math.max(0, durationMs - FADE_OUT_MS) / 1000;
  return `${fadeIn}afade=t=out:st=${outStart.toFixed(3)}:d=${(FADE_OUT_MS / 1000).toFixed(3)},`;
}

/**
 * Build an `atempo` filter chain for a tempo factor. `atempo` only accepts
 * 0.5–2.0 per instance, so larger/smaller factors are decomposed into a chain.
 * Returns a trailing-comma-terminated fragment (or '' for a no-op factor) so it
 * can be spliced directly in front of `adelay`.
 */
export function buildAtempoChain(ratio?: number): string {
  if (!ratio || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-3) return '';
  let r = ratio;
  const factors: number[] = [];
  while (r > 2.0) {
    factors.push(2.0);
    r /= 2.0;
  }
  while (r < 0.5) {
    factors.push(0.5);
    r /= 0.5;
  }
  factors.push(r);
  return factors.map((f) => `atempo=${f.toFixed(4)}`).join(',') + ',';
}

/** Extract placeable clips from aligned segments (skips empty audio paths). */
export function alignedSegmentsToClips(segments: AlignedSegment[]): TimelineClip[] {
  return segments
    .filter((s) => typeof s.audioPath === 'string' && s.audioPath.length > 0)
    .map((s) => ({ audioPath: s.audioPath, startMs: Math.max(0, Math.round(s.startMs)) }))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Build the filter_complex string for a single-pass mix of `clips`.
 * Inputs are referenced as [0], [1], ... in the SAME order as `clips`.
 * Produces a final labeled pad `[out]` exactly `totalDurationMs` long.
 *
 * Pure function — used by the single-pass path and by each chunk.
 */
export function buildTimelineFilterComplex(
  clips: TimelineClip[],
  totalDurationMs: number,
  /** `natural`: end where the last clip ends (a chunk's intermediate) instead of at totalDurationMs. */
  length: 'total' | 'natural' = 'total',
): string {
  if (clips.length === 0) {
    // No audio at all: emit silence of the right length from a generated source.
    // The caller wires anullsrc as input 0 in that case (see buildAnullsrcArgs).
    return `[0:a]atrim=0:${msToSec(totalDurationMs)},asetpts=N/SR/TB[out]`;
  }

  const parts: string[] = [];
  const delayedLabels: string[] = [];

  clips.forEach((clip, i) => {
    const label = `a${i}`;
    const delay = Math.max(0, Math.round(clip.startMs));
    // adelay needs one value per channel; resample/format to a common layout
    // first so amix never has to reconcile mismatched sample rates/layouts.
    // Micro-fades (join smoothing) run BEFORE the stretch so their timings
    // refer to the natural clip; the stretch fragment is either Rubber Band
    // (formant-preserving, when resolved by policy) or the atempo chain.
    //
    // CRITICAL: reset PTS with `asetpts=N/SR/TB` AFTER adelay. When a stretch is
    // present it emits frames whose timestamps break `amix`'s alignment — amix
    // then collapses every clip to the front of the timeline and ends early, so
    // the dub piles all voices on top of each other in the first stretch and
    // goes silent for the rest. Re-stamping each delayed clip on a clean,
    // sample-count PTS base lets amix place them at their true offsets. (Without
    // any stretch it already works, but the reset is harmless and uniform.)
    const gain = clip.gainDb && Number.isFinite(clip.gainDb) ? `volume=${clip.gainDb.toFixed(2)}dB,` : '';
    const shaping = clip.premixed
      ? ''
      : `${buildFadeChain(clip.durationMs)}${
          clip.stretchWith === 'rubberband'
            ? buildRubberbandFilterChain(clip.speedRatio)
            : buildAtempoChain(clip.speedRatio)
        }${gain}`;
    parts.push(
      `[${i}:a]${clip.premixed ? '' : buildTrimChain(clip.trimStartMs, clip.trimEndMs)}aresample=${SAMPLE_RATE},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `${shaping}adelay=${delay}|${delay},asetpts=N/SR/TB[${label}]`,
    );
    delayedLabels.push(`[${label}]`);
  });

  const mixInputs = delayedLabels.length;
  // normalize=0 keeps absolute levels (we manage gain explicitly in mix.ts).
  // dropout_transition=0 avoids volume ramps when inputs end.
  parts.push(
    `${delayedLabels.join('')}amix=inputs=${mixInputs}:normalize=0:dropout_transition=0[mixed]`,
  );
  if (length === 'natural') {
    // amix ends with its longest input: the chunk's last clip.
    parts.push('[mixed]asetpts=N/SR/TB[out]');
    return parts.join(';');
  }
  // Pin exact total length: pad to total, then hard-trim.
  parts.push(
    `[mixed]apad=whole_dur=${msToSec(totalDurationMs)},atrim=0:${msToSec(totalDurationMs)},` +
      `asetpts=N/SR/TB[out]`,
  );

  return parts.join(';');
}

/**
 * Build the full ffmpeg argv for a single-pass timeline mix.
 * Each clip becomes an `-i <path>` input in order; output is 48k stereo WAV.
 */
export function buildTimelineMixArgs(
  clips: TimelineClip[],
  totalDurationMs: number,
  outputPath: string,
  length: 'total' | 'natural' = 'total',
): string[] {
  const args: string[] = ['-y'];

  if (clips.length === 0) {
    // Single silent input sized to the timeline.
    args.push(
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
    );
  } else {
    for (const clip of clips) {
      args.push('-i', clip.audioPath);
    }
  }

  args.push(
    '-filter_complex',
    buildTimelineFilterComplex(clips, totalDurationMs, length),
    '-map',
    '[out]',
    '-ac',
    String(CHANNELS),
    '-ar',
    String(SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    // Past 4 GiB (~6.2 h at 48 kHz stereo) a plain RIFF header overflows;
    // `auto` switches to RF64 only then, so every other file is unchanged.
    '-rf64',
    'auto',
    outputPath,
  );

  return args;
}

/**
 * Where a group of clips starts on the timeline (its earliest clip). The
 * group's intermediate is mixed relative to this point and placed back here.
 */
export function groupStartMs(clips: readonly TimelineClip[]): number {
  return clips.reduce((min, c) => Math.min(min, c.startMs), Number.POSITIVE_INFINITY);
}

/** The clips of a group moved so that the group starts at 0 (see {@link groupStartMs}). */
export function relativeToGroup(clips: readonly TimelineClip[], startMs: number): TimelineClip[] {
  return clips.map((c) => ({ ...c, startMs: Math.max(0, c.startMs - startMs) }));
}

/** Split clips into chunks of at most MAX_INPUTS_PER_MIX. */
export function chunkClips(clips: TimelineClip[], size = MAX_INPUTS_PER_MIX): TimelineClip[][] {
  if (size < 1) size = 1;
  const chunks: TimelineClip[][] = [];
  for (let i = 0; i < clips.length; i += size) {
    chunks.push(clips.slice(i, i + size));
  }
  return chunks;
}

function msToSec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/** A placed segment for {@link buildTtsTimeline}. */
export interface TimelineSegmentInput {
  audioPath: string;
  startMs: number;
  /** Tempo factor to apply before placement (1/undefined = none). */
  speedRatio?: number;
  /** Measured clip duration in ms (pre-stretch) for tail-fade placement — of the trimmed part when trimmed. */
  durationMs?: number;
  /** The part of the clip that plays, in ms of the clip (see {@link TimelineClip}). */
  trimStartMs?: number;
  trimEndMs?: number;
  /** Level change in dB (a greeting's gain). */
  gainDb?: number;
}

/** Input object for {@link buildTtsTimeline}. */
export interface BuildTtsTimelineInput {
  segments: TimelineSegmentInput[];
  totalDurationMs: number;
  outputPath: string;
  /**
   * Stretcher policy for fitting clips: `auto` (rubberband when available and
   * the ratio warrants it), `rubberband`, or `ffmpeg-atempo`. Undefined behaves
   * like `ffmpeg-atempo` (legacy callers keep their exact behavior).
   */
  timeStretchEngine?: TimeStretchEngine;
  /**
   * How many chunk mixes may run at once on a long timeline. Default
   * {@link defaultMixConcurrency}; 1 reproduces the old sequential build (the
   * output is byte-identical either way — benchmarks and tests set it).
   */
  mixConcurrency?: number;
}

/**
 * What actually stretched this run's clips.
 *
 * Reported (and logged by the orchestrator) because the stretcher is INVISIBLE
 * otherwise: Rubber Band is picked purely from runtime capability detection, and
 * the shipped macOS ffmpeg has no `rubberband` filter and no CLI beside it — so
 * every packaged macOS dub silently falls back to atempo, which smears speech
 * above ~1.1x, while a developer with Homebrew's `rubberband` on PATH hears the
 * good path. One line in pipeline.log makes that difference diagnosable instead
 * of a mystery about "why do users' dubs sound worse than mine".
 */
export interface TimelineStretchSummary {
  /** Clips that needed a tempo change at all. */
  stretched: number;
  /** Stretched by ffmpeg's in-graph `rubberband` filter. */
  rubberbandFilter: number;
  /** Pre-stretched by the standalone `rubberband` CLI. */
  rubberbandCli: number;
  /** Left to ffmpeg's `atempo` (the universal fallback). */
  atempo: number;
  /** Rubber Band capabilities detected on this machine. */
  capabilities: StretchCapabilities;
}

/** Capabilities reported when nothing was probed (no clip needed stretching). */
const NO_CAPABILITIES: StretchCapabilities = { ffmpegFilter: false, cli: false };

/**
 * Resolve each clip's stretch mechanism from the engine policy + detected
 * capabilities. Prefers ffmpeg's `rubberband` filter (in-graph, zero-copy);
 * clips needing Rubber Band with only the CLI available are pre-stretched to
 * temp WAVs in `cliTmpDir`. A CLI failure silently falls back to atempo for
 * that clip. Mutates `clips` and reports what each one ended up using.
 */
async function resolveStretchMechanisms(
  clips: TimelineClip[],
  engine: TimeStretchEngine | undefined,
  cliTmpDir: () => string,
): Promise<TimelineStretchSummary> {
  const needsStretch = (c: TimelineClip): boolean =>
    c.speedRatio !== undefined && Number.isFinite(c.speedRatio) && Math.abs(c.speedRatio - 1) >= 1e-3;
  const stretched = clips.filter(needsStretch).length;

  const wantsRubberband = engine === 'auto' || engine === 'rubberband';
  if (!wantsRubberband || !clips.some((c) => shouldUseRubberband(c.speedRatio, engine, true))) {
    return { stretched, rubberbandFilter: 0, rubberbandCli: 0, atempo: stretched, capabilities: NO_CAPABILITIES };
  }
  const caps = await detectStretchCapabilities();
  let rubberbandFilter = 0;
  let rubberbandCli = 0;
  for (const [i, clip] of clips.entries()) {
    if (shouldUseRubberband(clip.speedRatio, engine, caps.ffmpegFilter)) {
      clip.stretchWith = 'rubberband';
      rubberbandFilter += 1;
    } else if (shouldUseRubberband(clip.speedRatio, engine, caps.cli)) {
      const stretchedPath = join(cliTmpDir(), `stretched_${String(i).padStart(4, '0')}.wav`);
      try {
        const ratio = clip.speedRatio!;
        await stretchWithRubberbandCli(clip.audioPath, stretchedPath, ratio);
        clip.audioPath = stretchedPath;
        // The clip is now already at target tempo: the tail-fade anchor and the
        // trim window (positions in the source) shrink with it.
        if (clip.durationMs !== undefined) clip.durationMs = Math.round(clip.durationMs / ratio);
        if (clip.trimStartMs !== undefined && clip.trimEndMs !== undefined) {
          clip.trimStartMs = Math.round(clip.trimStartMs / ratio);
          clip.trimEndMs = Math.round(clip.trimEndMs / ratio);
        }
        clip.speedRatio = undefined;
        rubberbandCli += 1;
      } catch {
        // CLI failed for this clip — leave it to the in-graph atempo fallback.
      }
    }
  }
  return {
    stretched,
    rubberbandFilter,
    rubberbandCli,
    atempo: Math.max(0, stretched - rubberbandFilter - rubberbandCli),
    capabilities: caps,
  };
}

/**
 * Build a single full-length TTS timeline WAV ("tts_full.wav") by placing each
 * per-segment WAV at its `startMs` (with optional time-stretch + join-smoothing
 * micro-fades) and padding/trimming to exactly `totalDurationMs`.
 *
 * Signature matches the orchestrator's `PipelineMediaService.buildTtsTimeline`:
 * a single input object in, `{ outputPath, durationMs }` out.
 */
export async function buildTtsTimeline(
  input: BuildTtsTimelineInput,
  opts: RunOptions = {},
): Promise<{ outputPath: string; durationMs: number; stretch: TimelineStretchSummary }> {
  const { totalDurationMs, outputPath } = input;
  assertOutputWritable(outputPath);

  const clips: TimelineClip[] = input.segments
    .filter((s) => typeof s.audioPath === 'string' && s.audioPath.length > 0)
    .map((s) => ({
      audioPath: s.audioPath,
      startMs: Math.max(0, Math.round(s.startMs)),
      speedRatio: s.speedRatio,
      durationMs: s.durationMs,
      ...(s.trimStartMs !== undefined && s.trimEndMs !== undefined
        ? { trimStartMs: s.trimStartMs, trimEndMs: s.trimEndMs }
        : {}),
      ...(s.gainDb ? { gainDb: s.gainDb } : {}),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  // Validate every source clip exists before we spend time on ffmpeg.
  for (const clip of clips) {
    assertInputReadable(clip.audioPath);
  }

  // Resolve the stretch mechanism per clip (rubberband filter / CLI / atempo).
  // The CLI path needs a scratch dir for pre-stretched clips; create it lazily
  // and clean it up with the rest of the temp state.
  let stretchTmpDir: string | undefined;
  const cliTmpDir = (): string => {
    stretchTmpDir ??= mkdtempSync(join(tmpdir(), 'vd-stretch-'));
    return stretchTmpDir;
  };

  try {
    const stretch = await resolveStretchMechanisms(clips, input.timeStretchEngine, cliTmpDir);

    // Single-pass path: few enough inputs to mix at once. Written atomically so
    // an interrupted mix can't leave a truncated tts_full.wav that the pipeline's
    // resume check would accept as a finished step (see atomic.ts).
    if (clips.length <= MAX_INPUTS_PER_MIX) {
      await writeAtomically(outputPath, (partial) =>
        runFfmpeg(buildTimelineMixArgs(clips, totalDurationMs, partial), opts),
      );
      return { outputPath, durationMs: await probeDurationMs(outputPath), stretch };
    }

    const concurrency = input.mixConcurrency ?? defaultMixConcurrency();
    return {
      ...(await buildChunkedTimeline(clips, totalDurationMs, outputPath, opts, concurrency)),
      stretch,
    };
  } finally {
    if (stretchTmpDir) rmSync(stretchTmpDir, { recursive: true, force: true });
  }
}

/**
 * Mix each group of `groups` to its own full-length WAV in `tmpDir`, up to
 * `concurrency` ffmpeg processes at once. Returns the intermediates in GROUP
 * order (not completion order), which is what keeps the final amix — and so the
 * output bytes — identical to a sequential build. Every child gets the shared
 * abort signal, so a cancel or a sibling's failure kills the rest.
 */
async function mixGroupsToIntermediates(
  groups: TimelineClip[][],
  prefix: string,
  tmpDir: string,
  totalDurationMs: number,
  opts: RunOptions,
  concurrency: number,
): Promise<TimelineClip[]> {
  return mapWithConcurrency(
    groups,
    concurrency,
    async (group, c, signal) => {
      const out = join(tmpDir, `${prefix}_${String(c).padStart(4, '0')}.wav`);
      // Mixed from the group's first clip to its last one's end, then placed
      // back at that start: an intermediate only as long as its own stretch.
      const startMs = groupStartMs(group);
      await runFfmpeg(buildTimelineMixArgs(relativeToGroup(group, startMs), totalDurationMs, out, 'natural'), {
        ...opts,
        signal,
      });
      return { audioPath: out, startMs, premixed: true };
    },
    opts.signal,
  );
}

/**
 * Chunked path: mix each chunk to an intermediate covering its own stretch of
 * the timeline, then mix the intermediates, each placed where its chunk starts.
 * Fail fast with a clear message if temp space is short. Running chunks side
 * by side changes nothing here: all intermediates coexisted on disk before too.
 */
async function buildChunkedTimeline(
  clips: TimelineClip[],
  totalDurationMs: number,
  outputPath: string,
  opts: RunOptions,
  concurrency: number,
): Promise<{ outputPath: string; durationMs: number }> {
  assertTmpSpace(estimateTimelineTmpBytes(clips.length, totalDurationMs));
  const tmpDir = mkdtempSync(join(tmpdir(), 'vd-tts-'));
  try {
    const intermediates = await mixGroupsToIntermediates(
      chunkClips(clips),
      'chunk',
      tmpDir,
      totalDurationMs,
      opts,
      concurrency,
    );

    // If the number of intermediates ALSO exceeds the limit, mix them in a
    // second level. One extra level supports MAX^2 segments which is ample.
    // Only the FINAL mix needs the atomic write — the intermediates live in
    // `tmpDir`, which is removed wholesale in the finally block.
    const finalInputs =
      intermediates.length <= MAX_INPUTS_PER_MIX
        ? intermediates
        : await mixGroupsToIntermediates(
            chunkClips(intermediates),
            'super',
            tmpDir,
            totalDurationMs,
            opts,
            concurrency,
          );
    await writeAtomically(outputPath, (partial) =>
      runFfmpeg(buildTimelineMixArgs(finalInputs, totalDurationMs, partial), opts),
    );

    return { outputPath, durationMs: await probeDurationMs(outputPath) };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

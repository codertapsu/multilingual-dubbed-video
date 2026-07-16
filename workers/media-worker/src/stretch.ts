/**
 * Time-stretch helpers for fitting a synthesized clip into its subtitle window.
 *
 * Quality ranking for speech (research + practice): Rubber Band (formant-
 * preserving) > SoundTouch > ffmpeg `atempo`. `atempo` stays the universal
 * fallback, but beyond ~1.1x it audibly degrades speech, so the policy is:
 *
 *   - `auto` (default): Rubber Band when available and |ratio| is far enough
 *     from 1 to matter (>= RUBBERBAND_THRESHOLD), else atempo.
 *   - `rubberband`: Rubber Band whenever available and ratio != 1.
 *   - `ffmpeg-atempo`: never Rubber Band.
 *
 * Rubber Band can be used two ways, preferred in this order:
 *   1. ffmpeg's `rubberband` filter (present when ffmpeg is built with
 *      librubberband — e.g. the gyan.dev "full" Windows builds): zero-copy,
 *      spliced straight into the timeline filtergraph.
 *   2. The standalone `rubberband` CLI (R3 `--fine` engine + `--formant`):
 *      clips are pre-stretched to temp WAVs before the timeline mix.
 * Rubber Band is GPL, so — like ffmpeg and piper — it is only ever a separate
 * binary/library, never linked in. Both capabilities are detected at runtime
 * and cached; with neither present everything falls back to atempo.
 *
 * Arg/fragment builders and the policy predicate are pure (unit-tested); the
 * detection + CLI execution live at the bottom (I/O).
 */
import { spawn } from 'node:child_process';
import type { TimeStretchEngine } from '@videodubber/shared';
import { runFfmpeg } from './exec.js';

/**
 * Above this ratio (or below its inverse), Rubber Band is worth it over atempo
 * for speech in `auto` mode. ~1.1 per listening practice: atempo is transparent
 * for micro-corrections but starts smearing transients past ~10%.
 */
export const RUBBERBAND_THRESHOLD = 1.1;

/**
 * Decide whether a given clip should be stretched with Rubber Band.
 * Pure: returns true only when the engine policy allows it, a Rubber Band
 * capability is available, and the ratio is far enough from 1 to matter.
 */
export function shouldUseRubberband(
  ratio: number | undefined,
  engine: TimeStretchEngine | undefined,
  rubberbandAvailable: boolean,
): boolean {
  if (!rubberbandAvailable) return false;
  if (!ratio || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-3) return false;
  if (engine === 'rubberband') return true;
  if (engine === 'auto') return ratio >= RUBBERBAND_THRESHOLD || ratio <= 1 / RUBBERBAND_THRESHOLD;
  // 'ffmpeg-atempo' (or undefined) never uses Rubber Band.
  return false;
}

/**
 * Build the ffmpeg `rubberband` FILTER fragment for a tempo factor, trailing-
 * comma-terminated so it can be spliced in front of `adelay` exactly like the
 * atempo chain. `formant=preserved` keeps the voice from chipmunking. Pure.
 */
export function buildRubberbandFilterChain(ratio?: number): string {
  if (!ratio || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-3) return '';
  return `rubberband=tempo=${ratio.toFixed(4)}:formant=preserved,`;
}

/**
 * Build the `rubberband` CLI argv to stretch `input` by `ratio` into `output`.
 * `--time 1/ratio` because rubberband's `--time` is a duration multiplier
 * (output length / input length): a ratio of 1.5 (1.5× faster) => 0.667 time.
 * R3 engine (`--fine`) + formant preservation (`--formant`) for natural speech.
 * Pure (testable).
 */
export function buildRubberbandArgs(input: string, output: string, ratio: number): string[] {
  const timeMultiplier = (1 / ratio).toFixed(6);
  return ['--fine', '--formant', '--time', timeMultiplier, input, output];
}

// ---- Runtime capability detection + CLI execution (I/O) ---------------------

/** Which Rubber Band delivery mechanisms this machine has. */
export interface StretchCapabilities {
  /** ffmpeg was built with librubberband (the `rubberband` audio filter exists). */
  ffmpegFilter: boolean;
  /** A standalone `rubberband` CLI binary is runnable. */
  cli: boolean;
}

/** Resolve the rubberband CLI binary (env override -> PATH lookup). */
export function resolveRubberbandBinary(): string {
  return process.env.RUBBERBAND_PATH?.trim() || 'rubberband';
}

let cachedCapabilities: Promise<StretchCapabilities> | undefined;

/**
 * Detect Rubber Band capabilities once per process (cached — binaries don't
 * appear mid-run). Never throws: any probe failure just reports `false`.
 */
export function detectStretchCapabilities(): Promise<StretchCapabilities> {
  cachedCapabilities ??= (async () => {
    const [ffmpegFilter, cli] = await Promise.all([probeFfmpegRubberbandFilter(), probeRubberbandCli()]);
    return { ffmpegFilter, cli };
  })();
  return cachedCapabilities;
}

/** Test seam: reset the cached capability probe. */
export function resetStretchCapabilitiesCache(): void {
  cachedCapabilities = undefined;
}

/** True when the bundled/`PATH` ffmpeg lists the `rubberband` filter. */
async function probeFfmpegRubberbandFilter(): Promise<boolean> {
  try {
    const res = await runFfmpeg(['-hide_banner', '-filters'], { timeoutMs: 15_000 });
    return /\brubberband\b/.test(res.stdout) || /\brubberband\b/.test(res.stderr);
  } catch {
    return false;
  }
}

/** True when the standalone `rubberband` CLI runs. */
async function probeRubberbandCli(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // argv array, no shell — same execution rules as exec.ts.
      child = spawn(resolveRubberbandBinary(), ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 10_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    // Some rubberband builds exit non-zero for --version; existing + exiting is
    // enough proof the binary is runnable.
    child.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Pre-stretch a clip with the standalone Rubber Band CLI (R3 + formant) into
 * `output`. Throws on failure — callers fall back to the atempo path.
 */
export function stretchWithRubberbandCli(input: string, output: string, ratio: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolveRubberbandBinary(), buildRubberbandArgs(input, output, ratio), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('rubberband CLI timed out'));
    }, 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`rubberband CLI exited with ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

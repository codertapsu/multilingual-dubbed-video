/**
 * Time-stretch helpers for fitting a synthesized clip into its subtitle window.
 *
 * The universal default is ffmpeg `atempo` (handled inline in the timeline
 * builder). For larger speed-ups (>~1.3×) `atempo` audibly degrades speech;
 * Rubber Band's R3 engine with formant preservation sounds markedly more
 * natural. Rubber Band is GPL, so — like ffmpeg and piper — it is used ONLY as
 * a separate subprocess binary (`rubberband`), delivered as an engine pack or
 * found on PATH. These helpers are pure/argv-only so they unit-test without it.
 */
import type { TimeStretchEngine } from '@videodubber/shared';

/** Above this ratio, Rubber Band is clearly worth it over atempo for speech. */
export const RUBBERBAND_THRESHOLD = 1.3;

/**
 * Decide whether a given clip should be stretched with Rubber Band.
 * Pure: returns true only when the engine policy allows it, the binary is
 * available, and the ratio is far enough from 1 to matter.
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

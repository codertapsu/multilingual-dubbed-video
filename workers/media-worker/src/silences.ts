/**
 * Long silent stretches of a whole track (the STT step's digital-silence
 * check, docs/plans/production-requests-2026-11-23.md 1.6).
 *
 * The same `silencedetect` pass as speech.ts, tuned for hours of audio
 * instead of a clip: the threshold and the shortest silence are the caller's
 * (the check asks for below −80 dB for a minute or more: no room tone is that
 * quiet, only a broken source), and a 27.8-hour track gets a timeout to match.
 * The garbled join of the 27.8-hour series left two hours of it, which no
 * transcript check can see (an empty transcript and a silent re-decode agree).
 */
import { assertInputReadable, runFfmpeg } from './exec.js';
import { probeDurationMs } from './probe.js';
import { buildSilenceDetectArgs, deriveSpeechMeasurement, parseSilenceDetect, type SilenceInterval } from './speech.js';

/** Options for {@link detectSilences}. */
export interface DetectSilencesOptions {
  /** Silence threshold, dBFS. */
  noiseDb: number;
  /** Shortest silence reported, ms. */
  minSilenceMs: number;
  signal?: AbortSignal;
}

/**
 * A silencedetect pass decodes 16 kHz PCM at several hundred times real time;
 * a 27.8-hour track then takes a few minutes. This only stops a hung ffmpeg. Pure.
 */
export function silenceTimeoutMs(durationMs: number): number {
  return Math.max(5 * 60_000, Math.round(durationMs / 20));
}

/** Silent stretches of `input`, sorted, in ms; and its length. Reads only. */
export async function detectSilences(
  input: string,
  opts: DetectSilencesOptions,
): Promise<{ durationMs: number; silences: SilenceInterval[] }> {
  assertInputReadable(input);
  const signal = opts.signal ? { signal: opts.signal } : {};
  const durationMs = await probeDurationMs(input, { timeoutMs: 60_000, ...signal });
  const detect = await runFfmpeg(buildSilenceDetectArgs(input, opts.noiseDb, Math.max(1, opts.minSilenceMs)), {
    timeoutMs: silenceTimeoutMs(durationMs),
    ...signal,
  });
  const { silences } = deriveSpeechMeasurement(durationMs, parseSilenceDetect(detect.stderr), {
    noiseDb: opts.noiseDb,
    minSilenceMs: opts.minSilenceMs,
  });
  // deriveSpeechMeasurement folds clicks into a silence; what is left shorter
  // than asked (only at the very ends of a track) is not one.
  return { durationMs, silences: silences.filter((s) => s.endMs - s.startMs >= opts.minSilenceMs) };
}

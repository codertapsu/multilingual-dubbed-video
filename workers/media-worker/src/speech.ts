/**
 * Where the speech actually is inside a synthesized clip.
 *
 * WHY: some VieNeu clips are mostly silence with a stray burst — "Thua" came
 * back 12.3 s long with the word at 0.1-0.3 s and a burst at 6.4 s; "Sức mạnh
 * gần như vô hạn." 24 s with 0.6 s of sound; "Ở." 4.1 s with a 1.1 s burst at
 * 2.7 s. Alignment only knew the clip's total duration, so it time-squeezed the
 * silence along with the word, or flagged a timing conflict that was not real.
 * Even healthy clips carry silence: over the 259 clips of a 31-minute dub the
 * lead-in was 73/98/113 ms (p10/p50/p90) and the tail 181/226/269 ms. This
 * module only MEASURES; deciding what to do (trim, re-synthesize) is the
 * orchestrator's call.
 *
 * One ffmpeg `silencedetect` pass (argv array, reads only, writes nothing) plus
 * an ffprobe for the exact duration, run side by side. The parser and the
 * derivation are pure and unit-tested against real ffmpeg output.
 */

import { assertInputReadable, runFfmpeg } from './exec.js';
import { probeDurationMs } from './probe.js';

/**
 * Silence threshold. Tuned on real VieNeu clips (48 kHz mono, peaks around
 * -1..-10 dBFS):
 *   - -45 dB is too sensitive: the junk filling broken clips peaks at -41..-49
 *     dBFS. In "Na-er-gơ" (19.4 s) -45 found seven fake speech islands of
 *     35-310 ms and moved the speech end from 3.5 s to 12.2 s.
 *   - -35 dB starts eating real speech: a healthy "Kệ nó đi" decays through
 *     -33..-39 dBFS, and its speech end moved 75 ms early (0.827 s vs 0.902 s).
 *   - -40 dB keeps every junk stretch one silence; on 259 clips its speech end
 *     came only 7 ms (p50) / 18 ms (p90) earlier than -45's — the faintest
 *     decay, inaudible under the next line anyway.
 */
export const SPEECH_NOISE_DB = -40;

/**
 * Shortest silence reported. Below the VieNeu lead-ins measured (p10 73 ms),
 * so every clip's head and tail are found; far longer than the sub-ms dropouts
 * inside voiced speech.
 */
export const SPEECH_MIN_SILENCE_MS = 50;

/**
 * Sound shorter than this between two silences is a click, not speech: the
 * real ones were 0.04-4 ms (e.g. "Ở." at -40 dB: a 0.17 ms blip splitting one
 * 1.7 s silence in two). A syllable is never this short, so such islands are
 * merged into the surrounding silence — including at the clip's two ends.
 */
export const SPEECH_MAX_ISLAND_MS = 20;

/** A silent stretch of a clip, in ms from the clip start. */
export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

/** What {@link measureSpeech} reports for one clip. */
export interface SpeechMeasurement {
  /** Total clip duration (ffprobe; exact for WAV). */
  durationMs: number;
  /** Silent stretches, sorted, non-overlapping, within [0, durationMs]. */
  silences: SilenceInterval[];
  /** First ms of sound (0 when the clip opens on sound, or has none). */
  speechStartMs: number;
  /** End of the last sound (durationMs when it runs to the end; 0 when there is none). */
  speechEndMs: number;
  /** Total non-silent time. 0 = the clip is silent throughout. */
  speechMs: number;
  /** Threshold used (dBFS), so a logged measurement is self-describing. */
  noiseDb: number;
  /** Shortest silence reported, ms. */
  minSilenceMs: number;
}

/** Options for {@link measureSpeech}. */
export interface MeasureSpeechOptions {
  /** Silence threshold in dBFS (default {@link SPEECH_NOISE_DB}). */
  noiseDb?: number;
  /** Shortest silence to report, ms (default {@link SPEECH_MIN_SILENCE_MS}). */
  minSilenceMs?: number;
  /** Cancels the ffmpeg/ffprobe children. */
  signal?: AbortSignal;
  /** Per-process ceiling (default 60 s; a clip is seconds long). */
  timeoutMs?: number;
}

/** ffmpeg argv: run `silencedetect` over `input`, discarding the audio. Pure. */
export function buildSilenceDetectArgs(input: string, noiseDb: number, minSilenceMs: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // -nostats: the progress line would interleave with the detector's lines.
    '-nostats',
    // silencedetect logs at INFO, so the level must not go below it.
    '-v',
    'info',
    '-i',
    input,
    '-vn',
    '-sn',
    '-dn',
    '-af',
    `silencedetect=noise=${noiseDb}dB:duration=${(minSilenceMs / 1000).toFixed(3)}`,
    '-f',
    'null',
    '-',
  ];
}

/** One `silencedetect` event, in seconds as ffmpeg printed it. */
export interface SilenceDetectEvent {
  kind: 'start' | 'end';
  seconds: number;
}

/**
 * Pull the `silence_start` / `silence_end` events out of ffmpeg's stderr, in
 * order. Pure. Lines look like
 * `[silencedetect @ 0x…] silence_end: 6.398083 | silence_duration: 6.090979`.
 */
export function parseSilenceDetect(stderr: string): SilenceDetectEvent[] {
  const events: SilenceDetectEvent[] = [];
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/gi;
  for (const m of stderr.matchAll(re)) {
    const seconds = Number(m[2]);
    if (Number.isFinite(seconds)) {
      events.push({ kind: m[1]!.toLowerCase() === 'start' ? 'start' : 'end', seconds });
    }
  }
  return events;
}

/**
 * Turn detector events into a {@link SpeechMeasurement}. Pure.
 *
 * Robust to what different ffmpeg builds print: a final silence with no
 * `silence_end` (older builds stop at EOF without one) runs to `durationMs`; a
 * slightly negative first `silence_start` (some builds) clamps to 0. Islands of
 * sound shorter than {@link SPEECH_MAX_ISLAND_MS} are folded into silence.
 */
export function deriveSpeechMeasurement(
  durationMs: number,
  events: SilenceDetectEvent[],
  opts: { noiseDb?: number; minSilenceMs?: number; maxIslandMs?: number } = {},
): SpeechMeasurement {
  const total = Math.max(0, Math.round(durationMs));
  const maxIsland = opts.maxIslandMs ?? SPEECH_MAX_ISLAND_MS;
  const clamp = (ms: number): number => Math.min(total, Math.max(0, ms));

  // Pair each start with the next end; an unpaired start runs to EOF.
  const raw: SilenceInterval[] = [];
  let open: number | undefined;
  for (const e of events) {
    const ms = clamp(Math.round(e.seconds * 1000));
    if (e.kind === 'start') {
      open ??= ms;
    } else if (open !== undefined) {
      raw.push({ startMs: open, endMs: ms });
      open = undefined;
    }
  }
  if (open !== undefined) raw.push({ startMs: open, endMs: total });

  raw.sort((a, b) => a.startMs - b.startMs);
  const silences: SilenceInterval[] = [];
  for (const s of raw) {
    if (s.endMs <= s.startMs) continue;
    const last = silences[silences.length - 1];
    // Overlapping, touching, or separated only by a click: one silence.
    if (last && s.startMs - last.endMs < maxIsland) last.endMs = Math.max(last.endMs, s.endMs);
    else silences.push({ ...s });
  }
  // A click right at either end of the clip is not where speech starts/ends.
  const first = silences[0];
  if (first && first.startMs < maxIsland) first.startMs = 0;
  const last = silences[silences.length - 1];
  if (last && total - last.endMs < maxIsland) last.endMs = total;

  const silentMs = silences.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  const speechMs = Math.max(0, total - silentMs);
  const opensSilent = first !== undefined && first.startMs === 0;
  const endsSilent = last !== undefined && last.endMs === total;
  return {
    durationMs: total,
    silences,
    speechStartMs: speechMs === 0 ? 0 : opensSilent ? first!.endMs : 0,
    speechEndMs: speechMs === 0 ? 0 : endsSilent ? last!.startMs : total,
    speechMs,
    noiseDb: opts.noiseDb ?? SPEECH_NOISE_DB,
    minSilenceMs: opts.minSilenceMs ?? SPEECH_MIN_SILENCE_MS,
  };
}

/**
 * Measure where the speech is in `input` (normally a synthesized WAV clip).
 * Writes nothing; safe to run on clips the pipeline is about to use.
 */
export async function measureSpeech(input: string, opts: MeasureSpeechOptions = {}): Promise<SpeechMeasurement> {
  assertInputReadable(input);
  const noiseDb = opts.noiseDb ?? SPEECH_NOISE_DB;
  const minSilenceMs = Math.max(1, opts.minSilenceMs ?? SPEECH_MIN_SILENCE_MS);
  const run = { timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.signal ? { signal: opts.signal } : {}) };
  const [durationMs, detect] = await Promise.all([
    probeDurationMs(input, run),
    runFfmpeg(buildSilenceDetectArgs(input, noiseDb, minSilenceMs), run),
  ]);
  return deriveSpeechMeasurement(durationMs, parseSilenceDetect(detect.stderr), { noiseDb, minSilenceMs });
}

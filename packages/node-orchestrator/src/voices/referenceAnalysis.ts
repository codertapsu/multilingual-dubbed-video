/**
 * What is in a voice-cloning reference, measured from its samples.
 *
 * A clone is only as good as the few seconds it was made from, and users bring
 * whatever they have: a laptop microphone, a phone memo, a clip of a video with
 * music under it. Before anything is enrolled the app says, in plain words,
 * what it measured (too little speech, too quiet, clipped, noisy, long pauses)
 * and proposes the best window. Everything here only warns, except too little
 * speech, which the engine cannot clone from at all; the user decides.
 *
 * Pure: the WAV bytes and the speech map come in, numbers come out. The input
 * is the 48 kHz mono PCM that voices/referencePrep.ts decodes every import to.
 */
import type { VoiceCheckWarning, VoiceReferenceChecks, VoiceReferencePolicy } from '@videodubber/shared';

/** Analysis frame (ms). */
export const FRAME_MS = 20;
/** A sample at or above this magnitude counts as clipped (int16 full scale is 32767). */
const CLIP_LEVEL = 32_700;
/** Below this average speech level (dBFS) the recording is called too quiet. */
const QUIET_DB = -38;
/** Share of clipped samples above which the recording is called clipped. */
const CLIPPED_SHARE = 0.005;
/** Speech-to-background ratio (dB) below which the recording is called noisy. */
const NOISY_SNR_DB = 15;
/** A pause longer than this inside the window is worth a warning. */
const LONG_PAUSE_MS = 1_500;
/** Margin kept around speech when a window is snapped to it. */
const EDGE_MS = 150;

export interface PcmMono {
  sampleRate: number;
  samples: Int16Array;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/**
 * Read a PCM-16 WAV (any channel count: channels are averaged). Throws on
 * anything else, which the caller reports as an undecodable recording.
 */
export function parseWavPcm16(buf: Buffer): PcmMono {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let at = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let format = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which ffmpeg writes for some layouts.
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || channels < 1 || sampleRate <= 0) {
        throw new Error(`unsupported WAV (format ${format}, ${bits}-bit, ${channels} ch)`);
      }
      const end = Math.min(buf.length, body + (size === 0xffffffff ? buf.length : size));
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = Math.round(sum / channels);
      }
      return { sampleRate, samples };
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function durationMs(pcm: PcmMono): number {
  return Math.floor((pcm.samples.length * 1000) / pcm.sampleRate);
}

/** Per-frame RMS level (dBFS) and clipped-sample counts. */
export function frameStats(pcm: PcmMono, frameMs = FRAME_MS): { db: Float32Array; clipped: Uint16Array } {
  const per = Math.max(1, Math.round((pcm.sampleRate * frameMs) / 1000));
  const n = Math.ceil(pcm.samples.length / per);
  const db = new Float32Array(n);
  const clipped = new Uint16Array(n);
  for (let f = 0; f < n; f++) {
    let sq = 0;
    let clips = 0;
    const end = Math.min(pcm.samples.length, (f + 1) * per);
    for (let i = f * per; i < end; i++) {
      const s = pcm.samples[i]!;
      sq += s * s;
      if (s >= CLIP_LEVEL || s <= -CLIP_LEVEL) clips++;
    }
    const rms = Math.sqrt(sq / Math.max(1, end - f * per)) / 32768;
    db[f] = rms > 0 ? 20 * Math.log10(rms) : -120;
    clipped[f] = clips;
  }
  return { db, clipped };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))]!;
}

/**
 * Where speech is, from levels alone: the fallback when the speech-to-text
 * worker's voice detector is not running. Frames 12 dB over the noise floor
 * are speech; gaps under 300 ms are closed and blips under 200 ms dropped.
 *
 * The floor is the quietest tenth of the frames, which in a recording that
 * barely pauses is speech itself; so the threshold is also held at least
 * 20 dB under the loud end of the recording, and never below -55 dBFS (a
 * silent recording has no speech).
 */
export function energySpeechRegions(db: Float32Array, frameMs = FRAME_MS): TimeRange[] {
  const levels = Array.from(db);
  const floor = percentile(levels, 10);
  const threshold = Math.max(-55, Math.min(floor + 12, percentile(levels, 95) - 20));
  const raw: TimeRange[] = [];
  let start = -1;
  for (let f = 0; f <= db.length; f++) {
    const loud = f < db.length && db[f]! >= threshold;
    if (loud && start < 0) start = f;
    if (!loud && start >= 0) {
      raw.push({ startMs: start * frameMs, endMs: f * frameMs });
      start = -1;
    }
  }
  const merged: TimeRange[] = [];
  for (const r of raw) {
    const last = merged.at(-1);
    if (last && r.startMs - last.endMs < 300) last.endMs = r.endMs;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.endMs - r.startMs >= 200);
}

/** Total ms of `regions` inside `[startMs, endMs)`. */
export function overlapMs(regions: readonly TimeRange[], startMs: number, endMs: number): number {
  let total = 0;
  for (const r of regions) total += Math.max(0, Math.min(r.endMs, endMs) - Math.max(r.startMs, startMs));
  return total;
}

/** Longest stretch without speech between the first and last speech in a window. */
export function longestPauseMs(regions: readonly TimeRange[], startMs: number, endMs: number): number {
  const inside = regions
    .filter((r) => r.endMs > startMs && r.startMs < endMs)
    .map((r) => ({ startMs: Math.max(r.startMs, startMs), endMs: Math.min(r.endMs, endMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  let longest = 0;
  for (let i = 1; i < inside.length; i++) longest = Math.max(longest, inside[i]!.startMs - inside[i - 1]!.endMs);
  return longest;
}

function clippedMsIn(clipped: Uint16Array, startMs: number, endMs: number, frameMs: number): number {
  let frames = 0;
  for (let f = Math.floor(startMs / frameMs); f < Math.min(clipped.length, Math.ceil(endMs / frameMs)); f++) {
    if (clipped[f]! > 0) frames++;
  }
  return frames * frameMs;
}

/**
 * The window a clone should be made from: up to `policy.maxMs` long, with the
 * most speech, penalised for clipping and long pauses, then snapped to the
 * speech it holds so it starts and ends just outside a word, not in one.
 */
export function suggestWindow(
  totalMs: number,
  regions: readonly TimeRange[],
  clipped: Uint16Array,
  policy: Pick<VoiceReferencePolicy, 'maxMs'>,
  frameMs = FRAME_MS,
): TimeRange {
  const length = Math.min(policy.maxMs, totalMs);
  if (length <= 0) return { startMs: 0, endMs: 0 };
  const starts = new Set<number>();
  for (let s = 0; s + length <= totalMs; s += 250) starts.add(s);
  for (const r of regions) starts.add(Math.max(0, Math.min(totalMs - length, r.startMs - EDGE_MS)));
  let best = { startMs: 0, endMs: length };
  let bestScore = -Infinity;
  for (const s of [...starts].sort((a, b) => a - b)) {
    const e = s + length;
    const pause = longestPauseMs(regions, s, e);
    const score =
      overlapMs(regions, s, e) - 4 * clippedMsIn(clipped, s, e, frameMs) - (pause > LONG_PAUSE_MS ? pause - LONG_PAUSE_MS : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { startMs: s, endMs: e };
    }
  }
  // Snap to the speech inside, keeping a small margin, never past the cap.
  const inside = regions.filter((r) => r.endMs > best.startMs && r.startMs < best.endMs);
  if (inside.length === 0) return best;
  const startMs = Math.max(best.startMs, inside[0]!.startMs - EDGE_MS, 0);
  const endMs = Math.min(best.endMs, inside.at(-1)!.endMs + EDGE_MS, totalMs);
  return endMs > startMs ? { startMs, endMs } : best;
}

/** Measure a window and say what is wrong with it. */
export function checkReference(
  stats: { db: Float32Array; clipped: Uint16Array },
  sampleRate: number,
  regions: readonly TimeRange[],
  window: TimeRange,
  policy: Pick<VoiceReferencePolicy, 'minSpeechMs' | 'idealMs'>,
  frameMs = FRAME_MS,
): VoiceReferenceChecks {
  const speechMs = overlapMs(regions, window.startMs, window.endMs);
  const first = Math.max(0, Math.floor(window.startMs / frameMs));
  const last = Math.min(stats.db.length, Math.ceil(window.endMs / frameMs));
  const speech: number[] = [];
  const background: number[] = [];
  let clippedSamples = 0;
  for (let f = first; f < last; f++) {
    const t = f * frameMs + frameMs / 2;
    const inSpeech = regions.some((r) => t >= r.startMs && t < r.endMs);
    (inSpeech ? speech : background).push(stats.db[f]!);
    clippedSamples += stats.clipped[f]!;
  }
  const totalSamples = Math.max(1, ((last - first) * frameMs * sampleRate) / 1000);
  // Speech level: the mean power of speech frames, in dB.
  const levelDb =
    speech.length > 0 ? 10 * Math.log10(speech.reduce((a, d) => a + 10 ** (d / 10), 0) / speech.length) : -120;
  // Background: the quiet end of the frames between words (or the quietest
  // speech frames when the recording has no pause at all).
  const floor = background.length >= 5 ? percentile(background, 50) : percentile(speech, 5);
  const snrDb = levelDb - floor;
  const clippedShare = clippedSamples / totalSamples;
  const pause = longestPauseMs(regions, window.startMs, window.endMs);

  const warnings: VoiceCheckWarning[] = [];
  if (speechMs < policy.minSpeechMs) warnings.push('too-short');
  else if (speechMs < policy.idealMs * 0.6) warnings.push('short');
  if (levelDb < QUIET_DB) warnings.push('too-quiet');
  if (clippedShare > CLIPPED_SHARE) warnings.push('clipped');
  if (snrDb < NOISY_SNR_DB) warnings.push('noisy');
  if (pause > LONG_PAUSE_MS) warnings.push('long-pause');
  return {
    speechMs,
    levelDb: Math.round(levelDb * 10) / 10,
    clippedShare: Math.round(clippedShare * 10_000) / 10_000,
    snrDb: Math.round(snrDb * 10) / 10,
    longestPauseMs: pause,
    warnings,
  };
}

/** Peak magnitude (0..1) per bucket, for drawing the waveform. */
export function waveformPeaks(pcm: PcmMono, buckets = 400): number[] {
  const n = pcm.samples.length;
  if (n === 0) return [];
  const per = Math.max(1, Math.ceil(n / buckets));
  const out: number[] = [];
  for (let b = 0; b * per < n; b++) {
    let peak = 0;
    for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) peak = Math.max(peak, Math.abs(pcm.samples[i]!));
    out.push(Math.round((peak / 32768) * 1000) / 1000);
  }
  return out;
}

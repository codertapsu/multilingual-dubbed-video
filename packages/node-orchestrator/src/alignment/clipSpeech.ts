/**
 * The part of a synthesized clip worth playing.
 *
 * WHY: alignment only knew each clip's total length, and no engine hands back
 * just the speech. Every VieNeu clip carries a lead-in and a tail (73/98/113 ms
 * and 181/226/269 ms at p10/p50/p90 over the 259 clips of a 31-minute dub), so
 * the voice started a tenth of a second after its line and the silence counted
 * as speech to fit: 28–41 units per dub were time-stretched for their own edge
 * silence. And some clips are botched outright: "Thua" came back 12.3 s long
 * with the word in its first half-second and a burst of noise at 6.4 s. It was
 * placed whole, reported as a timing conflict, and its noise played over the
 * next lines.
 *
 * The media worker measures (media-worker speech.ts: silencedetect at -40
 * dBFS); this module decides. Keep from just before the first sound to just
 * after the last. When the sound spans far longer than the text could take to
 * say, the engine kept generating after the line (an autoregressive voice that
 * missed its stop; every botched clip measured had the speech FIRST): cut at
 * the long silence that leaves the kept part closest to the text's expected
 * length.
 *
 * {@link speechKeepWindow} is pure; {@link measureClip} runs it on a clip
 * through the injected media service.
 */
import type { PipelineMediaService } from '../media.js';

/** Kept before the first sound: a soft onset (an "s", a breath) can sit under the threshold. */
export const LEAD_PAD_MS = 50;
/**
 * Kept after the last sound: the decay below -40 dBFS ended 7/18 ms (p50/p90)
 * later at -45 dBFS, and the mix's 18 ms fade-out has to land in silence.
 */
export const TAIL_PAD_MS = 80;
/**
 * Less sound than this is not trusted as "the speech": a clip whose only sound
 * is a click more likely holds speech too quiet to detect. Left untrimmed.
 */
export const MIN_SOUND_MS = 120;
/** Trims smaller than this at both ends are not worth a filter. */
const MIN_TRIM_MS = 10;
/**
 * A clip is botched when its sound spans more than this many times the text's
 * expected length, plus {@link BROKEN_SLACK_MS}. Loose on purpose: the
 * expected length is a rough per-script rate, and a slow, well-paused reading
 * must never be mistaken for one.
 */
export const BROKEN_FACTOR = 2.5;
export const BROKEN_SLACK_MS = 1500;
/** Only a silence this long can separate the speech from what follows it. */
export const CUT_GAP_MS = 700;
/** The shortest expected length (a one-syllable "Thua" is still a breath and a word). */
const MIN_EXPECTED_MS = 400;
/** Letters per second of an ordinary reading, per Latin-weight letter. */
const LETTERS_PER_SECOND = 14;

/** What the media worker measured (media.ts `measureSpeech`). */
export interface ClipSpeech {
  durationMs: number;
  silences: ReadonlyArray<{ startMs: number; endMs: number }>;
  speechStartMs: number;
  speechEndMs: number;
  speechMs: number;
}

/** The part to play, in ms of the clip. */
export interface KeepWindow {
  startMs: number;
  endMs: number;
  /** Sound after a long silence was dropped as the engine's noise. */
  cut: boolean;
}

/**
 * Roughly how long `text` takes to say, from its letters: a Han character is
 * about a syllable (×3 letters), kana a mora (×2), Hangul a syllable block
 * (×2.5). Counting letters rather than words keeps languages written without
 * spaces (Thai) from looking one "word" long. Pure.
 */
export function expectedSpeechMs(text: string): number {
  let letters = 0;
  for (const ch of text) {
    if (/\p{Script=Han}/u.test(ch)) letters += 3;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) letters += 2;
    else if (/\p{Script=Hangul}/u.test(ch)) letters += 2.5;
    else if (/[\p{L}\p{N}]/u.test(ch)) letters += 1;
  }
  return Math.max(MIN_EXPECTED_MS, Math.round((letters / LETTERS_PER_SECOND) * 1000));
}

/**
 * Where the sound ends if the clip is botched: of the cut points (the start of
 * each long silence inside the sound, or no cut at all), the one whose kept
 * span is closest to `expectedMs`, the longer on a tie. Undefined = no cut.
 */
function noiseCut(m: ClipSpeech, expectedMs: number): number | undefined {
  const span = m.speechEndMs - m.speechStartMs;
  if (span <= BROKEN_FACTOR * expectedMs + BROKEN_SLACK_MS) return undefined;
  // Longest first, replaced only by a strictly closer one: a tie keeps more.
  const cuts = m.silences
    .filter((s) => s.startMs > m.speechStartMs && s.endMs < m.speechEndMs && s.endMs - s.startMs >= CUT_GAP_MS)
    .map((s) => s.startMs)
    .filter((at) => at - m.speechStartMs >= MIN_SOUND_MS)
    .sort((a, b) => b - a);
  let best: number | undefined;
  let bestCost = Math.abs(span - expectedMs);
  for (const at of cuts) {
    const cost = Math.abs(at - m.speechStartMs - expectedMs);
    if (cost < bestCost) {
      best = at;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * The part of a clip that plays, or undefined to play it whole: a silent clip,
 * one with too little sound to trust, or one with nothing worth trimming. Pure.
 */
export function speechKeepWindow(m: ClipSpeech, text: string): KeepWindow | undefined {
  const duration = Math.max(0, Math.round(m.durationMs));
  if (!(m.speechMs > 0) || !(m.speechEndMs > m.speechStartMs)) return undefined;
  const cut = noiseCut(m, expectedSpeechMs(text));
  const soundEnd = cut ?? m.speechEndMs;
  if (soundEnd - m.speechStartMs < MIN_SOUND_MS) return undefined;
  const startMs = Math.max(0, Math.round(m.speechStartMs - LEAD_PAD_MS));
  const endMs = Math.min(duration, Math.round(soundEnd + TAIL_PAD_MS));
  if (startMs < MIN_TRIM_MS && duration - endMs < MIN_TRIM_MS) return undefined;
  return { startMs, endMs, cut: cut !== undefined };
}

/** How a clip enters alignment: the length that plays, and the trim that gives it. */
export interface ClipTiming {
  generatedDurationMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
}

/** {@link ClipTiming} plus what the measurement found, for the step's log. */
export interface MeasuredClip extends ClipTiming {
  /** The whole file, ms. */
  clipDurationMs: number;
  /**
   * `trimmed` edges only; `cut` noise after the speech dropped too; `whole`
   * nothing to trim; `silent` no sound found (played whole); `unmeasured` this
   * media service cannot measure speech (an older worker), or it failed.
   */
  outcome: 'trimmed' | 'cut' | 'whole' | 'silent' | 'unmeasured';
}

/**
 * Measure one clip and decide what of it plays. Falls back to a plain probe
 * (the whole clip, as before) when the media service has no speech measurement
 * or it fails; a cancel is never swallowed.
 */
export async function measureClip(
  media: Pick<PipelineMediaService, 'probe' | 'measureSpeech'>,
  audioPath: string,
  text: string,
  signal?: AbortSignal,
): Promise<MeasuredClip> {
  if (typeof media.measureSpeech === 'function') {
    try {
      const m = await media.measureSpeech(audioPath, undefined, signal);
      const keep = speechKeepWindow(m, text);
      if (keep) {
        return {
          generatedDurationMs: keep.endMs - keep.startMs,
          trimStartMs: keep.startMs,
          trimEndMs: keep.endMs,
          clipDurationMs: m.durationMs,
          outcome: keep.cut ? 'cut' : 'trimmed',
        };
      }
      return {
        generatedDurationMs: m.durationMs,
        clipDurationMs: m.durationMs,
        outcome: m.speechMs > 0 ? 'whole' : 'silent',
      };
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  const { durationMs } = await media.probe(audioPath, signal);
  return { generatedDurationMs: durationMs, clipDurationMs: durationMs, outcome: 'unmeasured' };
}

/** Apply a fresh {@link ClipTiming} to an alignment input, clearing a stale trim. */
export function applyClipTiming(
  input: { generatedDurationMs: number; trimStartMs?: number; trimEndMs?: number },
  timing: ClipTiming,
): void {
  input.generatedDurationMs = timing.generatedDurationMs;
  if (timing.trimStartMs !== undefined && timing.trimEndMs !== undefined) {
    input.trimStartMs = timing.trimStartMs;
    input.trimEndMs = timing.trimEndMs;
  } else {
    delete input.trimStartMs;
    delete input.trimEndMs;
  }
}

/**
 * Display cues: when each subtitle appears, and for how long.
 *
 * Cues used to be the transcript segments' times exactly, and the subtitle
 * audit (2026-11-17) measured what that does on real dubs: 28–43% of cues
 * faster than 17 characters per second (the worst 102 cps, on screen for
 * 0.40 s), 26–34% shorter than one second, the dub voice still speaking after
 * its subtitle had gone in 15–54 lines per video, 6–18 flicker gaps of a frame
 * or two, and, after voice re-timing, a cue that started before the previous
 * one and was squeezed to 245 ms.
 *
 * This is the one place that turns timed text into display cues, for every
 * subtitle file writer. It only ever adds time into a following gap (never
 * over the next cue), keeps every word, and does not move a cue's start except
 * where two cues are merged.
 */
import { subtitleTextWidth, DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES } from './lines.js';
import type { IndexedCue } from './cues.js';

/** A cue to plan, with what is known about its dub. */
export interface DisplayCueInput extends IndexedCue {
  /** When the dub voice finishes this line (ms): the cue stays up at least until then. */
  voiceEndMs?: number;
  /**
   * Lines voiced together as one synthesis group. A cue still too fast to read
   * may merge with the next cue of its group (they are spoken as one anyway).
   */
  groupId?: string;
}

export interface DisplayCueOptions {
  /** Reading speed ceiling, in display columns per second (CJK counts 2). Default 17. */
  maxCps?: number;
  /** Shortest time a cue stays on screen. Default 1000 ms. */
  minDurationMs?: number;
  /** Longest time a cue stays on screen, unless reading or the voice needs longer. Default 7000 ms. */
  maxDurationMs?: number;
  /** A gap shorter than this between two cues is closed: it only flickers. Default 84 ms (2 frames at 24 fps). */
  flickerGapMs?: number;
  /** A cue an overlap would squeeze below this is merged with the next one instead. Default 400 ms. */
  minCueMs?: number;
  /** A merge for reading speed must still fit this layout. Defaults 42 × 2. */
  maxCharsPerLine?: number;
  maxLines?: number;
}

const DEFAULTS: Required<DisplayCueOptions> = {
  maxCps: 17,
  minDurationMs: 1000,
  maxDurationMs: 7000,
  flickerGapMs: 84,
  minCueMs: 400,
  maxCharsPerLine: DEFAULT_MAX_CHARS_PER_LINE,
  maxLines: DEFAULT_MAX_LINES,
};

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}。，！？、]/u;

/** Join two cue texts the way their script is written (no space between CJK). */
function joinText(a: string, b: string): string {
  const last = [...a].at(-1) ?? '';
  const first = [...b][0] ?? '';
  return CJK_EDGE.test(last) || CJK_EDGE.test(first) ? `${a}${b}` : `${a} ${b}`;
}

interface Working {
  startMs: number;
  endMs: number;
  text: string;
  voiceEndMs: number;
  groupId: string | undefined;
}

function merge(a: Working, b: Working): Working {
  return {
    startMs: Math.min(a.startMs, b.startMs),
    endMs: Math.max(a.endMs, b.endMs),
    text: joinText(a.text, b.text),
    voiceEndMs: Math.max(a.voiceEndMs, b.voiceEndMs),
    groupId: a.groupId === b.groupId ? a.groupId : undefined,
  };
}

/**
 * Plan display cues from timed text (see the module comment). Returns cues
 * sorted by start, re-indexed from 1.
 */
export function planDisplayCues(input: readonly DisplayCueInput[], options: DisplayCueOptions = {}): IndexedCue[] {
  const o = { ...DEFAULTS, ...options };
  // Whole milliseconds: with fractional ones, a cue held to exactly its reading
  // time came out a rounding error short, was judged "too fast", and was merged
  // into the next line for nothing.
  const readMs = (text: string) => Math.max(o.minDurationMs, Math.ceil((subtitleTextWidth(text) / o.maxCps) * 1000));

  // 1. Text, sorted by start (voice re-timing can reorder cues), each held at
  //    least until its voice ends.
  const cues: Working[] = input
    .map((c, order) => ({ c, order, text: (c.text ?? '').replace(/\s+/g, ' ').trim() }))
    .filter(({ text }) => text !== '')
    .sort((a, b) => a.c.startMs - b.c.startMs || a.order - b.order)
    .map(({ c, text }) => {
      const startMs = Math.round(c.startMs);
      const voiceEndMs = Math.round(c.voiceEndMs ?? 0);
      const endMs = Math.max(startMs, Math.round(c.endMs), voiceEndMs);
      return { startMs, endMs, text, voiceEndMs, groupId: c.groupId };
    });

  // 2. No overlaps: end each cue where the next begins, merging instead of
  //    leaving a cue too short to see.
  for (let i = 0; i < cues.length - 1; ) {
    const cur = cues[i]!;
    const next = cues[i + 1]!;
    if (cur.endMs <= next.startMs) {
      i++;
      continue;
    }
    if (next.startMs - cur.startMs < o.minCueMs) {
      cues.splice(i, 2, merge(cur, next));
    } else {
      cur.endMs = next.startMs;
      i++;
    }
  }

  // 3. Time to read: hold into the following gap; a cue still too fast merges
  //    with the next line of its synthesis group when the two fit together.
  for (let i = 0; i < cues.length; ) {
    const cur = cues[i]!;
    const next = cues[i + 1];
    const room = next ? next.startMs : Number.POSITIVE_INFINITY;
    const need = readMs(cur.text);
    cur.endMs = Math.max(cur.endMs, Math.min(cur.startMs + need, room));
    const tooFast = cur.endMs - cur.startMs < need;
    if (
      tooFast &&
      next &&
      cur.groupId !== undefined &&
      cur.groupId === next.groupId &&
      subtitleTextWidth(joinText(cur.text, next.text)) <= o.maxCharsPerLine * o.maxLines
    ) {
      cues.splice(i, 2, merge(cur, next));
      continue; // re-plan the merged cue
    }
    i++;
  }

  // 4. Not on screen for ever (unless reading it, or the voice, takes longer),
  //    and no flicker between cues that nearly touch.
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i]!;
    const longest = Math.max(o.maxDurationMs, readMs(cur.text), cur.voiceEndMs - cur.startMs);
    cur.endMs = Math.min(cur.endMs, cur.startMs + longest);
    const next = cues[i + 1];
    if (next && next.startMs > cur.endMs && next.startMs - cur.endMs < o.flickerGapMs) cur.endMs = next.startMs;
  }

  return cues.map((c, k) => ({ index: k + 1, startMs: Math.round(c.startMs), endMs: Math.round(c.endMs), text: c.text }));
}

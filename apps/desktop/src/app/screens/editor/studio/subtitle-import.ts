/**
 * Import translations from a subtitle file dropped onto the timeline.
 *
 * Professional workflows often have a human-translated .srt/.vtt for the same
 * video (a subtitler's deliverable, a fan translation, a client revision). The
 * cue timing in such a file rarely matches our recogniser's cue split, so cues
 * are matched by TIME OVERLAP, not by index: each line takes the text of every
 * imported cue that covers most of it (joined, in order). Lines with no
 * sufficiently-overlapping cue are left alone.
 *
 * Pure and unit-tested (subtitle-import.spec.ts).
 */

export interface ImportedCue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
const ARROW = /^\s*(\S+)\s*-->\s*(\S+)/;

function toMs(stamp: string): number | null {
  const m = TIME.exec(stamp);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  return (
    ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(frac!.padEnd(3, '0'))
  );
}

/** Parse SRT or WebVTT text into cues (tags stripped, line breaks joined). */
export function parseSubtitles(text: string): ImportedCue[] {
  const cues: ImportedCue[] = [];
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0) continue;
    const [, a, b] = ARROW.exec(lines[at]!)!;
    const startMs = toMs(a!);
    const endMs = toMs(b!);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const body = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) cues.push({ startMs, endMs, text: body });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}

/** Map line id -> imported text, for lines covered (>= minCover) by imported cues. */
export function matchCuesToLines(
  lines: readonly { id: string; startMs: number; endMs: number }[],
  cues: readonly ImportedCue[],
  minCover = 0.5,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const len = line.endMs - line.startMs;
    if (len <= 0) continue;
    const parts: string[] = [];
    for (const cue of cues) {
      if (cue.endMs <= line.startMs) continue;
      if (cue.startMs >= line.endMs) break;
      const overlap = Math.min(cue.endMs, line.endMs) - Math.max(cue.startMs, line.startMs);
      // A cue counts when it covers most of the line OR the line covers most of it
      // (one long subtitle over two short recogniser cues, or the reverse).
      if (overlap / len >= minCover || overlap / (cue.endMs - cue.startMs) >= minCover)
        parts.push(cue.text);
    }
    if (parts.length > 0) out.set(line.id, parts.join(' '));
  }
  return out;
}

/**
 * Speech-to-text against the video's own burned-in subtitles
 * (settings.subtitleCoverageCheck; shared subtitleCheckOn).
 *
 * The media worker reads the subtitle band five times a second and says when
 * a subtitle is on screen (media-worker subtitlePresence.ts). Two uses:
 *   - the loop check never takes a line under a subtitle for silence: the
 *     subtitle times join the speech map for its silence test
 *     ({@link speechWithSubtitles}). 《反相之地》's speech map heard 3,579 s of
 *     speech in 4 h where its subtitles showed 4,916 s, and the loop check
 *     removed ~780 real lines as "silence" (claude-dubber, 2026-11-25);
 *   - the warnings ({@link coverageWarnings}): subtitles with no line under
 *     them (speech lost: 777 of them there, 821 s), and, where the subtitles
 *     follow the dialogue, lines with no subtitle (hallucination candidates).
 * Kept in audio/subtitle_presence.json, in the transcript's time, so the
 * warnings stay true as the lines are edited (transcriptWarnings.ts). Pure,
 * except reading that file.
 */
import fsp from 'node:fs/promises';
import type { PictureDetection, Project, ProjectWarning } from '@videodubber/shared';
import { formatClock } from '../activity/history.js';
import type { SpeechRegion } from './segmentTiming.js';

type Warning = Omit<ProjectWarning, 'at' | 'step'>;

/** A subtitle on screen, in the transcript's time. */
export interface SubtitleSpan {
  startMs: number;
  endMs: number;
}

/** `audio/subtitle_presence.json`. */
export interface SubtitlePresenceReport {
  at: string;
  /** The band read, as shares of the picture's height. */
  band: { y: number; h: number };
  /** Where it came from: the cover band of the settings, or picture detection. */
  bandFrom: 'settings' | 'detection';
  /** The window of the input read (its time). */
  window: { startMs: number; endMs?: number };
  frames: number;
  framesWithText: number;
  /** In the transcript's time (the window's start is 0). */
  events: SubtitleSpan[];
}

/** Picture detection's band is trusted from this confidence (its marks' threshold). */
export const MIN_BAND_CONFIDENCE = 0.35;

/** The band to read: the one the user set to cover, else picture detection's when sure enough. Pure. */
export function subtitleBandFor(
  project: Pick<Project, 'settings'>,
  detection: Pick<PictureDetection, 'band'> | undefined,
): { band: { y: number; h: number }; from: SubtitlePresenceReport['bandFrom'] } | undefined {
  const set = project.settings.burnSubtitleStyle?.coverBand;
  if (set && set.h > 0) return { band: { y: set.y, h: set.h }, from: 'settings' };
  const found = detection?.band;
  if (found && found.h > 0 && found.confidence >= MIN_BAND_CONFIDENCE) return { band: { y: found.y, h: found.h }, from: 'detection' };
  return undefined;
}

/** Whether a saved report read the same band over the same window. Pure. */
export function sameRead(report: SubtitlePresenceReport, band: { y: number; h: number }, window: SubtitlePresenceReport['window']): boolean {
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.002;
  return close(report.band.y, band.y) && close(report.band.h, band.h) && report.window.startMs === window.startMs && report.window.endMs === window.endMs;
}

/** The saved report, or undefined when there is none (or it is unreadable). */
export async function readPresenceReport(file: string): Promise<SubtitlePresenceReport | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as SubtitlePresenceReport;
    return Array.isArray(parsed?.events) && parsed.band ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Sorted, merged spans. */
function union(spans: readonly SubtitleSpan[], padMs = 0): SubtitleSpan[] {
  const sorted = spans
    .filter((s) => s.endMs > s.startMs)
    .map((s) => ({ startMs: s.startMs - padMs, endMs: s.endMs + padMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: SubtitleSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/** How much of [fromMs, toMs) the sorted, merged `cover` holds (from index `at`, which only moves forward). */
function overlapWith(cover: readonly SubtitleSpan[], fromMs: number, toMs: number, at: { i: number }): number {
  while (at.i < cover.length && cover[at.i]!.endMs <= fromMs) at.i += 1;
  let sum = 0;
  for (let k = at.i; k < cover.length && cover[k]!.startMs < toMs; k++) {
    sum += Math.max(0, Math.min(toMs, cover[k]!.endMs) - Math.max(fromMs, cover[k]!.startMs));
  }
  return sum;
}

/**
 * The speech map with the subtitles' times added, for the loop check's
 * silence test only: a line under a subtitle was said. Line timing still
 * anchors to the speech map alone (subtitle times are a reader's, not a
 * speaker's). Pure.
 */
export function speechWithSubtitles(regions: readonly SpeechRegion[], events: readonly SubtitleSpan[]): SpeechRegion[] {
  return union([...regions, ...events]);
}

/** A line's edges are this loose against a subtitle (subtitles come up early and stay late). */
const EDGE_MS = 300;
/** A subtitle has a line when lines cover this share of it. */
const COVERED_SHARE = 0.3;
/** Shorter lines are never named as without a subtitle: a cough, a name called. */
const MIN_UNSEEN_LINE_MS = 1500;
/** The subtitles follow the dialogue when they cover this share of the lines' time. */
const FOLLOWS_DIALOGUE = 0.5;
/** Subtitles without a line closer than this are one stretch. */
const STRETCH_JOIN_MS = 5000;
/** Stretches and lines a warning names. */
const NAMED = 3;
/** Fewer subtitles without a line than this, for less than this long, are no warning: a title card, a sign. */
const MIN_MISSING = 5;
const MIN_MISSING_MS = 10_000;
/** Fewer lines without a subtitle than this are no warning. */
const MIN_UNSEEN = 3;

/** A line as the check reads it. */
export interface CheckedLine {
  id?: string;
  startMs: number;
  endMs: number;
}

/** What the check found. */
export interface CoverageResult {
  /** Subtitles on screen with (almost) no line under them. */
  missing: SubtitleSpan[];
  missingMs: number;
  /** Those, joined where close, the longest first. */
  stretches: { fromMs: number; toMs: number; count: number }[];
  /** Lines with no subtitle at all, when the subtitles follow the dialogue (else empty). */
  unseen: CheckedLine[];
  /** Share of the lines' time a subtitle was on screen for. */
  linesCovered: number;
  followsDialogue: boolean;
}

/** Compare the subtitles with the lines (both in the transcript's time). Pure. */
export function subtitleCoverage(events: readonly SubtitleSpan[], lines: readonly CheckedLine[]): CoverageResult {
  const timed = lines.filter((l) => l.endMs > l.startMs).sort((a, b) => a.startMs - b.startMs);
  const lineCover = union(timed, EDGE_MS);
  const subs = [...events].filter((e) => e.endMs > e.startMs).sort((a, b) => a.startMs - b.startMs);
  const missing: SubtitleSpan[] = [];
  const atLine = { i: 0 };
  for (const e of subs) {
    if (overlapWith(lineCover, e.startMs, e.endMs, atLine) < COVERED_SHARE * (e.endMs - e.startMs)) missing.push(e);
  }
  const subCover = union(subs, EDGE_MS);
  let lineMs = 0;
  let coveredMs = 0;
  const unseenAll: CheckedLine[] = [];
  const atSub = { i: 0 };
  for (const l of timed) {
    const len = l.endMs - l.startMs;
    const over = Math.min(len, overlapWith(subCover, l.startMs, l.endMs, atSub));
    lineMs += len;
    coveredMs += over;
    if (over === 0 && len >= MIN_UNSEEN_LINE_MS) unseenAll.push(l);
  }
  const linesCovered = lineMs > 0 ? coveredMs / lineMs : 0;
  const followsDialogue = linesCovered >= FOLLOWS_DIALOGUE;
  const stretches: CoverageResult['stretches'] = [];
  for (const m of missing) {
    const last = stretches[stretches.length - 1];
    if (last && m.startMs - last.toMs <= STRETCH_JOIN_MS) {
      last.toMs = Math.max(last.toMs, m.endMs);
      last.count += 1;
    } else stretches.push({ fromMs: m.startMs, toMs: m.endMs, count: 1 });
  }
  stretches.sort((a, b) => b.toMs - b.fromMs - (a.toMs - a.fromMs));
  return {
    missing,
    missingMs: missing.reduce((n, m) => n + (m.endMs - m.startMs), 0),
    stretches,
    unseen: followsDialogue ? unseenAll : [],
    linesCovered: Math.round(linesCovered * 1000) / 1000,
    followsDialogue,
  };
}

const span = (fromMs: number, toMs: number): string => `${formatClock(fromMs)}–${formatClock(toMs)}`;

/** The check's warnings, in the STT step's words (none when all is well). Pure. */
export function coverageWarnings(result: CoverageResult): Warning[] {
  const out: Warning[] = [];
  if (result.missing.length >= MIN_MISSING || result.missingMs >= MIN_MISSING_MS) {
    const seconds = Math.round(result.missingMs / 1000);
    const biggest =
      result.stretches
        .slice(0, NAMED)
        .map((s) => `${span(s.fromMs, s.toMs)} (${s.count})`)
        .join(', ') + (result.stretches.length > NAMED ? ', …' : '');
    out.push({
      code: 'subtitles-without-lines',
      key: 'warning.subtitles-without-lines',
      params: { count: result.missing.length, seconds, biggest },
      message:
        `${result.missing.length} subtitle(s) of the video itself (${seconds} s) have no line under them: speech that was probably lost. ` +
        `Biggest stretches: ${biggest}. Transcribe them again (retranscribe_range over each stretch) or write the lines.`,
    });
  }
  if (result.unseen.length >= MIN_UNSEEN) {
    const first = result.unseen
      .slice(0, NAMED)
      .map((l) => formatClock(l.startMs))
      .join(', ');
    const examples = first + (result.unseen.length > NAMED ? ', …' : '');
    out.push({
      code: 'lines-without-subtitles',
      key: 'warning.lines-without-subtitles',
      params: { count: result.unseen.length, examples },
      message:
        `${result.unseen.length} line(s) have no subtitle of the video under them, while its subtitles follow the dialogue elsewhere: ` +
        `they may be hallucinated. First ones at ${examples}. Check them (get_transcript, retranscribe_range).`,
    });
  }
  return out;
}

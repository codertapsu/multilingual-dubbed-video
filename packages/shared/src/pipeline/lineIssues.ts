/**
 * The lines of a dub to look at once it ran: those still failing the
 * translation checks, and the voices that run into the next line.
 *
 * WHY: holdFlaggedLines stops a dub before voicing for flagged lines. A user
 * who leaves it off has them voiced as they are and reviews them later, and
 * for that they must stay visible until fixed or set aside: on the project and
 * its part in the lists, in the editor, and in get_project and get_series
 * (claude-dubber, 2026-11-25, H7). Pure.
 */
import type { AlignedSegment, LineIssueCounts, LineQualityFlag, ProjectLineIssues, TranscriptSegment } from '../models/domain.js';

/** Each check in a few English words, for the warnings and the agent (the screens translate their own). */
export const LINE_FLAG_WORDS: Readonly<Record<LineQualityFlag, string>> = {
  untranslated: 'untranslated',
  'wrong-script': 'letters of another script',
  pinyin: 'a pinyin name',
  'no-diacritics': 'no diacritics',
  alternatives: '"/" alternatives',
};

/**
 * A voice running into the next line by more than this is listed. Less is
 * barely heard, and 1-6 such lines per part would bury the ones that matter
 * (claude-dubber's threshold: "> 300 ms").
 */
export const OVERRUN_REPORT_MS = 300;

type IssueLine = Pick<TranscriptSegment, 'id' | 'qualityFlags' | 'locked' | 'song'>;
type IssueUnit = Pick<AlignedSegment, 'segmentId' | 'status' | 'overflowMs'>;
/** A pipeline's warnings as far as their codes go (a PipelineState is one). */
type IssueWarnings = { warnings?: readonly { code: string }[]; dismissedWarnings?: readonly { code: string }[] };

/** A warning with this code was dismissed, and no run has raised it again since. */
export function warningDismissed(p: IssueWarnings | undefined, code: string): boolean {
  return (p?.dismissedWarnings ?? []).some((w) => w.code === code) && !(p?.warnings ?? []).some((w) => w.code === code);
}

/** A line still failing the checks: flagged, and neither the user's (locked) nor a song. */
export function isFlaggedLine(l: IssueLine): boolean {
  return l.locked !== true && l.song !== true && (l.qualityFlags?.length ?? 0) > 0;
}

/**
 * The lines to look at, from the translated lines, the alignment and the
 * pipeline's warnings (whose dismissal sets them aside). Either list may be
 * absent: not translated, or not aligned yet.
 */
export function lineIssuesFrom(
  lines: readonly IssueLine[] | undefined,
  aligned: readonly IssueUnit[] | undefined,
  pipeline?: IssueWarnings,
): ProjectLineIssues {
  const flagged = (lines ?? []).filter(isFlaggedLine).map((l) => ({ id: l.id, flags: [...(l.qualityFlags ?? [])] }));
  const overruns = (aligned ?? [])
    .filter((a) => a.status === 'timing-conflict' && Number.isFinite(a.overflowMs) && a.overflowMs > OVERRUN_REPORT_MS)
    .map((a) => ({ id: a.segmentId, overflowMs: Math.round(a.overflowMs) }));
  return {
    flagged,
    overruns,
    ...(flagged.length > 0 && warningDismissed(pipeline, 'lines-flagged') ? { flaggedDismissed: true as const } : {}),
    ...(overruns.length > 0 && warningDismissed(pipeline, 'timing-conflicts') ? { overrunsDismissed: true as const } : {}),
  };
}

/** The counts the lists show: what is set aside is not counted. */
export function lineIssueCounts(issues: ProjectLineIssues): LineIssueCounts {
  return {
    flagged: issues.flaggedDismissed ? 0 : issues.flagged.length,
    overruns: issues.overrunsDismissed ? 0 : issues.overruns.length,
  };
}

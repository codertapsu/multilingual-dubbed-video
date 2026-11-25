/**
 * A project's lines to look at (shared pipeline/lineIssues.ts), read from its
 * files and kept while those do not change.
 *
 * WHY a cache: GET /projects asks it for every project, and one part's
 * transcript is about 200 KB, so a list of a 48-part series would read and
 * parse them all at every visit. Only what the issues need is kept (the
 * flagged lines, the overrunning voices, the warning codes), never the files.
 * The JSON artifacts are written through writeJsonAtomic, a new file renamed
 * over the old one, so their mtime moves with every write; size and mtime
 * together are the key.
 */
import { promises as fsp } from 'node:fs';
import {
  lineIssuesFrom,
  type AlignedSegment,
  type ProjectLineIssues,
  type TranscriptSegment,
} from '@videodubber/shared';

import type { WorkspacePaths } from './paths.js';

type IssuePaths = Pick<WorkspacePaths, 'translatedJson' | 'translatedAlignedJson' | 'pipelineJson'>;
type FlagLine = Pick<TranscriptSegment, 'id' | 'qualityFlags' | 'locked' | 'song'>;
type ConflictUnit = Pick<AlignedSegment, 'segmentId' | 'status' | 'overflowMs'>;
type WarningCodes = { warnings: { code: string }[]; dismissedWarnings: { code: string }[] };

/** Files kept at most (three per project): a long list of projects only drops the oldest. */
const MAX_ENTRIES = 1500;

/** The flagged lines of translated.json: the others are not needed. */
function flaggedLines(raw: unknown): FlagLine[] {
  const segments = (raw as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) return [];
  return segments
    .filter((s): s is TranscriptSegment => typeof (s as TranscriptSegment)?.id === 'string' && ((s as TranscriptSegment).qualityFlags?.length ?? 0) > 0)
    .map((s) => ({ id: s.id, qualityFlags: s.qualityFlags, ...(s.locked ? { locked: true } : {}), ...(s.song ? { song: true } : {}) }));
}

/** The units of translated.aligned.json in timing conflict. */
function conflictUnits(raw: unknown): ConflictUnit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is AlignedSegment => typeof (a as AlignedSegment)?.segmentId === 'string' && (a as AlignedSegment).status === 'timing-conflict')
    .map((a) => ({ segmentId: a.segmentId, status: a.status, overflowMs: Number(a.overflowMs) }));
}

/** The codes of pipeline.json's warnings, raised and dismissed. */
function warningCodes(raw: unknown): WarningCodes {
  const codes = (list: unknown) =>
    Array.isArray(list) ? list.filter((w) => typeof (w as { code?: unknown })?.code === 'string').map((w) => ({ code: (w as { code: string }).code })) : [];
  const p = raw as { warnings?: unknown; dismissedWarnings?: unknown } | undefined;
  return { warnings: codes(p?.warnings), dismissedWarnings: codes(p?.dismissedWarnings) };
}

export class LineIssueReader {
  private readonly entries = new Map<string, { key: string; value: unknown }>();

  constructor(private readonly paths: (projectId: string) => IssuePaths) {}

  /** The project's lines to look at now: none when it is not translated or aligned yet. */
  async of(projectId: string): Promise<ProjectLineIssues> {
    const p = this.paths(projectId);
    const [lines, units, warnings] = await Promise.all([
      this.read(p.translatedJson, flaggedLines),
      this.read(p.translatedAlignedJson, conflictUnits),
      this.read(p.pipelineJson, warningCodes),
    ]);
    return lineIssuesFrom(lines, units, warnings);
  }

  /** The file reduced by `reduce`, re-read only when its size or mtime changed; undefined when it is missing or unreadable. */
  private async read<T>(file: string, reduce: (raw: unknown) => T): Promise<T | undefined> {
    let key: string;
    try {
      const st = await fsp.stat(file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      this.entries.delete(file);
      return undefined;
    }
    const hit = this.entries.get(file);
    if (hit?.key === key) return hit.value as T;
    let value: T;
    try {
      value = reduce(JSON.parse(await fsp.readFile(file, 'utf8')));
    } catch {
      // Half a file is never on disk (atomic writes); unreadable JSON is a broken project, not an issue list.
      return undefined;
    }
    this.entries.delete(file);
    this.entries.set(file, { key, value });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}

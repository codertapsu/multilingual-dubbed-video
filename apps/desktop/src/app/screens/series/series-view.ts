/**
 * The series screen's words for what the server sends: the AI's name, a
 * part's status, what "Start every part" did. Pure.
 */
import type { SeriesAiOption } from '@videodubber/shared';

import type { BadgeStatus } from '../../shared/status-badge/status-badge.component';

/**
 * The AI that chose the cuts, by name. The settings line printed its registry
 * id ("llama-cpp-chat"), which says nothing to a user.
 */
export function seriesAiName(id: string, options: readonly SeriesAiOption[]): string {
  const option = options.find((o) => o.id === id);
  if (!option) return id;
  // As the wizard and Download list it.
  return option.viaMotherClaude ? `${option.label} (Mother Claude)` : option.label;
}

const BADGE_STATUSES: ReadonlySet<string> = new Set<BadgeStatus>([
  'created',
  'queued',
  'running',
  'paused',
  'failed',
  'completed',
  'pending',
  'skipped',
  'idle',
]);

/**
 * A part's status as a badge (translated), or null for one this build does
 * not know. The rows printed the raw value ("running 45%").
 */
export function partBadge(status: string | undefined): BadgeStatus | null {
  return status !== undefined && BADGE_STATUSES.has(status) ? (status as BadgeStatus) : null;
}

/**
 * The parts typed in "Only these parts": "23, 24", "23-30", "1, 5–7". An
 * empty field is every part ([]); anything else unreadable is null.
 */
export function parsePartList(text: string): number[] | null {
  const t = text.trim();
  if (!t) return [];
  const out = new Set<number>();
  for (const piece of t.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(piece);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b) as [number, number];
      if (from < 1 || to - from > 1000) return null;
      for (let n = from; n <= to; n++) out.add(n);
    } else if (/^\d+$/.test(piece) && Number(piece) >= 1) {
      out.add(Number(piece));
    } else {
      return null;
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** One part of "Rebuild parts"' answer (seriesService.rebuildParts). */
export interface RebuiltPartView {
  index: number;
  rebuilt: boolean;
  skipped?: string;
  reason?: string;
  queued?: boolean;
  translationDiscarded?: boolean;
  oldLines?: number;
  newLines?: number;
  speakers?: number;
}

/**
 * What a rebuild did to one part, as a line of the report: rebuilt (where it
 * waits in the queue, or with its translation set aside), or why it was left.
 * A part left for another reason than being dubbed says the server's reason.
 */
export function rebuildReportLine(p: RebuiltPartView): { key: string; params: Record<string, string | number> } {
  const counts = { n: p.index, old: p.oldLines ?? 0, lines: p.newLines ?? 0, speakers: p.speakers ?? 0 };
  if (p.rebuilt) {
    if (p.translationDiscarded) return { key: 'series.report-rebuilt-forced', params: counts };
    return { key: p.queued ? 'series.report-rebuilt-queued' : 'series.report-rebuilt', params: counts };
  }
  if (p.skipped === 'running' && p.reason && p.reason !== 'is being dubbed now') {
    return { key: 'series.report-kept-busy', params: { n: p.index, why: p.reason } };
  }
  return { key: `series.report-kept-${p.skipped ?? 'missing'}`, params: { n: p.index } };
}

/** One part's answer to "Start every part" (seriesService.startParts). */
export interface PartStart {
  projectId: string;
  started?: boolean;
  queued?: boolean;
  /** Waiting for a model download to end; it starts by itself after. */
  waiting?: boolean;
  /** Already dubbed: left as it is. */
  done?: boolean;
  /** Paused or stopped on its own (Project.pausedByUser): left as it is until started itself. */
  held?: boolean;
  /** Why it did not start (the server's English). */
  error?: string;
}

/** The parts in POST /series/start's answer (the IPC types the body `unknown`). */
export function partStarts(body: unknown): PartStart[] {
  const parts = typeof body === 'object' && body !== null ? (body as { parts?: unknown }).parts : undefined;
  if (!Array.isArray(parts)) return [];
  return parts.filter(
    (p): p is PartStart => typeof p === 'object' && p !== null && typeof (p as { projectId?: unknown }).projectId === 'string',
  );
}

/** One line of the report under the Start button. */
export interface StartReportLine {
  key: string;
  params: Record<string, string | number>;
  /** The part did not start: its line stands out and opens it. */
  failed: boolean;
  projectId: string;
}

/**
 * What "Start every part" did, part by part. The server answers each part,
 * but the screen ignored the answer, so a part that could not start stayed
 * "Created" with nothing to say why. `indexOf` gives a part's number; a part
 * it does not know takes its place in the answer, which is the parts' order.
 */
export function startReport(starts: readonly PartStart[], indexOf: (projectId: string) => number | undefined): StartReportLine[] {
  return starts.map((s, i) => {
    const n = indexOf(s.projectId) ?? i + 1;
    const line = (key: string, failed = false, why?: string): StartReportLine => ({
      key,
      params: why === undefined ? { n } : { n, why },
      failed,
      projectId: s.projectId,
    });
    if (s.error) return line('series.start-failed', true, s.error);
    if (s.done) return line('series.start-done');
    if (s.held) return line('series.start-held');
    if (s.started) return line('series.start-started');
    if (s.waiting) return line('series.start-waiting');
    return line('series.start-queued');
  });
}

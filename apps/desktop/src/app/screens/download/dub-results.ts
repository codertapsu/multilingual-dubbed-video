import type { AppError } from '../../core/models';
import type { DownloadItem, DubDownloadResult } from '../../core/models/download';

/** What "Dub N videos" did with one video. */
export type DubOutcome = 'started' | 'queued' | 'waiting' | 'created' | 'series' | 'failed';

/** One line of the result, under the button that produced it. */
export interface DubResultRow {
  downloadId: string;
  /** The title the Downloads list shows for it, so the line is recognisable. */
  title: string;
  outcome: DubOutcome;
  /** Router commands to follow it: its progress page, or the series page of a video dubbed in parts. */
  link?: readonly string[];
  error?: AppError;
}

/**
 * The result of POST /downloads/dub, one row per video, in the order sent.
 *
 * It used to be one sentence in the card at the top of the screen ("3
 * projects made."), out of view of the button, with only the first failure
 * and no way to reach the projects it made (UX audit, 2026-11). Pure.
 */
export function dubResultRows(results: readonly DubDownloadResult[], items: readonly DownloadItem[]): DubResultRow[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return results.map((r) => {
    const item = byId.get(r.downloadId);
    const title = item?.source?.title || r.name || item?.input || r.downloadId;
    if (r.error || !r.projectId) {
      return { downloadId: r.downloadId, title, outcome: 'failed', ...(r.error ? { error: r.error } : {}) };
    }
    const outcome: DubOutcome = r.series ? 'series' : r.started ? 'started' : r.queued ? 'queued' : r.waiting ? 'waiting' : 'created';
    // A series is followed on its own page: the parts it makes are projects of their own.
    const link = ['/project', r.projectId, r.series ? 'series' : 'processing'];
    return { downloadId: r.downloadId, title, outcome, link };
  });
}

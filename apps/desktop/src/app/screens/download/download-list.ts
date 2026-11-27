/**
 * The download list as shown (download.component): which filter each download
 * belongs to, the filters' counts, the search, and the short forms a row shows.
 *
 * WHY: a long list (a playlist, a series' 40 parts) pushed the sign-in and dub
 * cards out of reach below it, and each download was a tall card with its
 * whole file path and four buttons; where a video came from was not shown at
 * all (2026-11-27). Pure.
 */
import type { DownloadItem } from '../../core/models/download';
import { fileName, fold } from '../../core/util/list-format';

/** What the list shows: everything, what is still to come, what is done, what went wrong. */
export type DownloadFilter = 'all' | 'active' | 'done' | 'problem';
export const DOWNLOAD_FILTERS: readonly DownloadFilter[] = ['all', 'active', 'done', 'problem'];

/** The filter a download belongs to besides All: waiting or under way, finished, or failed or cancelled. */
export function downloadGroup(item: Pick<DownloadItem, 'state'>): Exclude<DownloadFilter, 'all'> {
  switch (item.state) {
    case 'done':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'problem';
    default:
      return 'active';
  }
}

/** How many downloads each filter holds. */
export function downloadCounts(items: readonly Pick<DownloadItem, 'state'>[]): Record<DownloadFilter, number> {
  const counts: Record<DownloadFilter, number> = { all: items.length, active: 0, done: 0, problem: 0 };
  for (const item of items) counts[downloadGroup(item)]++;
  return counts;
}

/** The page a download came from: the site's own page once known, else what was pasted when it is a link. */
export function sourcePageOf(item: Pick<DownloadItem, 'input' | 'source'>): string | undefined {
  if (item.source?.url) return item.source.url;
  return /^https?:\/\//i.test(item.input.trim()) ? item.input.trim() : undefined;
}

/** A link short enough for a row: no scheme, no "www.", at most `max` characters. */
export function shortUrl(url: string, max = 60): string {
  const bare = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

/** Whether a download's title, part, uploader, link or file name holds the (folded) query. */
function matches(item: DownloadItem, folded: string): boolean {
  if (!folded) return true;
  const fields = [
    item.source?.title ?? '',
    item.source?.partTitle ?? '',
    item.source?.ownerName ?? '',
    item.input,
    item.source?.url ?? '',
    item.filePath ? fileName(item.filePath) : '',
  ];
  return fields.some((f) => fold(f).includes(folded));
}

/** The downloads a filter and a search leave, in the list's own order (newest first). */
export function filterDownloads(items: readonly DownloadItem[], opts: { query: string; filter: DownloadFilter }): DownloadItem[] {
  const folded = fold(opts.query.trim());
  return items.filter((item) => (opts.filter === 'all' || downloadGroup(item) === opts.filter) && matches(item, folded));
}

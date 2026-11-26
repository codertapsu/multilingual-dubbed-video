/**
 * The Projects list as shown.
 *
 * WHY: with dozens of dubs (a 48-part series among them) a flat list of cards
 * was hard to read (2026-11-26). A series is one entry now, its parts folded
 * under it behind a summary of where they stand; the list can be searched,
 * narrowed to what needs doing, and sorted. A part whose series is gone
 * (deleted) stands on its own. Pure.
 */
import type { Project, ProjectListItem } from '../../core/models';

/** What the list shows: everything, what is under way, what needs the user, what is done. */
export type ProjectFilter = 'all' | 'active' | 'attention' | 'finished';
export const PROJECT_FILTERS: readonly ProjectFilter[] = ['all', 'active', 'attention', 'finished'];

/** The order of the entries: last changed first, by name, or newest first. */
export type ProjectSort = 'recent' | 'name' | 'created';
export const PROJECT_SORTS: readonly ProjectSort[] = ['recent', 'name', 'created'];

/** Where a series' parts stand, for its header. */
export interface SeriesSummary {
  /** Parts made. */
  parts: number;
  done: number;
  running: number;
  /** Queued or paused. */
  waiting: number;
  failed: number;
  /** Made, never started. */
  notStarted: number;
  /** Lines voiced while still failing the translation checks, over every part. */
  flagged: number;
  /** The parts' length together, else the parent's (before the parts exist). */
  durationMs: number;
}

export type ProjectEntry =
  | { kind: 'project'; project: ProjectListItem }
  | {
      kind: 'series';
      parent: ProjectListItem;
      /** The parts shown, in order: all of them unless a search or a filter narrows the list. */
      parts: ProjectListItem[];
      summary: SeriesSummary;
      /** A search or a filter hides some parts: the group opens by itself to show the ones left. */
      narrowed: boolean;
    };

export interface ListOptions {
  query: string;
  filter: ProjectFilter;
  sort: ProjectSort;
}

/** Case- and accent-insensitive text, so "xuyen khong" finds "Xuyên Không". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** The file name of a path (either slash), for a card that has no room for the whole path. */
export function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** The series' name as its parts carry it (a series that continues another keeps that name). */
export function seriesName(parent: Project): string {
  return parent.series?.role === 'parent' ? (parent.series.settings.seriesName ?? parent.name) : parent.name;
}

const isActiveStatus = (p: Project): boolean => p.status === 'running' || p.status === 'queued' || p.status === 'paused';

/**
 * Where a series parent's OWN work stands. Once its parts are made, they carry
 * the work, and the parent counts for no filter of its own.
 */
function parentWork(p: Project): ProjectFilter | undefined {
  const s = p.series?.role === 'parent' ? p.series : undefined;
  if (!s) return undefined;
  if (p.status === 'failed' || s.state === 'failed' || s.state === 'review') return 'attention';
  if (s.state === 'parts') return undefined;
  return isActiveStatus(p) ? 'active' : undefined;
}

/** Whether one project belongs under a filter. */
export function matchesFilter(p: ProjectListItem, filter: ProjectFilter): boolean {
  if (filter === 'all') return true;
  if (p.series?.role === 'parent') return parentWork(p) === filter;
  switch (filter) {
    case 'active':
      return isActiveStatus(p);
    case 'attention':
      return p.status === 'failed' || (p.issues?.flagged ?? 0) > 0;
    case 'finished':
      return p.status === 'completed';
  }
}

/** Whether a project's name, file or part title holds the (folded) query. */
function matchesQuery(p: Project, folded: string): boolean {
  if (!folded) return true;
  const title = p.series?.role === 'part' ? (p.series.title ?? '') : '';
  return [p.name, fileName(p.inputVideoPath), title].some((t) => fold(t).includes(folded));
}

/** How many projects each filter holds (a made series' parent counts as its parts do). */
export function filterCounts(projects: readonly ProjectListItem[]): Record<Exclude<ProjectFilter, 'all'>, number> {
  const count = (f: ProjectFilter) => projects.filter((p) => matchesFilter(p, f)).length;
  return { active: count('active'), attention: count('attention'), finished: count('finished') };
}

/** Where a series' parts stand. */
export function summarizeSeries(parent: Project, parts: readonly ProjectListItem[]): SeriesSummary {
  const by = (s: Project['status']) => parts.filter((p) => p.status === s).length;
  const partsMs = parts.reduce((sum, p) => sum + (p.mediaInfo?.durationMs ?? 0), 0);
  return {
    parts: parts.length,
    done: by('completed'),
    running: by('running'),
    waiting: by('queued') + by('paused'),
    failed: by('failed'),
    notStarted: by('created'),
    flagged: parts.reduce((sum, p) => sum + (p.issues?.flagged ?? 0), 0),
    durationMs: partsMs > 0 ? partsMs : (parent.mediaInfo?.durationMs ?? 0),
  };
}

const partIndex = (p: Project): number => (p.series?.role === 'part' ? p.series.index : 0);
const latest = (projects: readonly Project[]): string => projects.reduce((max, p) => (p.updatedAt > max ? p.updatedAt : max), '');
const nameOf = (e: ProjectEntry): string => (e.kind === 'series' ? seriesName(e.parent) : e.project.name);
const changedOf = (e: ProjectEntry, allParts: ReadonlyMap<string, ProjectListItem[]>): string =>
  e.kind === 'series' ? latest([e.parent, ...(allParts.get(e.parent.id) ?? [])]) : e.project.updatedAt;
const createdOf = (e: ProjectEntry): string => (e.kind === 'series' ? e.parent.createdAt : e.project.createdAt);

/** The list as shown: each series one entry with its parts, searched, filtered and sorted. */
export function projectEntries(projects: readonly ProjectListItem[], opts: ListOptions): ProjectEntry[] {
  const folded = fold(opts.query.trim());
  const ids = new Set(projects.map((p) => p.id));
  const partsOf = new Map<string, ProjectListItem[]>();
  for (const p of projects) {
    if (p.series?.role === 'part' && ids.has(p.series.parentId)) {
      const list = partsOf.get(p.series.parentId) ?? [];
      list.push(p);
      partsOf.set(p.series.parentId, list);
    }
  }
  for (const list of partsOf.values()) list.sort((a, b) => partIndex(a) - partIndex(b));

  const entries: ProjectEntry[] = [];
  for (const p of projects) {
    if (p.series?.role === 'part' && ids.has(p.series.parentId)) continue; // shown in its series
    if (p.series?.role === 'parent') {
      const all = partsOf.get(p.id) ?? [];
      // The series' own name matching lets every part through the search.
      const nameHit = !folded || fold(seriesName(p)).includes(folded) || matchesQuery(p, folded);
      const parts = all.filter((part) => matchesFilter(part, opts.filter) && (nameHit || matchesQuery(part, folded)));
      const own = matchesFilter(p, opts.filter) && nameHit;
      if (parts.length > 0 || own) {
        entries.push({ kind: 'series', parent: p, parts, summary: summarizeSeries(p, all), narrowed: parts.length < all.length });
      }
      continue;
    }
    if (matchesFilter(p, opts.filter) && matchesQuery(p, folded)) entries.push({ kind: 'project', project: p });
  }

  const collator = new Intl.Collator(['vi', 'en'], { numeric: true, sensitivity: 'base' });
  const byRecent = (a: ProjectEntry, b: ProjectEntry) => changedOf(b, partsOf).localeCompare(changedOf(a, partsOf));
  const sorters: Record<ProjectSort, (a: ProjectEntry, b: ProjectEntry) => number> = {
    recent: byRecent,
    name: (a, b) => collator.compare(nameOf(a), nameOf(b)) || byRecent(a, b),
    created: (a, b) => createdOf(b).localeCompare(createdOf(a)) || byRecent(a, b),
  };
  return entries.sort(sorters[opts.sort]);
}

/** A video's length the way players show it: "2:30", "48:00", "8:12:00". */
export function clockDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Just a part's number ("Phần 07", "Part 7", "Tập 7", "07"): a row already says that. */
const BARE_PART_NUMBER = /^(phan|part|tap|ep|episode)?\.?\s*\d+$/;

/**
 * What a part's row says beside "Part N": its title, else its name without the
 * series' name in front ("Xuyên Không - Phần 07" in "Xuyên Không" says nothing
 * more than the number, so nothing). Pure.
 */
export function partCaption(part: Project, series: string): string {
  if (part.series?.role === 'part' && part.series.title) return part.series.title;
  const name = part.name.trim();
  if (!fold(name).startsWith(fold(series))) return name;
  const rest = name.slice(series.length).replace(/^[\s\-–—:|·.]+/, '').trim();
  return BARE_PART_NUMBER.test(fold(rest)) ? '' : rest;
}

/**
 * A date as short as it can be told apart: the time today, the day this year,
 * the full date before. `locale` is the app's ("vi" writes "25 thg 11").
 */
export function shortDate(iso: string, locale: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

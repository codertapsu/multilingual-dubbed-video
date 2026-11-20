/**
 * The Projects list as shown: a series is one entry with its parts right under
 * it, in order, instead of a parent and n parts scattered by date among the
 * other projects. A part whose series is gone (deleted) stands on its own.
 * Pure.
 */
import type { Project } from '../../core/models';

export interface ListedProject {
  project: Project;
  /** A part, shown under its series. */
  nested: boolean;
}

export function groupSeries(projects: readonly Project[]): ListedProject[] {
  const ids = new Set(projects.map((p) => p.id));
  const partsOf = new Map<string, Project[]>();
  const isNestedPart = (p: Project): boolean => p.series?.role === 'part' && ids.has(p.series.parentId);
  for (const p of projects) {
    if (p.series?.role === 'part' && isNestedPart(p)) {
      const list = partsOf.get(p.series.parentId) ?? [];
      list.push(p);
      partsOf.set(p.series.parentId, list);
    }
  }
  const index = (p: Project): number => (p.series?.role === 'part' ? p.series.index : 0);
  const out: ListedProject[] = [];
  for (const p of projects) {
    if (isNestedPart(p)) continue;
    out.push({ project: p, nested: false });
    for (const part of [...(partsOf.get(p.id) ?? [])].sort((a, b) => index(a) - index(b))) {
      out.push({ project: part, nested: true });
    }
  }
  return out;
}

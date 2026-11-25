/**
 * How a project's source names itself, as people wrote it: its title (the
 * site's, the part's), the project's name, and the names of the files a
 * joined project was made from. Speech recognition hears names; these spell
 * them. 《反相之地》 was heard 反向之地, and the glossary and every part title
 * carried the mishearing while all nine file names said 反相之地
 * (claude-dubber, 2026-11-25, F1). Pure.
 */
import path from 'node:path';

import type { Project } from '@videodubber/shared';

export function sourceNameHints(project: Pick<Project, 'name' | 'source' | 'inputFiles'>): string[] {
  const out: string[] = [];
  const add = (label: string, value: string | undefined): void => {
    const v = value?.trim();
    if (v && !out.some((o) => o.endsWith(`: ${v}`))) out.push(`${label}: ${v}`);
  };
  add('Title', project.source?.title);
  add('Part title', project.source?.partTitle);
  add('Project', project.name);
  for (const f of (project.inputFiles ?? []).slice(0, 12)) add('File', path.parse(f.name).name);
  return out;
}

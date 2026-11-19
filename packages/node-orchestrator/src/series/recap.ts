/**
 * A part's recap (its first seconds, the end of the previous part) says the
 * same lines the previous part said, so it should say them in the same
 * words: after a part's translation, its recap lines take the previous part's
 * translation when that part is already translated (parts dub in order). A
 * previous part not translated yet leaves them as they are.
 */
import fsp from 'node:fs/promises';

import type { Project } from '@videodubber/shared';

import type { ProjectStore } from '../workspace/projectStore.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

interface Line {
  startMs: number;
  sourceText: string;
  translatedText?: string;
}

async function readLines(file: string): Promise<Line[] | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: Line[] } | Line[];
    return Array.isArray(raw) ? raw : raw.segments;
  } catch {
    return undefined;
  }
}

/** Copy the previous part's translation onto this part's recap lines; how many changed. */
export async function reuseRecapTranslations(project: Project, store: ProjectStore): Promise<number> {
  const info = project.series;
  if (info?.role !== 'part' || info.index <= 1 || info.recapEndMs <= 0 || !project.sourceRange) return 0;
  const parent = await store.getProject(info.parentId).catch(() => undefined);
  const previousId = parent?.series?.role === 'parent' ? parent.series.partIds?.[info.index - 2] : undefined;
  if (!previousId) return 0;
  const previous = await store.getProject(previousId).catch(() => undefined);
  const theirs = await readLines(store.paths(previousId).translatedJson);
  const file = store.paths(project.id).translatedJson;
  const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: Line[] };
  const mine = raw.segments;
  if (!previous || !theirs || !mine) return 0;
  // Where this part's time 0 is, in the previous part's time.
  const offset = project.sourceRange.startMs - (previous.sourceRange?.startMs ?? 0);
  let changed = 0;
  for (const line of mine) {
    if (line.startMs >= info.recapEndMs) continue;
    const same = theirs.find((t) => t.sourceText === line.sourceText && Math.abs(t.startMs - (line.startMs + offset)) < 1500);
    if (same?.translatedText && same.translatedText !== line.translatedText) {
      line.translatedText = same.translatedText;
      changed += 1;
    }
  }
  if (changed > 0) await writeJsonAtomic(file, raw);
  return changed;
}

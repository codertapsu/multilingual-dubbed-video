/**
 * How a series' parts are numbered and named for the viewer (models/series.ts).
 *
 * A series that continues another (a later season) carries its name on and
 * numbers its parts after the other's: part 49 of 60, not part 1 of 12. The
 * numbers shown are the parts' `index`; their order in the series is their
 * place in `partIds`. Pure.
 */
import type { Project, SeriesParentInfo, SeriesSettings } from '@videodubber/shared';

/** The series' name on its parts and cards: the one it continues, else the parent project's own. */
export function seriesNameOf(parent: Pick<Project, 'name'> & { series: Pick<SeriesParentInfo, 'settings'> }): string {
  return parent.series.settings.seriesName?.trim() || parent.name;
}

/**
 * The numbers a series' parts are shown with: after `partNumberOffset`, out
 * of `totalParts`, which is never fewer than the parts there are ("Phần 55/50"
 * would say nothing true).
 */
export function partNumbering(
  settings: Pick<SeriesSettings, 'partNumberOffset' | 'totalParts'>,
  ownParts: number,
): { offset: number; total: number } {
  const offset = Math.max(0, Math.floor(Number(settings.partNumberOffset) || 0));
  return { offset, total: Math.max(Math.floor(Number(settings.totalParts) || 0), offset + ownParts) };
}

/** "23", "23–24", "1, 5–7": part numbers for a sentence. */
export function partList(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return runs.join(', ');
}

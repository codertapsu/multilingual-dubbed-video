/**
 * Picking the parts of a multi-part video to download (Download → Check
 * link). Before 2026-11-27 the page offered one part or all of them: a
 * 48-part upload whose user wanted P3–P10 had to add eight links by hand
 * or download all 48. Pure.
 */

/** The part a link pointed at (`?p=3`), else the video's first. */
export function linkedPage(info: { parts: readonly { page: number }[]; requestedPage?: number }): number {
  return info.parts.find((p) => p.page === info.requestedPage)?.page ?? info.parts[0]?.page ?? 1;
}

/**
 * The ticked parts after a click on part `page` (now `on`). With `anchor`
 * (the part clicked before, Shift held), every part between the two takes
 * the same state, as in a file list.
 */
export function pickParts(
  current: ReadonlySet<number>,
  pages: readonly number[],
  page: number,
  on: boolean,
  anchor?: number,
): Set<number> {
  const from = anchor ?? page;
  const lo = Math.min(from, page);
  const hi = Math.max(from, page);
  const next = new Set(current);
  for (const p of pages) {
    if (p < lo || p > hi) continue;
    if (on) next.add(p);
    else next.delete(p);
  }
  return next;
}

/** The ticked parts in short: "P1–P3, P7, P10–P12", in order. */
export function partRanges(picked: Iterable<number>): string {
  const pages = [...new Set(picked)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(j === i ? `P${pages[i]}` : `P${pages[i]}–P${pages[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

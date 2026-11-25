/**
 * Seconds left in a run, from its own pace since it was first seen running:
 * the time since then over the progress made since (`made` points of 100).
 * Rough, as steps do not take equal time, and absent until 3 points were made.
 *
 * WHY this pace and not the first step's start: a dub resumed after a pause
 * (or the app closing) keeps the start of its first run, days earlier for the
 * 48-part series, and that would make every estimate absurd. Pure.
 */
export function runEtaSeconds(since: { atMs: number; percent: number }, percent: number, nowMs = Date.now()): number | undefined {
  const made = percent - since.percent;
  const elapsed = (nowMs - since.atMs) / 1000;
  if (!(made >= 3) || percent >= 100 || !(elapsed > 0)) return undefined;
  return Math.round((elapsed * (100 - percent)) / made);
}

import type { PipelineStepId } from '../../../core/models';

/**
 * What a re-dub from a stage throws away of the user's own work.
 *
 * Re-running from translation (or anything before it) builds every line's
 * text again from the source: the translation step does not keep locked
 * lines (only the review pass and auto-fit do, pipeline/runner.ts). "Re-dub
 * from: Translation" and "Save & re-translate" ran without a word, under a
 * tooltip promising "reusing the earlier stages", and replaced the lines the
 * user had rewritten by hand.
 */

/** The stages whose re-run translates every line again. */
const RETRANSLATING: ReadonlySet<PipelineStepId> = new Set<PipelineStepId>(['probe-video', 'extract-audio', 'stt', 'translation']);

/** True when re-dubbing from `step` replaces every line's translation. */
export function retranslates(step: PipelineStepId): boolean {
  return RETRANSLATING.has(step);
}

/**
 * Lines whose translation the user wrote or locked by hand. A text edit
 * locks its line (the editor and the server both do), so the lock is the
 * only record of "written by hand" there is: the count cannot tell the two
 * apart, and the prompt says so.
 */
export function handLockedCount(lines: readonly { locked?: boolean }[]): number {
  let n = 0;
  for (const l of lines) if (l.locked === true) n++;
  return n;
}

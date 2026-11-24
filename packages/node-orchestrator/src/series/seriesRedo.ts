/**
 * A part changed after it was dubbed (its transcript rebuilt with force, its
 * title edited): which steps its next run must do again.
 */
import {
  PIPELINE_STEP_IDS,
  pausePipelineState,
  pipelineStepIndex,
  setStepStatus,
  type PipelineState,
  type PipelineStepId,
} from '@videodubber/shared';

/**
 * The pipeline with `step` and every step after it to do again on the next
 * run, the steps before it kept: those steps pending, and the pipeline paused
 * at `step`, so Continue (or start_series, which continues paused parts)
 * starts there. Unchanged when nothing from `step` on had been done. Pure.
 *
 * WHY paused: the runner takes a pending step whose file is on disk for done
 * work (an older project's artifacts) and skips it; only the step a paused
 * run continues at, and the ones after it, are always run. A part rebuilt with
 * force after it was voiced would have translated again and kept its old
 * voices, mix and video; a part whose title changed would have kept its old
 * title card (2.2/2.4 of the 2026-11-23 plan).
 */
export function redoFrom(state: PipelineState, step: PipelineStepId, now: string = new Date().toISOString()): PipelineState {
  const from = pipelineStepIndex(step);
  const later = state.steps.filter((s) => pipelineStepIndex(s.id) >= from);
  if (later.every((s) => s.status === 'pending')) return state;
  let next = state;
  for (const id of PIPELINE_STEP_IDS) {
    if (pipelineStepIndex(id) >= from) next = setStepStatus(next, id, 'pending', undefined, now);
  }
  return pausePipelineState(next, now);
}

/** The step has run (done, or found done) for this pipeline. */
export function stepDone(state: PipelineState, step: PipelineStepId): boolean {
  const s = state.steps.find((x) => x.id === step);
  return s?.status === 'completed' || s?.status === 'skipped';
}

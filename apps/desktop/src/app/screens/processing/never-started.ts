/**
 * Whether a dub never started, so the progress screen offers Start. Pure.
 *
 * Home and the series page send such a project to the progress screen (the
 * wizard was left at step 2, or a series' "Open it to start"), and that screen
 * had no Start: its Continue is only for a paused dub. Also a dub whose queued
 * start failed before it ran (the project reads "failed", its steps all
 * pending): Start says what is wrong.
 */
import type { PipelineState, Project } from '../../core/models';

export function isNeverStarted(
  pipeline: PipelineState | null,
  projectStatus: Project['status'] | undefined,
  queued: boolean,
): boolean {
  if (!pipeline || projectStatus === undefined || queued || pipeline.awaitingReview) return false;
  // Running: between two steps the pipeline reads "idle" for a moment.
  if (projectStatus === 'running' || projectStatus === 'queued') return false;
  // Paused in its first step is paused (Continue), not never started.
  return pipeline.status === 'idle' && pipeline.steps.length > 0 && pipeline.steps.every((s) => s.status === 'pending');
}

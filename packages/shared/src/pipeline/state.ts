/**
 * Pure, deterministic pipeline-state transitions.
 *
 * `setStepStatus` never mutates its input; it returns a fresh
 * {@link PipelineState} with progress and overall status rolled up.
 */

import type { PipelineStepId } from '../models/domain.js';
import type {
  PipelineState,
  PipelineStatus,
  PipelineStepState,
  PipelineStepStatus,
} from '../models/pipeline.js';
import { PIPELINE_STEP_DEFS } from './steps.js';

/**
 * Build the initial pipeline state for a project: all steps `pending`,
 * overall status `idle`, 0% progress.
 *
 * @param projectId Owning project id.
 * @param now       Optional ISO timestamp (defaults to the current time);
 *                  pass a fixed value for deterministic tests.
 */
export function createInitialPipelineState(
  projectId: string,
  now: string = new Date().toISOString(),
): PipelineState {
  const steps: PipelineStepState[] = PIPELINE_STEP_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    status: 'pending',
    progressPercent: 0,
  }));
  return {
    projectId,
    currentStep: undefined,
    steps,
    progressPercent: 0,
    status: 'idle',
    updatedAt: now,
  };
}

/**
 * Reconcile a persisted pipeline state with the CURRENT canonical step list:
 * steps added in newer app versions (e.g. `refine`) are inserted as `pending`
 * in canonical order, and labels are refreshed. Without this, a pipeline.json
 * written by an older version silently drops the new step — `setStepStatus`
 * maps over existing entries, so the runner's transitions for it would no-op
 * and the UI would never show it. Steps whose ids are no longer known are
 * removed. Returns the input unchanged (same reference) when already current.
 */
export function normalizePipelineState(state: PipelineState): PipelineState {
  const byId = new Map(state.steps.map((s) => [s.id, s]));
  const isCurrent =
    state.steps.length === PIPELINE_STEP_DEFS.length &&
    PIPELINE_STEP_DEFS.every((def, i) => state.steps[i]?.id === def.id && state.steps[i]?.label === def.label);
  if (isCurrent) return state;
  const steps: PipelineStepState[] = PIPELINE_STEP_DEFS.map((def) => {
    const existing = byId.get(def.id);
    return existing ? { ...existing, label: def.label } : { id: def.id, label: def.label, status: 'pending', progressPercent: 0 };
  });
  return { ...state, steps };
}

/** Fields of a step that callers may patch alongside a status change. */
export type StepPatch = Partial<
  Pick<PipelineStepState, 'progressPercent' | 'startedAt' | 'finishedAt' | 'error' | 'detail'>
>;

/**
 * Compute the overall pipeline status from per-step statuses.
 *
 * Priority order:
 *  - any `failed`            -> `failed`
 *  - any `running`           -> `running`
 *  - all `completed`/`skipped` (and at least one not pending) -> `completed`
 *  - otherwise               -> `idle`
 */
function rollUpStatus(steps: PipelineStepState[]): PipelineStatus {
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.some((s) => s.status === 'running')) return 'running';
  const allDone = steps.every((s) => s.status === 'completed' || s.status === 'skipped');
  if (allDone) return 'completed';
  return 'idle';
}

/**
 * Overall progress = (completed + skipped + the running step's own share) /
 * total * 100, rounded. Finished steps alone held a dub at "22%" for the whole
 * of its speech-to-text, and its time left, which comes from this, at "about
 * 8 min" for the hour speaker detection took (claude-dubber, 2026-11-27).
 */
function rollUpProgress(all: PipelineStepState[], endsAfter?: PipelineStepId): number {
  // A pipeline that ends early (PipelineState.endsAfter) counts only its own steps.
  const last = endsAfter ? all.findIndex((s) => s.id === endsAfter) : -1;
  const steps = last >= 0 ? all.slice(0, last + 1) : all;
  const total = steps.length;
  if (total === 0) return 0;
  const done = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  const running = steps.find((s) => s.status === 'running');
  const share = running ? Math.max(0, Math.min(100, running.progressPercent ?? 0)) / 100 : 0;
  return Math.round(((done + share) / total) * 100);
}

/**
 * The pipeline set to end after `stepId` (PipelineState.endsAfter), or to
 * run to the end when undefined, with its progress counted again. Pure.
 */
export function withEndsAfter(state: PipelineState, stepId: PipelineStepId | undefined): PipelineState {
  if (state.endsAfter === stepId) return state;
  const { endsAfter: _old, ...rest } = state;
  const next: PipelineState = stepId ? { ...rest, endsAfter: stepId } : rest;
  return { ...next, progressPercent: rollUpProgress(next.steps, next.endsAfter) };
}

/**
 * Determine the "current step": the running step if any, otherwise the first
 * step that is not yet completed/skipped, otherwise undefined (all done).
 */
function computeCurrentStep(steps: PipelineStepState[]): PipelineStepId | undefined {
  const running = steps.find((s) => s.status === 'running');
  if (running) return running.id;
  const next = steps.find((s) => s.status !== 'completed' && s.status !== 'skipped');
  return next?.id;
}

/**
 * Pure transition: set the status (and optional patch) of one step and
 * recompute derived fields (progress, currentStep, overall status).
 *
 * Defaults applied automatically:
 *  - `completed`/`skipped` set the step's `progressPercent` to 100 unless the
 *    patch explicitly provides one.
 *  - `error` is cleared when transitioning away from `failed` unless provided.
 *
 * @param state  The current state (not mutated).
 * @param stepId The step to update.
 * @param status The new status for that step.
 * @param patch  Optional extra fields to set on the step.
 * @param now    Optional ISO timestamp for `updatedAt` (deterministic tests).
 * @returns A new {@link PipelineState}.
 */
export function setStepStatus(
  state: PipelineState,
  stepId: PipelineStepId,
  status: PipelineStepStatus,
  patch?: StepPatch,
  now: string = new Date().toISOString(),
): PipelineState {
  const steps: PipelineStepState[] = state.steps.map((step) => {
    if (step.id !== stepId) return { ...step };

    const next: PipelineStepState = { ...step, status };

    // Progress default for terminal-success statuses.
    if (patch?.progressPercent !== undefined) {
      next.progressPercent = clampPercent(patch.progressPercent);
    } else if (status === 'completed' || status === 'skipped') {
      next.progressPercent = 100;
    } else if (status === 'pending') {
      next.progressPercent = 0;
    }

    // startedAt / finishedAt handling.
    if (patch?.startedAt !== undefined) {
      next.startedAt = patch.startedAt;
    } else if (status === 'running' && next.startedAt === undefined) {
      next.startedAt = now;
    }

    if (patch?.finishedAt !== undefined) {
      next.finishedAt = patch.finishedAt;
    } else if (status === 'completed' || status === 'failed' || status === 'skipped') {
      next.finishedAt = now;
    }

    // error handling.
    if (patch?.error !== undefined) {
      next.error = patch.error;
    } else if (status !== 'failed') {
      // Clear any stale error when leaving the failed state.
      next.error = undefined;
    }

    // Where a long step is inside itself: only while it runs.
    if (status === 'running') {
      if (patch && 'detail' in patch) next.detail = patch.detail;
    } else {
      delete next.detail;
    }

    // Reset transient fields when going back to pending.
    if (status === 'pending') {
      next.startedAt = patch?.startedAt;
      next.finishedAt = patch?.finishedAt;
      next.error = patch?.error;
    }

    return next;
  });

  const overall = rollUpStatus(steps);

  return {
    ...state,
    steps,
    progressPercent: rollUpProgress(steps, state.endsAfter),
    currentStep: computeCurrentStep(steps),
    status: overall,
    // Preserve a top-level error only while failed; otherwise clear it.
    error:
      overall === 'failed'
        ? steps.find((s) => s.status === 'failed')?.error ?? state.error
        : undefined,
    updatedAt: now,
  };
}

/**
 * The pipeline after its run stopped part-way and will continue later (a
 * pause, or an app that closed mid-run): the step that was running goes back
 * to `pending`, keeping the progress it had reported, and the pipeline is
 * `paused` at that step. Stopped between steps, it is paused at the next one.
 * A pipeline with nothing left to do is returned unchanged.
 */
export function pausePipelineState(state: PipelineState, now: string = new Date().toISOString()): PipelineState {
  const pausedStep = computeCurrentStep(state.steps);
  if (pausedStep === undefined) return state;
  const steps: PipelineStepState[] = state.steps.map((step) => {
    if (step.status !== 'running') return { ...step };
    const { startedAt: _startedAt, finishedAt: _finishedAt, error: _error, ...rest } = step;
    return { ...rest, status: 'pending' };
  });
  return {
    ...state,
    steps,
    progressPercent: rollUpProgress(steps, state.endsAfter),
    currentStep: pausedStep,
    status: 'paused',
    error: undefined,
    pausedAt: now,
    pausedStep,
    updatedAt: now,
  };
}

/** The pipeline as a new run starts: no longer paused, its status read from its steps again. */
export function resumePipelineState(state: PipelineState, now: string = new Date().toISOString()): PipelineState {
  if (state.pausedAt === undefined && state.pausedStep === undefined && state.status !== 'paused') return state;
  const { pausedAt: _pausedAt, pausedStep: _pausedStep, ...rest } = state;
  return { ...rest, status: rollUpStatus(state.steps), currentStep: computeCurrentStep(state.steps), updatedAt: now };
}

/** Clamp a percentage into the 0..100 integer range. */
function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * Pipeline state types: the per-step and overall progress model that the
 * orchestrator persists (pipeline.json) and streams to the UI over SSE.
 */

import type { PipelineStepId } from './domain.js';

/** Status of a single pipeline step. */
export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

/** Runtime state of a single pipeline step. */
export interface PipelineStepState {
  /** Step identifier. */
  id: PipelineStepId;
  /** Human-readable label for the UI. */
  label: string;
  /** Current status. */
  status: PipelineStepStatus;
  /** Progress for this step in the range 0..100. */
  progressPercent: number;
  /** ISO-8601 start timestamp, when running/completed. */
  startedAt?: string;
  /** ISO-8601 finish timestamp, when completed/failed/skipped. */
  finishedAt?: string;
  /** Error message for a failed step. */
  error?: string;
}

/** Overall status of the pipeline run. */
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'failed' | 'completed';

/** Aggregate state of a project's pipeline run. */
export interface PipelineState {
  /** Owning project id. */
  projectId: string;
  /** The step currently in focus (running, or next to run). */
  currentStep?: PipelineStepId;
  /** Ordered per-step states. */
  steps: PipelineStepState[];
  /** Overall progress in the range 0..100. */
  progressPercent: number;
  /** Rolled-up overall status. */
  status: PipelineStatus;
  /** Overall error message, if the run failed. */
  error?: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
}

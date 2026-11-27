/**
 * Pipeline state types: the per-step and overall progress model that the
 * orchestrator persists (pipeline.json) and streams to the UI over SSE.
 */

import type { ProjectWarning, StepDetail } from './diagnostics.js';
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
  /** Where a long step is inside itself ("Detecting speakers 12/60"); cleared when it ends. */
  detail?: StepDetail;
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
  /**
   * The last step this pipeline runs, when it stops before the render: a
   * series parent only transcribes the video, and its parts dub the rest.
   * Progress (so the time left, from its pace) counts only the steps up to it.
   * Counting all nine held the Phong Thủy Thiên Sư analysis at "30%" with
   * "about 20 h 45 min left" for under two hours of work (claude-dubber,
   * 2026-11-27).
   */
  endsAfter?: PipelineStepId;
  /** Rolled-up overall status. */
  status: PipelineStatus;
  /** Overall error message, if the run failed. */
  error?: string;
  /**
   * The run paused at the transcript-review checkpoint
   * (settings.reviewBeforeSynthesis): the translated transcript is ready for
   * the user to review/edit in the editor; no voice has been synthesized yet.
   * Cleared when the next run starts.
   */
  awaitingReview?: boolean;
  /**
   * Why the run is awaiting review when it is these lines: they still fail the
   * translation checks and settings.holdFlaggedLines stopped the run before
   * voicing (ids, at most 200). Cleared when the next run starts.
   */
  heldLines?: string[];
  /**
   * The run was paused, by the user or because the app closed (or the
   * computer went off) in the middle of it: when, and the step it stopped in.
   * Every finished step is kept, and the paused step keeps what it can of its
   * own work (speech-to-text chunks, translated batches, voice clips), so the
   * next run continues there. `status` is 'paused' meanwhile. Cleared when
   * the next run starts.
   */
  pausedAt?: string;
  pausedStep?: PipelineStepId;
  /**
   * What went worse than asked (speaker detection failed, a CPU fallback,
   * loops left in the transcript…). A step's warnings are replaced when the
   * step runs again.
   */
  warnings?: ProjectWarning[];
  /**
   * Warnings the user or an agent dismissed (POST /projects/:id/warnings/
   * dismiss), with when: kept so get_project can say what was set aside. A
   * step that runs again and finds the same raises it again.
   */
  dismissedWarnings?: (ProjectWarning & { dismissedAt: string })[];
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
}

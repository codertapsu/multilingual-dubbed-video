/**
 * Ordered definitions of the dubbing pipeline steps.
 */

import type { PipelineStepId } from '../models/domain.js';

/** A static definition of a pipeline step: its id and human-readable label. */
export interface PipelineStepDef {
  /** Step identifier. */
  id: PipelineStepId;
  /** Human-readable label for the UI. */
  label: string;
}

/**
 * The nine pipeline steps, in execution order.
 *
 * probe-video -> extract-audio -> stt -> translation -> refine -> tts ->
 * alignment -> audio-mix -> render
 *
 * `refine` is the optional AI review pass (settings.refineProviderId); it
 * completes instantly as a no-op when not configured.
 */
export const PIPELINE_STEP_DEFS: readonly PipelineStepDef[] = [
  { id: 'probe-video', label: 'Probe Video' },
  { id: 'extract-audio', label: 'Extract Audio' },
  { id: 'stt', label: 'Transcribe (Speech-to-Text)' },
  { id: 'translation', label: 'Translate' },
  { id: 'refine', label: 'Review & Refine Translation' },
  { id: 'tts', label: 'Synthesize Speech (Text-to-Speech)' },
  { id: 'alignment', label: 'Align Timing' },
  { id: 'audio-mix', label: 'Mix Audio' },
  { id: 'render', label: 'Render Final Video' },
] as const;

/** Ordered list of just the step ids. */
export const PIPELINE_STEP_IDS: readonly PipelineStepId[] = PIPELINE_STEP_DEFS.map(
  (d) => d.id,
);

/** Look up the human label for a step id (returns the id if unknown). */
export function pipelineStepLabel(id: PipelineStepId): string {
  return PIPELINE_STEP_DEFS.find((d) => d.id === id)?.label ?? id;
}

/** Zero-based execution order index of a step id (-1 if unknown). */
export function pipelineStepIndex(id: PipelineStepId): number {
  return PIPELINE_STEP_DEFS.findIndex((d) => d.id === id);
}

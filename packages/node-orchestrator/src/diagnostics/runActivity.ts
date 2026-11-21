/**
 * Which step each running dub is in, from the runs' own events (the event
 * bus's observers). The download gate reads it synchronously at every start:
 * a dub's heavy step pauses downloads, its light steps do not.
 */
import type { PipelineStepId } from '@videodubber/shared';

import type { PipelineEvent } from '../events.js';

export class RunActivity {
  private readonly current = new Map<string, PipelineStepId>();

  /** Feed one project event (EventBusRegistry.observe). */
  onEvent(projectId: string, event: PipelineEvent): void {
    if (event.type === 'step') {
      if (event.step.status === 'running') this.current.set(projectId, event.step.id);
      else if (this.current.get(projectId) === event.step.id) this.current.delete(projectId);
      return;
    }
    if (event.type === 'done' || event.type === 'error') {
      this.current.delete(projectId);
      return;
    }
    if (event.type === 'state' && event.pipeline.status !== 'running') this.current.delete(projectId);
  }

  /** The running steps, by project. */
  steps(): ReadonlyMap<string, PipelineStepId> {
    return this.current;
  }

  /** Whether any dub is in a step right now. */
  anyRunning(): boolean {
    return this.current.size > 0;
  }
}

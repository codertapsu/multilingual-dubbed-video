/**
 * Dubs and renders as activity: one entry per run, from the moment it is asked
 * for (waiting in the queue, or started at once) through its steps to how it
 * ended (finished, failed, paused, waiting for the review).
 *
 * The orchestrator says when a run is scheduled, leaves the queue unstarted,
 * or ends (orchestrator.ts calls {@link DubRunTracker.scheduled},
 * {@link DubRunTracker.dequeued}, {@link DubRunTracker.ended}): scheduling
 * happens in the asker's own request, so the entry records who asked (the
 * window, an agent, the series starting its parts) even when the run only
 * starts hours later, when a slot frees. The steps and the ending come from
 * the run's own events (every project's bus, activityRoutes.ts).
 *
 * WHY: a dub was followed only by its Processing screen, and nothing recorded
 * who had started it: the 48 parts of the production were queued by an agent
 * (claude-dubber report, 2026-11-23, R3).
 */
import { pipelineStepLabel, type ActivityInitiator, type PipelineStepId, type Project } from '@videodubber/shared';

import type { PipelineEvent } from '../events.js';
import { activity, type ActivityHandle, type ActivityRegistry } from './registry.js';

export const DUB_RUN_KINDS: readonly string[] = ['dub.run', 'dub.render'];

interface Run {
  handle: ActivityHandle;
  percent: number | null;
  step?: string;
  /** A running state was seen in this run: its later review stop or pause is its ending. */
  sawRunning: boolean;
  /** Queued again after a restart, its asker not known yet (see {@link DubRunTracker.adoptRestored}). */
  needsInitiator?: boolean;
}

/** A run starting from the mix or the render is a render (Export's "Render again", the studio's Render). */
export const isRenderStep = (step: PipelineStepId | undefined): boolean => step === 'audio-mix' || step === 'render';

export class DubRunTracker {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly registry: ActivityRegistry = activity) {}

  /**
   * A run was scheduled: started now, or waiting in the queue. Called in the
   * asker's context. `restored`: the queue read back at start-up, whose asker
   * is found in the activity read back from disk.
   */
  scheduled(
    project: Pick<Project, 'id' | 'name'> & { series?: Project['series'] },
    how: { queued: boolean; fromStep?: PipelineStepId; restored?: boolean },
  ): void {
    this.close(project.id, 'Replaced by a new run');
    const render = isRenderStep(how.fromStep);
    const parent = project.series?.role === 'parent';
    const title = render
      ? `Rendering “${project.name}”`
      : parent
        ? `Transcribing “${project.name}” for its parts`
        : `Dubbing “${project.name}”`;
    const initiator = how.restored ? this.lastInitiatorOf(project.id) : undefined;
    const handle = this.registry.start({
      kind: render ? 'dub.render' : 'dub.run',
      title,
      projectId: project.id,
      waiting: how.queued,
      message: how.queued ? 'Waiting in the queue' : 'Starting',
      ...(how.restored ? { initiator: initiator ?? { kind: 'scheduler' } } : {}),
    });
    this.runs.set(project.id, { handle, percent: null, sawRunning: false, ...(how.restored && !initiator ? { needsInitiator: true } : {}) });
  }

  /** Taken out of the queue before it started (paused while waiting). */
  dequeued(projectId: string): void {
    this.close(projectId, 'Taken out of the queue');
  }

  /** The run's work is over, however it ended: an entry its events did not end stops here. */
  ended(projectId: string): void {
    this.close(projectId, 'Stopped');
  }

  /** One event of a project's run (EventBusRegistry.observe). */
  onEvent(projectId: string, event: PipelineEvent): void {
    const run = this.runs.get(projectId);
    if (!run) return;
    if (event.type === 'done') {
      run.handle.done('Finished');
      this.runs.delete(projectId);
      return;
    }
    if (event.type === 'error') {
      run.handle.fail(event.error);
      this.runs.delete(projectId);
      return;
    }
    if (event.type !== 'state') return;
    const p = event.pipeline;
    // A continued run first re-reads where the last one stopped (paused, or at
    // the review): only once this run has been seen running are those its end.
    if (run.sawRunning && p.awaitingReview) {
      run.handle.done('Waiting for your review: the draft translation is ready');
      this.runs.delete(projectId);
      return;
    }
    if (run.sawRunning && p.status === 'paused') {
      run.handle.cancelled(`Paused${p.pausedStep ? ` at “${pipelineStepLabel(p.pausedStep)}”` : ''}: it continues where it stopped`);
      this.runs.delete(projectId);
      return;
    }
    if (p.status !== 'running' || p.awaitingReview) return;
    run.sawRunning = true;
    const step = p.currentStep ? pipelineStepLabel(p.currentStep) : undefined;
    const percent = Number.isFinite(p.progressPercent) ? Math.round(p.progressPercent) : null;
    // The bus repeats a state at every write; the list needs only what moved.
    if (percent === run.percent && step === run.step && this.registry.get(run.handle.id)?.state === 'running') return;
    run.percent = percent;
    run.step = step;
    run.handle.progress(percent, step);
  }

  /**
   * After the activity was read back from disk: the queued runs re-entered
   * before it was get the asker of their project's last run.
   */
  adoptRestored(): void {
    for (const [projectId, run] of this.runs) {
      if (!run.needsInitiator) continue;
      const initiator = this.lastInitiatorOf(projectId, run.handle.id);
      if (initiator) this.registry.patch(run.handle.id, { initiator });
      run.needsInitiator = false;
    }
  }

  /** Who asked for the project's last run before this one, as the activity remembers it. */
  private lastInitiatorOf(projectId: string, except?: string): ActivityInitiator | undefined {
    const last = this.registry
      .list({ projectId })
      .find((e) => e.id !== except && DUB_RUN_KINDS.includes(e.kind) && e.initiator.kind !== 'unknown');
    return last?.initiator;
  }

  private close(projectId: string, message: string): void {
    const run = this.runs.get(projectId);
    if (!run) return;
    run.handle.cancelled(message);
    this.runs.delete(projectId);
  }
}

/** The app's one tracker (orchestrator.ts reports to it; the routes feed it the events). */
export const dubRuns = new DubRunTracker();

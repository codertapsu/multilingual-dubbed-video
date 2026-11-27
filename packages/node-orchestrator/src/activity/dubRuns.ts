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
import { runEtaSeconds } from './eta.js';
import { activity, said, type ActivityHandle, type ActivityRegistry, type ActivityText } from './registry.js';

export const DUB_RUN_KINDS: readonly string[] = ['dub.run', 'dub.render'];

interface Run {
  handle: ActivityHandle;
  percent: number | null;
  step?: string;
  /** A running state was seen in this run: its later review stop or pause is its ending. */
  sawRunning: boolean;
  /** When this run was first seen running, and how far it was then: its pace, for the time left. */
  since?: { atMs: number; percent: number };
  /** The time left last estimated (s), for the queue view. */
  eta?: number;
  /** Queued again after a restart, its asker not known yet (see {@link DubRunTracker.adoptRestored}). */
  needsInitiator?: boolean;
}

/** A run starting from the mix or the render is a render (Export's "Render again", the studio's Render). */
export const isRenderStep = (step: PipelineStepId | undefined): boolean => step === 'audio-mix' || step === 'render';

export class DubRunTracker {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly registry: ActivityRegistry = activity,
    private readonly now: () => number = Date.now,
  ) {}

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
    const name = { name: project.name };
    const title = render
      ? said(`Rendering “${project.name}”`, 'activity.text.dub-render', name)
      : parent
        ? said(`Transcribing “${project.name}” for its parts`, 'activity.text.dub-parent', name)
        : said(`Dubbing “${project.name}”`, 'activity.text.dub-run', name);
    const initiator = how.restored ? this.lastInitiatorOf(project.id) : undefined;
    const handle = this.registry.start({
      kind: render ? 'dub.render' : 'dub.run',
      title,
      projectId: project.id,
      waiting: how.queued,
      message: how.queued ? said('Waiting in the queue', 'activity.text.queue-waiting') : said('Starting', 'activity.text.starting'),
      ...(how.restored ? { initiator: initiator ?? { kind: 'scheduler' } } : {}),
    });
    this.runs.set(project.id, { handle, percent: null, sawRunning: false, ...(how.restored && !initiator ? { needsInitiator: true } : {}) });
  }

  /** Taken out of the queue before it started (paused while waiting). */
  dequeued(projectId: string): void {
    this.close(projectId, said('Taken out of the queue', 'activity.text.dequeued'));
  }

  /** The run's work is over, however it ended: an entry its events did not end stops here. */
  ended(projectId: string): void {
    this.close(projectId, said('Stopped', 'activity.text.stopped'));
  }

  /** One event of a project's run (EventBusRegistry.observe). */
  onEvent(projectId: string, event: PipelineEvent): void {
    const run = this.runs.get(projectId);
    if (!run) return;
    if (event.type === 'done') {
      run.handle.done(said('Finished', 'activity.text.finished'));
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
      run.handle.done(said('Waiting for your review: the draft translation is ready', 'activity.text.review-ready'));
      this.runs.delete(projectId);
      return;
    }
    if (run.sawRunning && p.status === 'paused') {
      run.handle.cancelled(
        p.pausedStep
          ? said(`Paused at “${pipelineStepLabel(p.pausedStep)}”: it continues where it stopped`, 'activity.text.paused-at', { stepKey: `opt.step.${p.pausedStep}` })
          : said('Paused: it continues where it stopped', 'activity.text.paused'),
      );
      this.runs.delete(projectId);
      return;
    }
    if (p.status !== 'running' || p.awaitingReview) return;
    run.sawRunning = true;
    const step = p.currentStep ? pipelineStepLabel(p.currentStep) : undefined;
    const percent = Number.isFinite(p.progressPercent) ? Math.round(p.progressPercent) : null;
    if (!run.since && percent !== null) run.since = { atMs: this.now(), percent };
    const eta = percent !== null && run.since ? runEtaSeconds(run.since, percent, this.now()) : undefined;
    // The bus repeats a state at every write; the list needs only what moved:
    // the percent, the step, or a time left that drifted (a minute, and a tenth).
    const drifted = eta !== undefined && run.eta !== undefined ? Math.abs(eta - run.eta) >= Math.max(60, run.eta * 0.1) : eta !== run.eta;
    if (percent === run.percent && step === run.step && !drifted && this.registry.get(run.handle.id)?.state === 'running') return;
    run.percent = percent;
    run.step = step;
    run.eta = eta;
    run.handle.progress(percent, p.currentStep && step ? said(step, `opt.step.${p.currentStep}`) : undefined, run.eta);
  }

  /**
   * A running dub's time left from its own pace (seconds), if it can tell
   * yet: worked out when asked, so it counts the time since the last progress
   * too. The one saved at the last change of percent read "about 8 min left"
   * for an hour in which nothing moved (claude-dubber, 2026-11-27).
   */
  etaOf(projectId: string): number | undefined {
    const run = this.runs.get(projectId);
    return run?.since && run.percent !== null ? runEtaSeconds(run.since, run.percent, this.now()) : undefined;
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

  private close(projectId: string, message: ActivityText): void {
    const run = this.runs.get(projectId);
    if (!run) return;
    run.handle.cancelled(message);
    this.runs.delete(projectId);
  }
}

/** The app's one tracker (orchestrator.ts reports to it; the routes feed it the events). */
export const dubRuns = new DubRunTracker();

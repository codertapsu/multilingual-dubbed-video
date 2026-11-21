import type {
  OnDestroy,
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { projectOutputVideoPath } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { PipelineEventsService } from '../../core/ipc/pipeline-events.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { StatusBadgeComponent } from '../../shared/status-badge/status-badge.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { PIPELINE_STEP_LABELS } from '../../core/util/format';
import type { WorkersHealth } from '../../core/models/view-models';
import type { QueueEntry, QueueState } from '../../core/models/setup';
import type {
  AppError,
  PipelineState,
  PipelineStepId,
  PipelineStepState,
  Project,
  ProjectWarning,
  StepDetail,
} from '../../core/models';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { isNeverStarted } from './never-started';

/** How often to re-probe the bundled services' health while on this screen. */
const WORKERS_HEALTH_POLL_MS = 5000;
/** Queue poll cadence while this project waits for a free slot. */
const QUEUE_POLL_MS = 3000;

/**
 * ProcessingComponent (route "project/:id/processing").
 *
 * Subscribes to the live SSE pipeline stream and renders the pipeline steps with
 * per-step progress, an overall progress bar, the current step, and a live log
 * panel. Starts a dub that was never started, pauses and continues one, retries
 * a failed step, and says when the video is ready. All async — never blocks the
 * UI (signals + the events service drive change detection).
 */
@Component({
  selector: 'vd-processing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, StatusBadgeComponent, BusyIndicatorComponent, TranslatePipe, RouterLink],
  templateUrl: './processing.component.html',
  styleUrl: './processing.component.scss',
})
export class ProcessingComponent implements OnInit, OnDestroy {
  /** Route param bound via withComponentInputBinding(). */
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  protected readonly store = inject(ProjectStore);
  protected readonly events = inject(PipelineEventsService);

  protected readonly stepLabels = PIPELINE_STEP_LABELS;

  protected readonly actionError = signal<AppError | null>(null);
  protected readonly cancelling = signal(false);
  protected readonly pausing = signal(false);
  protected readonly resuming = signal(false);
  protected readonly starting = signal(false);
  protected readonly runningNext = signal(false);
  /** The step a retry was asked for, until the request answers. */
  protected readonly retrying = signal<PipelineStepId | null>(null);
  /** Play or Show in folder, while the system opens it. */
  protected readonly opening = signal(false);

  /**
   * Loading the project failed. Said with a Retry: the step list used to wait
   * for a pipeline that would never come, with a spinner that never stopped.
   */
  protected readonly loadFailed = signal(false);
  protected readonly reloading = signal(false);

  /** Live health of the bundled services (polled while on this screen). */
  protected readonly workersHealth = signal<WorkersHealth | null>(null);
  private workersHealthTimer: ReturnType<typeof setInterval> | null = null;

  /** Names of services that are currently unavailable (for the live indicator). */
  protected readonly degradedServices = computed<string[]>(() => {
    const h = this.workersHealth();
    if (!h) return [];
    const entries: [string, boolean][] = [
      [this.translate.instant('misc.phase-stt'), h.stt.available],
      [this.translate.instant('misc.phase-translation'), h.translation.available],
      [this.translate.instant('misc.phase-tts'), h.tts.available],
      ['FFmpeg', h.ffmpeg.available],
    ];
    return entries.filter(([, ok]) => !ok).map(([name]) => name);
  });

  /**
   * This screen's project. The store still holds the previous screen's until
   * this one loads, and that project's name and state must not show here.
   */
  protected readonly project = computed<Project | null>(() => {
    const p = this.store.current();
    return p?.id === this.id() ? p : null;
  });

  /**
   * Effective pipeline state: prefer the live SSE state; fall back to the
   * persisted state loaded from the store (for resume / first paint before the
   * stream delivers anything). Either only when it is this project's (a
   * pipeline saved without its id is taken as this one's).
   */
  protected readonly pipeline = computed<PipelineState | null>(() => {
    const mine = (p: PipelineState | null): p is PipelineState => !!p && (!p.projectId || p.projectId === this.id());
    const live = this.events.pipeline();
    if (mine(live)) return live;
    const saved = this.store.pipeline();
    return mine(saved) ? saved : null;
  });

  protected readonly steps = computed<PipelineStepState[]>(
    () => this.pipeline()?.steps ?? [],
  );

  /**
   * What the run decided on its own that the result depends on (a CPU
   * fallback, speakers not detected, transcription loops repaired): shown,
   * never only in the log, since the field report found each one by accident.
   */
  protected readonly warnings = computed<ProjectWarning[]>(() => this.pipeline()?.warnings ?? []);

  /** A warning in the UI's language; the server's English when the key is new to this build. */
  protected warningText(w: ProjectWarning): string {
    const t = this.translate.instant(w.key, w.params);
    return t === w.key ? w.message : t;
  }

  /** Where a running step is ("Detecting speakers 3/12"), in the UI's language. */
  protected detailText(d: StepDetail): string {
    const t = this.translate.instant(d.key, d.params);
    return t === d.key ? d.text : t;
  }

  protected readonly overallPercent = computed(() => {
    const p = this.pipeline();
    return p ? Math.round(p.progressPercent) : 0;
  });

  protected readonly overallStatus = computed(
    () => this.pipeline()?.status ?? 'idle',
  );

  protected readonly isRunning = computed(() => this.overallStatus() === 'running');
  /**
   * From the state alone: a `done` only ever follows the state that completes
   * a run, and the stream's `done` may be an earlier run's, replayed on
   * connect (pipeline-replay.ts).
   */
  protected readonly isComplete = computed(() => this.overallStatus() === 'completed');
  protected readonly hasFailure = computed(() => this.overallStatus() === 'failed');
  /** A series' whole video, analysed once: its parts are what get dubbed. */
  protected readonly isSeriesParent = computed(() => this.project()?.series?.role === 'parent');
  /**
   * The dub is finished: the success moment, with what the user wants next.
   * It used to be two buttons under a title that still said "Processing".
   * A series' analysis makes no video: the series card says what comes next.
   * A render again waiting in the queue leaves the pipeline "completed" until
   * it starts: the queue card speaks for it then.
   */
  protected readonly showReady = computed(
    () => this.isComplete() && !this.isSeriesParent() && !this.isQueued() && this.project()?.status !== 'queued',
  );
  /** The finished video, where the user chose to save it (pipeline/output.ts). */
  protected readonly outputVideoPath = computed(() => {
    const p = this.project();
    return p ? projectOutputVideoPath(p) : null;
  });
  /** Paused at the transcript-review checkpoint (reviewBeforeSynthesis). */
  protected readonly awaitingReview = computed(() => this.pipeline()?.awaitingReview === true);
  /**
   * Paused by the user, or by the app closing mid-run: Continue picks it up.
   * Not once Continue has put it in the queue (its pipeline stays "paused"
   * until a slot frees): the queue card says what happens next.
   */
  protected readonly isPaused = computed(
    () => this.overallStatus() === 'paused' && !this.awaitingReview() && !this.isQueued(),
  );
  /** The step a paused dub continues at. */
  protected readonly pausedStep = computed<PipelineStepId | null>(() => {
    const p = this.pipeline();
    return p?.status === 'paused' ? (p.pausedStep ?? p.currentStep ?? null) : null;
  });
  protected readonly continuing = signal(false);

  /** A dub that never started: the Start card (never-started.ts says when). */
  protected readonly neverStarted = computed(() =>
    isNeverStarted(this.pipeline(), this.project()?.status, this.isQueued()),
  );

  // -------- run queue (waiting for a free slot) --------
  /** Live queue state, polled while this project is waiting. */
  protected readonly queue = signal<QueueState | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  /** This project's queue entry, when it is waiting for capacity. */
  protected readonly queueEntry = computed<QueueEntry | null>(
    () => this.queue()?.entries.find((e) => e.projectId === this.id()) ?? null,
  );
  protected readonly isQueued = computed(() => this.queueEntry() !== null);
  /** Names of the dubs currently occupying the slots (for the waiting panel). */
  protected readonly runningNames = computed(() =>
    (this.queue()?.running ?? []).map((r) => r.name).join(', '),
  );

  /**
   * Error to display. What the user's last click got back comes first: Play,
   * Start or Retry failing behind the run's own failure looked like a button
   * that did nothing.
   */
  protected readonly displayError = computed<AppError | null>(
    () => this.actionError() ?? this.events.error(),
  );

  /** The live stream just reached the end of a run. */
  private readonly finishedLive = computed(() => {
    const live = this.events.pipeline();
    return !!live && (!live.projectId || live.projectId === this.id()) && live.status === 'completed';
  });

  constructor() {
    // When the stream completes, refresh the persisted project so navigation
    // targets (editor/export) have fresh data on arrival. This deliberately
    // triggers a store load whose `guard()` flips loading/error signals — a
    // considered reaction to the completion state, not an accidental in-
    // computation write (effects may write signals freely since Angular v19).
    // Once per completion: the stream's every later frame does not reload.
    effect(() => {
      if (this.finishedLive()) {
        void this.store.loadProject(this.id());
      }
    });
  }

  ngOnInit(): void {
    // Open the live event stream, and load the persisted state so the page
    // isn't blank before the stream delivers anything.
    this.events.connect(this.id());
    void this.load();
    // Live service-health: probe once now, then poll. Surfaces a service that
    // drops mid-run (the run-gate already ensured they were up at start).
    void this.refreshWorkersHealth();
    this.workersHealthTimer = setInterval(() => void this.refreshWorkersHealth(), WORKERS_HEALTH_POLL_MS);
    // The queue has no SSE channel yet; poll it (loopback, tiny payload) so a
    // waiting project shows its position and starts the moment a slot frees.
    void this.refreshQueue();
    this.queueTimer = setInterval(() => void this.refreshQueue(), QUEUE_POLL_MS);
  }

  ngOnDestroy(): void {
    this.events.disconnect();
    if (this.workersHealthTimer) clearInterval(this.workersHealthTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
  }

  /** Load the project (and Retry after a failed load). */
  protected async load(): Promise<void> {
    if (this.reloading()) return;
    this.reloading.set(true);
    const failedBefore = this.loadFailed();
    try {
      const loaded = await this.store.loadProject(this.id());
      if (loaded) {
        this.loadFailed.set(false);
        if (failedBefore) {
          this.actionError.set(null);
          // The stream died with the backend, and a closed one stays closed.
          this.events.connect(this.id());
        }
      } else {
        this.loadFailed.set(true);
        this.actionError.set(
          this.store.lastError() ?? { code: 'UNKNOWN', message: this.translate.instant('processing.load-failed-title') },
        );
      }
    } finally {
      this.reloading.set(false);
    }
  }

  /** Poll the scheduler state; refresh the project when it leaves the queue. */
  private async refreshQueue(): Promise<void> {
    const wasQueued = this.isQueued();
    try {
      this.queue.set(await this.ipc.getQueue());
    } catch {
      // Non-fatal: the panel just keeps its last known state.
      return;
    }
    if (wasQueued && !this.isQueued()) void this.store.loadProject(this.id());
  }

  private async refreshWorkersHealth(): Promise<void> {
    try {
      this.workersHealth.set(await this.ipc.getWorkersHealth());
    } catch {
      // Non-fatal: leave the last known health; the pipeline errors surface real failures.
    }
  }

  /**
   * Start a dub that never started, as the wizard's Start does
   * (new-project-wizard start()): its readiness check first, so what to fix is
   * said before anything runs; then the run, which may wait in the queue.
   */
  protected async start(): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    this.actionError.set(null);
    this.events.clearError();
    try {
      // A failed check falls through to the run, whose own gate still refuses.
      const preflight = await this.ipc.runPreflight(this.id()).catch(() => null);
      const problems = preflight && !preflight.ok ? preflight.providers.filter((p) => !p.ready) : [];
      const first = problems[0];
      if (first) {
        this.actionError.set({
          code: 'ENGINE_UNAVAILABLE',
          message:
            problems.length > 1
              ? this.translate.instant('processing.preflight-and-more', { message: first.message, more: problems.length - 1 })
              : first.message,
          ...(first.remediation ? { remediation: first.remediation } : {}),
        });
        return;
      }
      await this.ipc.runPipeline(this.id());
      this.events.connect(this.id());
      // Queued: the queue card takes over at once. Started: the project reads "running".
      await this.refreshQueue();
      await this.store.loadProject(this.id());
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.starting.set(false);
    }
  }

  /** Jump this project to the front of the dubbing queue. */
  protected async runNext(): Promise<void> {
    if (this.runningNext()) return;
    this.runningNext.set(true);
    this.actionError.set(null);
    try {
      await this.ipc.runNext(this.id());
      await this.refreshQueue();
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.runningNext.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    if (this.cancelling()) return;
    this.cancelling.set(true);
    this.actionError.set(null);
    try {
      await this.ipc.cancelPipeline(this.id());
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.cancelling.set(false);
    }
  }

  /**
   * Pause the dub: it stops at once and keeps everything done so far, so the
   * user can close the app (or turn the computer off) and continue later.
   */
  protected async pause(): Promise<void> {
    if (this.pausing()) return;
    this.pausing.set(true);
    this.actionError.set(null);
    try {
      await this.ipc.pausePipeline(this.id());
      // The paused state also arrives over SSE; this covers a dropped stream.
      await this.store.loadProject(this.id());
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.pausing.set(false);
    }
  }

  /** Continue a paused dub where it stopped (it may queue behind other dubs). */
  protected async resume(): Promise<void> {
    if (this.resuming()) return;
    this.resuming.set(true);
    this.actionError.set(null);
    this.events.clearError();
    try {
      await this.ipc.runPipeline(this.id());
      this.events.connect(this.id());
      await this.refreshQueue();
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.resuming.set(false);
    }
  }

  /**
   * Re-run from a failed step. One request at a time: the server answers a
   * second retry by stopping the run the first one started and starting over.
   */
  protected async retry(stepId: PipelineStepId): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(stepId);
    this.actionError.set(null);
    // Drop the failure that prompted the retry: `connect()` below no-ops while
    // the stream for this project is still open, so without this the old error
    // banner stays up over the successful re-run.
    this.events.clearError();
    try {
      await this.ipc.retryPipelineStep(this.id(), stepId);
      // Re-open the stream so we observe the re-run from this step.
      this.events.connect(this.id());
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.retrying.set(null);
    }
  }

  protected goToEditor(): void {
    void this.router.navigate(['/project', this.id(), 'editor']);
  }

  /** Leave the transcript-review checkpoint: resume the pipeline at TTS. */
  protected async continueDubbing(): Promise<void> {
    if (this.continuing()) return;
    this.continuing.set(true);
    this.actionError.set(null);
    this.events.clearError();
    try {
      await this.ipc.retryPipelineStep(this.id(), 'tts');
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.continuing.set(false);
    }
  }

  protected goToExport(): void {
    void this.router.navigate(['/project', this.id(), 'export']);
  }

  /** Play the finished video in the system's video player. */
  protected playVideo(): Promise<void> {
    const path = this.outputVideoPath();
    return path ? this.openWithSystem(path) : Promise.resolve();
  }

  /** Open the folder the finished video was saved to. */
  protected showInFolder(): Promise<void> {
    const dir = this.project()?.outputDir;
    return dir ? this.openWithSystem(dir) : Promise.resolve();
  }

  /** The OS opens a file in its default app and a folder in its file manager (open_output_folder). */
  private async openWithSystem(path: string): Promise<void> {
    if (this.opening()) return;
    this.opening.set(true);
    this.actionError.set(null);
    try {
      await this.ipc.openOutputFolder(path);
    } catch (err) {
      this.actionError.set(toAppError(err));
    } finally {
      this.opening.set(false);
    }
  }

  protected stepPercent(step: PipelineStepState): number {
    return Math.round(step.progressPercent);
  }

  /** The banner's ✕: whichever error it shows goes (the failed step keeps its own). */
  protected dismissError(): void {
    if (this.actionError()) this.actionError.set(null);
    else this.events.dismissError();
  }
}

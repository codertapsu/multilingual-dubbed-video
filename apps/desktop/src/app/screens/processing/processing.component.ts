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
import { Router } from '@angular/router';

import { IpcService } from '../../core/ipc/ipc.service';
import { PipelineEventsService } from '../../core/ipc/pipeline-events.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { StatusBadgeComponent } from '../../shared/status-badge/status-badge.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { PIPELINE_STEP_LABELS } from '../../core/util/format';
import type { WorkersHealth } from '../../core/models/view-models';
import type {
  AppError,
  PipelineState,
  PipelineStepId,
  PipelineStepState,
} from '../../core/models';

/** How often to re-probe the bundled services' health while on this screen. */
const WORKERS_HEALTH_POLL_MS = 5000;

/**
 * ProcessingComponent (route "project/:id/processing").
 *
 * Subscribes to the live SSE pipeline stream and renders the pipeline steps with
 * per-step progress, an overall progress bar, the current step, and a live log
 * panel. Offers Cancel and per-failed-step Retry. All async — never blocks the
 * UI (signals + the events service drive change detection).
 */
@Component({
  selector: 'vd-processing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, StatusBadgeComponent, BusyIndicatorComponent],
  templateUrl: './processing.component.html',
  styleUrl: './processing.component.scss',
})
export class ProcessingComponent implements OnInit, OnDestroy {
  /** Route param bound via withComponentInputBinding(). */
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  protected readonly store = inject(ProjectStore);
  protected readonly events = inject(PipelineEventsService);

  protected readonly stepLabels = PIPELINE_STEP_LABELS;

  protected readonly actionError = signal<AppError | null>(null);
  protected readonly cancelling = signal(false);

  /** Live health of the bundled services (polled while on this screen). */
  protected readonly workersHealth = signal<WorkersHealth | null>(null);
  private workersHealthTimer: ReturnType<typeof setInterval> | null = null;

  /** Names of services that are currently unavailable (for the live indicator). */
  protected readonly degradedServices = computed<string[]>(() => {
    const h = this.workersHealth();
    if (!h) return [];
    const entries: [string, boolean][] = [
      ['Speech-to-text', h.stt.available],
      ['Translation', h.translation.available],
      ['Text-to-speech', h.tts.available],
      ['FFmpeg', h.ffmpeg.available],
    ];
    return entries.filter(([, ok]) => !ok).map(([name]) => name);
  });

  /**
   * Effective pipeline state: prefer the live SSE state; fall back to the
   * persisted state loaded from the store (for resume / first paint before the
   * stream delivers anything).
   */
  protected readonly pipeline = computed<PipelineState | null>(
    () => this.events.pipeline() ?? this.store.pipeline(),
  );

  protected readonly steps = computed<PipelineStepState[]>(
    () => this.pipeline()?.steps ?? [],
  );

  protected readonly overallPercent = computed(() => {
    const p = this.pipeline();
    return p ? Math.round(p.progressPercent) : 0;
  });

  protected readonly overallStatus = computed(
    () => this.pipeline()?.status ?? 'idle',
  );

  protected readonly isRunning = computed(() => this.overallStatus() === 'running');
  protected readonly isComplete = computed(
    () => this.overallStatus() === 'completed' || this.events.done(),
  );
  protected readonly hasFailure = computed(() => this.overallStatus() === 'failed');
  /** Paused at the transcript-review checkpoint (reviewBeforeSynthesis). */
  protected readonly awaitingReview = computed(() => this.pipeline()?.awaitingReview === true);
  protected readonly continuing = signal(false);

  /** Error to display: an SSE error event takes precedence over action errors. */
  protected readonly displayError = computed<AppError | null>(
    () => this.events.error() ?? this.actionError(),
  );

  constructor() {
    // When the stream completes, refresh the persisted project so navigation
    // targets (editor/export) have fresh data on arrival. This deliberately
    // triggers a store load whose `guard()` flips loading/error signals — a
    // considered reaction to the completion state, not an accidental in-
    // computation write (effects may write signals freely since Angular v19).
    effect(() => {
      if (this.events.done() || this.events.pipeline()?.status === 'completed') {
        void this.store.loadProject(this.id());
      }
    });
  }

  ngOnInit(): void {
    const projectId = this.id();
    // Load persisted state immediately (so the page isn't blank pre-stream),
    // then open the live event stream.
    void this.store.loadProject(projectId);
    this.events.connect(projectId);
    // Live service-health: probe once now, then poll. Surfaces a service that
    // drops mid-run (the run-gate already ensured they were up at start).
    void this.refreshWorkersHealth();
    this.workersHealthTimer = setInterval(() => void this.refreshWorkersHealth(), WORKERS_HEALTH_POLL_MS);
  }

  ngOnDestroy(): void {
    this.events.disconnect();
    if (this.workersHealthTimer) clearInterval(this.workersHealthTimer);
  }

  private async refreshWorkersHealth(): Promise<void> {
    try {
      this.workersHealth.set(await this.ipc.getWorkersHealth());
    } catch {
      // Non-fatal: leave the last known health; the pipeline errors surface real failures.
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

  protected async retry(stepId: PipelineStepId): Promise<void> {
    this.actionError.set(null);
    try {
      await this.ipc.retryPipelineStep(this.id(), stepId);
      // Re-open the stream so we observe the re-run from this step.
      this.events.connect(this.id());
    } catch (err) {
      this.actionError.set(toAppError(err));
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

  protected stepPercent(step: PipelineStepState): number {
    return Math.round(step.progressPercent);
  }

  protected dismissError(): void {
    this.actionError.set(null);
  }
}

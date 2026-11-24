import type { OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { JoinStatus } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { AppError } from '../../../core/models';
import { toAppError } from '../../../core/state/project.store';
import { formatDurationCoarse } from '../../../core/util/format';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { ErrorBannerComponent } from '../../../shared/error-banner/error-banner.component';
import { gbOf, joinRetryable, joinRunning } from './join-form';

/** How often the screen asks how far the join is. */
const POLL_MS = 1000;

/**
 * New project, step 2, for a project made from several videos: how far the
 * join of its videos is (percent, time left, which file), with Cancel; how it
 * ended (Join again when it did not finish); and where each video starts.
 * Start waits for it (the form reads `statusChange`). The join itself runs in
 * the app: leaving the screen does not stop it.
 */
@Component({
  selector: 'vd-join-progress',
  standalone: true,
  imports: [TranslatePipe, BusyIndicatorComponent, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    p {
      margin: 0;
    }
    .join-progress {
      border: 1px solid var(--vd-border);
      border-radius: var(--vd-radius);
      padding: var(--vd-sp-3) var(--vd-sp-4);
    }
    .join-progress.failed {
      border-color: var(--vd-danger);
      background: var(--vd-danger-bg);
    }
    .join-progress.stopped {
      border-color: var(--vd-warning);
      background: var(--vd-warning-bg);
    }
    .progress {
      display: block;
    }
    .ok-text {
      color: var(--vd-success);
    }
    .join-where summary {
      cursor: pointer;
      font-size: 0.85rem;
      color: var(--vd-text-muted);
    }
    .join-where ol {
      margin: var(--vd-sp-1) 0 0;
      padding-left: 1.4rem;
    }
  `,
  template: `
    @let s = status();
    <section
      class="join-progress stack-sm"
      [class.failed]="s?.state === 'failed'"
      [class.stopped]="s?.state === 'cancelled' || s?.state === 'interrupted'"
      aria-live="polite"
    >
      <strong>{{ 'join.progress-title' | translate }}</strong>
      @switch (s?.state) {
        @case ('waiting') {
          <span class="hint">{{ 'join.waiting' | translate }}</span>
          <span class="progress indeterminate" role="progressbar" [attr.aria-label]="'join.progress-aria' | translate"><span></span></span>
        }
        @case ('running') {
          @if (s?.percent === null || s?.percent === undefined) {
            <span class="hint">{{ 'join.starting' | translate }}</span>
          } @else {
            <span class="row row-between">
              <span>{{ 'join.running' | translate: { percent: floor(s!.percent!) } }}</span>
              @if (s?.etaSec !== undefined) {
                <span class="hint">{{ 'join.eta' | translate: { time: duration(s!.etaSec! * 1000) } }}</span>
              }
            </span>
          }
          <span
            class="progress"
            [class.indeterminate]="s?.percent === null || s?.percent === undefined"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-valuenow]="s?.percent ?? undefined"
            [attr.aria-label]="'join.progress-aria' | translate"
          ><span [style.width.%]="s?.percent ?? 100"></span></span>
          @if (s?.currentFile !== undefined) {
            <span class="hint">{{ 'join.file-n' | translate: { n: s!.currentFile! + 1, count: s!.files.length, name: s!.files[s!.currentFile!]?.name ?? '' } }}</span>
          }
        }
        @case ('done') {
          <span class="ok-text">✓ {{ 'join.done' | translate: { duration: duration(s!.result?.durationMs ?? s!.totalDurationMs), size: gb(s!.result?.sizeBytes ?? 0) } }}</span>
        }
        @case ('failed') {
          <span>{{ 'join.failed' | translate }}</span>
          <vd-error-banner [error]="s!.error ?? null" />
        }
        @case ('cancelled') {
          <span>{{ 'join.cancelled' | translate }}</span>
        }
        @case ('interrupted') {
          <span>{{ 'join.interrupted' | translate }}</span>
        }
        @default {
          <vd-busy-indicator [active]="true" [label]="'join.starting' | translate" />
        }
      }

      @if (s) {
        <span class="hint">{{ (s.mode === 'copy' ? 'join.picture-copy' : 'join.picture-reencode') | translate }}</span>
      }

      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      @if (running()) {
        <p class="hint">{{ 'join.background' | translate }}</p>
        <div class="row">
          <button type="button" class="btn btn-sm" (click)="cancel()" [disabled]="acting()">{{ 'join.cancel' | translate }}</button>
        </div>
      } @else if (retryable()) {
        <div class="row">
          <button type="button" class="btn btn-primary btn-sm" (click)="retry()" [disabled]="acting()">{{ 'join.retry' | translate }}</button>
        </div>
      }

      @if (s && s.files.length > 0) {
        <details class="join-where">
          <summary>{{ 'join.where' | translate }}</summary>
          <ol>
            @for (f of s.files; track $index) {
              <li><span class="mono">{{ clock(f.startMs) }}</span> {{ f.name }} <span class="hint">({{ duration(f.durationMs) }})</span></li>
            }
          </ol>
        </details>
      }
    </section>
  `,
})
export class JoinProgressComponent implements OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly confirm = inject(ConfirmService);
  private readonly translate = inject(TranslateService);

  /** The project whose videos are being joined. */
  readonly projectId = input.required<string>();
  /** Every status read, so the form knows when the video is there. */
  readonly statusChange = output<JoinStatus>();

  protected readonly status = signal<JoinStatus | null>(null);
  protected readonly error = signal<AppError | null>(null);
  protected readonly acting = signal(false);
  protected readonly running = (): boolean => joinRunning(this.status());
  protected readonly retryable = (): boolean => joinRetryable(this.status());

  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every new follow and on destroy: a late answer never lands. */
  private seq = 0;

  constructor() {
    effect(() => {
      const id = this.projectId();
      untracked(() => this.follow(id));
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.seq++;
  }

  protected floor(n: number): number {
    return Math.floor(n);
  }

  protected gb(bytes: number): string {
    return gbOf(bytes);
  }

  protected duration(ms: number): string {
    return formatDurationCoarse(ms);
  }

  /** Where a file starts, as h:mm:ss. */
  protected clock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  /** Read the status now and again every second while the join waits or runs. */
  private follow(projectId: string): void {
    clearTimeout(this.timer);
    const seq = ++this.seq;
    const tick = async (): Promise<void> => {
      try {
        const status = await this.ipc.getJoin(projectId);
        if (seq !== this.seq) return;
        this.status.set(status);
        this.statusChange.emit(status);
        if (!joinRunning(status)) return;
      } catch (err) {
        if (seq !== this.seq) return;
        // A blip (the app busy for a moment) must not stop the following.
        this.error.set(toAppError(err));
      }
      this.timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
  }

  protected async cancel(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('join.cancel-title'),
      message: this.translate.instant('join.cancel-body'),
      confirmLabel: this.translate.instant('join.cancel'),
      cancelLabel: this.translate.instant('join.keep'),
    });
    if (!ok) return;
    await this.act(() => this.ipc.cancelJoin(this.projectId()));
  }

  protected async retry(): Promise<void> {
    await this.act(() => this.ipc.restartJoin(this.projectId()));
    this.follow(this.projectId());
  }

  private async act(fn: () => Promise<JoinStatus>): Promise<void> {
    this.acting.set(true);
    this.error.set(null);
    try {
      const status = await fn();
      this.status.set(status);
      this.statusChange.emit(status);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.acting.set(false);
    }
  }
}

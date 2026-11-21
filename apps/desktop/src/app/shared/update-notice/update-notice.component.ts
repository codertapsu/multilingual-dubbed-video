import type { OnInit } from '@angular/core';
import { ChangeDetectionStrategy, Component, HostListener, effect, inject, signal, untracked } from '@angular/core';
import { updateNoticeFor, type UpdateNotice } from '@videodubber/shared';

import { ActivityService } from '../../core/activity/activity.service';
import { IpcService } from '../../core/ipc/ipc.service';
import { UpdateService } from '../../core/update/update.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { UpdateProgressComponent } from './update-progress.component';

/** Resolve after `ms`. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Remembers the version whose notes the user dismissed (per machine). */
const DISMISSED_KEY = 'vd.update.dismissedVersion';

/**
 * Tells the user about a pending update, once, at launch.
 *
 * Before this, an update was invisible: with `autoUpdate` ON the app silently
 * downloaded a new version at launch and RESTARTED ITSELF with no explanation,
 * and with it OFF nothing happened at all — the user had to know to visit
 * Settings → Updates and press a button. So the two states differ on purpose:
 *
 *   auto-installing — a status strip. The install runs in the background (see
 *                     `maybe_auto_update` in lib.rs); the strip shows how far it
 *                     is (update-progress), not a button that would race it.
 *   available       — a modal with the release notes and a real choice. Shown
 *                     ONCE per version: nagging every launch is how people learn
 *                     to dismiss dialogs without reading them.
 *
 * It also says what the LAST update came to: an installer that did not finish
 * left no trace in the app, and the user just saw the old version again
 * (0.16.1 -> 0.17.0). A finished update gets a short toast.
 *
 * The decision of which notice to show is {@link updateNoticeFor} in the shared
 * package, where it is unit-tested — this component only renders it.
 */
@Component({
  selector: 'vd-update-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UpdateProgressComponent],
  template: `
    @if (update.outcome(); as o) {
      @if (o.outcome === 'failed') {
        <div class="update-strip update-strip-failed" role="alert">
          <span class="update-strip-text">
            <strong>{{ 'update.outcome.failed-title' | translate: { to: o.to } }}</strong>
            {{ 'update.outcome.failed-body' | translate: { from: o.from } }}
          </span>
          <button type="button" class="btn btn-primary btn-sm" (click)="retryFailed()" [disabled]="update.busy()">
            {{ 'update.progress.retry' | translate }}
          </button>
          <button type="button" class="btn btn-sm" (click)="update.openReleases()">
            {{ 'update.progress.github' | translate }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" (click)="update.dismissOutcome()" [attr.aria-label]="'common.close' | translate">
            {{ 'common.close' | translate }}
          </button>
        </div>
      }
    }
    @if (retrying()) {
      <div class="update-strip-body">
        <vd-update-progress />
      </div>
    }
    @if (notice(); as n) {
      @switch (n.kind) {
        @case ('auto-installing') {
          <div class="update-strip" role="status" aria-live="polite">
            <span class="update-dot" aria-hidden="true"></span>
            <span class="update-strip-text">
              @if (update.status().phase === 'idle') {
                <strong>{{ 'update.auto-waiting-title' | translate: { version: n.version } }}</strong>
                {{ 'update.auto-waiting-body' | translate }}
              } @else {
                <strong>{{ 'update.installing-title' | translate: { version: n.version } }}</strong>
                {{ 'update.installing-body' | translate }}
              }
            </span>
            @if (update.status().phase === 'idle') {
              <button type="button" class="btn btn-primary btn-sm" (click)="update.install()">
                {{ 'update.install-now' | translate }}
              </button>
            }
            <button type="button" class="btn btn-ghost btn-sm" (click)="dismiss()" [attr.aria-label]="'common.hide' | translate">
              {{ 'common.hide' | translate }}
            </button>
          </div>
          @if (update.status().phase !== 'idle' || update.error()) {
            <div class="update-strip-body">
              <vd-update-progress />
            </div>
          }
        }
        @case ('available') {
          <div class="update-overlay" role="presentation" (click)="dismiss()">
            <div
              class="update-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="vd-update-title"
              (click)="$event.stopPropagation()"
            >
              <h3 class="update-title" id="vd-update-title">{{ 'update.whats-new' | translate: { version: n.version } }}</h3>
              @if (n.date) {
                <p class="update-date">{{ 'update.released' | translate: { date: n.date } }}</p>
              }
              @if (n.notes) {
                <pre class="update-notes">{{ n.notes }}</pre>
              } @else {
                <p class="update-notes-empty">{{ 'update.no-notes' | translate }}</p>
              }
              <vd-update-progress />
              <div class="update-actions">
                <button type="button" class="btn btn-ghost" (click)="dismiss()">
                  {{ (update.busy() ? 'common.hide' : 'common.later') | translate }}
                </button>
                @if (update.status().phase !== 'installing') {
                  <button type="button" class="btn btn-primary" (click)="update.install()" [disabled]="update.busy()">
                    {{ (update.busy() ? 'update.installing' : 'update.install-now') | translate }}
                  </button>
                }
              </div>
            </div>
          </div>
        }
      }
    }
  `,
  styles: [
    `
      .update-strip {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--vd-sp-3);
        padding: var(--vd-sp-2) var(--vd-sp-4);
        background: var(--vd-surface-2, var(--vd-surface));
        border-bottom: 1px solid var(--vd-border);
        font-size: 0.9rem;
      }
      .update-strip-failed {
        border-bottom-color: var(--vd-danger);
      }
      .update-strip-failed strong {
        color: var(--vd-danger);
      }
      .update-strip-text {
        flex: 1;
        min-width: 16rem;
      }
      .update-strip-body {
        padding: var(--vd-sp-2) var(--vd-sp-4);
        border-bottom: 1px solid var(--vd-border);
      }
      .update-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--vd-primary);
        animation: vd-update-pulse 1.6s ease-in-out infinite;
      }
      @keyframes vd-update-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.3;
        }
      }
      /* Users who ask for less motion get a static dot, not a throbbing one. */
      @media (prefers-reduced-motion: reduce) {
        .update-dot {
          animation: none;
        }
      }
      .update-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--vd-sp-5);
        background: rgba(0, 0, 0, 0.45);
      }
      .update-card {
        width: 100%;
        max-width: 560px;
        max-height: 80vh;
        overflow-y: auto;
        background: var(--vd-surface);
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius-lg, 12px);
        padding: var(--vd-sp-5);
      }
      .update-title {
        margin: 0 0 var(--vd-sp-2);
      }
      .update-date {
        margin: 0 0 var(--vd-sp-3);
        color: var(--vd-text-muted);
        font-size: 0.85rem;
      }
      .update-notes {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0 0 var(--vd-sp-4);
        font-family: inherit;
        font-size: 0.9rem;
        line-height: 1.5;
      }
      .update-notes-empty {
        color: var(--vd-text-muted);
      }
      .update-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--vd-sp-3);
        margin-top: var(--vd-sp-4);
      }
    `,
  ],
})
export class UpdateNoticeComponent implements OnInit {
  protected readonly ipc = inject(IpcService);
  protected readonly update = inject(UpdateService);
  private readonly activity = inject(ActivityService);
  private readonly translate = inject(TranslateService);
  protected readonly notice = signal<UpdateNotice | null>(null);
  /** "Try again" from the failed-update strip: show the progress under it. */
  protected readonly retrying = signal(false);

  constructor() {
    // A finished update: say so briefly, once.
    effect(() => {
      const o = this.update.outcome();
      if (o?.outcome !== 'updated') return;
      untracked(() => {
        this.activity.toast({ tone: 'success', title: this.translate.instant('update.outcome.updated-title', { to: o.to }) });
        this.update.dismissOutcome();
      });
    });
  }

  async ngOnInit(): Promise<void> {
    // Desktop only: the browser dev session has no updater, and checking there
    // would surface an offer the user cannot act on.
    if (!this.ipc.inTauri) return;
    void this.update.start();

    // Wait before asking. `autoUpdate` lives in the orchestrator's
    // /preferences, and the orchestrator is a ~100 MB sidecar still booting at
    // ngOnInit — asking immediately mostly fails. The Rust auto-update task
    // waits 5s for the same reason (lib.rs `maybe_auto_update`), so checking
    // just after it also means the "installing" status we may show is already
    // true rather than merely imminent.
    for (const waitMs of [6000, 5000, 5000]) {
      await sleep(waitMs);
      try {
        const [info, prefs] = await Promise.all([
          this.ipc.checkForUpdate(),
          this.ipc.getUpdatePreference(),
        ]);
        const dismissed = this.dismissedVersion();
        this.notice.set(
          updateNoticeFor(info, {
            autoUpdate: prefs.autoUpdate,
            ...(dismissed ? { dismissedVersion: dismissed } : {}),
          }),
        );
        return;
      } catch {
        // Backend not up yet, offline, or the updater endpoint is unreachable.
        // Retry quietly; an update notice is never worth an error banner,
        // because the user did not ask for this check.
      }
    }
    // Still nothing after ~16s. Stay silent rather than guessing: without the
    // preference we cannot tell an install already running in the background
    // from one the user must start, and offering the wrong one races the
    // updater. Settings → Updates still works, and the next launch retries.
  }

  /** Escape closes the modal (the download, if any, goes on), matching the confirm dialog. */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.notice()?.kind === 'available') this.dismiss();
  }

  protected dismiss(): void {
    const n = this.notice();
    // Only a MANUAL notice is remembered, and only when the user declined it:
    // hiding a download in progress is not saying no to the update. The
    // auto-installing strip is transient — gone on the next launch anyway.
    if (n?.kind === 'available' && this.update.status().phase === 'idle') {
      try {
        localStorage.setItem(DISMISSED_KEY, n.version);
      } catch {
        // Private mode / storage disabled: the notice simply reappears next
        // launch, which is a far better failure than not showing it at all.
      }
    }
    this.notice.set(null);
  }

  /** The failed-update strip's Try again: same install, progress shown under the strip. */
  protected retryFailed(): void {
    this.update.dismissOutcome();
    this.retrying.set(true);
    void this.update.install();
  }

  private dismissedVersion(): string | null {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  }
}

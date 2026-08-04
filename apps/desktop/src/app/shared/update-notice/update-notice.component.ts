import type { OnInit } from '@angular/core';
import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { updateNoticeFor, type UpdateNotice } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { BusyIndicatorComponent } from '../busy-indicator/busy-indicator.component';
import { TranslatePipe, TranslateService } from '../../core/i18n';

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
 *   auto-installing — a status strip. The install is already running in the
 *                     background (see `maybe_auto_update` in lib.rs); the user
 *                     gets told the app will restart, not offered a button that
 *                     would race it.
 *   available       — a modal with the release notes and a real choice. Shown
 *                     ONCE per version: nagging every launch is how people learn
 *                     to dismiss dialogs without reading them.
 *
 * The decision of which to show is {@link updateNoticeFor} in the shared
 * package, where it is unit-tested — this component only renders it.
 */
@Component({
  selector: 'vd-update-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BusyIndicatorComponent, TranslatePipe],
  template: `
    @if (notice(); as n) {
      @switch (n.kind) {
        @case ('auto-installing') {
          <div class="update-strip" role="status" aria-live="polite">
            <span class="update-dot" aria-hidden="true"></span>
            <span>
              <strong>{{ 'update.installing-title' | translate: { version: n.version } }}</strong>
              {{ 'update.installing-body' | translate }}
            </span>
            <button type="button" class="btn btn-ghost btn-sm" (click)="dismiss()" [attr.aria-label]="'common.hide' | translate">
              {{ 'common.hide' | translate }}
            </button>
          </div>
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
              @if (error(); as e) {
                <p class="update-error" role="alert">{{ e }}</p>
              }
              <vd-busy-indicator [active]="installing()" [label]="'update.installing-label' | translate" />
              <div class="update-actions">
                <button type="button" class="btn btn-ghost" (click)="dismiss()" [disabled]="installing()">
                  {{ 'common.later' | translate }}
                </button>
                <button type="button" class="btn btn-primary" (click)="install()" [disabled]="installing()">
                  {{ (installing() ? 'update.installing' : 'update.install-now') | translate }}
                </button>
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
        gap: var(--vd-sp-3);
        padding: var(--vd-sp-2) var(--vd-sp-4);
        background: var(--vd-surface-2, var(--vd-surface));
        border-bottom: 1px solid var(--vd-border);
        font-size: 0.9rem;
      }
      .update-strip > span:nth-of-type(2) {
        flex: 1;
      }
      .update-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--vd-accent, #3b82f6);
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
      .update-error {
        color: var(--vd-danger, #dc2626);
        font-size: 0.9rem;
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
  private readonly translate = inject(TranslateService);
  protected readonly notice = signal<UpdateNotice | null>(null);
  protected readonly installing = signal(false);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    // Desktop only: the browser dev session has no updater, and checking there
    // would surface an offer the user cannot act on.
    if (!this.ipc.inTauri) return;

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

  /** Escape closes the modal, matching the confirm dialog. */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.notice()?.kind === 'available' && !this.installing()) this.dismiss();
  }

  protected dismiss(): void {
    const n = this.notice();
    // Only a MANUAL notice is remembered. The auto-installing strip is
    // transient — it is gone on the next launch anyway, because the update it
    // describes will have been installed.
    if (n?.kind === 'available') {
      try {
        localStorage.setItem(DISMISSED_KEY, n.version);
      } catch {
        // Private mode / storage disabled: the notice simply reappears next
        // launch, which is a far better failure than not showing it at all.
      }
    }
    this.notice.set(null);
  }

  protected async install(): Promise<void> {
    this.installing.set(true);
    this.error.set(null);
    try {
      // Diverges on success — the app relaunches into the new version.
      await this.ipc.downloadAndInstallUpdate();
    } catch (err) {
      this.installing.set(false);
      this.error.set(
        err instanceof Error
          ? err.message
          : this.translate.instant('update.install-failed'),
      );
    }
  }

  private dismissedVersion(): string | null {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  }
}

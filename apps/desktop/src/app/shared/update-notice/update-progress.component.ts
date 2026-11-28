import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { UpdateService, formatMegabytes } from '../../core/update/update.service';

/**
 * Where an app update is, with what the user can do about it: the download
 * (megabytes, speed, Cancel), the installer starting (the app will close and
 * reopen), an update waiting for a dub to end, or a failure (Try again, the
 * installer from GitHub, and the technical reason folded away).
 *
 * One component for the update dialog, the background-update strip and
 * Settings → General, so they can never tell different stories. It replaced a
 * spinner that showed nothing for the minutes a ~280 MB download takes: the
 * 0.17.0 update stalled behind it and looked frozen.
 */
@Component({
  selector: 'vd-update-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    @let s = update.status();
    @switch (s.phase) {
      @case ('downloading') {
        <div class="up" role="status" aria-live="polite">
          <div class="up-line">
            <strong>{{ 'update.progress.downloading' | translate: { version: s.version ?? '' } }}</strong>
            @if (amount(); as a) {
              <span class="up-amount">{{ a }}</span>
            }
          </div>
          <div
            class="up-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-valuenow]="update.percent()"
            [attr.aria-label]="'update.progress.downloading' | translate: { version: s.version ?? '' }"
          >
            <span [class.indeterminate]="update.percent() === null" [style.width.%]="update.percent() ?? 30"></span>
          </div>
          <div class="up-foot">
            <span class="hint">{{ 'update.progress.keep-working' | translate }}</span>
            <button type="button" class="btn btn-ghost btn-sm" (click)="update.cancel()">
              {{ 'update.progress.cancel' | translate }}
            </button>
          </div>
        </div>
      }
      @case ('installing') {
        <div class="up" role="status" aria-live="polite">
          <strong>{{ 'update.progress.installing-title' | translate: { version: s.version ?? '' } }}</strong>
          <div class="up-bar" aria-hidden="true"><span class="indeterminate"></span></div>
          <span class="hint">{{ 'update.progress.installing' | translate }}</span>
        </div>
      }
      @case ('ready') {
        <div class="up" role="status">
          <strong>{{ 'update.progress.ready-title' | translate: { version: s.version ?? '' } }}</strong>
          <span class="hint">{{ 'update.progress.ready' | translate }}</span>
          <div class="up-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="update.install()">
              {{ 'update.install-now' | translate }}
            </button>
          </div>
        </div>
      }
    }
    @if (failure(); as f) {
      <div class="up" [class.up-failed]="!f.busy" [attr.role]="f.busy ? 'status' : 'alert'">
        <strong>{{ (f.busy ? 'update.progress.busy-title' : 'update.progress.failed-title') | translate }}</strong>
        <span>{{ (f.busy ? 'update.progress.busy' : 'update.progress.failed-hint') | translate }}</span>
        @if (f.busy) {
          <!-- One step for the whole queue: pausing dubs one by one let the next start each time. -->
          <div class="up-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="update.pauseDubsAndInstall()">
              {{ 'update.progress.pause-and-install' | translate }}
            </button>
          </div>
        } @else {
          <div class="up-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="update.install()">
              {{ 'update.progress.retry' | translate }}
            </button>
            <button type="button" class="btn btn-sm" (click)="update.openReleases()">
              {{ 'update.progress.github' | translate }}
            </button>
          </div>
        }
        @if (f.detail) {
          <details class="up-details">
            <summary>{{ 'update.progress.details' | translate }}</summary>
            <code>{{ f.detail }}</code>
          </details>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .up {
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-2);
        padding: var(--vd-sp-3);
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius, 8px);
        background: var(--vd-surface-2, var(--vd-surface));
        font-size: 0.9rem;
      }
      .up + .up {
        margin-top: var(--vd-sp-2);
      }
      .up-failed {
        border-color: var(--vd-danger);
      }
      .up-failed > strong {
        color: var(--vd-danger);
      }
      .up-line,
      .up-foot {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--vd-sp-3);
        flex-wrap: wrap;
      }
      .up-amount {
        color: var(--vd-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .up-bar {
        position: relative;
        height: 6px;
        overflow: hidden;
        border-radius: 3px;
        background: var(--vd-border);
      }
      .up-bar > span {
        position: absolute;
        inset: 0 auto 0 0;
        width: 30%;
        border-radius: 3px;
        background: var(--vd-primary);
        transition: width 0.25s ease-out;
      }
      .up-bar > span.indeterminate {
        width: 30%;
        animation: vd-update-slide 1.2s ease-in-out infinite;
      }
      @keyframes vd-update-slide {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(340%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .up-bar > span.indeterminate {
          animation: none;
          width: 100%;
          opacity: 0.5;
        }
        .up-bar > span {
          transition: none;
        }
      }
      .hint {
        color: var(--vd-text-muted);
      }
      .up-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--vd-sp-2);
      }
      .up-details summary {
        cursor: pointer;
        color: var(--vd-text-muted);
        font-size: 0.85rem;
      }
      .up-details code {
        display: block;
        margin-top: var(--vd-sp-1, 4px);
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.8rem;
      }
    `,
  ],
})
export class UpdateProgressComponent {
  protected readonly update = inject(UpdateService);
  private readonly translate = inject(TranslateService);

  /** `84,2 MB / 284 MB · 29% · 2,1 MB/s`, in the reader's number format. */
  protected readonly amount = computed(() => {
    const s = this.update.status();
    const locale = this.translate.locale();
    if (s.downloaded <= 0 && !s.total) return null;
    const parts = [
      s.total ? `${formatMegabytes(s.downloaded, locale)} / ${formatMegabytes(s.total, locale)}` : formatMegabytes(s.downloaded, locale),
    ];
    const pct = this.update.percent();
    if (pct !== null) parts.push(`${pct}%`);
    if (s.bytesPerSecond && s.bytesPerSecond > 0) parts.push(`${formatMegabytes(s.bytesPerSecond, locale)}/s`);
    return parts.join(' · ');
  });

  /**
   * Why the update stopped, if it did: the shell's own failure (download or
   * installer), or the request refused because a dub is running. That one is
   * a wait, not a failure, and reads as one (no red): the update stays
   * downloaded (`ready`) until the dub ends.
   */
  protected readonly failure = computed<{ busy: boolean; detail: string | null } | null>(() => {
    const s = this.update.status();
    const err = this.update.error();
    if (s.phase === 'downloading' || s.phase === 'installing') return null;
    if (s.phase === 'failed') return { busy: false, detail: s.error ?? err?.message ?? null };
    if (!err) return null;
    if (err.code === 'RUN_IN_PROGRESS') return { busy: true, detail: null };
    return { busy: false, detail: err.message };
  });
}

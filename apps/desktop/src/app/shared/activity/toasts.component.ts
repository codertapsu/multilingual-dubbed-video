import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ActivityService } from '../../core/activity/activity.service';
import { TranslatePipe } from '../../core/i18n';

/**
 * Corner notices (core/activity/activity.service.ts): an engine, a model or a
 * video finished downloading, a dub or render finished, the projects folder
 * moved, or one of them failed, wherever the user is in the app. Success goes
 * by itself; a failure stays until dismissed, with where to retry.
 */
@Component({
  selector: 'vd-toasts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe],
  template: `
    <div class="toasts" aria-live="polite" aria-atomic="false">
      @for (t of activity.toasts(); track t.id) {
        <div class="toast" [attr.data-tone]="t.tone" [attr.role]="t.tone === 'error' ? 'alert' : 'status'">
          <span class="icon" aria-hidden="true">{{ t.tone === 'success' ? '✓' : t.tone === 'error' ? '!' : 'i' }}</span>
          <div class="body">
            <strong>{{ t.title }}</strong>
            @if (t.message) {
              <span class="msg">{{ t.message }}</span>
            }
            @if (t.link) {
              <a [routerLink]="t.link" [fragment]="t.fragment" (click)="activity.closeToast(t.id)">{{ t.linkLabel ?? ('activity.open' | translate) }}</a>
            }
          </div>
          <button type="button" class="close" (click)="activity.closeToast(t.id)" [attr.aria-label]="'activity.dismiss' | translate">×</button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toasts {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 100;
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: min(380px, calc(100vw - 32px));
        pointer-events: none;
      }
      .toast {
        pointer-events: auto;
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 10px 12px;
        border-radius: var(--vd-radius, 10px);
        background: var(--vd-surface, #fff);
        color: var(--vd-text, inherit);
        border: 1px solid var(--vd-border, #d0d7de);
        border-left-width: 4px;
        box-shadow: var(--vd-shadow-lg, 0 10px 28px rgba(0, 0, 0, 0.16));
        animation: vd-toast-in 0.18s ease-out;
      }
      .toast[data-tone='success'] {
        border-left-color: var(--vd-success, #16a34a);
      }
      .toast[data-tone='error'] {
        border-left-color: var(--vd-danger, #dc2626);
      }
      .toast[data-tone='info'] {
        border-left-color: var(--vd-primary, #2563eb);
      }
      .icon {
        font-weight: 700;
        width: 18px;
        text-align: center;
      }
      .body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.9rem;
        overflow-wrap: anywhere;
      }
      .msg {
        color: var(--vd-text-muted, #6b7280);
        font-size: 0.85rem;
      }
      .close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1.1rem;
        line-height: 1;
        color: var(--vd-text-muted, #6b7280);
      }
      @keyframes vd-toast-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
    `,
  ],
})
export class ToastsComponent {
  protected readonly activity = inject(ActivityService);
}

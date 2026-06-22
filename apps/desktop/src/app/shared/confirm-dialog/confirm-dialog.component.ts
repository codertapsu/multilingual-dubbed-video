import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';

import { ConfirmService } from './confirm.service';

/**
 * The single confirmation-dialog host, mounted once at the app root. It renders
 * a modal overlay whenever {@link ConfirmService.confirm} has an open request.
 * Cancel via the Cancel button, the backdrop, or the Escape key; confirm via the
 * primary button. Purely driven by the service — no inputs.
 */
@Component({
  selector: 'vd-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (confirm.request(); as req) {
      <div class="confirm-overlay" role="presentation" (click)="onCancel()">
        <div
          class="confirm-card"
          role="alertdialog"
          aria-modal="true"
          [attr.aria-label]="req.title"
          (click)="$event.stopPropagation()"
        >
          <h3 class="confirm-title">{{ req.title }}</h3>
          <p class="confirm-message">{{ req.message }}</p>
          <div class="confirm-actions">
            <button type="button" class="btn btn-ghost" (click)="onCancel()" autofocus>
              {{ req.cancelLabel ?? 'Cancel' }}
            </button>
            <button
              type="button"
              class="btn"
              [class.btn-danger]="req.danger !== false"
              [class.btn-primary]="req.danger === false"
              (click)="onConfirm()"
            >
              {{ req.confirmLabel ?? 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .confirm-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--vd-sp-5);
        background: rgba(0, 0, 0, 0.45);
      }
      .confirm-card {
        width: 100%;
        max-width: 420px;
        background: var(--vd-surface);
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
        padding: var(--vd-sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-3);
      }
      .confirm-title {
        margin: 0;
        font-size: 1.05rem;
        color: var(--vd-text);
      }
      .confirm-message {
        margin: 0;
        color: var(--vd-text-muted);
        line-height: 1.5;
      }
      .confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--vd-sp-2);
        margin-top: var(--vd-sp-2);
      }
    `,
  ],
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);

  onConfirm(): void {
    this.confirm.resolve(true);
  }

  onCancel(): void {
    this.confirm.resolve(false);
  }

  /** Escape closes the dialog as a cancel (only when one is open). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.confirm.request()) this.confirm.resolve(false);
  }
}

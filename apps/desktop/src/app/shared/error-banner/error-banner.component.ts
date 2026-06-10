import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { AppError } from '../../core/models';

/**
 * Renders an {@link AppError} in a consistent, accessible banner:
 *   what failed (message) / why (cause) / how to fix (remediation) / docs link.
 *
 * Pure presentational: pass `error` in, listen for `dismiss`.
 */
@Component({
  selector: 'vd-error-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as err) {
      <div class="error-banner" role="alert" aria-live="assertive">
        <div class="error-head">
          <span class="error-code mono">{{ err.code }}</span>
          <strong class="error-msg">{{ err.message }}</strong>
          <button
            type="button"
            class="btn btn-ghost btn-sm dismiss"
            aria-label="Dismiss error"
            (click)="dismiss.emit()"
          >
            ✕
          </button>
        </div>

        @if (err.cause) {
          <p class="error-cause">
            <span class="label">Why:</span>
            <span class="mono">{{ err.cause }}</span>
          </p>
        }

        @if (err.remediation) {
          <p class="error-remediation">
            <span class="label">How to fix:</span> {{ err.remediation }}
          </p>
        }

        @if (err.docsRef) {
          <p class="error-docs">
            <span class="label">Docs:</span>
            <span class="mono">{{ err.docsRef }}</span>
          </p>
        }
      </div>
    }
  `,
  styles: [
    `
      .error-banner {
        border: 1px solid var(--vd-danger);
        background: var(--vd-danger-bg);
        color: var(--vd-text);
        border-radius: var(--vd-radius);
        padding: var(--vd-sp-4);
        margin-bottom: var(--vd-sp-4);
      }
      .error-head {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-3);
      }
      .error-code {
        color: var(--vd-danger);
        font-weight: 700;
        font-size: 0.75rem;
        padding: 2px 6px;
        border: 1px solid var(--vd-danger);
        border-radius: 999px;
        white-space: nowrap;
      }
      .error-msg {
        flex: 1;
      }
      .dismiss {
        line-height: 1;
      }
      .error-cause,
      .error-remediation,
      .error-docs {
        margin: var(--vd-sp-2) 0 0;
        font-size: 0.9rem;
      }
      .label {
        font-weight: 650;
        color: var(--vd-text-muted);
      }
    `,
  ],
})
export class ErrorBannerComponent {
  /** The error to render. When null/undefined the banner renders nothing. */
  readonly error = input<AppError | null>(null);

  /** Emitted when the user dismisses the banner. */
  readonly dismiss = output<void>();
}

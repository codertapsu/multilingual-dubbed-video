import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError } from '../../core/models';
import { TranslatePipe } from '../../core/i18n';

/**
 * Base for turning an error's `docsRef` into something a user can actually
 * open. `docsRef` is a REPO-RELATIVE path with an anchor
 * (e.g. "docs/TROUBLESHOOTING.md#python-not-found"), which the banner used to
 * print as inert monospace text — a filename that does not exist on the machine
 * of anyone running an installed .dmg/.exe, shown at the exact moment they are
 * already stuck.
 */
const DOCS_BASE_URL =
  'https://github.com/codertapsu/multilingual-dubbed-video/blob/main/';

/**
 * Renders an {@link AppError} in a consistent, accessible banner:
 *   what failed (message) / why (cause) / how to fix (remediation) / docs link.
 *
 * Presentational apart from one thing: it opens the `docsRef` in the OS browser
 * itself (via {@link IpcService.openExternal}), because making every one of its
 * ~15 call sites forward a click would guarantee some of them forget.
 */
@Component({
  selector: 'vd-error-banner',
  standalone: true,
  imports: [TranslatePipe],
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
            [attr.aria-label]="'error.dismiss-aria' | translate"
            (click)="dismiss.emit()"
          >
            ✕
          </button>
        </div>

        @if (err.cause) {
          <p class="error-cause">
            <span class="label">{{ 'error.why' | translate }}</span>
            <span class="mono">{{ err.cause }}</span>
          </p>
        }

        @if (err.remediation) {
          <p class="error-remediation">
            <span class="label">{{ 'error.how-to-fix' | translate }}</span> {{ err.remediation }}
          </p>
        }

        @if (err.docsRef; as ref) {
          <p class="error-docs">
            <span class="label">{{ 'error.docs' | translate }}</span>
            <button type="button" class="docs-link mono" (click)="openDocs(ref)">
              {{ ref }}
            </button>
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
      .docs-link {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        color: var(--vd-primary);
        cursor: pointer;
        text-decoration: underline;
      }
    `,
  ],
})
export class ErrorBannerComponent {
  private readonly ipc = inject(IpcService);

  /** The error to render. When null/undefined the banner renders nothing. */
  readonly error = input<AppError | null>(null);

  /** Emitted when the user dismisses the banner. */
  readonly dismiss = output<void>();

  /** Open the referenced doc page on GitHub in the OS browser. */
  protected openDocs(docsRef: string): void {
    void this.ipc.openExternal(DOCS_BASE_URL + docsRef.replace(/^\/+/, ''));
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  viewChild,
  type ElementRef,
} from '@angular/core';

import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError } from '../../core/models';
import { TranslatePipe } from '../../core/i18n';
import { ErrorRevealService } from './error-reveal.service';
import { describeError, docsUrl } from './error-view';

let nextBannerId = 0;

/**
 * Renders an {@link AppError} in a consistent, accessible banner: what went
 * wrong and what to do, in the user's language (error-view.ts maps every
 * code), with the code, the server's own words, the cause and the guide
 * folded under "Technical details" for whoever helps them.
 *
 * It asks to be brought into view when it appears or its error changes: on a
 * long page a failure out of sight read as a click that "did nothing"
 * (ErrorRevealService decides, with every other banner of the moment).
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
    @if (view(); as v) {
      <div #banner class="error-banner" role="alert" tabindex="-1" [attr.aria-labelledby]="titleId">
        <div class="error-head">
          <span class="error-icon" aria-hidden="true">!</span>
          <strong class="error-title" [id]="titleId">{{ v.titleKey | translate }}</strong>
          <button
            type="button"
            class="btn btn-ghost btn-sm dismiss"
            [attr.aria-label]="'error.dismiss-aria' | translate"
            (click)="dismiss.emit()"
          >
            ✕
          </button>
        </div>

        @if (v.message) {
          <p class="error-message">{{ v.message }}</p>
        }
        <p class="error-fix">
          @if (v.advice) {
            {{ v.advice }}
          } @else {
            {{ v.fixKey | translate }}
          }
        </p>

        <!-- Each label and its value are separate elements, spaced by CSS:
             Angular drops the whitespace-only text between two elements, which
             printed "Mã lỗi:WORKER_TIMEOUT". -->
        <details class="error-details">
          <summary>{{ 'error.details' | translate }}</summary>
          <p>
            <span class="label">{{ 'error.code-label' | translate }}</span>
            <span class="mono">{{ v.code }}</span>
          </p>
          @if (v.details.message) {
            <p>
              <span class="label">{{ 'error.message-label' | translate }}</span>
              <span>{{ v.details.message }}</span>
            </p>
          }
          @if (v.details.remediation) {
            <p>
              <span class="label">{{ 'error.how-to-fix' | translate }}</span>
              <span>{{ v.details.remediation }}</span>
            </p>
          }
          @if (v.details.cause) {
            <p>
              <span class="label">{{ 'error.why' | translate }}</span>
              <span class="mono cause">{{ v.details.cause }}</span>
            </p>
          }
          @if (v.details.docsRef; as ref) {
            <p>
              <span class="label">{{ 'error.docs' | translate }}</span>
              <button type="button" class="docs-link" [title]="ref" (click)="openDocs(ref)">
                {{ 'error.docs-open' | translate }}
              </button>
            </p>
          }
        </details>
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
        /* Brought into view with a little room above it, not flush with the edge. */
        scroll-margin: var(--vd-sp-4);
      }
      .error-banner:focus {
        outline: none;
      }
      .error-banner:focus-visible {
        outline: 2px solid var(--vd-danger);
        outline-offset: 2px;
      }
      .error-head {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-3);
      }
      .error-icon {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: var(--vd-danger);
        /* The banner's own tint: it contrasts with the danger colour in both themes. */
        color: var(--vd-danger-bg);
        font-weight: 800;
        font-size: 0.85rem;
      }
      .error-title {
        flex: 1;
      }
      .dismiss {
        line-height: 1;
      }
      .error-message,
      .error-fix {
        margin: var(--vd-sp-2) 0 0;
        font-size: 0.92rem;
        overflow-wrap: anywhere;
      }
      .error-details {
        margin-top: var(--vd-sp-2);
        font-size: 0.85rem;
      }
      .error-details summary {
        cursor: pointer;
        color: var(--vd-text-muted);
        width: fit-content;
      }
      .error-details p {
        margin: var(--vd-sp-1) 0 0;
        overflow-wrap: anywhere;
      }
      .label {
        font-weight: 650;
        color: var(--vd-text-muted);
        margin-right: 0.35em;
      }
      .cause {
        display: block;
        white-space: pre-wrap;
        max-height: 10em;
        overflow: auto;
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
  private readonly reveals = inject(ErrorRevealService);

  /** The error to render. When null/undefined the banner renders nothing. */
  readonly error = input<AppError | null>(null);

  /** Emitted when the user dismisses the banner. */
  readonly dismiss = output<void>();

  protected readonly view = computed(() => describeError(this.error()));
  protected readonly titleId = `vd-error-title-${++nextBannerId}`;
  private readonly banner = viewChild<ElementRef<HTMLElement>>('banner');
  /**
   * The error (code and message) it last asked to be shown for. The same
   * error passed again, as the same object or as a new one on every poll,
   * stays put; a different one, or one after no error, asks again.
   */
  private announced: string | null = null;

  constructor() {
    afterRenderEffect(() => {
      const view = this.view();
      const el = this.banner()?.nativeElement;
      if (!view || !el) {
        this.announced = null;
        return;
      }
      if (view.signature === this.announced) return;
      this.announced = view.signature;
      this.reveals.request(el);
    });
  }

  /** Open the referenced doc page on GitHub in the OS browser. */
  protected openDocs(docsRef: string): void {
    void this.ipc.openExternal(docsUrl(docsRef));
  }
}

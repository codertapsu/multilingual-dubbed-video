import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import type { SetupItemProgress } from '../../core/ipc/setup-events.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';

/**
 * DownloadProgressListComponent — renders a list of in-flight downloads (from
 * the setup SSE stream) as labelled per-item progress bars.
 *
 * Shared by the first-run onboarding wizard and the New Project wizard's
 * "Review media & start" step so a blocking model/pack download always shows
 * measurable progress (a real percent when known, an animated indeterminate bar
 * with an elapsed-time message otherwise) instead of a frozen-looking label.
 *
 * Pure presentational: pass `items` (typically `setupEvents.items()`).
 */
@Component({
  selector: 'vd-download-progress-list',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="dl-list" role="list">
      @for (item of items(); track item.item) {
        <li class="dl-row">
          <div class="dl-head">
            <span class="dl-name">{{ friendlyItem(item.item) }}</span>
            <span class="dl-pct mono">
              @if (item.done) {
                {{ 'download.done' | translate }}
              } @else if (item.percent !== null) {
                {{ item.percent }}%
              } @else {
                {{ 'download.working' | translate }}
              }
            </span>
          </div>
          <div
            class="progress"
            [class.indeterminate]="item.percent === null && !item.done"
            role="progressbar"
            [attr.aria-valuenow]="item.percent ?? undefined"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-label]="friendlyItem(item.item)"
          >
            <span [style.width]="progressWidth(item.percent)"></span>
          </div>
          @if (item.message) {
            <span class="hint">{{ item.message }}</span>
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      .dl-list {
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-4);
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .dl-row {
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-1);
      }
      .dl-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .dl-name {
        font-weight: 600;
      }
      .dl-pct {
        color: var(--vd-text-muted);
      }
    `,
  ],
})
export class DownloadProgressListComponent {
  private readonly translate = inject(TranslateService);

  /** In-flight download items (e.g. `setupEvents.items()`). */
  readonly items = input.required<readonly SetupItemProgress[]>();

  /**
   * Human label for a setup item id, which is keyed by a raw id
   * (e.g. "whisper:small", "argos:en->vi", "piper:vi_VN-…").
   *
   * Resolved through {@link TranslateService} rather than returned as a key for
   * the template's pipe: the row also needs the raw id interpolated, and these
   * labels shipped as English template literals — the first-run download screen
   * is the very first thing a Vietnamese user sees, and it read
   * "Speech recognition model (small)" to them.
   */
  protected friendlyItem(item: string): string {
    const sep = item.indexOf(':');
    if (sep === -1) return item;
    const kind = item.slice(0, sep);
    const rest = item.slice(sep + 1);
    switch (kind) {
      case 'whisper':
        return this.translate.instant('download.item.whisper', { ref: rest });
      case 'argos':
        return this.translate.instant('download.item.argos', {
          ref: rest.replace('->', ' → '),
        });
      case 'piper':
        return this.translate.instant('download.item.piper');
      default:
        return item;
    }
  }

  /** Bar fill width; `null` (indeterminate) renders full and is animated by the
   *  `.indeterminate` class on the track. */
  protected progressWidth(percent: number | null): string {
    return percent === null ? '100%' : `${Math.max(0, Math.min(100, percent))}%`;
  }
}

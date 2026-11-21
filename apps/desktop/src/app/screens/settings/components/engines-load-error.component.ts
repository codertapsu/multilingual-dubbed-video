import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import { SettingsStore } from '../settings.store';

/**
 * "Couldn't load the engines", with Try again, where an engine page's family
 * cards would be. The store swallowed the failure and the pages rendered no
 * cards, so a backend that did not answer looked like an app with nothing to
 * install (Speakers even said "No engine packs are available for this
 * platform"). Renders nothing while the list is fine.
 */
@Component({
  selector: 'vd-engines-load-error',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // No box of its own: the engine pages are flex columns with a gap, and an
  // empty host would add one more gap to every page whose list loaded fine.
  styles: `
    :host {
      display: contents;
    }
    h3 {
      margin: 0;
      font-size: 1rem;
      color: var(--vd-warning);
    }
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--vd-sp-2);
    }
  `,
  template: `
    @if (store.enginesError()) {
      <div class="card stack-sm" role="alert">
        <h3>{{ 'settings.engines.load-failed' | translate }}</h3>
        <p class="hint">{{ 'settings.engines.load-failed-hint' | translate }}</p>
        <div class="row-actions">
          <button type="button" class="btn btn-sm btn-primary" (click)="store.retryEngines()" [disabled]="store.enginesLoading()">
            {{ (store.enginesLoading() ? 'settings.engines.load-retrying' : 'settings.engines.retry') | translate }}
          </button>
        </div>
      </div>
    }
  `,
})
export class EnginesLoadErrorComponent {
  protected readonly store = inject(SettingsStore);
}

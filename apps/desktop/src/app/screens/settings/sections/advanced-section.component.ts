import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Advanced: what almost nobody needs. The state of the Python
 * runtime the voice and helper engines install into (the old Engines card
 * opened with it, above every pack), and resetting every setting at once.
 */
@Component({
  selector: 'vd-settings-advanced',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
    h3 {
      margin: 0;
    }
  `,
  template: `
    <div class="card stack-sm" id="python-engines">
      <h3>{{ 'settings.advanced.uv' | translate }}</h3>
      <p class="hint">{{ 'settings.advanced.uv-hint' | translate }}</p>
      @if (store.prerequisites(); as pre) {
        @if (pre.uv.available) {
          <p class="hint test-ok">
            {{ 'settings.engines.uv-ok' | translate: { bundled: pre.uv.bundled ? ('settings.engines.uv-bundled' | translate) : '' } }}
          </p>
        } @else if (store.uvObtainable()) {
          <p class="hint">{{ 'settings.engines.uv-download' | translate }}</p>
        } @else {
          <p class="hint test-fail">{{ 'settings.engines.uv-missing' | translate }}</p>
        }
      } @else if (store.enginesLoaded()) {
        <!-- The engine list's load answered and this part did not come with it. -->
        <p class="hint warn-text">{{ 'settings.advanced.uv-unavailable' | translate }}</p>
      } @else {
        <p class="hint">{{ 'common.loading' | translate }}</p>
      }
    </div>

    <div class="card stack-sm" id="reset-all">
      <h3>{{ 'settings.advanced.reset-all' | translate }}</h3>
      <p class="hint">{{ 'settings.advanced.reset-all-hint' | translate }}</p>
      <div class="row-actions">
        <button type="button" class="btn btn-sm" (click)="resetAll()" [disabled]="busy()">
          {{ 'settings.advanced.reset-all-button' | translate }}
        </button>
        @if (done()) {
          <span class="hint test-ok" role="status">✓ {{ 'settings.reset.done' | translate }}</span>
        }
      </div>
    </div>
  `,
})
export class AdvancedSectionComponent {
  protected readonly store = inject(SettingsStore);
  protected readonly busy = signal(false);
  protected readonly done = signal(false);

  protected async resetAll(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.done.set(false);
    try {
      this.done.set(await this.store.resetSection('all'));
    } finally {
      this.busy.set(false);
    }
  }
}

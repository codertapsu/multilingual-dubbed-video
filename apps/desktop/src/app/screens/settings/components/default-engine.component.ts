import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { SettingsStore, type DefaultPhase } from '../settings.store';

/**
 * "Default for new projects" for one step: the one active choice of the page.
 * The old Processing-defaults card held the three pickers with a Save button;
 * each step's page now has its own, which saves on change like every other
 * setting. "Automatic" is spelled out with what it picks on this computer now,
 * and a choice that cannot run says why and what to do instead of "needs API
 * key" for every reason.
 */
@Component({
  selector: 'vd-default-engine',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  host: { class: 'opt' },
  template: `
    <div class="opt-text">
      <label class="opt-title" [for]="'default-' + phase()">{{ titleKey() | translate }}</label>
      <p class="hint">{{ hintKey() | translate }}</p>
    </div>
    <div class="opt-control stack-sm">
      @if (store.providers()) {
        <select
          [id]="'default-' + phase()"
          [ngModel]="store.defaultFor(phase())"
          (ngModelChange)="choose($event)"
          [disabled]="store.defaultsSaving()"
        >
          <option value="">{{ 'settings.defaults.auto' | translate }}</option>
          @for (p of store.selectable(phase(), store.defaultFor(phase()) || undefined); track p.id) {
            <option [value]="p.id">{{ store.providerLabel(p.id) }}{{ p.available ? '' : ' — ' + store.unavailableReason(p) }}</option>
          }
        </select>
        @if (!store.defaultFor(phase()) && autoName(); as name) {
          <!-- A voice is the one choice that follows the language: VieNeu for Vietnamese, Piper otherwise. -->
          <p class="hint">{{ (byLanguage() ? 'settings.fn.auto-now-tts' : 'settings.fn.auto-now') | translate: { name: name } }}</p>
        }
        @if (chosenUnavailable(); as p) {
          <p class="hint warn-text">
            {{ 'settings.fn.chosen-cannot-run' | translate: { reason: store.unavailableReason(p) } }}
            @if (p.readinessStatus === 'cloud-key-missing') {
              <a routerLink="/settings/cloud">{{ 'settings.fn.add-key' | translate }}</a>
            }
          </p>
        }
      } @else {
        <p class="hint">{{ 'settings.defaults.unavailable' | translate }}</p>
      }
    </div>
  `,
})
export class DefaultEngineComponent {
  protected readonly store = inject(SettingsStore);

  readonly phase = input.required<DefaultPhase>();
  readonly titleKey = input.required<string>();
  readonly hintKey = input.required<string>();

  /** What Automatic picks on this computer now (GET /project-defaults, asked for a Vietnamese dub). */
  protected readonly autoName = computed(() => this.store.providerLabel(this.store.effectiveProvider(this.phase())));

  /**
   * Automatic's voice depends on the language (projectDefaults.ts: VieNeu for
   * Vietnamese when installed, else the built-in Piper), so say so — unless it
   * is Piper either way.
   */
  protected readonly byLanguage = computed(
    () => this.phase() === 'tts' && this.store.effectiveProvider('tts') !== 'piper-local',
  );

  /** The saved choice, when it cannot run here now (its key removed, its engine uninstalled). */
  protected readonly chosenUnavailable = computed(() => {
    const id = this.store.defaultFor(this.phase());
    if (!id) return null;
    const p = this.store.providersFor(this.phase()).find((x) => x.id === id);
    return p && !p.available ? p : null;
  });

  protected choose(id: string): void {
    void this.store.setPhaseDefault(this.phase(), id);
  }
}

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Performance: this computer's hardware and how many dubs run at
 * once (the run queue), with the reasons. The old "This computer" card,
 * moved; its engine recommendation lives on Engines & models now, next to the
 * engines it recommends.
 */
@Component({
  selector: 'vd-settings-performance',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe],
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
    .chip-tier {
      border-color: var(--vd-primary);
    }
    .check {
      display: flex;
      align-items: center;
      gap: var(--vd-sp-2);
      margin: 0;
      font-weight: 400;
    }
    .check input {
      width: auto;
    }
  `,
  template: `
    @if (store.system(); as sys) {
      <div class="card stack-sm" id="this-computer">
        <h3>{{ 'settings.computer.heading' | translate }}</h3>
        <p class="hint">{{ 'settings.performance.computer-hint' | translate }}</p>
        <div class="chips">
          <span class="chip mono">{{ sys.profile.cpuModel }}</span>
          <span class="chip">{{ 'settings.computer.cores' | translate: { n: sys.profile.cpuCores } }}</span>
          <span class="chip">{{ store.ramLabel() }}</span>
          @for (gpu of sys.profile.gpus; track gpu.name) {
            <span class="chip">{{ gpu.name }}{{ gpu.vramMb ? ' · ' + store.gbLabel(gpu.vramMb) : '' }}</span>
          }
          <span class="chip chip-tier" [title]="'settings.performance.tier-title' | translate">{{ tierLabel(sys.recommendation.tier) }}</span>
        </div>
        <p class="hint">
          {{ 'settings.performance.engines-link' | translate }}
          <a routerLink="/settings/engines" fragment="engine-recommended">{{ 'settings.sections.engines.title' | translate }}</a>
        </p>
      </div>

      <!-- Simultaneous dubs: the machine-derived limit + a manual override. -->
      <div class="card stack-sm">
        <div class="opt" id="opt-concurrency">
          <div class="opt-text">
            <label class="opt-title" for="concurrency">{{ 'settings.computer.concurrent' | translate }}</label>
            <p class="hint">{{ 'settings.performance.concurrent-hint' | translate }}</p>
          </div>
          <div class="opt-control">
            <select
              id="concurrency"
              [ngModel]="store.concurrencyValue()"
              (ngModelChange)="store.setConcurrency($event)"
              [disabled]="store.prefSaving()"
            >
              <option value="auto">{{ 'settings.computer.auto' | translate: { n: sys.capacity.maxProjects } }}</option>
              @for (n of concurrencyChoices; track n) {
                <option [value]="n">{{ 'settings.computer.n-at-a-time' | translate: { n: n } }}</option>
              }
            </select>
          </div>
        </div>
        <div class="opt" id="opt-pause-queue">
          <div class="opt-text">
            <label class="opt-title" for="pause-queue">{{ 'settings.computer.pause-queue' | translate }}</label>
            <p class="hint">{{ 'settings.performance.pause-hint' | translate }}</p>
          </div>
          <div class="opt-control">
            <label class="check">
              <input
                id="pause-queue"
                type="checkbox"
                [ngModel]="store.queuePaused()"
                (ngModelChange)="store.setQueuePaused($event)"
                [disabled]="store.prefSaving()"
              />
              {{ 'settings.performance.pause' | translate }}
            </label>
          </div>
        </div>
        @if (store.queuePaused()) {
          <p class="hint warn-text" role="status">{{ 'settings.performance.paused-now' | translate }}</p>
        }
        <details>
          <summary class="hint">{{ 'settings.computer.why-limit' | translate }}</summary>
          @for (reason of sys.capacity.reasons; track reason.key) {
            <p class="hint">{{ reason.key | translate: reason.params }}</p>
          }
        </details>
      </div>
    } @else {
      <div class="card">
        <p class="hint">{{ 'settings.defaults.unavailable' | translate }}</p>
      </div>
    }
  `,
})
export class PerformanceSectionComponent {
  protected readonly store = inject(SettingsStore);
  private readonly translate = inject(TranslateService);
  protected readonly concurrencyChoices = [1, 2, 3, 4, 5, 6, 7, 8];

  /** The hardware tier in words ("constrained" was shown as it is, in English). */
  protected tierLabel(tier: string): string {
    const key = `settings.performance.tier-${tier}`;
    const text = this.translate.instant(key);
    return text === key ? tier : text;
  }
}

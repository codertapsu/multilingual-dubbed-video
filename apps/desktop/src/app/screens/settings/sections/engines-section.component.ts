import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { RecommendedEnginesComponent } from '../../../shared/recommended-engines/recommended-engines.component';
import type { DefaultPhase } from '../settings.store';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Engines & models: what each step of a new dub uses now, in one
 * table with a link to each step's page, and what this computer would gain
 * (the hardware recommendation and its install panel, moved from the old
 * "This computer" and "Engines" cards).
 */
@Component({
  selector: 'vd-settings-engines',
  standalone: true,
  imports: [RouterLink, TranslatePipe, RecommendedEnginesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
    h3,
    h4 {
      margin: 0;
    }
    .uses {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr) max-content;
      gap: var(--vd-sp-2) var(--vd-sp-4);
      align-items: baseline;
      margin: 0;
    }
    .uses dt {
      font-weight: 600;
    }
    .uses dd {
      margin: 0;
    }
  `,
  template: `
    <!-- ===================== What new projects use ===================== -->
    <div class="card stack" id="engine-defaults">
      <div class="stack-sm">
        <h3>{{ 'settings.overview.defaults' | translate }}</h3>
        <p class="hint">{{ 'settings.overview.defaults-hint' | translate }}</p>
      </div>
      <dl class="uses">
        @for (row of rows; track row.phase) {
          <dt>{{ row.label | translate }}</dt>
          <dd>
            {{ store.providerLabel(store.effectiveProvider(row.phase)) || ('settings.defaults.auto' | translate) }}
            @if (row.phase === 'stt' && sttModel(); as model) {
              <span class="muted">&nbsp;· {{ model }}</span>
            }
            @if (!store.defaultFor(row.phase) && store.effective()) {
              <span class="muted">&nbsp;({{ 'settings.fn.automatic' | translate }})</span>
            }
          </dd>
          <dd>
            <a [routerLink]="['/settings', row.phase]">{{ 'settings.overview.change' | translate }}</a>
          </dd>
        }
        <dt>{{ 'settings.defaults.render' | translate }}</dt>
        <dd>{{ 'settings.defaults.render-value' | translate }}</dd>
        <dd></dd>
      </dl>
      @if (store.system()?.recommendation; as rec) {
        <div class="row-actions">
          <button type="button" class="btn btn-sm" (click)="store.applyRecommended()" [disabled]="store.defaultsSaving()">
            {{ 'settings.computer.use-recommended' | translate }}
          </button>
          <span class="hint">{{ 'settings.overview.use-recommended-hint' | translate: { model: rec.whisperModel } }}</span>
        </div>
      }
      @if (store.defaultsSaved()) {
        <p class="hint test-ok" role="status">{{ 'settings.defaults.saved' | translate }}</p>
      }
    </div>

    <!-- ===================== Recommended for this computer ===================== -->
    <div class="card stack" id="engine-recommended">
      <!-- What this machine's hardware would gain, in plain words, with the
           download size; each step's page has the full families. -->
      <vd-recommended-engines (changed)="store.onRecommendedInstalled()" />
      @if (store.system(); as sys) {
        <div class="stack-sm">
          <h4>{{ 'settings.overview.why' | translate }}</h4>
          <p class="hint">
            {{ 'settings.computer.rec-model' | translate }}
            <strong class="mono">{{ sys.recommendation.whisperModel }}</strong>
          </p>
          @for (reason of sys.recommendation.reasons; track reason.key) {
            <p class="hint">{{ reason.key | translate: reason.params }}</p>
          }
          @if (sys.recommendation.suggestCloud.stt || sys.recommendation.suggestCloud.translation) {
            <p class="hint">
              {{ 'settings.computer.cloud-suggest' | translate: { phases: store.cloudSuggestPhases() } }}
              <a routerLink="/settings/cloud">{{ 'settings.sections.cloud.title' | translate }}</a>
            </p>
          }
        </div>
      }
    </div>
  `,
})
export class EnginesSectionComponent {
  protected readonly store = inject(SettingsStore);

  protected readonly rows: readonly { phase: DefaultPhase; label: string }[] = [
    { phase: 'stt', label: 'misc.phase-stt' },
    { phase: 'translation', label: 'misc.phase-translation' },
    { phase: 'tts', label: 'misc.phase-tts' },
  ];

  /** The speech model new projects use: the saved one, else Automatic's pick. */
  protected sttModel(): string | undefined {
    return this.store.defaults().sttModel ?? this.store.effective()?.sttModel;
  }
}

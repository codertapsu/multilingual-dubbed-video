import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { EngineFamilyCardComponent } from '../components/engine-family-card.component';
import { familiesForPage } from '../engine-families';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Engines & models → Speaker detection & separation: the helper
 * engines a project turns on itself (New project → Speakers, Original audio):
 * speaker detection, music & voice separation, and whatever else the catalog
 * offers that is not one of the three steps. Nothing here has a default for
 * new projects, so the page has no reset.
 */
@Component({
  selector: 'vd-settings-audio',
  standalone: true,
  imports: [RouterLink, TranslatePipe, EngineFamilyCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../settings-shared.scss', './engine-page.scss'],
  template: `
    <div class="card stack-sm" id="helpers-how">
      <p class="hint">{{ 'settings.fn.helpers-how' | translate }}</p>
      <div class="row-actions">
        <a routerLink="/new" class="btn btn-sm">{{ 'nav.new-project' | translate }}</a>
      </div>
    </div>

    @for (family of families(); track family.id) {
      <vd-engine-family-card [familyId]="family.id" [family]="family" />
    } @empty {
      @if (store.enginesLoaded()) {
        <div class="card">
          <p class="hint">{{ 'settings.engines.none' | translate }}</p>
        </div>
      }
    }
  `,
})
export class AudioSectionComponent {
  protected readonly store = inject(SettingsStore);
  protected readonly families = computed(() => familiesForPage(this.store.families(), 'audio'));
}

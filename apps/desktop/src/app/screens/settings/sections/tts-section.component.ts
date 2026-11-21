import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { DefaultEngineComponent } from '../components/default-engine.component';
import { EngineFamilyCardComponent } from '../components/engine-family-card.component';
import { EnginesLoadErrorComponent } from '../components/engines-load-error.component';
import { ProviderRowComponent } from '../components/provider-row.component';
import { familiesForPage, familyOfProvider } from '../engine-families';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Engines & models → Text-to-speech: the default voice engine for
 * new projects, the VieNeu family first (VieNeu-TTS 3.8 and Neural TTS v3,
 * each on the processor or an NVIDIA card), then the other voice engines, the
 * built-in Piper and the cloud. The voices themselves (listen, install,
 * favourites, cloned voices) are the Voices screen's; this page links there.
 */
@Component({
  selector: 'vd-settings-tts',
  standalone: true,
  imports: [RouterLink, TranslatePipe, DefaultEngineComponent, EngineFamilyCardComponent, EnginesLoadErrorComponent, ProviderRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../settings-shared.scss', './engine-page.scss'],
  template: `
    <!-- ===================== Default for new projects ===================== -->
    <div class="card" id="tts-defaults">
      <h3 class="card-title">{{ 'settings.fn.defaults-heading' | translate }}</h3>
      <vd-default-engine id="opt-tts-default" phase="tts" titleKey="settings.fn.tts-engine" hintKey="settings.fn.tts-engine-hint" />
      @if (store.defaultsSaved()) {
        <p class="hint test-ok saved" role="status" animate.leave="fade-out">{{ 'settings.defaults.saved' | translate }}</p>
      }
      <div class="row-actions voices-link">
        <a routerLink="/voices" class="btn btn-sm">{{ 'settings.fn.open-voices' | translate }}</a>
        <span class="hint">{{ 'settings.fn.open-voices-hint' | translate }}</span>
      </div>
    </div>

    <!-- ===================== Families (VieNeu first) ===================== -->
    <vd-engines-load-error />
    @for (family of families(); track family.id) {
      <vd-engine-family-card [familyId]="family.id" [family]="family" />
    }

    <!-- ===================== Built in (Piper) and cloud ===================== -->
    @if (otherProviders().length > 0) {
      <div class="card" id="tts-other">
        <h3 class="card-title">{{ 'settings.fn.other-engines' | translate }}</h3>
        @for (p of otherProviders(); track p.id) {
          <vd-provider-row [provider]="p" phase="tts" />
        }
      </div>
    }
  `,
  styles: `
    .voices-link {
      margin-top: var(--vd-sp-3);
    }
  `,
})
export class TtsSectionComponent {
  protected readonly store = inject(SettingsStore);

  protected readonly families = computed(() => familiesForPage(this.store.families(), 'tts'));
  /** Engines with nothing to download here: Piper (built in) and the cloud voices. */
  protected readonly otherProviders = computed(() =>
    this.store.providersFor('tts').filter((p) => !familyOfProvider(p, this.store.families())),
  );
}

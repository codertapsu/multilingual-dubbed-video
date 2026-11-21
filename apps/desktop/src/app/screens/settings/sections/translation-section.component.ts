import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import { ArgosPacksComponent } from '../components/argos-packs.component';
import { DefaultEngineComponent } from '../components/default-engine.component';
import { EngineFamilyCardComponent } from '../components/engine-family-card.component';
import { EnginesLoadErrorComponent } from '../components/engines-load-error.component';
import { ProviderRowComponent } from '../components/provider-row.component';
import { familiesForPage, familyOfProvider } from '../engine-families';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Engines & models → Translation: the default for new projects,
 * then the families — the TranslateGemma sizes, the Gemma models that
 * translate with context and review, the llama.cpp runtime they share,
 * LibreTranslate — the built-in Argos with its language packs, and the cloud
 * services and Ollama.
 */
@Component({
  selector: 'vd-settings-translation',
  standalone: true,
  imports: [
    TranslatePipe,
    DefaultEngineComponent,
    EngineFamilyCardComponent,
    EnginesLoadErrorComponent,
    ProviderRowComponent,
    ArgosPacksComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../settings-shared.scss', './engine-page.scss'],
  template: `
    <!-- ===================== Default for new projects ===================== -->
    <div class="card" id="translation-defaults">
      <h3 class="card-title">{{ 'settings.fn.defaults-heading' | translate }}</h3>
      <vd-default-engine
        id="opt-translation-default"
        phase="translation"
        titleKey="settings.fn.translation-engine"
        hintKey="settings.fn.translation-engine-hint"
      />
      @if (store.effective()?.refineProviderId; as refine) {
        <p class="hint">{{ 'settings.fn.review-now' | translate: { name: store.providerLabel(refine) } }}</p>
      }
      @if (store.defaultsSaved()) {
        <p class="hint test-ok saved" role="status" animate.leave="fade-out">{{ 'settings.defaults.saved' | translate }}</p>
      }
    </div>

    <!-- ===================== Families (TranslateGemma, Gemma, llama.cpp…) ===================== -->
    <vd-engines-load-error />
    @for (family of families(); track family.id) {
      <vd-engine-family-card [familyId]="family.id" [family]="family" />
    }

    <!-- ===================== Argos (built in) and its language packs ===================== -->
    <article class="card stack" id="family-argos">
      <div class="card-head">
        <h2 class="family-title">Argos Translate</h2>
        <span class="badge badge-pending">{{ 'settings.fn.built-in' | translate }}</span>
      </div>
      @if (argos(); as p) {
        <vd-provider-row [provider]="p" phase="translation" />
      }
      <section class="family-section" id="argos-packs">
        <h3>{{ 'settings.argos.heading' | translate }}</h3>
        <p class="hint">{{ 'settings.argos.intro' | translate }}</p>
        <vd-argos-packs />
      </section>
    </article>

    <!-- ===================== Cloud services and Ollama ===================== -->
    @if (otherProviders().length > 0) {
      <div class="card" id="translation-other">
        <h3 class="card-title">{{ 'settings.fn.other-engines' | translate }}</h3>
        <p class="hint">{{ 'settings.fn.cloud-hint' | translate }}</p>
        @for (p of otherProviders(); track p.id) {
          <vd-provider-row [provider]="p" phase="translation" />
        }
      </div>
    }
  `,
  styles: `
    .family-title {
      margin: 0;
      font-size: 1.1rem;
    }
  `,
})
export class TranslationSectionComponent {
  protected readonly store = inject(SettingsStore);

  protected readonly families = computed(() => familiesForPage(this.store.families(), 'translation'));
  protected readonly argos = computed(() => this.store.providersFor('translation').find((p) => p.id === 'argos') ?? null);
  /** Engines with nothing to download here: the cloud services and Ollama. */
  protected readonly otherProviders = computed(() =>
    this.store
      .providersFor('translation')
      .filter((p) => p.id !== 'argos' && !familyOfProvider(p, this.store.families())),
  );
}

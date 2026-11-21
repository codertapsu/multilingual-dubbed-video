import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import type { EnginePackInfo } from '../../../core/models';
import { FAMILY_RUNTIME, familyOfProvider, variantLabelOf, type EngineBuildGroup, type EngineFamilyView } from '../engine-families';
import { SettingsStore, type DefaultPhase, type SettingsProvider } from '../settings.store';
import { PackRowComponent } from './pack-row.component';

/**
 * One engine family on its function's page: what it is, which of its choices
 * new projects use, and its variants — each engine with its builds, then the
 * models. "One active choice per function" is the page's default picker; this
 * card mirrors it (the badge) and offers it ("Use for new projects") where the
 * family has something installed that can run.
 *
 * Content projected into the card goes between the explanation and the
 * engines: the Whisper card puts the built-in faster-whisper there, which is
 * no engine pack but is the same family.
 */
@Component({
  selector: 'vd-engine-family-card',
  standalone: true,
  imports: [NgTemplateOutlet, TranslatePipe, PackRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    .mode {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--vd-sp-2) var(--vd-sp-3);
      padding: var(--vd-sp-3);
      border-radius: var(--vd-radius-sm);
      background: var(--vd-surface-2);
    }
    .mode .grow {
      min-width: 220px;
    }
    h2 {
      font-size: 1.1rem;
    }
  `,
  template: `
    <article class="card stack" [attr.id]="'family-' + familyId()">
      <div class="stack-sm">
        <div class="card-head">
          <h2>{{ title() }}</h2>
          @if (usedHere(); as used) {
            <span class="badge badge-completed">{{ (used.auto ? 'settings.fn.used-auto' : 'settings.fn.used') | translate }}</span>
          }
        </div>
        <p class="hint">{{ description() }}</p>
        @if (runtime(); as rt) {
          <p class="hint" [class.test-ok]="rt.installed">
            {{ (rt.installed ? 'settings.fn.runtime-installed' : 'settings.fn.runtime-missing') | translate: { name: rt.label } }}
          </p>
        }
      </div>

      @for (mode of modes(); track mode.id) {
        <div class="mode">
          <div class="grow stack-sm">
            <div class="card-head">
              <strong>{{ store.providerLabel(mode.id) }}</strong>
              @if (isUsed(mode.id); as used) {
                <span class="badge badge-completed">{{ (used === 'auto' ? 'settings.fn.used-auto' : 'settings.fn.used') | translate }}</span>
              }
            </div>
            @if (providerNote(mode.id); as note) {
              <p class="hint">{{ note }}</p>
            }
          </div>
          <ng-container [ngTemplateOutlet]="useButton" [ngTemplateOutletContext]="{ $implicit: mode, modelsBelow: true }" />
        </div>
      }

      <ng-content />

      @for (engine of family()?.engines ?? []; track engine.providerId) {
        <!-- A family that is one engine (ZeroTTS, Kokoro…) is not titled twice. -->
        <section [class.family-section]="!soleEngine()">
          @if (!soleEngine()) {
            <div class="card-head">
              <h3>{{ engine.label }}</h3>
              @if (engineProvider(engine); as p) {
                @if (isUsed(p.id); as used) {
                  <span class="badge badge-completed">{{ (used === 'auto' ? 'settings.fn.used-auto' : 'settings.fn.used') | translate }}</span>
                }
              }
            </div>
          }
          @if (engineNote(engine); as note) {
            <p class="hint">{{ note }}</p>
          }
          <div class="variants">
            @for (pack of engine.packs; track pack.id) {
              <vd-pack-row [pack]="pack" [label]="accelLabel(pack)" />
            }
          </div>
          @if (engineProvider(engine); as p) {
            <div class="row-actions engine-use">
              <ng-container [ngTemplateOutlet]="useButton" [ngTemplateOutletContext]="{ $implicit: p, modelsBelow: false }" />
            </div>
          }
        </section>
      }

      @if (family()?.models?.length) {
        <section class="family-section">
          <h3>{{ modelsHeading() }}</h3>
          @if (runtimeMissing()) {
            <p class="hint">{{ 'settings.variant.installs-runtime' | translate }}</p>
          }
          <div class="variants">
            @for (pack of family()!.models; track pack.id) {
              <vd-pack-row [pack]="pack" [label]="modelLabel(pack)" />
            }
          </div>
        </section>
      }
    </article>

    <!-- "Use for new projects", or why it cannot be used yet and what to do. -->
    <ng-template #useButton let-p let-modelsBelow="modelsBelow">
      @if (isUsed(p.id) === null && phase()) {
        @if (p.available) {
          <button type="button" class="btn btn-sm" (click)="useForNewProjects(p.id)" [disabled]="store.defaultsSaving()">
            {{ 'settings.fn.use-for-new' | translate }}
          </button>
        } @else if (p.readinessStatus === 'engine-pack-missing' || p.readinessStatus === 'model-missing') {
          <span class="hint">{{ (modelsBelow ? 'settings.fn.install-model-first' : 'settings.fn.install-first') | translate }}</span>
        } @else {
          <span class="hint warn-text">{{ store.unavailableReason(p) }}</span>
        }
      }
    </ng-template>
  `,
})
export class EngineFamilyCardComponent {
  protected readonly store = inject(SettingsStore);
  private readonly translate = inject(TranslateService);

  /** The family's id ("whisper"): its title and explanation even with no pack offered here. */
  readonly familyId = input.required<string>();
  /** Its packs on this machine; null when the catalog offers none here (macOS has no whisper.cpp). */
  readonly family = input<EngineFamilyView | null>(null);

  /** The phase whose "default for new projects" this family can be: none for the helper engines. */
  protected readonly phase = computed<DefaultPhase | null>(() => {
    const page = this.family()?.page ?? (this.familyId() === 'whisper' ? 'stt' : null);
    return page === 'stt' || page === 'translation' || page === 'tts' ? page : null;
  });

  /** Providers that run on this family. */
  private readonly providers = computed<SettingsProvider[]>(() => {
    const phase = this.phase();
    if (!phase) return [];
    const families = this.store.families();
    return this.store.providersFor(phase).filter((p) => familyOfProvider(p, families)?.familyId === this.familyId());
  });

  /** The family is one engine and nothing else: its card title is the engine's name already. */
  protected readonly soleEngine = computed(() => {
    const f = this.family();
    return !!f && f.engines.length === 1 && f.models.length === 0;
  });

  /** Providers of the family that are no single engine of it: the TranslateGemma and Gemma translation modes. */
  protected readonly modes = computed(() =>
    this.providers().filter((p) => !familyOfProvider(p, this.store.families())?.providerId),
  );

  protected readonly title = computed(() => {
    const key = `settings.families.${this.familyId()}.title`;
    const text = this.translate.instant(key);
    if (text !== key) return text;
    const f = this.family();
    return f?.engines[0]?.label ?? (f?.models[0] ? f.models[0].displayName : this.familyId());
  });

  protected readonly description = computed(() => {
    const key = `settings.families.${this.familyId()}.desc`;
    const text = this.translate.instant(key);
    if (text !== key) return text;
    const f = this.family();
    return f?.engines[0]?.packs[0]?.description ?? f?.models[0]?.description ?? '';
  });

  /** The runtime a model-only family runs on (llama.cpp for the Gemma models), installed or not. */
  protected readonly runtime = computed(() => {
    const runtimeFamily = FAMILY_RUNTIME[this.familyId()];
    if (!runtimeFamily) return null;
    const packs = this.store.enginePacks().filter((p) => p.family === runtimeFamily);
    if (packs.length === 0) return null;
    return {
      label: variantLabelOf(packs[0]!),
      installed: packs.some((p) => this.store.isEngineInstalled(p.id)),
    };
  });

  protected readonly runtimeMissing = computed(() => {
    const rt = this.runtime();
    if (rt) return !rt.installed;
    // A family that carries its own engine (whisper.cpp, audio.cpp): missing when none is installed.
    const engines = this.family()?.engines ?? [];
    return engines.length > 0 && !engines.some((e) => e.packs.some((p) => this.store.isEngineInstalled(p.id)));
  });

  /** The family is what new projects use for its function: saved, or picked by Automatic. */
  protected readonly usedHere = computed<{ auto: boolean } | null>(() => {
    const phase = this.phase();
    if (!phase) return null;
    const used = this.providers().map((p) => this.isUsed(p.id)).find((u) => u !== null);
    return used ? { auto: used === 'auto' } : null;
  });

  protected readonly modelsHeading = computed(() => {
    const engines = this.family()?.engines ?? [];
    return engines.length === 1
      ? this.translate.instant('settings.fn.models-for', { name: engines[0]!.label })
      : this.translate.instant('settings.fn.models');
  });

  /** 'chosen' when new projects use this provider by the user's choice, 'auto' when Automatic picked it. */
  protected isUsed(providerId: string): 'chosen' | 'auto' | null {
    const phase = this.phase();
    if (!phase) return null;
    if (this.store.effectiveProvider(phase) !== providerId) return null;
    return this.store.defaultFor(phase) ? 'chosen' : 'auto';
  }

  /** The provider that runs one engine of the family (VieNeu-TTS 3.8, whisper.cpp). */
  protected engineProvider(engine: EngineBuildGroup): SettingsProvider | undefined {
    const families = this.store.families();
    return this.providers().find((p) => familyOfProvider(p, families)?.providerId === engine.providerId);
  }

  protected engineNote(engine: EngineBuildGroup): string {
    const key = `settings.engine-notes.${engine.providerId}`;
    const text = this.translate.instant(key);
    return text === key ? '' : text;
  }

  protected providerNote(providerId: string): string {
    const key = `settings.provider-notes.${providerId}`;
    const text = this.translate.instant(key);
    return text === key ? '' : text;
  }

  /** A build is named by what it runs on, in the user's language. */
  protected accelLabel(pack: EnginePackInfo): string {
    const key = `settings.accel.${pack.accel}`;
    const text = this.translate.instant(key);
    return text === key ? pack.displayName : text;
  }

  protected modelLabel(pack: EnginePackInfo): string {
    return variantLabelOf(pack);
  }

  protected useForNewProjects(providerId: string): void {
    const phase = this.phase();
    if (phase) void this.store.setPhaseDefault(phase, providerId);
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { SettingsStore, type DefaultPhase, type SettingsProvider } from '../settings.store';

/**
 * An engine with nothing to download from Settings: a built-in one (Piper,
 * Argos), a cloud service (OpenAI, Claude, Gemini) or Ollama. Its name, what
 * it needs, whether it can run now and why not, and "Use for new projects".
 * A cloud engine without its key links to the key; the old page left the user
 * to find "Cloud API keys" further down by themselves.
 */
@Component({
  selector: 'vd-provider-row',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host(vd-provider-row) {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--vd-sp-2) var(--vd-sp-4);
      padding: var(--vd-sp-3) 0;
      border-top: 1px solid var(--vd-border);
    }
    .grow {
      flex: 1;
      min-width: 240px;
    }
  `,
  host: { '[attr.id]': "'provider-' + provider().id" },
  template: `
    @let p = provider();
    <div class="grow stack-sm">
      <div class="card-head">
        <strong>{{ store.providerLabel(p.id) }}</strong>
        @if (p.credentialService) {
          <span class="badge badge-info">{{ 'settings.fn.cloud' | translate }}</span>
        } @else {
          <span class="badge badge-pending">{{ 'settings.fn.on-this-computer' | translate }}</span>
        }
        @if (used(); as u) {
          <span class="badge badge-completed">{{ (u === 'auto' ? 'settings.fn.used-auto' : 'settings.fn.used') | translate }}</span>
        }
      </div>
      @if (note()) {
        <p class="hint">{{ note() }}</p>
      }
      @if (!p.available) {
        <p class="hint warn-text">
          {{ store.unavailableReason(p) }}
          @if (p.readinessStatus === 'cloud-key-missing' && p.credentialService) {
            · <a [routerLink]="['/settings', 'cloud']" [fragment]="'key-' + p.credentialService">{{ 'settings.fn.add-key' | translate }}</a>
          }
        </p>
      }
    </div>
    <div class="row-actions">
      <ng-content />
      @if (used() === null && p.available) {
        <button type="button" class="btn btn-sm" (click)="useForNewProjects()" [disabled]="store.defaultsSaving()">
          {{ 'settings.fn.use-for-new' | translate }}
        </button>
      }
    </div>
  `,
})
export class ProviderRowComponent {
  protected readonly store = inject(SettingsStore);
  private readonly translate = inject(TranslateService);

  readonly provider = input.required<SettingsProvider>();
  readonly phase = input.required<DefaultPhase>();

  protected readonly note = computed(() => {
    const key = `settings.provider-notes.${this.provider().id}`;
    const text = this.translate.instant(key);
    return text === key ? '' : text;
  });

  /** 'chosen' when new projects use it by the user's choice, 'auto' when Automatic picked it. */
  protected readonly used = computed<'chosen' | 'auto' | null>(() => {
    const phase = this.phase();
    if (this.store.effectiveProvider(phase) !== this.provider().id) return null;
    return this.store.defaultFor(phase) ? 'chosen' : 'auto';
  });

  protected useForNewProjects(): void {
    void this.store.setPhaseDefault(this.phase(), this.provider().id);
  }
}

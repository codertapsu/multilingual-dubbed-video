import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DubPreset } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import { toAppError } from '../../../core/state/project.store';
import { BrandKitComponent } from '../../../shared/branding/brand-kit.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Dubbing defaults: what a new dub starts from.
 *
 * There is no global "default subtitle style" or "default languages": those
 * are chosen per project in New project, and kept for the next videos as a
 * PRESET (wizard → "Save as preset"). So this page lists the presets — until
 * now visible only inside the wizard's preset menu — with what each one sets,
 * and holds the brand kit (logo & greeting) the single page had.
 */
@Component({
  selector: 'vd-settings-dubbing',
  standalone: true,
  imports: [RouterLink, TranslatePipe, BrandKitComponent],
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
    .presets {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .preset {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--vd-sp-2) var(--vd-sp-4);
      padding: var(--vd-sp-3) 0;
      border-top: 1px solid var(--vd-border);
    }
    .preset:first-child {
      border-top: 0;
    }
    .preset-name {
      font-weight: 600;
    }
    .preset .mono {
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <!-- ===================== Presets ===================== -->
    <div class="card stack" id="presets">
      <div class="stack-sm">
        <h3>{{ 'settings.dubbing.presets' | translate }}</h3>
        <p class="hint">{{ 'settings.dubbing.presets-hint' | translate }}</p>
      </div>
      @if (presets(); as list) {
        @if (list.length === 0) {
          <p class="hint">{{ 'settings.dubbing.presets-empty' | translate }}</p>
        } @else {
          <ul class="presets">
            @for (p of list; track p.id) {
              <li class="preset">
                <div class="stack-sm">
                  <span class="preset-name">{{ p.name }}</span>
                  <span class="hint">
                    {{ 'settings.dubbing.preset-languages' | translate: { from: p.sourceLanguage || ('settings.dubbing.detect' | translate), to: p.targetLanguage } }}
                    @if (p.settings.ttsProviderId) {
                      · {{ store.providerLabel(p.settings.ttsProviderId) }}
                    }
                    @if (p.start) {
                      · {{ 'settings.dubbing.preset-starts' | translate }}
                    }
                  </span>
                  @if (p.outputDir) {
                    <span class="hint">{{ 'settings.dubbing.preset-folder' | translate }} <span class="mono">{{ p.outputDir }}</span></span>
                  }
                </div>
                <button type="button" class="btn btn-ghost btn-sm" (click)="deletePreset(p)" [disabled]="busy()">
                  {{ 'wizard.preset-delete' | translate }}
                </button>
              </li>
            }
          </ul>
        }
        <div class="row-actions">
          <a routerLink="/new" class="btn btn-sm">{{ 'settings.dubbing.preset-new' | translate }}</a>
        </div>
      } @else {
        <p class="hint">{{ 'settings.defaults.unavailable' | translate }}</p>
      }
    </div>

    <!-- ===================== Logo & greeting (the brand kit) ===================== -->
    <div class="card stack" id="brand-kit">
      <div class="stack-sm">
        <h3>{{ 'settings.brand-kit-heading' | translate }}</h3>
        <p class="hint">{{ 'settings.brand-kit-intro' | translate }}</p>
      </div>
      <vd-brand-kit />
    </div>

    <!-- ===================== Series ===================== -->
    <div class="card stack-sm" id="series">
      <h3>{{ 'settings.dubbing.series' | translate }}</h3>
      <p class="hint">{{ 'settings.dubbing.series-hint' | translate }}</p>
      <div class="row-actions">
        <a routerLink="/settings/cloud" class="btn btn-sm">{{ 'settings.dubbing.series-cloud' | translate }}</a>
        <a routerLink="/settings/translation" fragment="family-gemma-chat" class="btn btn-ghost btn-sm">{{ 'settings.dubbing.series-local' | translate }}</a>
      </div>
    </div>
  `,
})
export class DubbingSectionComponent implements OnInit {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);

  /** null until loaded, or when the backend cannot be reached. */
  protected readonly presets = signal<DubPreset[] | null>(null);
  protected readonly busy = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.presets.set(await this.ipc.listPresets());
    } catch {
      this.presets.set(null);
    }
  }

  /** The wizard's delete, from here: same question, same call. */
  protected async deletePreset(preset: DubPreset): Promise<void> {
    if (this.busy()) return;
    const ok = await this.confirm.confirm({
      title: this.translate.instant('wizard.preset-delete-title', { name: preset.name }),
      message: this.translate.instant('wizard.preset-delete-body'),
      confirmLabel: this.translate.instant('wizard.preset-delete'),
    });
    if (!ok) return;
    this.busy.set(true);
    this.store.error.set(null);
    try {
      await this.ipc.deletePreset(preset.id);
      await this.load();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }
}

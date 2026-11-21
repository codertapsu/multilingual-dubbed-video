import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import type { EnginePackInfo } from '../../../core/models';
import { SettingsStore } from '../settings.store';

/**
 * One variant on a family card: a build of an engine (VieNeu-TTS 3.8 on the
 * processor, on an NVIDIA card) or a model (TranslateGemma 12B), with what it
 * costs, whether this computer runs it well, its state, and the one or two
 * buttons that move it on. The buttons and their logic are the old flat
 * engine list's; the facts that list buried in an English paragraph (size,
 * memory, graphics memory) are shown as facts.
 */
@Component({
  selector: 'vd-pack-row',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host(vd-pack-row) {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: var(--vd-sp-3);
      border: 1px solid var(--vd-border);
      border-radius: var(--vd-radius-sm);
      background: var(--vd-surface);
    }
    .variant-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--vd-sp-2);
    }
    .variant-name {
      font-weight: 600;
    }
    .facts {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--vd-sp-2);
    }
    p {
      margin: 0;
    }
  `,
  host: { '[attr.id]': "'pack-' + pack().id" },
  template: `
    @let p = pack();
    <div class="variant-head">
      <span class="variant-name">{{ label() }}</span>
      @if (store.isEngineRecommended(p.id)) {
        <span class="badge badge-info">{{ 'settings.engines.recommended' | translate }}</span>
      }
      @if (store.isEngineInstalled(p.id)) {
        <span class="badge badge-completed">{{ 'settings.engines.installed' | translate }}</span>
      }
      @if (store.isEngineActive(p)) {
        <span class="badge badge-running" [title]="'settings.engines.in-use-title' | translate">{{ 'settings.engines.in-use' | translate }}</span>
      }
      @if (store.isEngineUpdatable(p.id)) {
        <span class="badge badge-warning">{{ 'settings.engines.update-available' | translate }}</span>
      }
    </div>

    <div class="facts">
      <span class="chip">{{ 'settings.variant.download' | translate: { size: store.sizeLabel(p.approxSizeMb) } }}</span>
      @if (p.minVramMb) {
        <span class="chip">{{ 'settings.variant.needs-vram' | translate: { size: store.gbLabel(p.minVramMb) } }}</span>
      }
      @if (p.minRamMb) {
        <span class="chip">{{ 'settings.variant.needs-ram' | translate: { size: store.gbLabel(p.minRamMb) } }}</span>
      }
      @if (store.isEngineFit(p.id)) {
        <span class="hint test-ok">{{ 'settings.engines.fit-ok' | translate }}</span>
      } @else {
        <span class="hint warn-text">⚠ {{ store.engineFitHint(p) }}</span>
      }
    </div>

    @if (store.isEngineShadowed(p)) {
      <p class="hint">
        {{ 'settings.engines.shadowed' | translate: { name: store.activePackName(p) } }}
        @if (store.activeSelectionNote(p)) {
          {{ store.activeSelectionNote(p) }}
        }
        {{ 'settings.engines.shadowed-free' | translate }}
      </p>
    }

    @if (store.engineProgressFor(p.id); as prog) {
      <div class="install-progress" role="status" aria-live="polite">
        <span class="hint">{{ prog.message }}</span>
        @if (prog.percent !== null) {
          <progress [value]="prog.percent" max="100"></progress>
        } @else {
          <progress></progress>
        }
      </div>
    } @else {
      <div class="row-actions">
        @if (store.isEngineInstalled(p.id)) {
          @if (store.isEngineUpdatable(p.id)) {
            <button type="button" class="btn btn-sm" (click)="store.installEngine(p.id)" [title]="'settings.engines.update-title' | translate">
              {{ 'settings.engines.update' | translate }}
            </button>
          } @else {
            <button type="button" class="btn btn-ghost btn-sm" (click)="store.installEngine(p.id)" [title]="'settings.engines.reinstall-title' | translate">
              {{ 'settings.engines.reinstall' | translate }}
            </button>
          }
          <button type="button" class="btn btn-ghost btn-sm" (click)="store.uninstallEngine(p.id)">{{ 'settings.engines.remove' | translate }}</button>
          @if (store.isChoosableModel(p)) {
            @if (store.isEngineShadowed(p)) {
              <button type="button" class="btn btn-sm" (click)="store.chooseModel(p, true)" [title]="'settings.engines.use-this-title' | translate">
                {{ 'settings.engines.use-this' | translate }}
              </button>
            } @else if (store.isEngineActive(p) && store.isModelChosenByUser(p)) {
              <span class="hint">{{ 'settings.engines.chosen-by-you' | translate }}</span>
              <button type="button" class="btn btn-ghost btn-sm" (click)="store.chooseModel(p, false)">
                {{ 'settings.engines.use-automatic' | translate }}
              </button>
            }
          }
        } @else if (store.installBlocked(p)) {
          <button type="button" class="btn btn-sm" disabled [title]="'settings.engines.needs-uv-title' | translate">
            {{ 'settings.engines.install' | translate }}
          </button>
          <span class="hint test-fail">{{ 'settings.engines.uv-missing' | translate }}</span>
        } @else {
          <button type="button" class="btn btn-sm" [class.btn-primary]="store.isEngineRecommended(p.id)" (click)="store.installEngine(p.id)">
            {{ 'settings.variant.install' | translate: { size: store.sizeLabel(p.approxSizeMb) } }}
          </button>
        }
      </div>
    }

    <details class="more">
      <summary class="hint">{{ 'settings.variant.details' | translate }}</summary>
      <p class="hint">{{ p.displayName }}{{ p.version ? ' · ' + p.version : '' }}</p>
      <p class="hint">{{ p.description }}</p>
      @if (p.licenseNote) {
        <p class="hint">{{ 'settings.variant.licence' | translate }} {{ p.licenseNote }}</p>
      }
    </details>
  `,
})
export class PackRowComponent {
  protected readonly store = inject(SettingsStore);

  readonly pack = input.required<EnginePackInfo>();
  /** What the row is called on its card: the build ("NVIDIA graphics card") or the model ("12B"). */
  readonly label = input.required<string>();
}

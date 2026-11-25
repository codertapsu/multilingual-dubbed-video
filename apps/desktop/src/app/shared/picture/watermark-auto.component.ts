import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { WatermarkAutoSettings } from '@videodubber/shared';

import { TranslatePipe } from '../../core/i18n';

/**
 * "Find the watermark and blur it by itself" (settings.watermarkAuto), with
 * how to hide what is found: in New project and in the editor's Picture panel.
 * A series looks once while it is analysed; a single video when it renders
 * (said under the option, so the user knows when it happens and what to check).
 */
@Component({
  selector: 'vd-watermark-auto',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="check-row">
      <input
        type="checkbox"
        [ngModel]="!!value()"
        [ngModelOptions]="{ standalone: true }"
        (ngModelChange)="toggle($event)"
        [disabled]="disabled()"
      />
      <span>{{ 'picture.auto' | translate }}</span>
    </label>
    @if (value(); as v) {
      <label class="auto-mode">
        <span>{{ 'picture.auto-mode' | translate }}</span>
        <select [ngModel]="v.mode" [ngModelOptions]="{ standalone: true }" (ngModelChange)="setMode($event)" [disabled]="disabled()">
          <option value="blur">{{ 'picture.mode-blur' | translate }}</option>
          <option value="pixelate">{{ 'picture.mode-pixelate' | translate }}</option>
          <option value="delogo">{{ 'picture.mode-delogo' | translate }}</option>
        </select>
      </label>
    }
    <p class="hint muted">{{ (series() ? 'picture.auto-hint-series' : 'picture.auto-hint') | translate }}</p>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-1);
      }
      .auto-mode {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--vd-sp-2);
        font-size: 0.85rem;
      }
      .auto-mode select {
        width: auto;
        min-width: 10rem;
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
    `,
  ],
})
export class WatermarkAutoComponent {
  readonly value = input<WatermarkAutoSettings | undefined>(undefined);
  readonly disabled = input(false);
  /** A series: it looks once while the video is analysed, not at each render. */
  readonly series = input(false);
  readonly changed = output<WatermarkAutoSettings | undefined>();

  protected toggle(on: boolean): void {
    this.changed.emit(on ? { mode: this.value()?.mode ?? 'blur', ...(this.value()?.strength ? { strength: this.value()!.strength } : {}) } : undefined);
  }

  protected setMode(mode: WatermarkAutoSettings['mode']): void {
    this.changed.emit({ ...(this.value() ?? {}), mode });
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { defaultPartNameTemplate } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { PLACEHOLDER_PARAMS, exampleNames, templateProblemText } from './part-names';

/**
 * "Part names": the template a series' parts (and their finished files) are
 * named from, with a live example of the names it gives, worked out by the
 * same function the app names them with. Empty means the names parts always
 * had ("<name> - Phần 01"). New project's "Split into parts" and the
 * Download screen's "Dub" both show it.
 *
 * WHY: the 48 parts of the 27.8-hour series were renamed one by one to the
 * channel's pattern after they were made (claude-dubber report, 2026-11-23).
 */
@Component({
  selector: 'vd-part-name-field',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .pn-input {
      font-family: var(--vd-font-mono, monospace);
    }
    p {
      margin: 0;
    }
    .pn-example {
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <div class="stack-sm">
      <label class="stack-sm">
        <span class="label">{{ 'series.name-template' | translate }}</span>
        <input
          type="text"
          class="pn-input"
          [name]="fieldName()"
          maxlength="200"
          spellcheck="false"
          autocomplete="off"
          [ngModelOptions]="{ standalone: true }" [ngModel]="value()"
          (ngModelChange)="valueChange.emit($event)"
          [placeholder]="defaultTemplate()"
          [disabled]="disabled()"
        />
      </label>
      <p class="hint muted">{{ 'series.name-template-hint' | translate: placeholders }}</p>
      @if (problem(); as p) {
        <p class="hint warn-text" role="alert">{{ p.key | translate: p.params }}</p>
      }
      <p class="hint pn-example">{{ 'series.name-template-example' | translate: { first: examples()[0], second: examples()[1] } }}</p>
    </div>
  `,
})
export class PartNameFieldComponent {
  private readonly translate = inject(TranslateService);

  /** The template as typed ('' = the default names). */
  readonly value = input<string>('');
  readonly valueChange = output<string>();
  /** The series' name, for the example (the project's name, or the series it continues). */
  readonly seriesName = input<string>('');
  readonly targetLanguage = input<string>('vi');
  /** The first part's number (after the series it continues). */
  readonly firstNumber = input<number>(1);
  /** The total, when known. */
  readonly total = input<number | null>(null);
  readonly fieldName = input<string>('seriesNameTemplate');
  readonly disabled = input<boolean>(false);

  protected readonly placeholders = PLACEHOLDER_PARAMS;
  protected readonly defaultTemplate = computed(() => defaultPartNameTemplate(this.targetLanguage() || 'vi'));
  protected readonly problem = computed(() => templateProblemText(this.value()));
  protected readonly examples = computed(() => {
    this.translate.locale(); // the sample words follow the UI's language
    return exampleNames({
      template: this.value(),
      seriesName: this.seriesName().trim() || this.translate.instant('series.name-template-series-ph'),
      targetLanguage: this.targetLanguage(),
      firstNumber: this.firstNumber(),
      total: this.total(),
      sampleTitle: this.translate.instant('series.name-template-sample-title'),
    });
  });
}

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { DiagnosticsPanelComponent } from '../../../shared/diagnostics/diagnostics-panel.component';

/**
 * Settings → Diagnostics: the app's own health and evidence, and the support
 * bundle (Phase 7). The same panel as Help's, so the two never disagree.
 */
@Component({
  selector: 'vd-settings-diagnostics',
  standalone: true,
  imports: [RouterLink, TranslatePipe, DiagnosticsPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  template: `
    <div class="card stack" id="diagnostics">
      <div class="stack-sm">
        <h3>{{ 'diagnostics.heading' | translate }}</h3>
        <p class="hint">{{ 'diagnostics.intro' | translate }}</p>
      </div>
      <vd-diagnostics-panel />
    </div>
    <div class="card stack-sm">
      <p class="hint">
        {{ 'settings.diagnostics.help' | translate }}
        <a routerLink="/help">{{ 'nav.help' | translate }}</a>
      </p>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
    h3 {
      margin: 0;
    }
  `,
})
export class DiagnosticsSectionComponent {}

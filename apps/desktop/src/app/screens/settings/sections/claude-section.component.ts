import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { ClaudeConnectionsComponent } from '../../../shared/claude-connections/claude-connections.component';

/**
 * Settings → Claude: let Claude (Desktop or Code) drive VideoDubber over MCP.
 * The old page's "Claude (AI assistant)" card, moved. Translating WITH Claude
 * is a key or a plan on Cloud services & keys; this page says so.
 */
@Component({
  selector: 'vd-settings-claude',
  standalone: true,
  imports: [RouterLink, TranslatePipe, ClaudeConnectionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  template: `
    <div class="card stack" id="claude-connections">
      <p class="hint">{{ 'settings.claude.intro' | translate }}</p>
      <p class="hint">{{ 'settings.claude.privacy' | translate }}</p>
      <!-- Claude Desktop and Claude Code: status + the button that fixes it
           (shared with the guide, so the two always agree). -->
      <vd-claude-connections />
      <p class="hint">{{ 'settings.claude.try' | translate }}</p>
      <div class="row-actions">
        <a routerLink="/claude" class="btn btn-sm">{{ 'settings.claude.guide' | translate }}</a>
      </div>
    </div>
    <div class="card stack-sm">
      <p class="hint">
        {{ 'settings.claude-page.translate-with' | translate }}
        <a routerLink="/settings/cloud" fragment="key-anthropic">{{ 'settings.sections.cloud.title' | translate }}</a>
      </p>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
  `,
})
export class ClaudeSectionComponent {}

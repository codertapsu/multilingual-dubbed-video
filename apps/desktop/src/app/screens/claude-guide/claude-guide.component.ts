import { ChangeDetectionStrategy, Component, computed, inject, type OnInit } from '@angular/core';

import { ClaudeIntegrationService } from '../../core/claude/claude-integration.service';
import { CLAUDE_TIP_DISMISSED_KEY, MOTHER_CLAUDE_DOWNLOAD_URL } from '../../core/claude/claude-view';
import { TranslatePipe } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import { ClaudeConnectionsComponent } from '../../shared/claude-connections/claude-connections.component';

/**
 * "Use VideoDubber from Claude": from an installed VideoDubber to a Claude
 * session that dubs a video, step by step, with no terminal. Reached from
 * Settings → Claude, Help and a one-time tip on Home.
 *
 * Before this the only trace of the integration was a Settings card whose
 * Claude Code half was a command to paste into a terminal, and nothing told a
 * user that Mother Claude sessions get VideoDubber's tools once Claude Code is
 * connected. Mother Claude detection only decides what the guide says first;
 * every step stands without it.
 */
@Component({
  selector: 'vd-claude-guide',
  standalone: true,
  imports: [TranslatePipe, ClaudeConnectionsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-guide.component.html',
  styleUrl: './claude-guide.component.scss',
})
export class ClaudeGuideComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  protected readonly claude = inject(ClaudeIntegrationService);

  protected readonly motherClaude = computed(() => this.claude.status()?.motherClaude ?? null);

  /** Example requests, in the user's language (Claude answers in kind). */
  protected readonly examples = [
    'claude-guide.ask-dub',
    'claude-guide.ask-status',
    'claude-guide.ask-fix',
    'claude-guide.ask-revoice',
  ] as const;

  ngOnInit(): void {
    // Opening the guide is what Home's tip asks for: it need not ask again.
    try {
      localStorage.setItem(CLAUDE_TIP_DISMISSED_KEY, '1');
    } catch {
      /* storage unavailable: the tip may show again, harmlessly */
    }
  }

  protected downloadMotherClaude(): void {
    void this.ipc.openExternal(MOTHER_CLAUDE_DOWNLOAD_URL);
  }
}

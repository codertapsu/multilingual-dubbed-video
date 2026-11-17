import { ChangeDetectionStrategy, Component, HostListener, inject, signal, type OnInit } from '@angular/core';

import { ClaudeIntegrationService } from '../../core/claude/claude-integration.service';
import { CLAUDE_CODE_ACTION_LABELS, claudeCodeView } from '../../core/claude/claude-view';
import { TranslatePipe } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError } from '../../core/models';
import type { ClaudeCodeAction, ClaudeIntegration } from '../../core/models/setup';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

/** Claude Code's install guide (the "not found" state links to it). */
const CLAUDE_CODE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';

/**
 * Connect VideoDubber to Claude Desktop and Claude Code: each client's status
 * and the one button that fixes it. Settings → Claude and the "Use VideoDubber
 * from Claude" guide both show this, so the two can never disagree.
 *
 * Claude Code had only a command to copy into a terminal; it now has a status
 * and buttons too. Its buttons run Claude Code's own CLI in the orchestrator —
 * VideoDubber never writes Claude Code's files — and a failure shows the CLI's
 * own words. Claude Desktop's row is the one Settings always had.
 */
@Component({
  selector: 'vd-claude-connections',
  standalone: true,
  imports: [TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The rows Settings always had, with its styles (they were scoped to Settings).
  styles: `
    .cred-row {
      padding: 0.7rem 0;
      border-top: 1px solid var(--vd-border);
    }
    .cred-head {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    .cred-name {
      font-weight: 600;
    }
    .cred-controls {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .cred-controls .grow {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .test-ok {
      color: var(--vd-success);
    }
    .test-fail {
      color: var(--vd-danger);
    }
    details > summary {
      cursor: pointer;
    }
  `,
  template: `
    <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />
    @if (claude.status(); as c) {
      @if (!c.mcp) {
        <p class="hint test-fail">{{ 'settings.claude.no-server' | translate }}</p>
      } @else {
        <div class="cred-row stack-sm">
          <div class="cred-head">
            <span class="cred-name">Claude Desktop</span>
            @if (c.claudeDesktop.connected) {
              <span class="badge badge-completed">{{ 'settings.claude.connected' | translate }}</span>
            } @else if (c.claudeDesktop.installed) {
              <span class="badge">{{ 'settings.claude.not-connected' | translate }}</span>
            } @else {
              <span class="badge">{{ 'settings.claude.not-installed' | translate }}</span>
            }
          </div>
          <div class="cred-controls">
            @if (c.claudeDesktop.connected) {
              <button type="button" class="btn btn-ghost btn-sm" (click)="setDesktop(false)" [disabled]="busy() !== null">
                {{ 'settings.claude.disconnect' | translate }}
              </button>
            } @else {
              <button
                type="button"
                class="btn btn-sm"
                (click)="setDesktop(true)"
                [disabled]="busy() !== null || !c.claudeDesktop.installed || !c.claudeDesktop.configPath"
              >
                {{ 'settings.claude.connect' | translate }}
              </button>
            }
          </div>
          @if (desktopChanged()) {
            <p class="hint test-ok">{{ 'settings.claude.restart' | translate }}</p>
          }
        </div>

        @if (c.claudeCode; as code) {
          @let view = codeView(code);
          <div class="cred-row stack-sm">
            <div class="cred-head">
              <span class="cred-name">Claude Code</span>
              <span
                class="badge"
                [class.badge-completed]="view.badgeClass === 'badge-completed'"
                [class.badge-warning]="view.badgeClass === 'badge-warning'"
                >{{ view.badge | translate }}</span
              >
            </div>
            @switch (code.state) {
              @case ('other-copy') {
                <p class="hint">
                  {{ 'settings.claude.code.other-copy-hint' | translate: { path: code.registered?.command ?? '' } }}
                </p>
              }
              @case ('unreadable') {
                <p class="hint">{{ 'settings.claude.code.unreadable-hint' | translate: { detail: code.detail ?? code.configPath } }}</p>
              }
              @case ('cli-missing') {
                <p class="hint">{{ 'settings.claude.code.cli-missing-hint' | translate }}</p>
              }
            }
            @if (view.actions.length > 0 || code.state === 'cli-missing') {
              <div class="cred-controls">
                @for (action of view.actions; track action) {
                  <button
                    type="button"
                    class="btn btn-sm"
                    [class.btn-ghost]="action === 'disconnect'"
                    (click)="runCode(action)"
                    [disabled]="busy() !== null"
                  >
                    {{ (busy() === 'code' ? 'common.working' : actionLabels[action]) | translate }}
                  </button>
                }
                @if (code.state === 'cli-missing') {
                  <button type="button" class="btn btn-sm" (click)="openInstallPage()">
                    {{ 'settings.claude.code.install' | translate }}
                  </button>
                }
              </div>
            }
            @if (codeConnected() && code.state === 'connected') {
              <p class="hint test-ok">{{ 'settings.claude.code.connected-hint' | translate }}</p>
            }
            @if (view.commandOpen) {
              <div class="cred-controls">
                <code class="grow">{{ code.command }}</code>
                <button type="button" class="btn btn-sm" (click)="copy(code.command)">
                  {{ (copied() ? 'settings.claude.copied' : 'settings.claude.copy') | translate }}
                </button>
              </div>
            } @else {
              <details>
                <summary class="hint">{{ 'settings.claude.code.manual' | translate }}</summary>
                <div class="cred-controls">
                  <code class="grow">{{ code.command }}</code>
                  <button type="button" class="btn btn-sm" (click)="copy(code.command)">
                    {{ (copied() ? 'settings.claude.copied' : 'settings.claude.copy') | translate }}
                  </button>
                </div>
              </details>
            }
          </div>
        }
      }
    } @else if (claude.unavailable()) {
      <p class="hint">{{ 'settings.defaults.unavailable' | translate }}</p>
    }
  `,
})
export class ClaudeConnectionsComponent implements OnInit {
  protected readonly claude = inject(ClaudeIntegrationService);
  private readonly ipc = inject(IpcService);

  protected readonly actionLabels = CLAUDE_CODE_ACTION_LABELS;
  protected readonly busy = signal<'desktop' | 'code' | null>(null);
  protected readonly error = signal<AppError | null>(null);
  /** Claude Desktop reads its config only at start: say so after a change. */
  protected readonly desktopChanged = signal(false);
  /** Set after a successful connect/reconnect: only NEW sessions get the tools. */
  protected readonly codeConnected = signal(false);
  protected readonly copied = signal(false);

  ngOnInit(): void {
    void this.claude.refresh();
  }

  /**
   * Re-read when the window comes back to the front: the usual way to change
   * these connections outside the app is a terminal (`claude mcp …`) or Claude
   * Desktop's own settings, and the row kept showing the state from before.
   */
  @HostListener('window:focus')
  protected onWindowFocus(): void {
    if (this.busy() === null) void this.claude.refresh();
  }

  protected codeView(code: NonNullable<ClaudeIntegration['claudeCode']>) {
    return claudeCodeView(code.state, code.cli !== null);
  }

  protected async setDesktop(connect: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set('desktop');
    this.error.set(null);
    try {
      await this.claude.setDesktop(connect);
      this.desktopChanged.set(true);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async runCode(action: ClaudeCodeAction): Promise<void> {
    if (this.busy()) return;
    this.busy.set('code');
    this.error.set(null);
    try {
      await this.claude.setCode(action);
      this.codeConnected.set(action !== 'disconnect');
    } catch (err) {
      this.error.set(toAppError(err));
      // The CLI may have done half (removed, then failed to add): show what is true now.
      await this.claude.refresh();
    } finally {
      this.busy.set(null);
    }
  }

  protected openInstallPage(): void {
    void this.ipc.openExternal(CLAUDE_CODE_INSTALL_URL);
  }

  protected async copy(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      // No clipboard access: the command is on screen and selectable.
    }
  }
}

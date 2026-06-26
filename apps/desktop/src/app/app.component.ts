import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { IpcService } from './core/ipc/ipc.service';
import { ConfirmDialogComponent } from './shared/confirm-dialog/confirm-dialog.component';

/**
 * Root shell: a slim top nav + a routed outlet. The whole app lives inside a
 * single window so navigation is lightweight. A "mode" tag indicates whether
 * we're running inside the Tauri desktop shell or in a plain browser dev
 * session (HTTP fallback to the orchestrator).
 */
@Component({
  selector: 'vd-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConfirmDialogComponent],
  template: `
    <header class="topnav">
      <a class="brand" routerLink="/" aria-label="VideoDubber home">
        <img class="brand-mark" src="assets/brand-icon.png" alt="" aria-hidden="true" />
        <span class="brand-name">VideoDubber</span>
      </a>

      <nav class="nav-links" aria-label="Primary">
        <a
          routerLink="/"
          routerLinkActive="active"
          [routerLinkActiveOptions]="{ exact: true }"
          >Projects</a
        >
        <a routerLink="/new" routerLinkActive="active">New project</a>
        <a routerLink="/settings" routerLinkActive="active">Settings</a>
        <a routerLink="/support" routerLinkActive="active">♥ Support</a>
      </nav>

      <span class="mode-tag" [class.local]="!ipc.inTauri" [title]="modeTooltip">
        {{ ipc.inTauri ? 'Desktop' : 'Browser dev' }}
      </span>
    </header>

    <main class="app-main">
      <router-outlet />
    </main>

    <vd-confirm-dialog />
  `,
  styles: [
    `
      .topnav {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-5);
        padding: var(--vd-sp-3) var(--vd-sp-5);
        background: var(--vd-surface);
        border-bottom: 1px solid var(--vd-border);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-2);
        font-weight: 700;
        color: var(--vd-text);
        text-decoration: none;
      }
      .brand-mark {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        display: block;
      }
      .nav-links {
        display: flex;
        gap: var(--vd-sp-2);
        flex: 1;
      }
      .nav-links a {
        color: var(--vd-text-muted);
        padding: var(--vd-sp-1) var(--vd-sp-3);
        border-radius: var(--vd-radius-sm);
        font-weight: 550;
      }
      .nav-links a:hover {
        background: var(--vd-surface-2);
        text-decoration: none;
      }
      .nav-links a.active {
        color: var(--vd-primary);
        background: var(--vd-info-bg);
      }
      .mode-tag {
        font-size: 0.75rem;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--vd-success-bg);
        color: var(--vd-success);
        border: 1px solid transparent;
      }
      .mode-tag.local {
        background: var(--vd-warning-bg);
        color: var(--vd-warning);
      }
      .app-main {
        display: block;
      }
    `,
  ],
})
export class AppComponent {
  protected readonly ipc = inject(IpcService);

  protected readonly modeTooltip = this.ipc.inTauri
    ? 'Running inside the Tauri desktop shell. Commands use native IPC.'
    : 'Running in a browser dev session. Commands fall back to HTTP against the orchestrator (port 5100).';
}

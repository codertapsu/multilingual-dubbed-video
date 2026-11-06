import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { IpcService } from './core/ipc/ipc.service';
import { ConfirmDialogComponent } from './shared/confirm-dialog/confirm-dialog.component';
import { UpdateNoticeComponent } from './shared/update-notice/update-notice.component';
import { TranslatePipe, TranslateService } from './core/i18n';
import { ThemeService, type ThemePreference } from './core/theme/theme.service';

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConfirmDialogComponent, UpdateNoticeComponent, TranslatePipe],
  template: `
    <header class="topnav">
      <a class="brand" routerLink="/" [attr.aria-label]="'nav.home-aria' | translate">
        <img class="brand-mark" src="assets/brand-icon.png" alt="" aria-hidden="true" />
        <span class="brand-name">VideoDubber</span>
      </a>

      <nav class="nav-links" [attr.aria-label]="'nav.primary' | translate">
        <a
          routerLink="/"
          routerLinkActive="active"
          [routerLinkActiveOptions]="{ exact: true }"
          >{{ 'nav.projects' | translate }}</a
        >
        <a routerLink="/new" routerLinkActive="active">{{ 'nav.new-project' | translate }}</a>
        <a routerLink="/download" routerLinkActive="active">{{ 'nav.download' | translate }}</a>
        <a routerLink="/settings" routerLinkActive="active">{{ 'nav.settings' | translate }}</a>
        <!-- Help sits BEFORE the sponsor link: a stuck user scans the nav for
             somewhere to go, and until this existed the nearest thing was a
             donation page. -->
        <a routerLink="/help" routerLinkActive="active">{{ 'nav.help' | translate }}</a>
        <a routerLink="/support" routerLinkActive="active">{{ 'nav.support' | translate }}</a>
      </nav>

      <button
        type="button"
        class="icon-btn theme-toggle"
        (click)="theme.cycle()"
        [title]="themeKeys[theme.preference()] | translate"
        [attr.aria-label]="themeKeys[theme.preference()] | translate"
      >
        @switch (theme.preference()) {
          @case ('light') {
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          }
          @case ('dark') {
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          }
          @default {
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
          }
        }
      </button>

      <span class="mode-tag" [class.local]="!ipc.inTauri" [title]="modeTooltip()">
        {{ (ipc.inTauri ? 'shell.mode-desktop' : 'shell.mode-browser') | translate }}
      </span>
    </header>

    <vd-update-notice />

    @if (ipc.backendDown()) {
      <!--
        The backend never came up. Requests already wait ~60s for it (the
        sidecar has to start a ~100 MB binary, which antivirus scans on the
        first run after an install or update), so reaching here means waiting
        longer will not help — but restarting reliably does, because the binary
        is warm the second time. Offer the button rather than instructions.
      -->
      <div class="backend-down" role="alert" aria-live="assertive">
        <div>
          <strong>{{ 'shell.backend-down-title' | translate }}</strong>
          <span>
            {{ 'shell.backend-down-body' | translate }}
            @if (ipc.inTauri) {
              {{ 'shell.backend-down-tauri' | translate }}
            } @else {
              {{ 'shell.backend-down-dev' | translate }}
            }
          </span>
        </div>
        <div class="row">
          <!-- The one moment a diagnostic is worth most is the one where no
               screen can load one, so point at Help from here too. -->
          <a routerLink="/help" class="btn">{{ 'shell.backend-down-help' | translate }}</a>
          @if (ipc.inTauri) {
            <button type="button" class="btn" (click)="restart()" [disabled]="restarting()">
              {{ (restarting() ? 'shell.restarting' : 'shell.restart') | translate }}
            </button>
          }
        </div>
      </div>
    }

    <main class="app-main">
      <router-outlet />
    </main>

    <vd-confirm-dialog />
  `,
  styles: [
    `
      .backend-down {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--vd-sp-4);
        padding: var(--vd-sp-3) var(--vd-sp-5);
        background: var(--vd-danger-bg);
        border-bottom: 1px solid var(--vd-danger);
        font-size: 0.92rem;
      }
      .backend-down span {
        opacity: 0.85;
        margin-left: var(--vd-sp-2);
      }
      /* The Help link renders as a button here; keep the global anchor
         hover-underline off it so the two controls match. */
      .backend-down a.btn:hover {
        text-decoration: none;
      }

      .topnav {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-5);
        padding: var(--vd-sp-3) var(--vd-sp-5);
        background: var(--vd-surface);
        border-bottom: 1px solid var(--vd-border);
        flex: none;
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
      /* A column that fills the window below the nav: ordinary screens stack
         their .page inside it, and the studio editor takes the full height. */
      .app-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: auto;
      }
    `,
  ],
})
export class AppComponent {
  protected readonly restarting = signal(false);

  /** Relaunch the app so the backend gets a second, warm start. */
  protected async restart(): Promise<void> {
    this.restarting.set(true);
    try {
      await this.ipc.restartApp();
    } catch {
      // restart_app diverges on success, so reaching here means it failed —
      // leave the notice up and let the user quit manually.
      this.restarting.set(false);
    }
  }

  protected readonly ipc = inject(IpcService);
  protected readonly theme = inject(ThemeService);
  protected readonly themeKeys: Record<ThemePreference, string> = {
    system: 'shell.theme-system',
    light: 'shell.theme-light',
    dark: 'shell.theme-dark',
  };
  private readonly translate = inject(TranslateService);

  /**
   * `computed`, not a plain field: `TranslateService.instant` reads the active
   * locale signal, so resolving it once at construction would freeze the
   * tooltip in whatever language was active at bootstrap. AppComponent is the
   * root and is never re-created, so a Settings language switch would have left
   * this one string behind for the rest of the session — which is exactly the
   * bug the app-wide switch was written to avoid.
   */
  protected readonly modeTooltip = computed(() =>
    this.translate.instant(
      this.ipc.inTauri ? 'shell.mode-desktop-tooltip' : 'shell.mode-browser-tooltip',
    ),
  );
}

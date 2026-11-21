import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LOCALE_LABELS, SUPPORTED_LOCALES, TranslatePipe, TranslateService, type SupportedLocale } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { ProjectsFolderInfo } from '../../../core/models';
import type { UpdateInfo } from '../../../core/models/setup';
import { toAppError } from '../../../core/state/project.store';
import { ThemeService, type ThemePreference } from '../../../core/theme/theme.service';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SettingsStore } from '../settings.store';

/** Outcome of the most recent "Check for updates" action. */
type CheckOutcome = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';

/**
 * Settings → General: the app's language and look, where the projects live,
 * updates, and about. The projects-folder and update logic is the old page's,
 * moved; the theme was only the top bar's unexplained icon.
 */
@Component({
  selector: 'vd-settings-general',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BusyIndicatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './general-section.component.html',
  styleUrls: ['../settings-shared.scss', './general-section.component.scss'],
})
export class GeneralSectionComponent implements OnInit, OnDestroy {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirmSvc = inject(ConfirmService);
  protected readonly theme = inject(ThemeService);

  protected readonly inTauri = this.ipc.inTauri;

  /** Language picker. Vietnamese is the default — see DEFAULT_LOCALE. */
  protected readonly supportedLocales = SUPPORTED_LOCALES;
  protected readonly localeLabels = LOCALE_LABELS;
  protected readonly locale = this.translate.locale;

  protected readonly themes: readonly { id: ThemePreference; label: string }[] = [
    { id: 'system', label: 'settings.general.theme-system' },
    { id: 'light', label: 'settings.general.theme-light' },
    { id: 'dark', label: 'settings.general.theme-dark' },
  ];

  // -------- projects folder (where the projects live) --------
  protected readonly projectsFolder = signal<ProjectsFolderInfo | null>(null);
  protected readonly projectsFolderBusy = signal(false);
  /** The folder typed in the browser, where there is no native folder dialog. */
  protected readonly projectsFolderInput = signal('');
  private projectsFolderTimer: ReturnType<typeof setTimeout> | null = null;

  // -------- update check / install --------
  protected readonly checkOutcome = signal<CheckOutcome>('idle');
  protected readonly updateInfo = signal<UpdateInfo | null>(null);
  protected readonly installing = signal(false);
  /** Installed app version (network-free, via get_app_version in Tauri). */
  protected readonly appVersion = signal<string | null>(null);
  protected readonly updateAvailable = computed(() => this.updateInfo()?.available === true);

  ngOnInit(): void {
    void this.loadVersion();
    void this.loadProjectsFolder();
  }

  ngOnDestroy(): void {
    if (this.projectsFolderTimer) clearTimeout(this.projectsFolderTimer);
  }

  /** Switch the app language. Applies immediately; no reload needed. */
  protected setLocale(next: SupportedLocale): void {
    this.translate.use(next);
  }

  // ----------------------------- projects folder -----------------------------
  //
  // The projects live in <folder>/projects, VideoDubber's own data folder by
  // default; choosing another moves them all there, structure unchanged
  // (orchestrator ProjectsFolderService), in the background with progress.

  private async loadProjectsFolder(): Promise<void> {
    try {
      const info = await this.ipc.getProjectsFolder();
      this.projectsFolder.set(info);
      if (!this.projectsFolderInput()) this.projectsFolderInput.set(info.root);
      if (info.moving) this.followProjectsMove();
    } catch {
      this.projectsFolder.set(null);
    }
  }

  /** Where a finished video lands, as an example of the structure. */
  protected projectsFolderExample(info: ProjectsFolderInfo): string {
    const sep = info.projectsDir.includes('\\') ? '\\' : '/';
    return [info.projectsDir, 'proj_…', 'render', 'output.mp4'].join(sep);
  }

  /** The native folder dialog (the desktop app); the browser types the folder instead. */
  protected async chooseProjectsFolder(): Promise<void> {
    const current = this.projectsFolder();
    const picked = await this.ipc.pickFolder(this.translate.instant('settings.projects-folder.pick-title'), current?.root);
    if (picked) await this.moveProjectsTo(picked);
  }

  protected async moveProjectsTo(root: string | null): Promise<void> {
    const info = this.projectsFolder();
    if (!info || this.projectsFolderBusy()) return;
    const target = root?.trim() || info.defaultRoot;
    const sep = target.includes('\\') ? '\\' : '/';
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('settings.projects-folder.confirm-title'),
      message: this.translate.instant('settings.projects-folder.confirm-body', {
        count: info.projectCount,
        folder: `${target.replace(/[\\/]+$/, '')}${sep}projects`,
      }),
      confirmLabel: this.translate.instant('settings.projects-folder.confirm-move'),
      // A move loses nothing: not the red of a delete.
      danger: false,
    });
    if (!ok) return;
    this.projectsFolderBusy.set(true);
    this.store.error.set(null);
    try {
      const next = await this.ipc.moveProjectsFolder(root?.trim() ? root.trim() : null);
      this.projectsFolder.set(next);
      if (next.moving) this.followProjectsMove();
      else this.projectsFolderInput.set(next.root);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.projectsFolderBusy.set(false);
    }
  }

  /** Follow a move until it ends, then show where the projects are now. */
  private followProjectsMove(): void {
    if (this.projectsFolderTimer) clearTimeout(this.projectsFolderTimer);
    this.projectsFolderTimer = setTimeout(() => {
      this.projectsFolderTimer = null;
      void this.ipc
        .getProjectsFolder()
        .then((info) => {
          this.projectsFolder.set(info);
          if (info.moving) this.followProjectsMove();
          else this.projectsFolderInput.set(info.root);
        })
        .catch(() => this.followProjectsMove());
    }, 700);
  }

  protected async openProjectsFolder(): Promise<void> {
    const dir = this.projectsFolder()?.projectsDir;
    if (!dir) return;
    this.store.error.set(null);
    try {
      await this.ipc.openManagedFolder(dir);
    } catch (err) {
      this.store.error.set(toAppError(err));
    }
  }

  // ----------------------------- version + updates -----------------------------

  private async loadVersion(): Promise<void> {
    try {
      this.appVersion.set(await this.ipc.getAppVersion());
    } catch {
      // Non-fatal — leave the version blank rather than showing an error.
    }
  }

  protected async check(): Promise<void> {
    if (this.checkOutcome() === 'checking') return;
    this.checkOutcome.set('checking');
    this.store.error.set(null);
    try {
      const info = await this.ipc.checkForUpdate();
      this.updateInfo.set(info);
      this.checkOutcome.set(info.available ? 'available' : 'up-to-date');
    } catch (err) {
      this.checkOutcome.set('error');
      this.store.error.set(toAppError(err));
    }
  }

  protected async installUpdate(): Promise<void> {
    if (this.installing() || !this.updateAvailable()) return;
    this.installing.set(true);
    this.store.error.set(null);
    try {
      // On success the app relaunches; this promise typically never resolves in
      // the running window. We still clear `installing` for the edge case where
      // install completes without an immediate relaunch.
      const res = await this.ipc.downloadAndInstallUpdate();
      if (!res.ok) {
        this.installing.set(false);
      }
    } catch (err) {
      this.installing.set(false);
      this.store.error.set(toAppError(err));
    }
  }

  protected async openReleaseNotes(): Promise<void> {
    const info = this.updateInfo();
    if (!info?.version) return;
    // Best-effort: link to the GitHub releases page for the new tag.
    await this.ipc.openExternal(`https://github.com/codertapsu/multilingual-dubbed-video/releases/tag/v${info.version}`);
  }
}

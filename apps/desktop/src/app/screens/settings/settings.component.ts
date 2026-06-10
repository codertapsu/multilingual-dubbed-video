import type { OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { IpcService } from '../../core/ipc/ipc.service';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import type { AppError } from '../../core/models';
import type { UpdateInfo } from '../../core/models/setup';

/** Outcome of the most recent "Check for updates" action. */
type CheckOutcome = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';

/**
 * SettingsComponent (route "settings").
 *
 * Auto-update controls backed by tauri-plugin-updater + the orchestrator's
 * `/preferences` endpoint:
 *  - "Automatically install updates" toggle (get/setUpdatePreference).
 *  - "Check for updates now" (checkForUpdate -> version + notes or "up to date").
 *  - "Download & install update" (downloadAndInstallUpdate -> relaunch).
 *
 * Outside Tauri (browser dev) the update controls are disabled with an
 * explanatory note; the auto-update preference still round-trips through the
 * orchestrator so the choice persists.
 */
@Component({
  selector: 'vd-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private readonly ipc = inject(IpcService);

  protected readonly inTauri = this.ipc.inTauri;

  protected readonly error = signal<AppError | null>(null);

  // -------- auto-update preference --------
  protected readonly autoUpdate = signal<boolean>(true);
  protected readonly prefLoading = signal(false);
  protected readonly prefSaving = signal(false);

  // -------- update check / install --------
  protected readonly checkOutcome = signal<CheckOutcome>('idle');
  protected readonly updateInfo = signal<UpdateInfo | null>(null);
  protected readonly installing = signal(false);

  /** Installed app version (network-free, via get_app_version in Tauri). */
  protected readonly appVersion = signal<string | null>(null);

  protected readonly updateAvailable = computed(
    () => this.updateInfo()?.available === true,
  );

  ngOnInit(): void {
    void this.loadPreference();
    // Show the installed version without a network call. We deliberately do NOT
    // auto-check for updates here: a fresh install (or an unreachable/placeholder
    // updater endpoint) must not greet the user with an error. Checking is an
    // explicit action via the "Check for updates" button.
    void this.loadVersion();
  }

  private async loadVersion(): Promise<void> {
    try {
      this.appVersion.set(await this.ipc.getAppVersion());
    } catch {
      // Non-fatal — leave the version blank rather than showing an error.
    }
  }

  // ----------------------------- preference -----------------------------

  private async loadPreference(): Promise<void> {
    this.prefLoading.set(true);
    try {
      const pref = await this.ipc.getUpdatePreference();
      this.autoUpdate.set(pref.autoUpdate);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.prefLoading.set(false);
    }
  }

  protected async toggleAutoUpdate(value: boolean): Promise<void> {
    if (this.prefSaving()) return;
    const previous = this.autoUpdate();
    this.autoUpdate.set(value); // optimistic
    this.prefSaving.set(true);
    this.error.set(null);
    try {
      await this.ipc.setUpdatePreference({ autoUpdate: value });
    } catch (err) {
      this.autoUpdate.set(previous); // roll back on failure
      this.error.set(toAppError(err));
    } finally {
      this.prefSaving.set(false);
    }
  }

  // ----------------------------- update check -----------------------------

  protected async check(): Promise<void> {
    if (this.checkOutcome() === 'checking') return;
    this.checkOutcome.set('checking');
    this.error.set(null);
    try {
      const info = await this.ipc.checkForUpdate();
      this.updateInfo.set(info);
      this.checkOutcome.set(info.available ? 'available' : 'up-to-date');
    } catch (err) {
      this.checkOutcome.set('error');
      this.error.set(toAppError(err));
    }
  }

  protected async installUpdate(): Promise<void> {
    if (this.installing() || !this.updateAvailable()) return;
    this.installing.set(true);
    this.error.set(null);
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
      this.error.set(toAppError(err));
    }
  }

  // ----------------------------- helpers -----------------------------

  protected async openReleaseNotes(): Promise<void> {
    const info = this.updateInfo();
    if (!info?.version) return;
    // Best-effort: link to the GitHub releases page for the new tag.
    await this.ipc.openExternal(
      `https://github.com/OWNER/REPO/releases/tag/v${info.version}`,
    );
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}

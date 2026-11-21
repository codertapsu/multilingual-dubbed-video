import { Injectable, computed, inject, signal } from '@angular/core';

import { IpcService } from '../ipc/ipc.service';
import type { AppError } from '../models';
import type { UpdateOutcome, UpdateStatus } from '../models/setup';
import { toAppError } from '../state/project.store';

/** Every release, with its installers: offered when an update cannot finish. */
export const RELEASES_URL = 'https://github.com/codertapsu/multilingual-dubbed-video/releases/latest';

const IDLE: UpdateStatus = {
  phase: 'idle',
  version: null,
  downloaded: 0,
  total: null,
  bytesPerSecond: null,
  error: null,
  auto: false,
};

/** Whole percent of a download, or null while the size is unknown. */
export function downloadPercent(status: Pick<UpdateStatus, 'downloaded' | 'total'>): number | null {
  if (!status.total || status.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((status.downloaded * 100) / status.total)));
}

/** `84.2 MB` in the reader's own number format (`84,2 MB` in Vietnamese). */
export function formatMegabytes(bytes: number, locale: string): string {
  const mb = bytes / 1_000_000;
  const digits = mb >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(mb)} MB`;
}

/**
 * The app update, one per app: its download, its install, and what the last
 * attempt came to.
 *
 * Before this, each screen awaited `download_and_install_update` behind an
 * indeterminate spinner. The 0.16.1 -> 0.17.0 update downloaded ~280 MB that
 * way, stalled with nothing on screen to say so, and the user, after closing
 * and reopening the app twice, uninstalled it and installed the new version by
 * hand. The shell now reports the download (src-tauri update.rs), and this
 * service is where every screen reads it: the update dialog, the strip of a
 * background update and Settings → General show the same bar, the same Cancel,
 * and on a failure the same Try again and installer link.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly ipc = inject(IpcService);

  readonly status = signal<UpdateStatus>(IDLE);
  /** What the last update attempt came to, shown once at launch. */
  readonly outcome = signal<UpdateOutcome | null>(null);
  /** Why the last install request stopped (a dub running, no connection…). */
  readonly error = signal<AppError | null>(null);

  readonly percent = computed(() => downloadPercent(this.status()));
  /** Downloading or installing: the Install buttons wait. */
  readonly busy = computed(() => {
    const phase = this.status().phase;
    return phase === 'downloading' || phase === 'installing';
  });

  private started = false;

  /** Follow the shell's update status; read what the last attempt came to. */
  async start(): Promise<void> {
    if (this.started || !this.ipc.inTauri) return;
    this.started = true;
    try {
      await this.ipc.onUpdateStatus((s) => this.status.set(s));
    } catch {
      /* a shell without the event: the reads below and after each request still work */
    }
    await this.refresh();
    try {
      this.outcome.set(await this.ipc.takeUpdateOutcome());
    } catch {
      /* an older shell without the command */
    }
  }

  /**
   * Download and install. Resolves when it did not install (the app closes
   * when it does): after a cancel, a failure, or a dub that started meanwhile.
   */
  async install(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    // Answered at once; the first progress report can take a second.
    this.status.update((s) => ({ ...s, phase: 'downloading', downloaded: 0, total: null, bytesPerSecond: null, error: null }));
    try {
      await this.ipc.downloadAndInstallUpdate();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      await this.refresh();
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.ipc.cancelUpdate();
    } catch {
      /* the download ended meanwhile: its own status says how */
    }
  }

  openReleases(): void {
    void this.ipc.openExternal(RELEASES_URL);
  }

  dismissOutcome(): void {
    this.outcome.set(null);
  }

  private async refresh(): Promise<void> {
    try {
      this.status.set(await this.ipc.updateStatus());
    } catch {
      // No status from the shell (an older one): never leave a bar running
      // for a request that has already ended.
      if (this.status().phase === 'downloading') this.status.set(IDLE);
    }
  }
}

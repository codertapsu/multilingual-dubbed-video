import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { StorageInfo } from '../../../core/models';
import { toAppError } from '../../../core/state/project.store';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Storage: what VideoDubber's downloads take on disk and the
 * buttons that free it. The old page's "Storage" card, moved.
 */
@Component({
  selector: 'vd-settings-storage',
  standalone: true,
  imports: [TranslatePipe, BusyIndicatorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
    h3 {
      margin: 0;
    }
    .usage {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--vd-sp-3);
      padding: var(--vd-sp-2) 0;
      border-top: 1px solid var(--vd-border);
    }
    .usage:first-child {
      border-top: 0;
    }
    .mono {
      overflow-wrap: anywhere;
    }
  `,
  template: `
    @if (storage(); as s) {
      <div class="card stack" id="storage">
        <div>
          @for (loc of s.locations; track loc.key) {
            <div class="usage">
              <span>{{ 'storage-loc.' + loc.key | translate }}</span>
              <span class="chip">{{ formatBytes(loc.bytes) }}</span>
            </div>
          }
          <div class="usage">
            <strong>{{ 'settings.storage.total' | translate }}</strong>
            <span class="chip">{{ formatBytes(s.totalBytes) }}</span>
          </div>
        </div>
        @if (s.freeBytes !== null) {
          <p class="hint">{{ 'settings.storage.free' | translate: { size: formatBytes(s.freeBytes) } }}</p>
        }
        <p class="hint">{{ 'settings.storage.intro' | translate }}</p>

        @if (storageMessage(); as msg) {
          <p class="hint test-ok" role="status">✓ {{ msg }}</p>
        }

        <div class="row-actions">
          <button type="button" class="btn btn-ghost btn-sm" (click)="openStorageFolder()">
            {{ store.openFolderLabel() }}
          </button>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            (click)="clearStorage()"
            [disabled]="storageClearing() || s.totalBytes === 0"
          >
            {{ (storageClearing() ? 'settings.storage.deleting' : 'settings.storage.delete') | translate }}
          </button>
          <vd-busy-indicator [active]="storageClearing()" [label]="'settings.storage.deleting-label' | translate" />
        </div>
      </div>

      <!-- Downloaded videos are the user's own files: listed apart, never in "delete everything". -->
      @if (s.downloads; as dl) {
        <div class="card stack-sm" id="downloaded-videos">
          <div class="usage">
            <h3>{{ 'settings.storage.downloads' | translate }}</h3>
            <span class="chip">{{ formatBytes(dl.bytes) }}</span>
          </div>
          <span class="hint mono">{{ dl.path }}</span>
          <p class="hint">{{ 'settings.storage.downloads-hint' | translate }}</p>
          <div class="row-actions">
            <button type="button" class="btn btn-ghost btn-sm" (click)="clearDownloads()" [disabled]="storageClearing() || dl.bytes === 0">
              {{ 'settings.storage.downloads-delete' | translate }}
            </button>
          </div>
        </div>
      }
    } @else if (storageLoading()) {
      <div class="card"><p class="hint">{{ 'settings.storage.calculating' | translate }}</p></div>
    } @else {
      <div class="card"><p class="hint">{{ 'settings.storage.unavailable' | translate }}</p></div>
    }
  `,
})
export class StorageSectionComponent implements OnInit {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirmSvc = inject(ConfirmService);

  protected readonly storage = signal<StorageInfo | null>(null);
  protected readonly storageLoading = signal(false);
  protected readonly storageClearing = signal(false);
  /** Last "freed N" message after a successful clear. */
  protected readonly storageMessage = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadStorage();
  }

  private async loadStorage(): Promise<void> {
    this.storageLoading.set(true);
    try {
      this.storage.set(await this.ipc.getStorage());
    } catch {
      // Non-fatal — leave the panel empty rather than blanking Settings.
    } finally {
      this.storageLoading.set(false);
    }
  }

  /** Human file size (decimal, matching the engine-pack size chips). */
  protected formatBytes(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const gb = bytes / 1e9;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / 1e6;
    if (mb >= 1) return `${mb.toFixed(0)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  protected async openStorageFolder(): Promise<void> {
    const root = this.storage()?.root;
    if (!root) return;
    this.store.error.set(null);
    try {
      await this.ipc.openManagedFolder(root);
    } catch (err) {
      this.store.error.set(toAppError(err));
    }
  }

  /** Delete all downloaded engine packs, models, and caches (with confirm), then refresh. */
  protected async clearStorage(): Promise<void> {
    if (this.storageClearing()) return;
    const s = this.storage();
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.clear-storage-title'),
      message: this.translate.instant('confirm.clear-storage-body', {
        packs: s?.installedEnginePacks ?? 0,
        size: s ? ` (${this.formatBytes(s.totalBytes)})` : '',
      }),
      confirmLabel: this.translate.instant('confirm.delete-everything'),
    });
    if (!ok) return;
    this.storageClearing.set(true);
    this.storageMessage.set(null);
    this.store.error.set(null);
    try {
      const res = await this.ipc.clearStorage();
      this.storageMessage.set(this.translate.instant('settings.storage.freed', { size: this.formatBytes(res.freedBytes) }));
      // Refresh everything the wipe affected.
      await Promise.all([this.loadStorage(), this.store.loadEngines(), this.store.loadProcessingSetup()]);
      void this.store.loadEffective();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.storageClearing.set(false);
    }
  }

  /** Delete the finished downloads and their videos (with confirm), then refresh. */
  protected async clearDownloads(): Promise<void> {
    if (this.storageClearing()) return;
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.clear-downloads-title'),
      message: this.translate.instant('confirm.clear-downloads-body'),
      confirmLabel: this.translate.instant('settings.storage.downloads-delete'),
    });
    if (!ok) return;
    this.storageClearing.set(true);
    this.storageMessage.set(null);
    this.store.error.set(null);
    try {
      const res = await this.ipc.clearFinishedDownloads();
      this.storageMessage.set(this.translate.instant('settings.storage.downloads-deleted', { n: res.removed }));
      await this.loadStorage();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.storageClearing.set(false);
    }
  }
}

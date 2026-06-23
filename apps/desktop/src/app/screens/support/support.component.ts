import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { IpcService } from '../../core/ipc/ipc.service';

/**
 * SupportComponent (route "support") — ways to fund VideoDubber.
 *
 * Online sponsorship (GitHub Sponsors / Buy Me a Coffee) opens in the user's
 * default browser via the opener plugin, and a Vietnam (VPBank) bank-transfer
 * card shows a VietQR code + copyable account details for direct donations.
 */
@Component({
  selector: 'vd-support',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support.component.html',
  styleUrl: './support.component.scss',
})
export class SupportComponent {
  private readonly ipc = inject(IpcService);

  /** The id of the field whose value was just copied (drives the "Copied" label). */
  protected readonly copied = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Open an external sponsor link in the OS default browser. */
  protected open(url: string): void {
    void this.ipc.openExternal(url);
  }

  /** Copy a bank detail to the clipboard and briefly flash a "Copied" label. */
  protected async copy(value: string, field: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(field);
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 1500);
    } catch {
      /* clipboard unavailable (rare) — the value is still visible to copy by hand */
    }
  }
}

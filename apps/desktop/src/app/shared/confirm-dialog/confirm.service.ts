import { Injectable, signal } from '@angular/core';

/** Options for a confirmation prompt. */
export interface ConfirmOptions {
  /** Short dialog heading (e.g. "Remove engine pack?"). */
  title: string;
  /** Body text explaining what will happen / what is at stake. */
  message: string;
  /** Confirm-button label (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel-button label (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). Default true. */
  danger?: boolean;
}

/** Active request = options plus a monotonic id so the view re-renders per open. */
type ActiveRequest = ConfirmOptions & { id: number };

/**
 * App-wide confirmation prompts. Call {@link confirm} from anywhere; it returns
 * a Promise that resolves `true` (user confirmed) or `false` (cancelled / closed)
 * — so a destructive action is a single `if (!(await confirm(...))) return;` away
 * from being guarded. The single {@link ConfirmDialogComponent} mounted at the
 * app root renders whatever request is active.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  /** The currently-open request, or null when nothing is showing. */
  readonly request = signal<ActiveRequest | null>(null);

  private resolver: ((ok: boolean) => void) | null = null;
  private counter = 0;

  /** Open a confirmation dialog and resolve with the user's choice. */
  confirm(options: ConfirmOptions): Promise<boolean> {
    // If one is somehow already open, treat it as cancelled before replacing it.
    this.resolver?.(false);
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.request.set({ ...options, id: ++this.counter });
    });
  }

  /** Resolve the open request (called by the dialog component). */
  resolve(ok: boolean): void {
    const r = this.resolver;
    this.resolver = null;
    this.request.set(null);
    r?.(ok);
  }
}

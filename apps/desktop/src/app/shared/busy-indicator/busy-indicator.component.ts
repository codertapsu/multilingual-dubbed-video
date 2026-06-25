import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';

/**
 * BusyIndicatorComponent — a small spinner + ticking elapsed-time label for a
 * BLOCKING wait that has no byte-level progress to show (e.g. copying the source
 * video, deleting downloaded data, re-rendering, installing an update).
 *
 * The rule it serves: any background task that blocks the user's next action
 * should show *something* moving so the app never looks frozen. When real
 * percent progress is available instead, use `<vd-download-progress-list>`.
 *
 * Renders nothing while inactive. The elapsed timer starts when `active` flips
 * true and is cleaned up automatically.
 */
@Component({
  selector: 'vd-busy-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <span class="busy" role="status" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <span class="busy-label">
          {{ label() }}
          @if (showElapsed()) {
            <span class="mono busy-elapsed">({{ elapsed() }})</span>
          }
        </span>
      </span>
    }
  `,
  styles: [
    `
      .busy {
        display: inline-flex;
        align-items: center;
        gap: var(--vd-sp-2);
        color: var(--vd-text-muted);
        font-size: 0.9rem;
      }
      .spinner {
        flex: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid var(--vd-border);
        border-top-color: var(--vd-primary);
        animation: vd-spin 0.7s linear infinite;
      }
      @keyframes vd-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class BusyIndicatorComponent {
  /** Whether the blocking task is in flight. */
  readonly active = input(false);
  /** What the user is waiting on. */
  readonly label = input('Working…');
  /** Show the elapsed `(m:ss)` timer (on by default; turn off for very short waits). */
  readonly showElapsed = input(true);

  private readonly _elapsed = signal('0:00');
  protected readonly elapsed = this._elapsed.asReadonly();

  constructor() {
    effect(
      (onCleanup) => {
        if (!this.active()) {
          this._elapsed.set('0:00');
          return;
        }
        const start = Date.now();
        this._elapsed.set('0:00');
        const id = setInterval(() => {
          const total = Math.floor((Date.now() - start) / 1000);
          const m = Math.floor(total / 60);
          const s = total % 60;
          this._elapsed.set(`${m}:${s.toString().padStart(2, '0')}`);
        }, 1000);
        onCleanup(() => clearInterval(id));
    });
  }
}

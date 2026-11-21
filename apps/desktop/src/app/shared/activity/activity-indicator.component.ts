import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ActivityService, type ActivityTask } from '../../core/activity/activity.service';
import { TranslatePipe } from '../../core/i18n';

/**
 * The top bar's "what is downloading" button (core/activity/activity.service.ts):
 * hidden while nothing runs or failed lately; a spinner and a count while
 * engine packs or models download; a list with each one's progress on click,
 * and a link to where it is managed. Users could not tell what was still
 * downloading once they left the screen they started it on (0.17.0 report).
 */
@Component({
  selector: 'vd-activity-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe],
  template: `
    @if (activity.tasks().length > 0) {
      <div class="activity">
        <button
          type="button"
          class="activity-btn"
          [class.busy]="activity.running().length > 0"
          [class.failed]="activity.running().length === 0 && activity.failed().length > 0"
          (click)="open.set(!open())"
          [attr.aria-expanded]="open()"
          aria-haspopup="dialog"
          [title]="summary()"
          [attr.aria-label]="summary()"
        >
          @if (activity.running().length > 0) {
            <span class="spinner" aria-hidden="true"></span>
            <span class="count">{{ activity.running().length }}</span>
          } @else if (activity.failed().length > 0) {
            <span aria-hidden="true">!</span>
          } @else {
            <span aria-hidden="true">✓</span>
          }
        </button>
        @if (open()) {
          <div class="panel" role="dialog" [attr.aria-label]="'activity.heading' | translate">
            <div class="panel-head">
              <strong>{{ 'activity.heading' | translate }}</strong>
              @if (activity.tasks().length > activity.running().length) {
                <button type="button" class="btn btn-ghost btn-sm" (click)="activity.clearFinished()">{{ 'activity.clear' | translate }}</button>
              }
            </div>
            <ul class="tasks">
              @for (t of activity.tasks(); track t.id) {
                <li class="task" [attr.data-state]="t.state">
                  <div class="task-head">
                    <span class="task-label">{{ t.label }}</span>
                    <span class="task-state">
                      @switch (t.state) {
                        @case ('running') { {{ t.percent !== null ? t.percent + '%' : ('activity.working' | translate) }} }
                        @case ('done') { ✓ }
                        @case ('failed') { {{ 'activity.failed' | translate }} }
                      }
                    </span>
                  </div>
                  @if (t.state === 'running') {
                    <div class="progress" role="progressbar" [attr.aria-valuenow]="t.percent ?? undefined" aria-valuemin="0" aria-valuemax="100" [attr.aria-label]="t.label">
                      <span [class.indeterminate]="t.percent === null" [style.width.%]="t.percent ?? 30"></span>
                    </div>
                  }
                  @if (t.message) {
                    <span class="task-msg" [class.err]="t.state === 'failed'">{{ t.message }}</span>
                  }
                  <div class="task-actions">
                    <a [routerLink]="t.link" (click)="open.set(false)">{{ 'activity.open' | translate }}</a>
                    @if (t.state !== 'running') {
                      <button type="button" class="link-btn" (click)="activity.dismiss(t.id)">{{ 'activity.dismiss' | translate }}</button>
                    }
                  </div>
                </li>
              }
            </ul>
            <p class="hint">{{ 'activity.hint' | translate }}</p>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .activity {
        position: relative;
      }
      .activity-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 34px;
        height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid var(--vd-border, #d0d7de);
        background: var(--vd-surface, transparent);
        color: inherit;
        cursor: pointer;
        font-weight: 600;
      }
      .activity-btn.busy {
        border-color: var(--vd-primary, #2563eb);
        color: var(--vd-primary, #2563eb);
      }
      .activity-btn.failed {
        border-color: var(--vd-danger, #dc2626);
        color: var(--vd-danger, #dc2626);
      }
      .spinner {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid currentColor;
        border-right-color: transparent;
        animation: vd-spin 0.9s linear infinite;
      }
      @keyframes vd-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .panel {
        position: absolute;
        right: 0;
        top: calc(100% + 8px);
        width: min(380px, 90vw);
        max-height: 70vh;
        overflow: auto;
        z-index: 50;
        background: var(--vd-surface, #fff);
        color: var(--vd-text, inherit);
        border: 1px solid var(--vd-border, #d0d7de);
        border-radius: var(--vd-radius, 10px);
        box-shadow: var(--vd-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.18));
        padding: var(--vd-sp-3, 12px);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--vd-sp-2, 8px);
      }
      .tasks {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-3, 12px);
      }
      .task-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.9rem;
      }
      .task-label {
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .task-state {
        white-space: nowrap;
        color: var(--vd-text-muted, #6b7280);
      }
      [data-state='failed'] .task-state {
        color: var(--vd-danger, #dc2626);
      }
      .progress {
        height: 6px;
        margin-top: 4px;
        border-radius: 999px;
        overflow: hidden;
        background: var(--vd-border, #e5e7eb);
      }
      .progress span {
        display: block;
        height: 100%;
        background: var(--vd-primary, #2563eb);
        transition: width 0.3s ease;
      }
      .progress span.indeterminate {
        animation: vd-slide 1.2s ease-in-out infinite;
      }
      @keyframes vd-slide {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(340%);
        }
      }
      .task-msg {
        display: block;
        margin-top: 4px;
        font-size: 0.8rem;
        color: var(--vd-text-muted, #6b7280);
        overflow-wrap: anywhere;
      }
      .task-msg.err {
        color: var(--vd-danger, #dc2626);
      }
      .task-actions {
        display: flex;
        gap: 12px;
        margin-top: 4px;
        font-size: 0.8rem;
      }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        color: var(--vd-text-muted, #6b7280);
        cursor: pointer;
        text-decoration: underline;
        font-size: inherit;
      }
      .hint {
        margin: var(--vd-sp-3, 12px) 0 0;
        font-size: 0.8rem;
        color: var(--vd-text-muted, #6b7280);
      }
    `,
  ],
})
export class ActivityIndicatorComponent {
  protected readonly activity = inject(ActivityService);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly open = signal(false);

  protected readonly summary = computed(() => {
    const running: ActivityTask[] = this.activity.running();
    if (running.length > 0) return running.map((t) => `${t.label}${t.percent !== null ? ` ${t.percent}%` : ''}`).join(' · ');
    return this.activity.failed().map((t) => t.label).join(' · ');
  });

  /** A click outside closes the list. */
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }
}

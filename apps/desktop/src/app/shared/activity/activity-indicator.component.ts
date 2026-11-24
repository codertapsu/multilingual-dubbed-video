import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { agentName } from '../../core/activity/activity-logic';
import { ActivityService, type ActivityTask } from '../../core/activity/activity.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';

/**
 * The top bar's "what is going on" button (core/activity/activity.service.ts):
 * hidden while nothing runs, waits or failed lately; a spinner and a count
 * while engine packs, models, videos or dubs are at work; a list with each
 * one's progress on click, and a link to where it is managed. Users could not
 * tell what was still downloading once they left the screen they started it
 * on (0.17.0 report), nor that a dub had finished (UX audit, 2026-11-21).
 */
@Component({
  selector: 'vd-activity-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe],
  template: `
    @if (activity.tasks().length > 0 || activity.agents().length > 0) {
      <div class="activity">
        <button
          type="button"
          class="activity-btn"
          [class.busy]="activity.running().length > 0"
          [class.failed]="activity.running().length === 0 && activity.failed().length > 0"
          (click)="toggle()"
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
          } @else if (activity.waiting().length > 0) {
            <span aria-hidden="true">…</span>
          } @else if (activity.tasks().length === 0) {
            <!-- Only agents connected: a small robot head. -->
            <svg class="agent-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>
          } @else {
            <span aria-hidden="true">✓</span>
          }
        </button>
        @if (open()) {
          <div class="panel" role="dialog" [attr.aria-label]="'activity.heading' | translate">
            <div class="panel-head">
              <strong>{{ 'activity.heading' | translate }}</strong>
              @if (hasFinished()) {
                <button type="button" class="btn btn-ghost btn-sm" (click)="activity.clearFinished()">{{ 'activity.clear' | translate }}</button>
              }
            </div>
            <ul class="tasks">
              @for (t of activity.tasks(); track t.id) {
                <li class="task" [attr.data-state]="t.state">
                  <div class="task-head">
                    <span class="task-label">
                      {{ t.label }}
                      @if (t.by) {
                        <span class="task-by">{{ t.by }}</span>
                      }
                    </span>
                    <span class="task-state">
                      @switch (t.state) {
                        @case ('running') { {{ t.percent !== null ? t.percent + '%' : ('activity.working' | translate) }} }
                        @case ('waiting') { {{ 'activity.waiting' | translate }} }
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
                  @if (messageOf(t); as msg) {
                    <span class="task-msg" [class.err]="t.state === 'failed'">{{ msg }}</span>
                  }
                  <div class="task-actions">
                    <a [routerLink]="t.link" [fragment]="t.fragment" (click)="open.set(false)">{{ t.linkLabel ?? ('activity.open' | translate) }}</a>
                    @if (t.state === 'done' || t.state === 'failed') {
                      <button type="button" class="link-btn" (click)="activity.dismiss(t.id)">{{ 'activity.dismiss' | translate }}</button>
                    }
                  </div>
                </li>
              }
            </ul>
            @if (activity.agents().length > 0) {
              <!-- The AI agents driving the app (MCP sessions of the last hour). -->
              <div class="agents">
                <strong class="agents-head">{{ 'activity.agents-heading' | translate }}</strong>
                <ul class="tasks">
                  @for (a of activity.agents(); track a.session) {
                    <li class="agent">
                      <span class="task-label">{{ agentLabel(a.client) }}</span>
                      <span class="task-msg">
                        {{ 'activity.agent-times' | translate: { first: clock(a.firstAt), last: ago(a.lastAt), calls: a.calls } }}
                      </span>
                      @if (a.tools.length > 0) {
                        <span class="task-msg mono">{{ 'activity.agent-tools' | translate: { tools: a.tools.slice(0, 5).join(', ') } }}</span>
                      }
                    </li>
                  }
                </ul>
                <p class="hint">{{ 'activity.agents-hint' | translate }}</p>
              </div>
            }
            <p class="hint">{{ 'activity.hint' | translate }}</p>
            <a class="all-link" routerLink="/activity" (click)="open.set(false)">{{ 'activity.see-all' | translate }}</a>
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
      .task-by {
        display: block;
        font-weight: 400;
        font-size: 0.75rem;
        color: var(--vd-text-muted, #6b7280);
      }
      .agent-icon {
        width: 16px;
        height: 16px;
      }
      .agents {
        margin-top: var(--vd-sp-3, 12px);
        padding-top: var(--vd-sp-3, 12px);
        border-top: 1px solid var(--vd-border, #e5e7eb);
      }
      .agents-head {
        display: block;
        margin-bottom: var(--vd-sp-2, 8px);
      }
      .agent .task-label {
        display: block;
      }
      .mono {
        font-family: var(--vd-mono, ui-monospace, monospace);
      }
      .all-link {
        display: inline-block;
        margin-top: var(--vd-sp-2, 8px);
        font-size: 0.85rem;
      }
    `,
  ],
})
export class ActivityIndicatorComponent {
  protected readonly activity = inject(ActivityService);
  private readonly i18n = inject(TranslateService);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly open = signal(false);

  protected readonly summary = computed(() => {
    const running: ActivityTask[] = this.activity.running();
    if (running.length > 0) return running.map((t) => `${t.label}${t.percent !== null ? ` ${t.percent}%` : ''}`).join(' · ');
    const failed = this.activity.failed();
    if (failed.length > 0) return failed.map((t) => t.label).join(' · ');
    return [...this.activity.waiting(), ...this.activity.tasks().filter((t) => t.state === 'done')].map((t) => t.label).join(' · ');
  });

  /** Something ended (done or failed) that "Clear finished" would remove. */
  protected readonly hasFinished = computed(() => this.activity.tasks().some((t) => t.state === 'done' || t.state === 'failed'));

  /** Open or close the list; opening looks at the connected agents again. */
  protected toggle(): void {
    const opening = !this.open();
    this.open.set(opening);
    if (opening) this.activity.refreshAgents();
  }

  /** An agent's name as people know it ("Claude Code"), or "An AI agent". */
  protected agentLabel(client: string | undefined): string {
    return agentName(client) ?? this.i18n.instant('activity.agent-unnamed');
  }

  /** `14:05`, in the user's language. */
  protected clock(iso: string): string {
    return new Date(iso).toLocaleTimeString(this.i18n.locale(), { hour: '2-digit', minute: '2-digit' });
  }

  /** "2 min ago" / "just now". */
  protected ago(iso: string): string {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return min < 1 ? this.i18n.instant('activity.just-now') : this.i18n.instant('activity.minutes-ago', { n: min });
  }

  /**
   * A failure says what went wrong in the user's language (an engine's error
   * arrives in the server's English); anything else shows its own message.
   */
  protected messageOf(t: ActivityTask): string {
    return t.state === 'failed' && t.error ? this.activity.failureLine(t.error) : t.message;
  }

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

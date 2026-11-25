import { ChangeDetectionStrategy, Component, computed, inject, input, signal, type OnDestroy, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { entryLink, entryText, initiatorView, kindLabelKey, mergeEntries, type ActivityTranslate } from '../../core/activity/activity-logic';
import type { ActivityEntry } from '../../core/activity/activity-models';
import { ActivityService } from '../../core/activity/activity.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import { toAppError } from '../../core/state/project.store';
import type { AppError } from '../../core/models';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';

/** How many entries the page reads (the server keeps the last 1000 app-wide, a project's own log holds more). */
const LIMIT = 200;
/** How often the open page looks for changes. */
const POLL_MS = 4000;

/**
 * The Activity page (routes `activity` and `project/:id/activity`): every
 * long piece of work, newest first, with who started it (the user, which AI
 * agent, the app itself), its progress, how it ended and a log reference.
 * For a project, also its older work read from its own log.
 *
 * WHY: the user could not see most of what the app did in the 27.8-hour
 * production: an agent ran speaker detection for five hours, 33
 * re-transcriptions and the part rebuilds over MCP, and nothing in the window
 * showed them, nor who had started what (claude-dubber report, 2026-11-23,
 * R3). Live while open: it asks every few seconds for what changed since.
 */
@Component({
  selector: 'vd-activity-log',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, ErrorBannerComponent],
  template: `
    <section class="page stack">
      <div class="row row-between">
        <div>
          <h1>{{ (id() ? 'activity.page-title-project' : 'activity.page-title') | translate: { name: projectName() } }}</h1>
          <p class="muted">{{ (id() ? 'activity.page-intro-project' : 'activity.page-intro') | translate }}</p>
        </div>
        <div class="row">
          @if (id(); as pid) {
            <a class="btn btn-ghost btn-sm" [routerLink]="['/project', pid, 'processing']">{{ 'activity.open-progress' | translate }}</a>
            <a class="btn btn-ghost btn-sm" [routerLink]="['/project', pid, 'editor']">{{ 'activity.open-editor' | translate }}</a>
          }
          <button type="button" class="btn btn-sm" (click)="load()" [disabled]="loading()">{{ 'common.refresh' | translate }}</button>
        </div>
      </div>

      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      <label class="only-active">
        <input type="checkbox" [checked]="onlyActive()" (change)="onlyActive.set(!onlyActive())" />
        {{ 'activity.only-active' | translate }}
      </label>

      @if (loading() && entries().length === 0) {
        <p class="muted">{{ 'common.loading' | translate }}</p>
      } @else if (shown().length === 0) {
        <div class="card"><p class="muted">{{ (onlyActive() ? 'activity.none-active' : 'activity.none') | translate }}</p></div>
      } @else {
        <ul class="entries">
          @for (e of shown(); track e.id) {
            <li class="card entry" [attr.data-state]="e.state">
              <div class="entry-head">
                <span class="badge" [class]="'badge ' + badgeClass(e)">{{ stateLabel(e) }}</span>
                <strong class="what">{{ label(e) }}</strong>
                @if (!id() && e.projectId) {
                  <a class="project" [routerLink]="link(e)">{{ e.projectName ?? e.projectId }}</a>
                }
              </div>
              @if (title(e); as t) {
                <div class="title muted">{{ t }}</div>
              }
              @if (e.state === 'running' || e.state === 'waiting') {
                <div class="progress" role="progressbar" [attr.aria-valuenow]="e.percent ?? undefined" aria-valuemin="0" aria-valuemax="100" [attr.aria-label]="label(e)">
                  <span [class.indeterminate]="e.percent === null" [style.width.%]="e.percent ?? 30"></span>
                </div>
              }
              @if (outcome(e); as text) {
                <p class="outcome" [class.err]="e.state === 'failed'">{{ text }}</p>
              }
              <dl class="facts">
                <div><dt>{{ 'activity.who' | translate }}</dt><dd>{{ who(e) }}</dd></div>
                <div><dt>{{ 'activity.when' | translate }}</dt><dd>{{ when(e) }}</dd></div>
                <div>
                  <dt>{{ 'activity.log-ref' | translate }}</dt>
                  <dd>
                    <span class="mono">{{ e.logRef ?? e.id }}</span>
                    <button type="button" class="link-btn" (click)="copy(e.logRef ?? e.id)">{{ (copied() === (e.logRef ?? e.id) ? 'activity.copied' : 'activity.copy') | translate }}</button>
                  </dd>
                </div>
              </dl>
            </li>
          }
        </ul>
        <p class="hint muted">{{ 'activity.log-ref-hint' | translate }}</p>
      }
    </section>
  `,
  styles: [
    `
      .only-active {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        font-size: 0.9rem;
      }
      .entries {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-3, 12px);
      }
      .entry-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .what {
        overflow-wrap: anywhere;
      }
      .project {
        font-size: 0.85rem;
      }
      .title {
        margin-top: 4px;
        font-size: 0.85rem;
        overflow-wrap: anywhere;
      }
      .progress {
        height: 6px;
        margin-top: 8px;
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
      .outcome {
        margin: 8px 0 0;
        font-size: 0.9rem;
        overflow-wrap: anywhere;
      }
      .outcome.err {
        color: var(--vd-danger, #dc2626);
      }
      .facts {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 24px;
        margin: 8px 0 0;
        font-size: 0.8rem;
        color: var(--vd-text-muted, #6b7280);
      }
      .facts div {
        display: flex;
        gap: 6px;
      }
      .facts dt {
        font-weight: 600;
      }
      .facts dd {
        margin: 0;
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        cursor: pointer;
        text-decoration: underline;
        font-size: inherit;
      }
      .hint {
        font-size: 0.8rem;
      }
    `,
  ],
})
export class ActivityLogComponent implements OnInit, OnDestroy {
  /** The project, on `project/:id/activity`; absent on `activity` (all of it). */
  readonly id = input<string | undefined>(undefined);

  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);
  private readonly activity = inject(ActivityService);

  protected readonly entries = signal<ActivityEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly onlyActive = signal(false);
  protected readonly copied = signal<string | null>(null);
  private readonly name = signal('');

  protected readonly shown = computed(() => (this.onlyActive() ? this.entries().filter((e) => !e.endedAt) : this.entries()));
  protected readonly projectName = computed(() => this.name() || this.entries().find((e) => e.projectName)?.projectName || this.id() || '');

  /** The latest `updatedAt` read: the next look asks only for what changed since. */
  private since = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnInit(): void {
    void this.load().finally(() => this.pollLater());
    const pid = this.id();
    if (pid) {
      this.ipc
        .getProject(pid)
        .then((res) => this.name.set(res.project.name))
        .catch(() => undefined);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The whole list again (on open, and Refresh). */
  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.take(await this.ipc.activity({ ...this.scope(), limit: LIMIT }));
      this.error.set(null);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Live while open: what changed since the last look, every few seconds (no stream: see ActivityService). */
  private pollLater(): void {
    if (this.destroyed) return;
    this.timer = setTimeout(async () => {
      try {
        this.take(await this.ipc.activity({ ...this.scope(), limit: LIMIT, ...(this.since ? { since: this.since } : {}) }));
      } catch {
        /* the backend is busy or restarting: look again */
      }
      this.pollLater();
    }, POLL_MS);
  }

  private scope(): { projectId?: string } {
    const pid = this.id();
    return pid ? { projectId: pid } : {};
  }

  private take(list: readonly ActivityEntry[]): void {
    for (const e of list) if (e.updatedAt > this.since) this.since = e.updatedAt;
    this.entries.update((now) => mergeEntries(now, list, LIMIT));
  }

  protected label(e: ActivityEntry): string {
    const key = e.external ? null : kindLabelKey(e.kind);
    return key ? this.i18n.instant(key) : e.title;
  }

  /** The entry's own title under its kind, in the reader's language; none when it says the same. */
  protected title(e: ActivityEntry): string | null {
    const title = e.external ? e.title : (entryText(e, 'title', this.say) ?? e.title);
    return title === this.label(e) ? null : title;
  }

  /** The registry's phrases in the reader's language; reading the locale re-renders on a switch. */
  private readonly say: ActivityTranslate = (key, params) => {
    this.i18n.locale();
    return this.i18n.instant(key, params);
  };

  protected link(e: ActivityEntry): string {
    return entryLink(e);
  }

  protected who(e: ActivityEntry): string {
    const view = initiatorView(e.initiator, e.external);
    return this.i18n.instant(view.key, view.params);
  }

  protected stateLabel(e: ActivityEntry): string {
    if (e.state === 'cancelled' && e.error?.code === 'CANCELLED') return this.i18n.instant('activity.state-interrupted');
    return this.i18n.instant(`activity.state-${e.state}`);
  }

  protected badgeClass(e: ActivityEntry): string {
    switch (e.state) {
      case 'running':
        return 'badge-running';
      case 'waiting':
        return 'badge-pending';
      case 'done':
        return 'badge-completed';
      case 'failed':
        return 'badge-failed';
      default:
        return 'badge-skipped';
    }
  }

  /** How it ended, or the step it is on (a failure in the user's language when the code says it). */
  protected outcome(e: ActivityEntry): string {
    if (e.state === 'failed' && e.error) return this.activity.failureLine(e.error);
    if (e.state === 'cancelled' && e.error?.code === 'CANCELLED') return this.i18n.instant('activity.interrupted-body');
    return entryText(e, 'result', this.say) ?? entryText(e, 'message', this.say) ?? '';
  }

  /** When it started, and how long it ran (or has been running). */
  protected when(e: ActivityEntry): string {
    const started = new Date(e.startedAt);
    const at = started.toLocaleString(this.i18n.locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const ms = (e.endedAt ? Date.parse(e.endedAt) : Date.now()) - started.getTime();
    return this.i18n.instant(e.endedAt ? 'activity.when-ran' : 'activity.when-running', { at, duration: this.duration(ms) });
  }

  private duration(ms: number): string {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return this.i18n.instant('activity.dur-s', { s: sec });
    const min = Math.round(sec / 60);
    if (min < 60) return this.i18n.instant('activity.dur-min', { m: min });
    return this.i18n.instant('activity.dur-h-min', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') });
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(text);
      setTimeout(() => {
        if (this.copied() === text) this.copied.set(null);
      }, 2000);
    } catch {
      /* no clipboard here: the reference is on screen to read */
    }
  }
}

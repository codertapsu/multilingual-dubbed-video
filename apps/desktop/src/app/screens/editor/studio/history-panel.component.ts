import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { initiatorView } from '../../../core/activity/activity-logic';
import type { EditHistoryEntry, EditHistorySummary, UndoChange } from '../../../core/activity/activity-models';
import { ActivityService } from '../../../core/activity/activity.service';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { AppError } from '../../../core/models';
import { toAppError } from '../../../core/state/project.store';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { clock, fieldKey, lineChanges, lineNumber, rangeView, refusalLines } from './edit-history-view';
import { StudioStore } from './studio.store';

/**
 * The editor's History tab: every change to the project's lines, newest
 * first, by anyone: the user here, an AI agent over MCP (replace_lines,
 * re-transcription, set_translations, adjust_lines), the app itself. Each
 * says who, when and what, shows its lines before and after, and can be
 * undone when those lines have not changed since; the server says what did,
 * when they have (node-orchestrator activity/undo.ts).
 *
 * WHY: transcript edits overwrote the project's files with no history, and
 * undo existed only in the open editor, for its own edits; an agent's
 * re-transcription that wrote credits and loops over good lines could only be
 * repaired by hand (claude-dubber report, 2026-11-23, F2 and R3).
 */
@Component({
  selector: 'vd-history-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe],
  template: `
    <div class="block head">
      <div class="title">
        <h3>{{ 'history.heading' | translate }}</h3>
        <button type="button" class="btn btn-ghost btn-sm" (click)="load()" [disabled]="loading()">{{ 'common.refresh' | translate }}</button>
      </div>
      <p class="muted intro">{{ 'history.intro' | translate }}</p>
      <a class="all" [routerLink]="['/project', store.projectId(), 'activity']">{{ 'history.all-activity' | translate }}</a>
    </div>

    @if (store.dubRunning()) {
      <p class="read-only-note">{{ 'history.dub-running' | translate }}</p>
    }
    @if (notice(); as n) {
      <div class="block notice" [class.err]="n.tone === 'error'" role="status">
        <p>{{ n.text }}</p>
        @for (line of n.lines; track $index) {
          <p class="why">{{ line }}</p>
        }
        <button type="button" class="link-btn" (click)="notice.set(null)">{{ 'common.dismiss' | translate }}</button>
      </div>
    }
    @if (error(); as e) {
      <p class="block err">{{ failureLine(e) }}</p>
    }

    @if (loading() && entries().length === 0) {
      <p class="block muted">{{ 'common.loading' | translate }}</p>
    } @else if (entries().length === 0) {
      <p class="block muted">{{ 'history.empty' | translate }}</p>
    }

    <ul class="entries">
      @for (e of entries(); track e.id) {
        <li class="block entry" [class.undone]="!!e.undoneAt">
          <div class="meta">
            <span class="badge" [class]="e.target === 'source' ? 'badge badge-info' : 'badge badge-pending'">{{ (e.target === 'source' ? 'history.target-source' : 'history.target-translation') | translate }}</span>
            <span class="muted">{{ when(e.at) }}</span>
            @if (e.undoneAt) {
              <span class="badge badge-skipped">{{ 'history.undone' | translate }}</span>
            }
          </div>
          <p class="summary">{{ e.summary }}</p>
          <p class="muted small">
            {{ who(e) }} · {{ 'history.counts' | translate: { before: e.beforeCount, after: e.afterCount } }}
            @if (e.undoOf) {
              · {{ 'history.undo-of' | translate }}
            }
          </p>
          <div class="actions">
            <button type="button" class="link-btn" (click)="toggle(e)" [attr.aria-expanded]="open() === e.id">
              {{ (open() === e.id ? 'history.hide-changes' : 'history.show-changes') | translate }}
            </button>
            <button
              type="button"
              class="btn btn-sm"
              (click)="undo(e)"
              [disabled]="!!e.undoneAt || store.dubRunning() || undoing() !== null"
              [title]="(e.undoneAt ? 'history.undone-title' : 'history.undo-title') | translate"
            >
              {{ (undoing() === e.id ? 'history.undoing' : 'history.undo') | translate }}
            </button>
          </div>
          @if (open() === e.id) {
            @if (details(); as d) {
              @if (d.range) {
                <div class="diff range">
                  <div>
                    <h4>{{ 'history.lines-before' | translate: { n: d.entry.before.length } }}</h4>
                    @for (l of d.range.before; track $index) {
                      <p class="line"><span class="mono">{{ clock(l.atMs) }}</span> {{ l.text }}@if (l.speakerId) { <span class="muted"> · {{ l.speakerId }}</span>}</p>
                    }
                    @if (d.range.moreBefore > 0) {
                      <p class="muted small">{{ 'history.more' | translate: { n: d.range.moreBefore } }}</p>
                    }
                  </div>
                  <div>
                    <h4>{{ 'history.lines-after' | translate: { n: d.entry.after.length } }}</h4>
                    @for (l of d.range.after; track $index) {
                      <p class="line"><span class="mono">{{ clock(l.atMs) }}</span> {{ l.text }}@if (l.speakerId) { <span class="muted"> · {{ l.speakerId }}</span>}</p>
                    }
                    @if (d.range.moreAfter > 0) {
                      <p class="muted small">{{ 'history.more' | translate: { n: d.range.moreAfter } }}</p>
                    }
                  </div>
                </div>
              } @else {
                <div class="diff">
                  @for (l of d.lines; track l.id) {
                    <div class="changed-line">
                      <h4>{{ 'history.line' | translate: { n: lineNumber(l.id), at: clock(l.atMs) } }}</h4>
                      @for (f of l.fields; track f.field) {
                        <p class="field">
                          <span class="muted">{{ fieldKey(f.field) | translate }}:</span>
                          <del>{{ f.before || '—' }}</del> → <ins>{{ f.after || '—' }}</ins>
                        </p>
                      }
                    </div>
                  }
                  @if (d.more > 0) {
                    <p class="muted small">{{ 'history.more' | translate: { n: d.more } }}</p>
                  }
                </div>
              }
            } @else {
              <p class="muted small">{{ 'common.loading' | translate }}</p>
            }
          }
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
        overflow-y: auto;
        min-height: 0;
      }
      .block {
        margin: 0;
        padding: var(--vd-sp-3, 12px) var(--vd-sp-4, 16px);
        border-bottom: 1px solid var(--vd-border, #e5e7eb);
      }
      .head .title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--vd-sp-2, 8px);
      }
      h3 {
        margin: 0;
        font-size: 0.95rem;
      }
      h4 {
        margin: 6px 0 2px;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--vd-text-muted, #6b7280);
      }
      .intro {
        margin: 6px 0 4px;
        font-size: 0.8rem;
      }
      .all {
        font-size: 0.8rem;
      }
      .read-only-note {
        margin: 0;
        padding: var(--vd-sp-2, 8px) var(--vd-sp-4, 16px);
        border-bottom: 1px solid var(--vd-border, #e5e7eb);
        background: var(--vd-info-bg, #eff6ff);
        font-size: 0.8rem;
      }
      .notice p {
        margin: 0 0 4px;
        font-size: 0.85rem;
      }
      .notice .why {
        font-size: 0.8rem;
      }
      .err {
        color: var(--vd-danger, #dc2626);
      }
      .entries {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .entry.undone .summary {
        text-decoration: line-through;
        color: var(--vd-text-muted, #6b7280);
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        font-size: 0.75rem;
      }
      .summary {
        margin: 6px 0 2px;
        font-size: 0.85rem;
        overflow-wrap: anywhere;
      }
      .small {
        margin: 0;
        font-size: 0.75rem;
      }
      .actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 6px;
      }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        color: inherit;
        cursor: pointer;
        text-decoration: underline;
        font-size: 0.8rem;
      }
      .diff {
        margin-top: 6px;
        font-size: 0.8rem;
      }
      .diff.range {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .line,
      .field {
        margin: 2px 0;
        overflow-wrap: anywhere;
      }
      del {
        color: var(--vd-danger, #dc2626);
      }
      ins {
        color: var(--vd-success, #16a34a);
        text-decoration: none;
      }
    `,
  ],
})
export class HistoryPanelComponent {
  /** The tab is showing: the list is read then, and again after each save. */
  readonly active = input(false);

  protected readonly store = inject(StudioStore);
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);
  private readonly activity = inject(ActivityService);

  protected readonly entries = signal<EditHistorySummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly open = signal<string | null>(null);
  protected readonly details = signal<{
    entry: EditHistoryEntry;
    range?: ReturnType<typeof rangeView>;
    lines: ReturnType<typeof lineChanges>['lines'];
    more: number;
  } | null>(null);
  protected readonly undoing = signal<string | null>(null);
  protected readonly notice = signal<{ tone: 'success' | 'error'; text: string; lines: string[] } | null>(null);

  protected readonly clock = clock;
  protected readonly lineNumber = lineNumber;
  protected readonly fieldKey = fieldKey;

  constructor() {
    // Read when shown, and again when an edit made here was saved (it is an entry too).
    effect(() => {
      const active = this.active();
      const pid = this.store.projectId();
      const saved = this.store.saveState() === 'saved';
      if (active && pid && saved) untracked(() => void this.load());
    });
  }

  async load(): Promise<void> {
    const pid = this.store.projectId();
    if (!pid) return;
    this.loading.set(true);
    try {
      this.entries.set(await this.ipc.editHistory(pid));
      this.error.set(null);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected failureLine(e: AppError): string {
    return this.activity.failureLine(e);
  }

  protected who(e: EditHistorySummary): string {
    const view = initiatorView(e.initiator);
    return this.i18n.instant(view.key, view.params);
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString(this.i18n.locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  protected async toggle(e: EditHistorySummary): Promise<void> {
    if (this.open() === e.id) {
      this.open.set(null);
      return;
    }
    this.open.set(e.id);
    this.details.set(null);
    try {
      const entry = await this.ipc.editHistoryEntry(this.store.projectId(), e.id);
      if (this.open() !== e.id) return;
      const changes = lineChanges(entry);
      this.details.set({ entry, ...(entry.range ? { range: rangeView(entry) } : {}), lines: changes.lines, more: changes.more });
    } catch (err) {
      this.open.set(null);
      this.error.set(toAppError(err));
    }
  }

  protected async undo(e: EditHistorySummary): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.i18n.instant('history.confirm-title'),
      message: this.i18n.instant('history.confirm-body', { summary: e.summary }),
      confirmLabel: this.i18n.instant('history.undo'),
      danger: false,
    });
    if (!ok) return;
    this.undoing.set(e.id);
    this.notice.set(null);
    try {
      // The editor's own edits still on their way go first: the undo is checked against what is saved.
      if (!(await this.store.flushNow())) {
        this.notice.set({ tone: 'error', text: this.i18n.instant('history.save-first'), lines: [] });
        return;
      }
      await this.ipc.undoEdit(this.store.projectId(), e.id);
      this.notice.set({ tone: 'success', text: this.i18n.instant('history.undone-notice', { summary: e.summary }), lines: [] });
      // The lines changed under the editor: read them again (its own undo steps no longer apply).
      await this.store.load(this.store.projectId());
      await this.load();
    } catch (err) {
      const error = toAppError(err);
      const changes = (err as { changes?: UndoChange[] } | null)?.changes;
      if (Array.isArray(changes) && changes.length > 0) {
        this.notice.set({
          tone: 'error',
          text: this.i18n.instant('history.refused'),
          lines: refusalLines(changes).map((l) =>
            this.i18n.instant(l.key, { ...l.params, ...(l.params['field'] ? { field: this.i18n.instant(l.params['field']) } : {}) }),
          ),
        });
      } else {
        this.notice.set({ tone: 'error', text: this.activity.failureLine(error), lines: [] });
      }
    } finally {
      this.undoing.set(null);
    }
  }
}

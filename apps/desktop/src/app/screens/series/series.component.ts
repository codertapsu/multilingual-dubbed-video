import { ChangeDetectionStrategy, Component, computed, inject, input, signal, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SeriesAiOption, SeriesView } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { toAppError } from '../../core/state/project.store';
import type { AppError } from '../../core/models';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { StatusBadgeComponent } from '../../shared/status-badge/status-badge.component';
import { formatClock, parseClock } from '../../shared/branding/branding-form.component';
import { parsePartList, partBadge, partStarts, rebuildReportLine, seriesAiName, startReport, type StartReportLine } from './series-view';

interface Row {
  index: number;
  startText: string;
  endMs: number;
  title: string;
  summary: string;
  /** The part's project name, once made. */
  name?: string;
  projectId?: string;
  status?: string;
  progressPercent?: number;
}

/** A made part being renamed or retitled (one at a time). */
interface PartEdit {
  index: number;
  projectId: string;
  name: string;
  title: string;
  summary: string;
}

/**
 * SeriesComponent (route "project/:id/series"): a long video dubbed in parts.
 * While the video is analysed it points at the progress screen; then it shows
 * the parts the AI planned (cut times and titles can be changed), makes them,
 * starts them, and follows each one.
 */
@Component({
  selector: 'vd-series',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorBannerComponent, StatusBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page stack">
      <div>
        <h1>{{ view()?.name ?? '…' }}</h1>
        <p class="muted">{{ 'series.subtitle' | translate }}</p>
      </div>
      <vd-error-banner [error]="error() ?? loadError()" (dismiss)="dismissError()" />

      @if (view(); as v) {
        <div class="card stack">
          @switch (v.state) {
            @case ('analysing') {
              <!-- Not started (or paused): it waits for the user, it is not working. -->
              @if (v.parentStatus === 'created' || v.parentStatus === 'paused') {
                <p>{{ 'series.not-started' | translate }}</p>
                <a class="btn btn-primary" [routerLink]="['/project', v.parentId, 'processing']">{{ 'series.open-to-start' | translate }}</a>
              } @else {
                <p>{{ 'series.analysing' | translate }}</p>
                <a class="btn" [routerLink]="['/project', v.parentId, 'processing']">{{ 'series.see-progress' | translate }}</a>
              }
            }
            @case ('planning') {
              <p>{{ 'series.planning' | translate }}</p>
            }
            @case ('failed') {
              <!-- The AI could not plan the cuts: the shared banner says why and how to fix it. -->
              <p>{{ 'series.plan-failed' | translate }}</p>
              <vd-error-banner [error]="planErrorHidden() ? null : planError()" (dismiss)="planErrorHidden.set(true)" />
              <div>
                <button type="button" class="btn" (click)="replan()" [disabled]="busy()">{{ 'series.try-again' | translate }}</button>
              </div>
            }
            @default {
              <p class="muted">
                {{ 'series.settings-line' | translate: { min: v.settings.minMinutes, max: v.settings.maxMinutes, ai: aiName(), recap: v.settings.recapSec } }}
              </p>
            }
          }
          <!-- A later season: its name and numbers carry on from the series it continues. -->
          @if (v.continues; as c) {
            <p class="muted">
              {{ 'series.continues-line' | translate: { name: c.name, first: (v.settings.partNumberOffset ?? 0) + 1 } }}
              <a [routerLink]="['/project', c.parentId, 'series']">{{ 'series.open' | translate }}</a>
            </p>
          }
          @if (v.settings.nameTemplate; as t) {
            <p class="muted">{{ 'series.name-template-line' | translate: { template: t } }}</p>
          }
          <!-- Asked to start by itself, it stopped: the analysis was not clean (seriesService.seriesReviewReasons). -->
          @if (v.reviewReasons?.length) {
            <div class="banner-warning stack-sm" role="status">
              <strong>{{ 'series.stopped-heading' | translate }}</strong>
              @for (r of v.reviewReasons; track $index) {
                <span>{{ reasonText(r) }}</span>
              }
            </div>
          }
          @for (note of v.plan?.notes ?? []; track $index) {
            <p class="hint warn-text">{{ note }}</p>
          }
        </div>

        @if (rows().length > 0) {
          <div class="card stack">
            <h2>{{ 'series.parts' | translate: { n: rows().length } }}</h2>
            @if (v.state === 'review') {
              <p class="hint muted">{{ 'series.review-hint' | translate }}</p>
            }
            <ol class="parts">
              @for (r of rows(); track r.index) {
                <li class="part stack-sm">
                  <div class="row head">
                    <strong>{{ 'series.part-n' | translate: { n: r.index } }}</strong>
                    @if (v.state === 'review' && r.index > 1) {
                      <label class="row inline">
                        <span class="muted">{{ 'series.starts-at' | translate }}</span>
                        <input type="text" class="time" [(ngModel)]="r.startText" />
                      </label>
                    } @else {
                      <span class="muted">{{ r.startText }}</span>
                    }
                    <span class="muted">– {{ clock(r.endMs) }}</span>
                    @if (badge(r.status); as b) {
                      <vd-status-badge [status]="b" />
                      @if (b === 'running' && r.progressPercent !== undefined) {
                        <span class="mono muted">{{ r.progressPercent }}%</span>
                      }
                    }
                  </div>
                  @if (v.state === 'review') {
                    <input type="text" [(ngModel)]="r.title" [placeholder]="'series.title-ph' | translate" />
                    <input type="text" [(ngModel)]="r.summary" [placeholder]="'series.summary-ph' | translate" />
                  } @else if (editing()?.index === r.index) {
                    <!-- A made part renamed or retitled: its dub is kept (PATCH /series-part). -->
                    @let e = editing()!;
                    <label class="stack-sm">
                      <span class="label">{{ 'series.edit-name' | translate }}</span>
                      <input type="text" maxlength="200" [ngModel]="e.name" (ngModelChange)="patchEdit('name', $event)" />
                    </label>
                    <input type="text" maxlength="120" [ngModel]="e.title" (ngModelChange)="patchEdit('title', $event)" [placeholder]="'series.title-ph' | translate" />
                    <input type="text" maxlength="600" [ngModel]="e.summary" (ngModelChange)="patchEdit('summary', $event)" [placeholder]="'series.summary-ph' | translate" />
                    <p class="hint muted">{{ 'series.edit-hint' | translate }}</p>
                    <div class="row">
                      <button type="button" class="btn btn-primary btn-sm" (click)="saveEdit()" [disabled]="busy() || !e.name.trim()">{{ 'series.edit-save' | translate }}</button>
                      <button type="button" class="btn btn-sm" (click)="editing.set(null)" [disabled]="busy()">{{ 'series.edit-cancel' | translate }}</button>
                    </div>
                  } @else {
                    <span>{{ r.title }}</span>
                    @if (r.name) {
                      <span class="muted part-name">{{ r.name }}</span>
                    }
                  }
                  @if (r.projectId) {
                    <div class="row links">
                      <a [routerLink]="['/project', r.projectId, 'processing']">{{ 'series.open-progress' | translate }}</a>
                      <a [routerLink]="['/project', r.projectId, 'editor']">{{ 'series.open-editor' | translate }}</a>
                      <a [routerLink]="['/project', r.projectId, 'export']">{{ 'series.open-export' | translate }}</a>
                      @if (editing()?.index !== r.index) {
                        <button type="button" class="link-btn" (click)="startEdit(r)" [disabled]="busy()">{{ 'series.edit-part' | translate }}</button>
                      }
                    </div>
                  }
                  @if (editNotice()?.index === r.index) {
                    <p class="hint" role="status">{{ editNotice()!.key | translate: { n: r.index } }}</p>
                  }
                </li>
              }
            </ol>
            @if (v.state === 'review') {
              <div class="row">
                <button type="button" class="btn" (click)="save()" [disabled]="busy()">{{ 'series.save' | translate }}</button>
                <button type="button" class="btn btn-primary" (click)="makeAndStart()" [disabled]="busy()">{{ 'series.make-start' | translate }}</button>
              </div>
              <!-- Plan again (another AI, a fixed transcript), keeping what was written here. -->
              <div class="row">
                <button type="button" class="btn" (click)="replan(keepTitles)" [disabled]="busy()">{{ 'series.try-again' | translate }}</button>
                <label class="row inline">
                  <input type="checkbox" [(ngModel)]="keepTitles" />
                  <span>{{ 'series.replan-keep' | translate }}</span>
                </label>
              </div>
              <p class="hint muted">{{ 'series.replan-hint' | translate }}</p>
            }
            @if (v.state === 'parts') {
              <div class="row">
                <button type="button" class="btn btn-primary" (click)="startAll()" [disabled]="busy() || allDone()">{{ 'series.start-all' | translate }}</button>
                <button type="button" class="btn" (click)="pauseAll()" [disabled]="busy() || !anyActive()">{{ 'series.pause-all' | translate }}</button>
              </div>
              <p class="hint muted">{{ 'series.all-parts-hint' | translate }}</p>
              <!-- What Start did to each part: one that could not start says why, and opens. -->
              @if (startLines().length > 0) {
                <ul class="stack-sm report">
                  @for (line of startLines(); track line.projectId) {
                    <li [class.failed]="line.failed">
                      {{ line.key | translate: line.params }}
                      @if (line.failed) {
                        <a [routerLink]="['/project', line.projectId, 'processing']">{{ 'series.start-open' | translate }}</a>
                      }
                    </li>
                  }
                </ul>
              }
            }
          </div>

          @if (v.state === 'parts') {
            <div class="card stack">
              <h2>{{ 'series.tools-heading' | translate }}</h2>
              <div class="stack-sm">
                <div class="row">
                  <button type="button" class="btn" (click)="applySettings()" [disabled]="busy()">{{ 'series.apply-settings' | translate }}</button>
                </div>
                <p class="hint muted">{{ 'series.apply-settings-hint' | translate }}</p>
              </div>
              <div class="stack-sm">
                <div class="row">
                  <button type="button" class="btn" (click)="rebuild()" [disabled]="busy() || rebuildPartsInvalid()">{{ 'series.rebuild' | translate }}</button>
                  <label class="row inline">
                    <span class="muted">{{ 'series.rebuild-parts' | translate }}</span>
                    <input
                      type="text"
                      class="parts-input"
                      [ngModel]="rebuildPartsText()"
                      (ngModelChange)="rebuildPartsText.set($event)"
                      [placeholder]="'series.rebuild-parts-ph' | translate"
                    />
                  </label>
                  <label class="row inline">
                    <input type="checkbox" [(ngModel)]="rebuildForce" />
                    <span>{{ 'series.rebuild-force' | translate }}</span>
                  </label>
                </div>
                @if (rebuildPartsInvalid()) {
                  <p class="hint warn-text" role="alert">{{ 'series.rebuild-parts-invalid' | translate }}</p>
                }
                <p class="hint muted">{{ 'series.rebuild-hint' | translate }}</p>
              </div>
              @if (report().length > 0) {
                <ul class="stack-sm report">
                  @for (line of report(); track $index) {
                    <li>{{ line }}</li>
                  }
                </ul>
              }
            </div>
          }
        }
      }
    </section>
  `,
  styles: [
    `
      .parts {
        margin: 0;
        padding-left: var(--vd-sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-3);
      }
      .head {
        align-items: center;
        gap: var(--vd-sp-2);
        flex-wrap: wrap;
      }
      .inline {
        align-items: center;
        gap: var(--vd-sp-1);
      }
      .time {
        width: 90px;
      }
      .links {
        gap: var(--vd-sp-3);
        font-size: 0.85rem;
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
      .report {
        margin: 0;
        padding-left: var(--vd-sp-5);
        font-size: 0.85rem;
      }
      .report li.failed {
        color: var(--vd-danger);
      }
      /* Why a series asked to start by itself stopped for review. */
      .banner-warning {
        color: var(--vd-warning);
        background: var(--vd-warning-bg);
        border: 1px solid var(--vd-warning);
        border-radius: var(--vd-radius-sm);
        padding: var(--vd-sp-3) var(--vd-sp-4);
      }
      /* What the plan could not do as asked (the AI did not answer for a cut). */
      .warn-text {
        color: var(--vd-warning);
      }
      .part-name {
        font-size: 0.85rem;
        overflow-wrap: anywhere;
      }
      .parts-input {
        width: 220px;
      }
      .link-btn {
        background: none;
        border: none;
        padding: 0;
        color: var(--vd-primary);
        cursor: pointer;
        font: inherit;
      }
      .link-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ],
})
export class SeriesComponent implements OnInit, OnDestroy {
  readonly id = input.required<string>();
  private readonly ipc = inject(IpcService);

  protected readonly view = signal<SeriesView | null>(null);
  protected readonly rows = signal<Row[]>([]);
  protected readonly busy = signal(false);
  /** What an action got back. */
  protected readonly error = signal<AppError | null>(null);
  /** The page's own reads failing; gone once a later read works (it reads every 3 s). */
  protected readonly loadError = signal<AppError | null>(null);
  /** Why the AI could not plan the cuts, as the server keeps it. */
  protected readonly planError = signal<AppError | null>(null);
  protected readonly planErrorHidden = signal(false);
  protected readonly allDone = computed(() => this.rows().every((r) => r.status === 'completed'));
  protected readonly anyActive = computed(() => this.rows().some((r) => r.status === 'running' || r.status === 'queued'));
  /** What the last series-wide action did, part by part. */
  protected readonly report = signal<string[]>([]);
  /** What "Start every part" did, part by part (series-view.ts). */
  protected readonly startLines = signal<StartReportLine[]>([]);
  /** The AIs that can choose cuts, for their names (null until they load). */
  private readonly aiOptions = signal<SeriesAiOption[] | null>(null);
  private aiOptionsLoading = false;
  /** The AI the series uses, by name rather than id. */
  protected readonly aiName = computed(() => {
    const v = this.view();
    return v ? seriesAiName(v.settings.aiProviderId, this.aiOptions() ?? []) : '';
  });
  protected readonly badge = partBadge;
  protected rebuildForce = false;
  /** "Only these parts" for a rebuild ('' = every part). */
  protected readonly rebuildPartsText = signal('');
  protected readonly rebuildPartsInvalid = computed(() => parsePartList(this.rebuildPartsText()) === null);
  /** Planning again keeps the titles written in review. */
  protected keepTitles = true;
  /** The made part being renamed or retitled. */
  protected readonly editing = signal<PartEdit | null>(null);
  /** What saving a part did, said under it. */
  protected readonly editNotice = signal<{ index: number; key: string } | null>(null);
  private readonly translate = inject(TranslateService);
  private timer: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    void this.load(true);
    // The analysis, the AI and the parts' dubs move on by themselves: follow them.
    this.timer = setInterval(() => void this.load(false), 3000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  /** A review reason in the UI's language (the server's English for a code this build does not know). */
  protected reasonText(r: { code: string; message: string }): string {
    const key = `series.reason-${r.code}`;
    const t = this.translate.instant(key);
    return t === key ? r.message : t;
  }

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  private async load(resetRows: boolean): Promise<void> {
    try {
      const v = await this.ipc.getSeries(this.id());
      this.loadError.set(null);
      const changedState = this.view()?.state !== v.state;
      this.view.set(v);
      // The same failure arrives with every read: the banner keeps the one it shows.
      const planError = v.state === 'failed' ? (v.error ?? null) : null;
      if (!sameError(planError, this.planError())) this.planError.set(planError);
      if (this.aiOptions() === null) void this.loadAiOptions();
      // While reviewing, keep what the user is typing; otherwise follow the server.
      if (resetRows || changedState || v.state !== 'review') {
        this.rows.set(
          v.parts.map((p) => {
            const planned = v.plan?.parts.find((x) => x.index === p.index);
            return {
              index: p.index,
              startText: formatClock(p.startMs),
              endMs: p.endMs,
              title: p.title,
              summary: p.summary ?? planned?.summary ?? '',
              ...(p.name ? { name: p.name } : {}),
              ...(p.projectId ? { projectId: p.projectId } : {}),
              ...(p.status ? { status: p.status } : {}),
              ...(p.progressPercent !== undefined ? { progressPercent: p.progressPercent } : {}),
            };
          }),
        );
      }
    } catch (err) {
      // Read every 3 s: a failure that persists is not announced again each time.
      const e = toAppError(err);
      if (!sameError(e, this.loadError())) this.loadError.set(e);
    }
  }

  /** Best-effort: until the names load, the settings line shows the AI's id. */
  private async loadAiOptions(): Promise<void> {
    if (this.aiOptionsLoading) return;
    this.aiOptionsLoading = true;
    try {
      this.aiOptions.set(await this.ipc.seriesAiOptions());
    } catch {
      /* the next read tries again */
    } finally {
      this.aiOptionsLoading = false;
    }
  }

  protected dismissError(): void {
    this.error.set(null);
    this.loadError.set(null);
  }

  private edits(): { cuts: number[]; titles: { title: string; summary: string }[] } {
    const rows = this.rows();
    return {
      cuts: rows.slice(1).map((r) => parseClock(r.startText)),
      titles: rows.map((r) => ({ title: r.title, summary: r.summary })),
    };
  }

  protected async save(): Promise<boolean> {
    return this.run(async () => {
      await this.ipc.reviseSeriesPlan(this.id(), this.edits());
      await this.load(true);
    });
  }

  protected async makeAndStart(): Promise<void> {
    if (!(await this.save())) return;
    await this.startAll();
  }

  /** Start (or continue) every part, then say what happened to each. */
  protected startAll(): Promise<boolean> {
    return this.run(async () => {
      this.startLines.set([]);
      const answer = await this.ipc.startSeries(this.id());
      // Reloaded first: parts made just now get their numbers from the view.
      await this.load(true);
      const parts = this.view()?.parts ?? [];
      this.startLines.set(startReport(partStarts(answer), (id) => parts.find((p) => p.projectId === id)?.index));
    });
  }

  /** Pause every part that is dubbing or waiting, in order (they continue in that order). */
  protected pauseAll(): Promise<boolean> {
    return this.run(async () => {
      this.startLines.set([]);
      await this.ipc.pausePipeline(this.view()?.parentId ?? this.id());
      await this.load(true);
    });
  }

  /** The series' own settings (voices per speaker included) on every part not being dubbed. */
  protected applySettings(): Promise<boolean> {
    return this.run(async () => {
      const parentId = this.view()?.parentId ?? this.id();
      const { project } = await this.ipc.getProject(parentId);
      const res = await this.ipc.updateSeriesSettings(parentId, project.settings);
      this.report.set(
        (res.parts ?? []).map((p) =>
          this.translate.instant(p.ok ? 'series.report-applied' : 'series.report-skipped', {
            n: p.index,
            why: p.skipped ?? p.error ?? '',
          }),
        ),
      );
    });
  }

  /**
   * Make the parts' transcripts again from the series transcript (after it
   * was fixed): only the parts typed, else all; a part waiting in the queue is
   * rebuilt where it waits.
   */
  protected rebuild(): Promise<boolean> {
    const parts = parsePartList(this.rebuildPartsText());
    if (parts === null) return Promise.resolve(false);
    return this.run(async () => {
      const res = await this.ipc.rebuildSeriesParts(this.view()?.parentId ?? this.id(), this.rebuildForce, parts);
      this.report.set(
        res.parts.map((p) => {
          const line = rebuildReportLine(p);
          return this.translate.instant(line.key, line.params);
        }),
      );
      await this.load(true);
    });
  }

  /** Plan the cuts again; `keepTitles` keeps the titles written in review. */
  protected replan(keepTitles = false): Promise<boolean> {
    return this.run(async () => {
      this.planErrorHidden.set(false);
      await this.ipc.replanSeries(this.id(), keepTitles);
      await this.load(true);
    });
  }

  /** Rename or retitle a made part (one at a time). */
  protected startEdit(r: Row): void {
    if (!r.projectId) return;
    this.editNotice.set(null);
    this.editing.set({ index: r.index, projectId: r.projectId, name: r.name ?? '', title: r.title, summary: r.summary });
  }

  protected patchEdit(field: 'name' | 'title' | 'summary', value: string): void {
    const e = this.editing();
    if (e) this.editing.set({ ...e, [field]: value });
  }

  /** Save what changed of the part being edited; its dub is kept, a new title renders it again. */
  protected saveEdit(): Promise<boolean> {
    const e = this.editing();
    const row = this.rows().find((r) => r.index === e?.index);
    if (!e || !row) return Promise.resolve(false);
    const edit = {
      ...(e.name.trim() !== (row.name ?? '') ? { name: e.name.trim() } : {}),
      ...(e.title.trim() !== row.title ? { title: e.title.trim() } : {}),
      ...(e.summary.trim() !== row.summary ? { summary: e.summary.trim() } : {}),
    };
    if (Object.keys(edit).length === 0) {
      this.editing.set(null);
      return Promise.resolve(true);
    }
    return this.run(async () => {
      const res = await this.ipc.editSeriesPart(e.projectId, edit);
      this.editing.set(null);
      this.editNotice.set({ index: e.index, key: res.renderAgain ? 'series.edit-render-again' : 'series.edit-saved' });
      await this.load(true);
    });
  }

  private async run(fn: () => Promise<void>): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      return true;
    } catch (err) {
      this.error.set(toAppError(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}

/** Two errors that say the same thing (null for none). */
function sameError(a: AppError | null, b: AppError | null): boolean {
  return a?.code === b?.code && a?.message === b?.message;
}

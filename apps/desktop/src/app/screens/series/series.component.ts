import { ChangeDetectionStrategy, Component, computed, inject, input, signal, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SeriesView } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { toAppError } from '../../core/state/project.store';
import type { AppError } from '../../core/models';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { formatClock, parseClock } from '../../shared/branding/branding-form.component';

interface Row {
  index: number;
  startText: string;
  endMs: number;
  title: string;
  summary: string;
  projectId?: string;
  status?: string;
  progressPercent?: number;
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
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page stack">
      <div>
        <h1>{{ view()?.name ?? '…' }}</h1>
        <p class="muted">{{ 'series.subtitle' | translate }}</p>
      </div>
      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

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
              <p class="test-fail">{{ v.error?.message }}</p>
              <button type="button" class="btn" (click)="replan()" [disabled]="busy()">{{ 'series.try-again' | translate }}</button>
            }
            @default {
              <p class="muted">
                {{ 'series.settings-line' | translate: { min: v.settings.minMinutes, max: v.settings.maxMinutes, ai: v.settings.aiProviderId, recap: v.settings.recapSec } }}
              </p>
            }
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
                    @if (r.status) {
                      <span class="badge" [class.badge-completed]="r.status === 'completed'" [class.badge-failed]="r.status === 'failed'">
                        {{ r.status }} @if (r.status === 'running') { {{ r.progressPercent }}% }
                      </span>
                    }
                  </div>
                  @if (v.state === 'review') {
                    <input type="text" [(ngModel)]="r.title" [placeholder]="'series.title-ph' | translate" />
                    <input type="text" [(ngModel)]="r.summary" [placeholder]="'series.summary-ph' | translate" />
                  } @else {
                    <span>{{ r.title }}</span>
                  }
                  @if (r.projectId) {
                    <div class="row links">
                      <a [routerLink]="['/project', r.projectId, 'processing']">{{ 'series.open-progress' | translate }}</a>
                      <a [routerLink]="['/project', r.projectId, 'editor']">{{ 'series.open-editor' | translate }}</a>
                      <a [routerLink]="['/project', r.projectId, 'export']">{{ 'series.open-export' | translate }}</a>
                    </div>
                  }
                </li>
              }
            </ol>
            @if (v.state === 'review') {
              <div class="row">
                <button type="button" class="btn" (click)="save()" [disabled]="busy()">{{ 'series.save' | translate }}</button>
                <button type="button" class="btn btn-primary" (click)="makeAndStart()" [disabled]="busy()">{{ 'series.make-start' | translate }}</button>
              </div>
            }
            @if (v.state === 'parts') {
              <div class="row">
                <button type="button" class="btn btn-primary" (click)="startAll()" [disabled]="busy() || allDone()">{{ 'series.start-all' | translate }}</button>
                <button type="button" class="btn" (click)="pauseAll()" [disabled]="busy() || !anyActive()">{{ 'series.pause-all' | translate }}</button>
              </div>
              <p class="hint muted">{{ 'series.all-parts-hint' | translate }}</p>
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
                  <button type="button" class="btn" (click)="rebuild()" [disabled]="busy()">{{ 'series.rebuild' | translate }}</button>
                  <label class="row inline">
                    <input type="checkbox" [(ngModel)]="rebuildForce" />
                    <span>{{ 'series.rebuild-force' | translate }}</span>
                  </label>
                </div>
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
    `,
  ],
})
export class SeriesComponent implements OnInit, OnDestroy {
  readonly id = input.required<string>();
  private readonly ipc = inject(IpcService);

  protected readonly view = signal<SeriesView | null>(null);
  protected readonly rows = signal<Row[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly allDone = computed(() => this.rows().every((r) => r.status === 'completed'));
  protected readonly anyActive = computed(() => this.rows().some((r) => r.status === 'running' || r.status === 'queued'));
  /** What the last series-wide action did, part by part. */
  protected readonly report = signal<string[]>([]);
  protected rebuildForce = false;
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
      const changedState = this.view()?.state !== v.state;
      this.view.set(v);
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
              summary: planned?.summary ?? '',
              ...(p.projectId ? { projectId: p.projectId } : {}),
              ...(p.status ? { status: p.status } : {}),
              ...(p.progressPercent !== undefined ? { progressPercent: p.progressPercent } : {}),
            };
          }),
        );
      }
    } catch (err) {
      this.error.set(toAppError(err));
    }
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
    await this.run(async () => {
      await this.ipc.startSeries(this.id());
      await this.load(true);
    });
  }

  protected startAll(): Promise<boolean> {
    return this.run(async () => {
      await this.ipc.startSeries(this.id());
      await this.load(true);
    });
  }

  /** Pause every part that is dubbing or waiting, in order (they continue in that order). */
  protected pauseAll(): Promise<boolean> {
    return this.run(async () => {
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

  /** Make the parts' transcripts again from the series transcript (after it was fixed). */
  protected rebuild(): Promise<boolean> {
    return this.run(async () => {
      const res = await this.ipc.rebuildSeriesParts(this.view()?.parentId ?? this.id(), this.rebuildForce);
      this.report.set(
        res.parts.map((p) =>
          p.rebuilt
            ? this.translate.instant('series.report-rebuilt', { n: p.index, old: p.oldLines ?? 0, lines: p.newLines ?? 0, speakers: p.speakers ?? 0 })
            : this.translate.instant(`series.report-kept-${p.skipped ?? 'missing'}`, { n: p.index }),
        ),
      );
      await this.load(true);
    });
  }

  protected replan(): Promise<boolean> {
    return this.run(async () => {
      await this.ipc.replanSeries(this.id());
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

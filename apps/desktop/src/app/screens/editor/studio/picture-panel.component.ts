import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { PictureDetection, PictureFrame, ProjectSettings, SubtitleStyle } from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { toAppError } from '../../../core/state/project.store';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { PictureEditorComponent } from '../../../shared/picture/picture-editor.component';
import { applyDetection, coverPatch, percent, pictureChanged, toSettingsRegions, type EditorRegion } from '../../../shared/picture/picture-geometry';
import { StudioStore } from './studio.store';

/**
 * The editor's picture options: watermarks hidden in the render and the band
 * over the source's own subtitles, found by the app (no AI, ~100 frames) and
 * adjusted on a frame. Saved with its own button, like the logo & greeting
 * block; for a series, on every part at once. A finished video needs a
 * render-only redo (the voices and the mix are kept): offered here, for every
 * finished part of a series too.
 */
@Component({
  selector: 'vd-picture-panel',
  standalone: true,
  imports: [FormsModule, TranslatePipe, PictureEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel-block stack">
      <div class="row row-between">
        <h2>{{ 'picture.heading' | translate }}</h2>
        @if (dirty()) {
          <span class="badge badge-warning">{{ 'picture.unsaved' | translate }}</span>
        }
      </div>
      <p class="hint muted">{{ 'picture.intro' | translate }}</p>
      @if (locked()) {
        <p class="hint warn-text">{{ 'picture.running-lock' | translate }}</p>
      }

      <div class="row">
        <button type="button" class="btn btn-sm" (click)="detect()" [disabled]="detecting()">
          @if (detecting()) {
            {{ 'picture.detecting' | translate: { percent: progress() } }}
          } @else {
            {{ (lastResult() ? 'picture.detect-again' : 'picture.detect') | translate }}
          }
        </button>
        <button type="button" class="btn btn-ghost btn-sm" (click)="otherFrame()" [disabled]="loadingFrame()">
          {{ 'picture.frame-other' | translate }}
        </button>
      </div>
      <p class="hint muted">{{ 'picture.detect-hint' | translate }}</p>
      @for (line of found(); track $index) {
        <p class="hint" role="status">{{ line }}</p>
      }
      @if (loadingFrame() && !frame()) {
        <p class="hint muted">{{ 'picture.frame-loading' | translate }}</p>
      }
      @if (frameError(); as e) {
        <p class="hint warn-text">{{ e }}</p>
      }

      <vd-picture-editor
        [frame]="frame()"
        [regions]="regions()"
        [style]="style()"
        [burnedIn]="burnedIn()"
        [disabled]="saving() || locked()"
        (regionsChange)="onRegions($event)"
        (styleChange)="onStyle($event)"
      />

      @if (isSeries()) {
        <label class="check-row">
          <input type="checkbox" [ngModel]="applyToParts()" (ngModelChange)="applyToParts.set($event)" [disabled]="saving()" />
          <span>{{ 'picture.apply-parts' | translate }}</span>
        </label>
        <p class="hint muted">{{ 'picture.apply-parts-hint' | translate }}</p>
      }
      <div class="row">
        <button type="button" class="btn btn-primary btn-sm" (click)="save()" [disabled]="!dirty() || saving() || locked()">
          {{ (saving() ? 'picture.saving' : 'picture.save') | translate }}
        </button>
        @if (canRenderAgain()) {
          <button
            type="button"
            class="btn btn-sm"
            (click)="renderAgain()"
            [disabled]="dirty() || saving() || locked()"
            [title]="'picture.render-again-hint' | translate"
          >
            {{ 'picture.render-again' | translate }}
          </button>
        }
        @if (finishedParts().length > 0) {
          <button type="button" class="btn btn-sm" (click)="renderParts()" [disabled]="dirty() || saving()">
            {{ 'picture.render-parts' | translate: { n: finishedParts().length } }}
          </button>
        }
      </div>
      @if (canRenderAgain()) {
        <p class="hint muted">{{ 'picture.render-again-hint' | translate }}</p>
      }
      @if (notice(); as n) {
        <p class="hint" role="status">{{ n }}</p>
      }
      @for (s of partNotes(); track $index) {
        <p class="hint warn-text">{{ s }}</p>
      }
    </section>
  `,
  styles: [
    `
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--vd-sp-2);
      }
    `,
  ],
})
export class PicturePanelComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  protected readonly store = inject(StudioStore);

  protected readonly frame = signal<PictureFrame | null>(null);
  protected readonly loadingFrame = signal(false);
  protected readonly frameError = signal<string | null>(null);
  protected readonly detecting = signal(false);
  protected readonly progress = signal(0);
  protected readonly lastResult = signal<PictureDetection | null>(null);
  protected readonly found = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly partNotes = signal<string[]>([]);
  protected readonly applyToParts = signal(true);
  protected readonly finishedParts = signal<string[]>([]);

  /** The draft: what the frame shows and Save writes. */
  protected readonly regions = signal<EditorRegion[]>([]);
  protected readonly style = signal<SubtitleStyle | undefined>(undefined);

  private readonly saved = computed(() => {
    const s = this.store.settings();
    return { regions: (s?.blurRegions ?? []) as EditorRegion[], style: s?.burnSubtitleStyle };
  });
  /** Changes not saved yet (the leave-page prompt names them). */
  readonly dirty = computed(() => pictureChanged({ regions: this.regions(), style: this.style() }, this.saved()));
  protected readonly burnedIn = computed(() => this.store.settings()?.subtitleExportMode === 'burned-in');
  /** Settings cannot change under a dub that runs or waits in the queue. */
  protected readonly locked = computed(() => this.store.dubRunning() || this.store.project()?.status === 'queued');
  protected readonly isSeries = computed(() => this.store.project()?.series?.role === 'parent');
  protected readonly canRenderAgain = computed(
    () => !this.isSeries() && this.store.pipeline()?.steps.some((s) => s.id === 'render' && s.status === 'completed') === true,
  );

  private destroyed = false;
  /** Set once the user changes the draft (or takes a detection in); a save clears it. */
  private edited = false;

  constructor() {
    // The saved settings become the draft, unless the user is in the middle
    // of a change (then an outside change, an agent's, waits for Save).
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        if (!this.dirtyAgainst(saved)) return;
        if (this.edited) return;
        this.regions.set(saved.regions.map((r) => ({ ...r })));
        this.style.set(saved.style);
      });
    });
  }

  ngOnInit(): void {
    void this.loadFrame();
    void this.ipc.getPictureDetection(this.store.projectId()).then(
      (job) => this.lastResult.set(job.result ?? null),
      () => undefined,
    );
    if (this.isSeries()) void this.loadFinishedParts();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  private dirtyAgainst(saved: { regions: EditorRegion[]; style: SubtitleStyle | undefined }): boolean {
    return pictureChanged({ regions: this.regions(), style: this.style() }, saved);
  }

  protected onRegions(regions: EditorRegion[]): void {
    this.edited = true;
    this.regions.set(regions);
  }

  protected onStyle(style: SubtitleStyle): void {
    this.edited = true;
    this.style.set(style);
  }

  protected async loadFrame(atMs?: number): Promise<void> {
    this.loadingFrame.set(true);
    this.frameError.set(null);
    try {
      this.frame.set(await this.ipc.pictureFrame(this.store.projectId(), atMs));
    } catch (err) {
      this.frameError.set(this.translate.instant('picture.frame-failed', { why: toAppError(err).message }));
    } finally {
      this.loadingFrame.set(false);
    }
  }

  /** Another moment of the video (somewhere else in the project's stretch). */
  protected otherFrame(): void {
    const f = this.frame();
    const start = f?.windowStartMs ?? 0;
    const end = f?.windowEndMs ?? 0;
    void this.loadFrame(end > start ? Math.round(start + Math.random() * (end - start)) : undefined);
  }

  protected async detect(): Promise<void> {
    if (this.detecting()) return;
    this.detecting.set(true);
    this.progress.set(0);
    this.found.set([]);
    const id = this.store.projectId();
    try {
      let job = await this.ipc.detectPicture(id, { fresh: true });
      while (job.state === 'running') {
        this.progress.set(job.percent ?? 0);
        await new Promise((r) => setTimeout(r, 1500));
        if (this.destroyed) return;
        job = await this.ipc.getPictureDetection(id);
      }
      if (job.state === 'failed' || !job.result) {
        this.found.set([this.translate.instant('picture.detect-failed', { why: job.error?.message ?? '' })]);
        return;
      }
      this.take(job.result);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.detecting.set(false);
    }
  }

  /** A detection into the draft, said in words, on its own frame. */
  private take(result: PictureDetection): void {
    this.lastResult.set(result);
    const next = applyDetection(result, this.style());
    this.regions.set(next.regions);
    this.style.set(next.style);
    this.edited = true;
    const lines: string[] = [];
    if (result.regions.length === 0 && !result.band) {
      lines.push(this.translate.instant('picture.found-none'));
    } else {
      lines.push(this.translate.instant('picture.found-marks', { n: result.regions.length }));
      if (result.band) {
        lines.push(this.translate.instant('picture.found-band', { from: percent(result.band.y), to: percent(result.band.y + result.band.h) }));
        if (result.band.method === 'appearance') lines.push(this.translate.instant('picture.band-guessed'));
      } else {
        lines.push(this.translate.instant('picture.found-no-band'));
      }
      lines.push(this.translate.instant('picture.found-check'));
    }
    this.found.set(lines);
    void this.loadFrame(result.frameAtMs);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.notice.set(null);
    this.partNotes.set([]);
    const id = this.store.projectId();
    const patch = {
      blurRegions: toSettingsRegions(this.regions()),
      // Unset band fields go as null, so the saved style loses them too.
      burnSubtitleStyle: coverPatch(this.style()) as unknown as SubtitleStyle,
    } satisfies Partial<ProjectSettings>;
    try {
      if (this.isSeries() && this.applyToParts()) {
        const res = await this.ipc.updateSeriesSettings(id, patch);
        this.store.adoptProject(res.project, res.pipeline ?? null);
        const parts = res.parts ?? [];
        const ok = parts.filter((p) => p.ok).length;
        this.notice.set(`${this.translate.instant('picture.saved')} ${this.translate.instant('picture.parts-result', { ok, total: parts.length })}`);
        this.partNotes.set(
          parts.filter((p) => !p.ok).map((p) => this.translate.instant('picture.parts-skipped', { n: p.index, why: p.skipped ?? p.error ?? '' })),
        );
        await this.loadFinishedParts();
      } else {
        const res = await this.ipc.updateProjectSettings(id, patch);
        this.store.adoptProject(res.project, res.pipeline ?? null);
        this.notice.set(this.translate.instant('picture.saved'));
      }
      this.edited = false;
      const saved = this.saved();
      this.regions.set(saved.regions.map((r) => ({ ...r, ...this.proposalInfo(r) })));
      this.style.set(saved.style);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.saving.set(false);
    }
  }

  /** What the last detection said about a saved box (its confidence), kept on the list. */
  private proposalInfo(r: EditorRegion): Partial<EditorRegion> {
    const m = this.lastResult()?.regions.find((p) => p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h);
    return m ? { confidence: m.confidence, corner: m.corner, ...(m.fileName ? { fileName: m.fileName } : {}) } : {};
  }

  /** A render-only redo: the picture again, the voices and the mix kept. */
  protected async renderAgain(): Promise<void> {
    try {
      const id = this.store.projectId();
      await this.ipc.retryPipelineStep(id, 'render');
      await this.router.navigate(['/project', id, 'processing']);
    } catch (err) {
      this.store.error.set(toAppError(err));
    }
  }

  private async loadFinishedParts(): Promise<void> {
    try {
      const view = await this.ipc.getSeries(this.store.projectId());
      this.finishedParts.set(view.parts.filter((p) => p.status === 'completed' && p.projectId).map((p) => p.projectId!));
    } catch {
      this.finishedParts.set([]);
    }
  }

  /** Every finished part of the series rendered again, one after another (the queue keeps the order). */
  protected async renderParts(): Promise<void> {
    const ids = this.finishedParts();
    if (ids.length === 0) return;
    const ok = await this.confirm.confirm({
      title: this.translate.instant('picture.render-parts-confirm-title'),
      message: this.translate.instant('picture.render-parts-confirm', { n: ids.length }),
      confirmLabel: this.translate.instant('picture.render-parts-confirm-ok'),
    });
    if (!ok) return;
    let queued = 0;
    for (const id of ids) {
      try {
        await this.ipc.retryPipelineStep(id, 'render');
        queued++;
      } catch (err) {
        this.partNotes.update((n) => [...n, toAppError(err).message]);
      }
    }
    this.notice.set(this.translate.instant('picture.render-parts-queued', { n: queued }));
  }
}

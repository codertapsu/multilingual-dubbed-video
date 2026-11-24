import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, type OnDestroy } from '@angular/core';
import type { PictureDetection, PictureFrame, SubtitleStyle } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { toAppError } from '../../core/state/project.store';
import { PictureEditorComponent } from './picture-editor.component';
import { applyDetection, percent, type EditorRegion } from './picture-geometry';

/**
 * The picture options of New project (More options): the chosen video looked
 * at where it is, before any project exists (POST /picture/detect and
 * /picture/frame), and the boxes and band adjusted on a frame. The host keeps
 * them in the settings the project is created with.
 */
@Component({
  selector: 'vd-picture-setup',
  standalone: true,
  imports: [TranslatePipe, PictureEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack-sm">
      @if (!videoPath().trim()) {
        <p class="hint muted">{{ 'picture.no-video' | translate }}</p>
      } @else if (isLink()) {
        <p class="hint muted">{{ 'picture.link-video' | translate }}</p>
      } @else {
        <div class="row">
          <button type="button" class="btn btn-sm" (click)="detect()" [disabled]="detecting()">
            @if (detecting()) {
              {{ 'picture.detecting' | translate: { percent: progress() } }}
            } @else {
              {{ 'picture.detect' | translate }}
            }
          </button>
          <button type="button" class="btn btn-ghost btn-sm" (click)="loadFrame()" [disabled]="loadingFrame()">
            {{ (frame() ? 'picture.frame-other' : 'picture.show-frame') | translate }}
          </button>
        </div>
        <p class="hint muted">{{ 'picture.detect-hint' | translate }}</p>
        @for (line of found(); track $index) {
          <p class="hint" role="status">{{ line }}</p>
        }
        @if (problem(); as p) {
          <p class="hint warn-text" role="alert">{{ p }}</p>
        }
      }
      <vd-picture-editor
        [frame]="frame()"
        [regions]="regions()"
        [style]="style()"
        [burnedIn]="burnedIn()"
        [disabled]="disabled()"
        (regionsChange)="regionsChange.emit($event)"
        (styleChange)="styleChange.emit($event)"
      />
    </div>
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
export class PictureSetupComponent implements OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);

  /** The video New project holds (a file path, or a link not downloaded yet). */
  readonly videoPath = input('');
  readonly regions = input<readonly EditorRegion[]>([]);
  readonly style = input<SubtitleStyle | undefined>(undefined);
  readonly burnedIn = input(false);
  readonly disabled = input(false);
  readonly regionsChange = output<EditorRegion[]>();
  readonly styleChange = output<SubtitleStyle>();

  protected readonly frame = signal<PictureFrame | null>(null);
  protected readonly loadingFrame = signal(false);
  protected readonly detecting = signal(false);
  protected readonly progress = signal(0);
  protected readonly found = signal<string[]>([]);
  protected readonly problem = signal<string | null>(null);
  protected readonly isLink = computed(() => /^[a-z][a-z0-9+.-]*:\/\//i.test(this.videoPath().trim()));

  private destroyed = false;

  constructor() {
    // Another video: what was found and shown was the old one's.
    effect(() => {
      this.videoPath();
      untracked(() => {
        this.frame.set(null);
        this.found.set([]);
        this.problem.set(null);
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  protected async loadFrame(atMs?: number): Promise<void> {
    const path = this.videoPath().trim();
    if (!path) return;
    this.loadingFrame.set(true);
    this.problem.set(null);
    try {
      const f = this.frame();
      const at = atMs ?? (f && f.windowEndMs > f.windowStartMs ? Math.round(f.windowStartMs + Math.random() * (f.windowEndMs - f.windowStartMs)) : undefined);
      const next = await this.ipc.pictureFrameOfFile(path, at);
      if (path === this.videoPath().trim()) this.frame.set(next);
    } catch (err) {
      this.problem.set(this.translate.instant('picture.frame-failed', { why: toAppError(err).message }));
    } finally {
      this.loadingFrame.set(false);
    }
  }

  protected async detect(): Promise<void> {
    const path = this.videoPath().trim();
    if (!path || this.detecting()) return;
    this.detecting.set(true);
    this.progress.set(0);
    this.found.set([]);
    this.problem.set(null);
    try {
      let job = await this.ipc.detectPictureOfFile(path, { fresh: true });
      while (job.state === 'running') {
        this.progress.set(job.percent ?? 0);
        await new Promise((r) => setTimeout(r, 1500));
        if (this.destroyed || path !== this.videoPath().trim()) return;
        // Asking again follows the same detection.
        job = await this.ipc.detectPictureOfFile(path);
      }
      if (job.state === 'failed' || !job.result) {
        this.problem.set(this.translate.instant('picture.detect-failed', { why: job.error?.message ?? '' }));
        return;
      }
      this.take(job.result);
    } catch (err) {
      this.problem.set(this.translate.instant('picture.detect-failed', { why: toAppError(err).message }));
    } finally {
      this.detecting.set(false);
    }
  }

  private take(result: PictureDetection): void {
    const next = applyDetection(result, this.style());
    this.regionsChange.emit(next.regions);
    if (next.style) this.styleChange.emit(next.style);
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
}

import type {
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../core/environment';
import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import {
  ALL_SUBTITLE_EXPORT_MODES,
  SUBTITLE_EXPORT_MODE_LABELS,
  formatDurationCoarse,
} from '../../core/util/format';
import type {
  AppError,
  RenderFinalVideoResult,
  SubtitleExportMode,
} from '../../core/models';

/**
 * ExportComponent (route "project/:id/export").
 *
 * Shows the final output path, a best-effort <video> preview, an "Open output
 * folder" action, and a control to re-render with a different subtitle mode.
 */
@Component({
  selector: 'vd-export',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent, BusyIndicatorComponent],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent implements OnInit {
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  protected readonly store = inject(ProjectStore);

  protected readonly subtitleModes = ALL_SUBTITLE_EXPORT_MODES;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;
  protected readonly formatDuration = formatDurationCoarse;

  protected readonly result = signal<RenderFinalVideoResult | null>(null);
  protected readonly chosenMode = signal<SubtitleExportMode>('srt-file');
  protected readonly rendering = signal(false);
  protected readonly opening = signal(false);
  protected readonly error = signal<AppError | null>(null);

  /** Output path: prefer a fresh render result, else the persisted project. */
  protected readonly outputPath = computed<string | null>(() => {
    const r = this.result();
    if (r) return r.outputPath;
    const proj = this.store.current();
    return proj ? `${proj.outputDir}/output.mp4` : null;
  });

  /**
   * Preview URL for the final video.
   *
   * LIMITATION: browsers cannot load `file://` paths from an http origin, and
   * the orchestrator may not serve a static file route. We attempt the
   * orchestrator's `/file?path=` route (same convention as the editor audio
   * preview). If unavailable the <video> will fail to load and we show a
   * fallback message — documented in the desktop README.
   */
  protected readonly previewUrl = computed<string | null>(() => {
    const path = this.outputPath();
    if (!path) return null;
    return `${environment.orchestratorUrl}/file?path=${encodeURIComponent(path)}`;
  });

  protected readonly previewFailed = signal(false);

  ngOnInit(): void {
    void this.store.loadProject(this.id()).then((proj) => {
      if (proj) {
        this.chosenMode.set(proj.settings.subtitleExportMode);
      }
    });
  }

  protected setMode(mode: SubtitleExportMode): void {
    this.chosenMode.set(mode);
  }

  /** Re-render the final video with the chosen subtitle mode. */
  protected async rerender(): Promise<void> {
    if (this.rendering()) return;
    this.rendering.set(true);
    this.error.set(null);
    this.previewFailed.set(false);
    try {
      const result = await this.ipc.renderFinalVideo(this.id(), {
        subtitleExportMode: this.chosenMode(),
      });
      this.result.set(result);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.rendering.set(false);
    }
  }

  /** Open the output folder in the OS file manager. */
  protected async openFolder(): Promise<void> {
    const proj = this.store.current();
    const path = proj?.outputDir ?? this.outputPath();
    if (!path || this.opening()) return;
    this.opening.set(true);
    this.error.set(null);
    try {
      await this.ipc.openOutputFolder(path);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.opening.set(false);
    }
  }

  protected onPreviewError(): void {
    this.previewFailed.set(true);
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}

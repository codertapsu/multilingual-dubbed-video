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
import { Router } from '@angular/router';
import type { BrandAsset, BrandingSettings } from '@videodubber/shared';
import { BrandingFormComponent } from '../../shared/branding/branding-form.component';
import { projectOutputVideoPath } from '@videodubber/shared';

import { environment } from '../../core/environment';
import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { OutputFolderComponent } from '../../shared/output-folder/output-folder.component';
import {
  ALL_SUBTITLE_EXPORT_MODES,
  SUBTITLE_EXPORT_MODE_LABELS,
} from '../../core/util/format';
import type {
  AppError,
  Project,
  SubtitleExportMode,
} from '../../core/models';
import { TranslatePipe } from '../../core/i18n';

/**
 * ExportComponent (route "project/:id/export").
 *
 * Shows the final output path, a best-effort <video> preview, an "Open output
 * folder" action, and "Render again" with a different subtitle mode: a run
 * from the mix when edits changed it, else from the render (POST
 * /projects/:id/render), followed on the progress screen like any dub.
 */
@Component({
  selector: 'vd-export',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent, BusyIndicatorComponent, OutputFolderComponent, TranslatePipe, BrandingFormComponent],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent implements OnInit {
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  protected readonly store = inject(ProjectStore);

  protected readonly subtitleModes = ALL_SUBTITLE_EXPORT_MODES;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;

  protected readonly chosenMode = signal<SubtitleExportMode>('srt-file');
  protected readonly rendering = signal(false);
  protected readonly opening = signal(false);
  protected readonly error = signal<AppError | null>(null);

  /** Where the finished video is (or will be). */
  protected readonly outputPath = computed<string | null>(() => {
    const proj = this.store.current();
    // Named after the project in a folder the user chose (pipeline/output.ts).
    return proj ? projectOutputVideoPath(proj) : null;
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

  /** The brand kit, for the Logo & greeting card. */
  protected readonly brandAssets = signal<BrandAsset[]>([]);
  protected readonly savingBranding = signal(false);

  /** Logo & greeting changed: saved at once; Render again uses it (a greeting change remixes). */
  protected async onBrandingChanged(branding: BrandingSettings | undefined): Promise<void> {
    this.savingBranding.set(true);
    this.error.set(null);
    try {
      const res = await this.ipc.updateProjectSettings(this.id(), { branding: branding ?? ({} as BrandingSettings) });
      this.store.setCurrent(res.project);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.savingBranding.set(false);
    }
  }

  ngOnInit(): void {
    void this.ipc.listBrandKit().then((a) => this.brandAssets.set(a), () => undefined);
    void this.store.loadProject(this.id()).then((proj) => {
      if (proj) {
        this.chosenMode.set(proj.settings.subtitleExportMode);
      }
    });
  }

  protected setMode(mode: SubtitleExportMode): void {
    this.chosenMode.set(mode);
  }

  /** Render again with the chosen subtitle mode, then follow it on the progress screen. */
  protected async rerender(): Promise<void> {
    if (this.rendering()) return;
    this.rendering.set(true);
    this.error.set(null);
    this.previewFailed.set(false);
    try {
      await this.ipc.rerender(this.id(), { subtitleExportMode: this.chosenMode() });
      await this.router.navigate(['/project', this.id(), 'processing']);
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

  /** "Save to" changed: the files moved, so the last render's paths are stale. */
  protected onOutputFolderChanged(project: Project): void {
    this.store.setCurrent(project);
    this.previewFailed.set(false);
  }

  protected onPreviewError(): void {
    this.previewFailed.set(true);
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}

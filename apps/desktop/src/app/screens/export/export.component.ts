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
import { Router, RouterLink } from '@angular/router';
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
import { TranslatePipe, TranslateService } from '../../core/i18n';

/**
 * ExportComponent (route "project/:id/export").
 *
 * Shows the finished video (a preview, Play, its folder), or that it is not
 * made yet, and "Render again" with a different subtitle mode: a run from the
 * mix when edits changed it, else from the render (POST /projects/:id/render),
 * followed on the progress screen like any dub.
 */
@Component({
  selector: 'vd-export',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    ErrorBannerComponent,
    BusyIndicatorComponent,
    OutputFolderComponent,
    TranslatePipe,
    BrandingFormComponent,
  ],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent implements OnInit {
  readonly id = input.required<string>();

  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly store = inject(ProjectStore);

  protected readonly subtitleModes = ALL_SUBTITLE_EXPORT_MODES;
  protected readonly subtitleLabels = SUBTITLE_EXPORT_MODE_LABELS;

  protected readonly chosenMode = signal<SubtitleExportMode>('srt-file');
  protected readonly rendering = signal(false);
  protected readonly opening = signal(false);
  protected readonly pausing = signal(false);
  protected readonly error = signal<AppError | null>(null);
  /** Loading the project failed: said, with a Retry (the page used to stay empty). */
  protected readonly loadFailed = signal(false);
  protected readonly reloading = signal(false);

  /** This screen's project: the store holds the previous screen's until this one loads. */
  protected readonly project = computed<Project | null>(() => {
    const p = this.store.current();
    return p?.id === this.id() ? p : null;
  });

  /** Where the finished video is (or will be). */
  protected readonly outputPath = computed<string | null>(() => {
    const proj = this.project();
    // Named after the project in a folder the user chose (pipeline/output.ts).
    return proj ? projectOutputVideoPath(proj) : null;
  });

  /**
   * Preview URL for the final video, through the orchestrator's `/file` route
   * (the webview cannot load `file://` from its http origin).
   */
  protected readonly previewUrl = computed<string | null>(() => {
    const path = this.outputPath();
    if (!path) return null;
    return `${environment.orchestratorUrl}/file?path=${encodeURIComponent(path)}`;
  });

  /**
   * The video has been made: the dub completed, or its render step finished.
   * The page used to show the path of a video that did not exist yet (and,
   * when it would not play, blamed the browser). A series' analysis never
   * makes one. A dub running again reads as "not made yet": its new video is
   * not, and the old one stays in its folder (the header's button opens it).
   */
  protected readonly videoMade = computed(() => {
    const proj = this.project();
    if (!proj || proj.series?.role === 'parent') return false;
    if (proj.status === 'completed') return true;
    const pipeline = this.store.pipeline();
    if (!pipeline || (pipeline.projectId && pipeline.projectId !== proj.id)) return false;
    const render = pipeline.steps.find((s) => s.id === 'render');
    return render?.status === 'completed' || render?.status === 'skipped';
  });

  /** The preview URL the in-app player could not play (a folder change tries the new one). */
  private readonly unplayableUrl = signal<string | null>(null);
  protected readonly previewFailed = computed(() => {
    const url = this.previewUrl();
    return url !== null && this.unplayableUrl() === url;
  });

  /**
   * A dub runs or waits for this project, and the server refuses Render again
   * meanwhile, telling the user to cancel a run the app has no Cancel for.
   */
  protected readonly busy = computed<'running' | 'queued' | null>(() => {
    const status = this.project()?.status;
    return status === 'running' || status === 'queued' ? status : null;
  });

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
    void this.load();
  }

  /** Load the project (and Retry after a failed load). */
  protected async load(): Promise<void> {
    if (this.reloading()) return;
    this.reloading.set(true);
    const failedBefore = this.loadFailed();
    try {
      const proj = await this.store.loadProject(this.id());
      this.loadFailed.set(proj === null);
      if (proj) {
        this.chosenMode.set(proj.settings.subtitleExportMode);
        if (failedBefore) this.error.set(null);
      } else {
        this.error.set(
          this.store.lastError() ?? { code: 'UNKNOWN', message: this.translate.instant('export.load-failed-title') },
        );
      }
    } finally {
      this.reloading.set(false);
    }
  }

  protected setMode(mode: SubtitleExportMode): void {
    this.chosenMode.set(mode);
  }

  /** Render again with the chosen subtitle mode, then follow it on the progress screen. */
  protected async rerender(): Promise<void> {
    if (this.rendering() || this.busy()) return;
    this.rendering.set(true);
    this.error.set(null);
    try {
      await this.ipc.rerender(this.id(), { subtitleExportMode: this.chosenMode() });
      await this.router.navigate(['/project', this.id(), 'processing']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.rendering.set(false);
    }
  }

  /**
   * Pause the dub that holds Render again back (a waiting one leaves the
   * queue). Nothing it has done is lost, and Continue picks it up later.
   */
  protected async pauseDub(): Promise<void> {
    if (this.pausing()) return;
    this.pausing.set(true);
    this.error.set(null);
    try {
      await this.ipc.pausePipeline(this.id());
      await this.store.loadProject(this.id());
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.pausing.set(false);
    }
  }

  /** Open the output folder in the OS file manager. */
  protected openFolder(): Promise<void> {
    const path = this.project()?.outputDir ?? this.outputPath();
    return path ? this.openWithSystem(path) : Promise.resolve();
  }

  /** Play the finished video in the system's video player. */
  protected play(): Promise<void> {
    const path = this.outputPath();
    return path ? this.openWithSystem(path) : Promise.resolve();
  }

  /** The OS opens a file in its default app and a folder in its file manager (open_output_folder). */
  private async openWithSystem(path: string): Promise<void> {
    if (this.opening()) return;
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

  /** "Save to" changed: the files moved, and the preview follows the new path. */
  protected onOutputFolderChanged(project: Project): void {
    this.store.setCurrent(project);
  }

  protected onPreviewFailed(url: string): void {
    this.unplayableUrl.set(url);
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}

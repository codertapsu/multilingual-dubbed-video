import type {
  OnDestroy,
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ClaudeIntegrationService } from '../../core/claude/claude-integration.service';
import { CLAUDE_TIP_DISMISSED_KEY, shouldShowClaudeTip } from '../../core/claude/claude-view';
import { IpcService } from '../../core/ipc/ipc.service';
import { ProjectStore } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import {
  StatusBadgeComponent,
  type BadgeStatus,
} from '../../shared/status-badge/status-badge.component';
import { formatDurationCoarse } from '../../core/util/format';
import type { Project } from '../../core/models';
import type { QueueState } from '../../core/models/setup';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';

/** How often the capacity summary refreshes while dubs are active. */
const QUEUE_POLL_MS = 4000;

/**
 * HomeComponent (route "") — landing screen.
 * Lists recent projects with status badges; lets the user create a new project
 * or open an existing one (routing to the most relevant screen for its state).
 */
@Component({
  selector: 'vd-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, StatusBadgeComponent, RouterLink, TranslatePipe],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly ipc = inject(IpcService);
  protected readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmService);
  private readonly translate = inject(TranslateService);

  protected readonly formatDuration = formatDurationCoarse;

  /** Live scheduler state — drives the "Now dubbing" / "Up next" summary. */
  protected readonly queue = signal<QueueState | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * True when no speech-recognition model is installed.
   *
   * The onboarding wizard can now be SKIPPED (offline, blocked mirror, out of
   * disk), which is safe — creating a project downloads what it needs — but a
   * user who skipped had nothing anywhere telling them the download is still
   * outstanding. This is that standing reminder; it disappears on its own the
   * moment a model lands, from Settings or from their first project.
   */
  protected readonly modelsMissing = signal(false);

  /**
   * A one-time tip that Claude can run VideoDubber: nothing outside Settings
   * said so. Hidden for good once dismissed or the guide is opened, and never
   * shown to a user who already connected a Claude client.
   */
  private readonly claude = inject(ClaudeIntegrationService);
  private readonly claudeTipDismissed = signal(readFlag(CLAUDE_TIP_DISMISSED_KEY));
  protected readonly showClaudeTip = computed(() =>
    shouldShowClaudeTip(this.claudeTipDismissed(), this.claude.status()),
  );

  protected dismissClaudeTip(): void {
    this.claudeTipDismissed.set(true);
    try {
      localStorage.setItem(CLAUDE_TIP_DISMISSED_KEY, '1');
    } catch {
      /* storage unavailable: the tip may come back next launch, harmlessly */
    }
  }

  ngOnInit(): void {
    void this.store.refreshProjects();
    void this.refreshQueue();
    void this.refreshSetupStatus();
    if (!this.claudeTipDismissed()) void this.claude.refresh();
    this.queueTimer = setInterval(() => void this.refreshQueue(), QUEUE_POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.queueTimer) clearInterval(this.queueTimer);
  }

  /** Poll the queue; refresh the project list when the active set changes so
   * the status badges follow along. Best-effort (the summary just hides). */
  private async refreshQueue(): Promise<void> {
    const before = this.activeKey();
    try {
      this.queue.set(await this.ipc.getQueue());
    } catch {
      this.queue.set(null);
      return;
    }
    if (this.activeKey() !== before) void this.store.refreshProjects();
  }

  /** Check whether any Whisper model is on disk. Best-effort: an unreachable
   *  backend must not produce a scary banner of its own (the shell already has
   *  one for that case), so a failure leaves the reminder hidden. */
  private async refreshSetupStatus(): Promise<void> {
    try {
      const status = await this.ipc.setupGetStatus();
      this.modelsMissing.set(status.installed.whisperModels.length === 0);
    } catch {
      this.modelsMissing.set(false);
    }
  }

  /** Identity of the running+queued set, to detect transitions cheaply. */
  private activeKey(): string {
    const q = this.queue();
    if (!q) return '';
    return `${q.running.map((r) => r.projectId).join(',')}|${q.entries.map((e) => e.projectId).join(',')}`;
  }

  protected newProject(): void {
    void this.router.navigate(['/new']);
  }

  /** The project being deleted (one at a time). */
  protected readonly deleting = signal<string | null>(null);

  /** Dubbing or waiting: it must be paused before it can go (the server refuses too). */
  protected isBusy(project: Project): boolean {
    const q = this.queue();
    const scheduled = !!q && (q.running.some((r) => r.projectId === project.id) || q.entries.some((e) => e.projectId === project.id));
    return scheduled || project.status === 'running' || project.status === 'queued';
  }

  /**
   * Delete a project, after saying exactly what goes: its folder in
   * VideoDubber's data, with the finished video when it is saved there. A
   * finished video in a folder the user chose stays: it is theirs.
   */
  protected async deleteProject(project: Project): Promise<void> {
    if (this.deleting() || this.isBusy(project)) return;
    const savesInItsFolder = isInside(project.outputDir, project.workspaceDir);
    const ok = await this.confirm.confirm({
      title: this.translate.instant('home.delete-title'),
      message: [
        this.translate.instant('home.delete-body', { name: project.name }),
        savesInItsFolder
          ? this.translate.instant('home.delete-body-render')
          : this.translate.instant('home.delete-body-kept', { folder: project.outputDir }),
      ].join(' '),
      confirmLabel: this.translate.instant('home.delete-confirm'),
    });
    if (!ok) return;
    this.deleting.set(project.id);
    try {
      await this.store.deleteProject(project.id);
    } finally {
      this.deleting.set(null);
    }
  }

  protected refresh(): void {
    void this.store.refreshProjects();
  }

  /**
   * Open a project at the screen that matches its lifecycle:
   *  - running/paused  -> processing
   *  - completed       -> editor (review/export from there)
   *  - failed          -> processing (to see error + retry)
   *  - created         -> processing (run will start there or via wizard)
   */
  protected open(project: Project): void {
    const id = project.id;
    // A series: its parts, the plan to review, or the analysis' progress.
    if (project.series?.role === 'parent') {
      void this.router.navigate(['/project', id, 'series']);
      return;
    }
    switch (project.status) {
      case 'completed':
        void this.router.navigate(['/project', id, 'editor']);
        break;
      case 'running':
      case 'paused':
      case 'failed':
      case 'created':
      default:
        void this.router.navigate(['/project', id, 'processing']);
        break;
    }
  }

  protected partIndex(project: Project): number {
    return project.series?.role === 'part' ? project.series.index : 0;
  }

  protected partCount(project: Project): number {
    return project.series?.role === 'part' ? project.series.count : 0;
  }

  /** Map a project status to a badge status. */
  protected badgeStatus(project: Project): BadgeStatus {
    return project.status;
  }

  protected dubLabel(project: Project): string {
    const { sourceLanguage, targetLanguage } = project.settings;
    return `${sourceLanguage} → ${targetLanguage}`;
  }
}

/** A '1' flag in localStorage (false when storage is unavailable). */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** `inner` is `outer` or inside it (either slash; Windows paths compare without case). */
function isInside(inner: string, outer: string): boolean {
  const fold = (p: string) => p.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const a = fold(inner);
  const b = fold(outer);
  return a === b || a.startsWith(`${b}/`);
}

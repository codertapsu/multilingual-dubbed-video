import type {
  OnDestroy,
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

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
  imports: [ErrorBannerComponent, StatusBadgeComponent, RouterLink],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly ipc = inject(IpcService);
  protected readonly store = inject(ProjectStore);

  protected readonly formatDuration = formatDurationCoarse;

  /** Live scheduler state — drives the "Now dubbing" / "Up next" summary. */
  protected readonly queue = signal<QueueState | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.store.refreshProjects();
    void this.refreshQueue();
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

  /** Identity of the running+queued set, to detect transitions cheaply. */
  private activeKey(): string {
    const q = this.queue();
    if (!q) return '';
    return `${q.running.map((r) => r.projectId).join(',')}|${q.entries.map((e) => e.projectId).join(',')}`;
  }

  protected newProject(): void {
    void this.router.navigate(['/new']);
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

  /** Map a project status to a badge status. */
  protected badgeStatus(project: Project): BadgeStatus {
    return project.status;
  }

  protected dubLabel(project: Project): string {
    const { sourceLanguage, targetLanguage } = project.settings;
    return `${sourceLanguage} → ${targetLanguage}`;
  }
}

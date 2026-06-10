import type {
  OnInit} from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';

import { ProjectStore } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import {
  StatusBadgeComponent,
  type BadgeStatus,
} from '../../shared/status-badge/status-badge.component';
import { formatDurationCoarse } from '../../core/util/format';
import type { Project } from '../../core/models';

/**
 * HomeComponent (route "") — landing screen.
 * Lists recent projects with status badges; lets the user create a new project
 * or open an existing one (routing to the most relevant screen for its state).
 */
@Component({
  selector: 'vd-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, StatusBadgeComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit {
  private readonly router = inject(Router);
  protected readonly store = inject(ProjectStore);

  protected readonly formatDuration = formatDurationCoarse;

  ngOnInit(): void {
    void this.store.refreshProjects();
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

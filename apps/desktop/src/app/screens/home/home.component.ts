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
import { NgTemplateOutlet } from '@angular/common';
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
import type { Project } from '../../core/models';
import type { QueueState } from '../../core/models/setup';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import {
  PROJECT_FILTERS,
  PROJECT_SORTS,
  clockDuration,
  fileName,
  filterCounts,
  partCaption,
  projectEntries,
  seriesName,
  shortDate,
  type ProjectEntry,
  type ProjectFilter,
  type ProjectSort,
} from './project-list';

/** How often the capacity summary refreshes while dubs are active. */
const QUEUE_POLL_MS = 4000;

/** Entries shown before "Show more" (a series counts as one). */
const PAGE = 30;
/** The list's order, kept between visits. */
const SORT_KEY = 'vd.home.sort';
/** The series the user opened, kept between visits (the last ones only). */
const OPEN_SERIES_KEY = 'vd.home.openSeries';
const OPEN_SERIES_KEPT = 200;

type SeriesEntry = Extract<ProjectEntry, { kind: 'series' }>;

/**
 * HomeComponent (route "") — landing screen.
 * Lists recent projects with status badges; lets the user create a new project
 * or open an existing one (routing to the most relevant screen for its state).
 */
@Component({
  selector: 'vd-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, StatusBadgeComponent, RouterLink, TranslatePipe, NgTemplateOutlet],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly ipc = inject(IpcService);
  protected readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmService);
  private readonly translate = inject(TranslateService);

  /** Lengths as players show them ("48:00", "8:12:00"): "8h 12m 0s" was noise in a long list. */
  protected readonly formatDuration = clockDuration;

  /**
   * The list as shown (project-list.ts): each series one entry with its parts
   * folded under it, searched, narrowed and sorted. A long list of dubs (a
   * 48-part series among them) read as a wall of cards (2026-11-26).
   */
  protected readonly query = signal('');
  protected readonly filter = signal<ProjectFilter>('all');
  protected readonly sort = signal<ProjectSort>(readSort());
  /** Entries shown; "Show more" adds a page. Back to one page whenever the list changes its terms. */
  protected readonly limit = signal(PAGE);
  /** Series opened by the user; one narrowed by a search or a filter opens by itself. */
  private readonly openSeries = signal<ReadonlySet<string>>(readOpenSeries());
  protected readonly filters = PROJECT_FILTERS;
  protected readonly sorts = PROJECT_SORTS;
  protected readonly filterKeys: Record<ProjectFilter, string> = {
    all: 'home.filter-all',
    active: 'home.filter-active',
    attention: 'home.filter-attention',
    finished: 'home.filter-finished',
  };
  protected readonly sortKeys: Record<ProjectSort, string> = {
    recent: 'home.sort-recent',
    name: 'home.sort-name',
    created: 'home.sort-created',
  };
  protected readonly entries = computed(() =>
    projectEntries(this.store.recentProjects(), { query: this.query(), filter: this.filter(), sort: this.sort() }),
  );
  protected readonly shown = computed(() => this.entries().slice(0, this.limit()));
  protected readonly counts = computed(() => filterCounts(this.store.recentProjects()));
  protected readonly fileName = fileName;
  protected readonly seriesName = seriesName;

  protected setQuery(query: string): void {
    this.query.set(query);
    this.limit.set(PAGE);
  }

  protected setFilter(filter: ProjectFilter): void {
    this.filter.set(filter);
    this.limit.set(PAGE);
  }

  protected setSort(sort: ProjectSort): void {
    this.sort.set(sort);
    this.limit.set(PAGE);
    writeSetting(SORT_KEY, sort);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.filter.set('all');
    this.limit.set(PAGE);
  }

  protected showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  protected entryKey(entry: ProjectEntry): string {
    return entry.kind === 'series' ? `series:${entry.parent.id}` : entry.project.id;
  }

  protected isOpen(entry: SeriesEntry): boolean {
    return entry.narrowed || this.openSeries().has(entry.parent.id);
  }

  protected toggleSeries(id: string): void {
    const next = new Set(this.openSeries());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openSeries.set(next);
    writeSetting(OPEN_SERIES_KEY, JSON.stringify([...next].slice(-OPEN_SERIES_KEPT)));
  }

  /** A series before its parts exist: what it is doing, as a key; undefined once the parts are made. */
  protected stageKey(parent: Project): string | undefined {
    const s = parent.series?.role === 'parent' ? parent.series : undefined;
    if (!s || s.state === 'parts') return undefined;
    if (s.state === 'failed' || parent.status === 'failed') return 'home.series-stage-failed';
    if (s.state === 'review') return 'home.series-stage-review';
    if (s.state === 'planning') return 'home.series-stage-planning';
    if (parent.status === 'running') return 'home.series-stage-analysing';
    if (parent.status === 'paused') return 'home.series-stage-paused';
    if (parent.status === 'queued') return 'home.series-stage-queued';
    return 'home.series-stage-not-started';
  }

  /** `part` of `whole` as a width in %. */
  protected pct(part: number, whole: number): number {
    return whole > 0 ? (part / whole) * 100 : 0;
  }

  /** What a part's row says beside "Part N" (project-list.ts partCaption). */
  protected partTitle(part: Project, parent: Project): string {
    return partCaption(part, seriesName(parent));
  }

  /** When the project last changed, as short as it can be told apart, in the app's language. */
  protected changed(project: Project): string {
    return shortDate(project.updatedAt, this.translate.locale());
  }

  /** Live scheduler state — drives the "Now dubbing" / "Up next" summary. */
  protected readonly queue = signal<QueueState | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The list could not be read. An empty list then said "No projects yet",
   * which reads as "my projects are gone" to someone whose backend was only
   * still starting.
   */
  protected readonly listFailed = signal(false);

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
    void this.loadList();
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
    if (this.activeKey() !== before) void this.loadList();
  }

  /** Refresh the list, and remember whether reading it failed. */
  private async loadList(): Promise<void> {
    await this.store.refreshProjects();
    this.listFailed.set(this.store.lastError() !== null);
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
    void this.loadList();
  }

  /**
   * Open a project at the screen that matches its lifecycle:
   *  - running/paused  -> processing
   *  - completed       -> editor (review/export from there)
   *  - failed          -> processing (to see error + retry)
   *  - created         -> processing (its Start dubbing card)
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

/** Keep a setting of the list; storage unavailable only means it is not remembered. */
function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered next time, harmlessly */
  }
}

/** The list's order as last chosen (last changed first by default). */
function readSort(): ProjectSort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    return (PROJECT_SORTS as readonly string[]).includes(saved ?? '') ? (saved as ProjectSort) : 'recent';
  } catch {
    return 'recent';
  }
}

/** The series the user left open. */
function readOpenSeries(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(OPEN_SERIES_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** `inner` is `outer` or inside it (either slash; Windows paths compare without case). */
function isInside(inner: string, outer: string): boolean {
  const fold = (p: string) => p.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const a = fold(inner);
  const b = fold(outer);
  return a === b || a.startsWith(`${b}/`);
}

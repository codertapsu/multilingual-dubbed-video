import { Injectable, computed, inject, signal, type Signal } from '@angular/core';

import { IpcService } from '../ipc/ipc.service';
import type { AppError, PipelineState, Project } from '../models';

/**
 * ProjectStore — signal-based store for:
 *  - the list of all projects (Home screen),
 *  - the currently-open project + its persisted pipeline state.
 *
 * Components call the async refresh methods; rendering reads the signals.
 * Errors are normalized to AppError and surfaced via {@link lastError} so an
 * <vd-error-banner> can render them uniformly.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly ipc = inject(IpcService);

  private readonly _projects = signal<Project[]>([]);
  private readonly _current = signal<Project | null>(null);
  private readonly _pipeline = signal<PipelineState | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<AppError | null>(null);

  readonly projects: Signal<Project[]> = this._projects.asReadonly();
  readonly current: Signal<Project | null> = this._current.asReadonly();
  readonly pipeline: Signal<PipelineState | null> = this._pipeline.asReadonly();
  readonly loading: Signal<boolean> = this._loading.asReadonly();
  readonly lastError: Signal<AppError | null> = this._error.asReadonly();

  /** Projects sorted most-recently-updated first (for the Home list). */
  readonly recentProjects = computed<Project[]>(() =>
    [...this._projects()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

  /** Clear any surfaced error (e.g. when a banner is dismissed). */
  clearError(): void {
    this._error.set(null);
  }

  /** Fetch the full project list. */
  async refreshProjects(): Promise<void> {
    await this.guard(async () => {
      const list = await this.ipc.listProjects();
      this._projects.set(list);
    });
  }

  /**
   * Load a single project (+ pipeline) into `current`/`pipeline`. Returns the
   * loaded project or null on failure.
   */
  async loadProject(projectId: string): Promise<Project | null> {
    let loaded: Project | null = null;
    await this.guard(async () => {
      const { project, pipeline } = await this.ipc.getProject(projectId);
      this._current.set(project);
      this._pipeline.set(pipeline);
      loaded = project;
    });
    return loaded;
  }

  /** Replace the cached pipeline state (e.g. from a live SSE update). */
  setPipeline(pipeline: PipelineState): void {
    this._pipeline.set(pipeline);
  }

  /** Replace the cached current project (e.g. after a probe persists media). */
  setCurrent(project: Project): void {
    this._current.set(project);
    this._projects.update((list) => {
      const idx = list.findIndex((p) => p.id === project.id);
      if (idx === -1) return [...list, project];
      const next = [...list];
      next[idx] = project;
      return next;
    });
  }

  /**
   * Run an async unit of work with shared loading + error handling. Any thrown
   * value is normalized to an AppError and stored in {@link lastError}.
   */
  private async guard(work: () => Promise<void>): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      await work();
    } catch (err) {
      this._error.set(toAppError(err));
    } finally {
      this._loading.set(false);
    }
  }
}

/**
 * Local normalizer mirroring the shared `toAppError`. We keep a UI copy so the
 * store does not depend on runtime exports of the shared package (UI imports
 * types only per the dependency rules). It recognizes the worker error
 * envelope shape and otherwise falls back to UNKNOWN.
 */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, cause: err.stack };
  }
  if (typeof err === 'string') {
    return { code: 'UNKNOWN', message: err };
  }
  return { code: 'UNKNOWN', message: 'An unexpected error occurred.' };
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as { code: unknown }).code === 'string' &&
    typeof (value as { message: unknown }).message === 'string'
  );
}

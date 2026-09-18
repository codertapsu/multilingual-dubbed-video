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
  return recordError(normalizeAppError(err));
}

function normalizeAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, cause: err.stack };
  }
  if (typeof err === 'string') {
    return { code: 'UNKNOWN', message: err };
  }
  return { code: 'UNKNOWN', message: 'An unexpected error occurred.' };
}

/** How many past failures the Help screen's diagnostics bundle can report. */
const RECENT_ERROR_LIMIT = 20;

const recent: string[] = [];

/**
 * Remember every error the user was shown, for the Help screen's "Copy
 * diagnostics".
 *
 * This funnel is the only thing in the app that sees all of them: worker
 * stdout/stderr is discarded by the shell, the Python workers configure no file
 * handler, and the SSE log buffer is cleared on every new stream — so when a
 * user reports "it failed", there is otherwise literally no artifact to look
 * at. In memory only: it dies with the window and never reaches disk or the
 * network unless the user pastes it somewhere.
 */
function recordError(error: AppError): AppError {
  recent.push(`${new Date().toISOString()} ${error.code}: ${error.message}`);
  if (recent.length > RECENT_ERROR_LIMIT) recent.splice(0, recent.length - RECENT_ERROR_LIMIT);
  return error;
}

/** The errors surfaced in this session, oldest first. */
export function recentErrors(): readonly string[] {
  return [...recent];
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

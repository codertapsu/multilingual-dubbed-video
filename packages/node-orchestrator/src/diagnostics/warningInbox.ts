/**
 * Warnings raised outside a run's own code, for the run to pick up: an engine
 * that fell back to its CPU build because the GPU was busy is decided in the
 * engine manager, which knows the owner (the project) but not the pipeline.
 * The runner drains the inbox when a step ends and keeps them with that step
 * (models/diagnostics.ts ProjectWarning).
 */
import type { ProjectWarning } from '@videodubber/shared';

export type InboxWarning = Omit<ProjectWarning, 'at' | 'step'> & { at?: string };

export class WarningInbox {
  private readonly byProject = new Map<string, InboxWarning[]>();

  push(projectId: string, warning: InboxWarning): void {
    const list = this.byProject.get(projectId) ?? [];
    // One of a kind per step is enough: four fallbacks in a minute are one warning.
    if (!list.some((w) => w.code === warning.code && w.message === warning.message)) {
      list.push({ ...warning, at: warning.at ?? new Date().toISOString() });
    }
    this.byProject.set(projectId, list);
  }

  drain(projectId: string): InboxWarning[] {
    const list = this.byProject.get(projectId) ?? [];
    this.byProject.delete(projectId);
    return list;
  }
}

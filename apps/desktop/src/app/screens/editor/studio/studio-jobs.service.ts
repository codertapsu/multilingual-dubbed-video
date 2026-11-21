import { Injectable, inject, signal } from '@angular/core';

import { IpcService } from '../../../core/ipc/ipc.service';
import type { AppError, TimelineDocument } from '../../../core/models';
import { toAppError } from '../../../core/state/project.store';
import { clipOf, unitIndex } from './clips';

/** Where a "voice the changed lines" batch is. */
export interface VoicingProgress {
  done: number;
  total: number;
  /** The clip being voiced right now (null between two). */
  clipId: string | null;
}

/** An open editor of the project, told what the batch does. */
export interface BatchWatcher {
  /** A line was voiced: the timeline read again after it, and that line's clip. */
  voiced(doc: TimelineDocument, clipId: string): void;
  /** The batch stopped on an error. */
  failed(error: AppError): void;
}

/**
 * Editor work that outlives the editor screen.
 *
 * "Voice N changed lines" takes minutes on a long video. It ran in the
 * editor's own store, which goes when the user leaves the editor: the batch
 * went on in the background with nothing showing it, and the editor opened
 * again offered the same batch a second time over the lines still being
 * voiced. Held here, in the app's root, a batch runs to its end whatever
 * screen is open; an open editor of the project shows its progress, gets the
 * timeline after every line and its error, and a batch that failed with no
 * editor open hands its error to the next editor of that project.
 */
@Injectable({ providedIn: 'root' })
export class StudioJobsService {
  private readonly ipc = inject(IpcService);

  private readonly progress = signal<ReadonlyMap<string, VoicingProgress>>(new Map());
  private readonly batches = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, Set<BatchWatcher>>();
  private readonly failures = new Map<string, AppError>();

  /** The project's batch, or null when none runs (reactive: read it in a computed). */
  voicing(projectId: string): VoicingProgress | null {
    return this.progress().get(projectId) ?? null;
  }

  /** Follow the project's batches; returns the unsubscribe. */
  watch(projectId: string, watcher: BatchWatcher): () => void {
    const set = this.watchers.get(projectId) ?? new Set<BatchWatcher>();
    set.add(watcher);
    this.watchers.set(projectId, set);
    return () => {
      set.delete(watcher);
      if (set.size === 0) this.watchers.delete(projectId);
    };
  }

  /** The error of a batch that stopped while no editor of the project was open (taken once). */
  takeFailure(projectId: string): AppError | null {
    const error = this.failures.get(projectId) ?? null;
    this.failures.delete(projectId);
    return error;
  }

  /**
   * Voice every line marked as changed, one at a time (the TTS engine is one
   * worker), reading the timeline again after each: re-voicing one line of a
   * merged clip re-voices all of it, so the list cannot be fixed up front.
   * Joins the project's running batch rather than start a second one.
   * Resolves when it ends; an error goes to the watchers.
   */
  voiceStale(projectId: string, total: number): Promise<void> {
    const running = this.batches.get(projectId);
    if (running) return running;
    const batch = this.run(projectId, Math.max(1, total)).finally(() => {
      this.batches.delete(projectId);
      this.setProgress(projectId, null);
    });
    this.batches.set(projectId, batch);
    return batch;
  }

  private async run(projectId: string, total: number): Promise<void> {
    const report = (doc: TimelineDocument, clipId: string | null): void => {
      const left = doc.segments.filter((s) => s.ttsStale === true).length;
      this.setProgress(projectId, { done: Math.min(total, Math.max(0, total - left)), total, clipId });
    };
    try {
      let doc = await this.ipc.getTimeline(projectId);
      // Bounded: lines the user changes while it runs are voiced too, but a
      // line the server keeps marked must not loop forever.
      for (let guard = 0; guard < total + 5; guard++) {
        const next = doc.segments.find((s) => s.ttsStale === true);
        if (!next) break;
        report(doc, clipOf(next.id, unitIndex(doc.units)));
        const res = await this.ipc.synthesizeSingleSegment(projectId, next.id, {});
        doc = await this.ipc.getTimeline(projectId);
        report(doc, null);
        for (const w of this.watchers.get(projectId) ?? []) w.voiced(doc, res.alignment.segmentId);
      }
    } catch (err) {
      const error = toAppError(err);
      const open = this.watchers.get(projectId);
      if (open?.size) for (const w of open) w.failed(error);
      else this.failures.set(projectId, error);
    }
  }

  private setProgress(projectId: string, value: VoicingProgress | null): void {
    this.progress.update((map) => {
      const next = new Map(map);
      if (value) next.set(projectId, value);
      else next.delete(projectId);
      return next;
    });
  }
}

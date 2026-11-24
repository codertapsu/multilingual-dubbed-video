/**
 * Re-voicing as activity: one entry per batch of lines re-voiced one after
 * another (POST /projects/:id/segments/:segId/tts), whoever sends them: the
 * MCP's regenerate_voices (a call voices lines for ~45 s, and is called again
 * until none is left) or the editor's "voice the changed lines".
 *
 * A batch is the lines one asker (the window, or one agent's session) voices
 * in one project without a pause of more than 90 s; it ends when its last
 * line is voiced (the MCP says how many are left, `x-vd-batch-left`) or after
 * that pause. Followed from the route's requests (activityRoutes.ts' hooks),
 * so neither the route nor the tool had to change for it.
 *
 * WHY: editor re-voicing was invisible outside the editor, and an agent's
 * regenerate_voices invisible everywhere (claude-dubber report, 2026-11-23,
 * R3).
 */
import { toAppError, type ActivityInitiator, type AppError } from '@videodubber/shared';

import { activity, type ActivityHandle, type ActivityRegistry } from './registry.js';

export const REVOICE_IDLE_MS = 90_000;

interface Batch {
  handle: ActivityHandle;
  done: number;
  failed: number;
  inFlight: number;
  /** Lines left, the one being voiced included, as the asker last said. */
  left?: number;
  lastError?: AppError;
  timer?: NodeJS.Timeout;
}

export class RevoiceTracker {
  private readonly batches = new Map<string, Batch>();

  constructor(
    private readonly registry: ActivityRegistry = activity,
    private readonly idleMs = REVOICE_IDLE_MS,
  ) {}

  private key(projectId: string, who: ActivityInitiator): string {
    return `${projectId}|${who.kind}|${who.session ?? ''}`;
  }

  /** A line's re-voicing was asked for. `left`: the lines still to do, this one included, when known. */
  started(projectId: string, who: ActivityInitiator, left?: number): void {
    const key = this.key(projectId, who);
    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        handle: this.registry.start({ kind: 'voices.regenerate', title: 'Re-voicing lines', projectId, initiator: who }),
        done: 0,
        failed: 0,
        inFlight: 0,
      };
      this.batches.set(key, batch);
    }
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = undefined;
    batch.inFlight++;
    if (left !== undefined && Number.isFinite(left) && left >= 1) batch.left = Math.round(left);
  }

  /** That line's re-voicing ended. */
  ended(projectId: string, who: ActivityInitiator, ok: boolean, error?: unknown): void {
    const key = this.key(projectId, who);
    const batch = this.batches.get(key);
    if (!batch) return;
    batch.inFlight = Math.max(0, batch.inFlight - 1);
    if (ok) batch.done++;
    else {
      batch.failed++;
      batch.lastError = toAppError(error ?? 'A line could not be re-voiced.');
    }
    const handled = batch.done + batch.failed;
    const remaining = batch.left !== undefined ? Math.max(0, batch.left - 1) : undefined;
    batch.left = remaining;
    const message =
      `${batch.done} line(s) re-voiced` +
      (batch.failed > 0 ? `, ${batch.failed} failed` : '') +
      (remaining !== undefined ? `, ${remaining} left` : '');
    batch.handle.progress(remaining !== undefined ? (100 * handled) / (handled + remaining) : null, message);
    if (remaining === 0 && batch.inFlight === 0) {
      this.finish(key);
      return;
    }
    if (batch.inFlight === 0) {
      batch.timer = setTimeout(() => this.finish(key), this.idleMs);
      batch.timer.unref?.();
    }
  }

  private finish(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    if (batch.timer) clearTimeout(batch.timer);
    this.batches.delete(key);
    if (batch.done === 0 && batch.failed > 0) {
      batch.handle.fail(batch.lastError ?? 'No line could be re-voiced.');
      return;
    }
    batch.handle.done(`Re-voiced ${batch.done} line(s)${batch.failed > 0 ? `; ${batch.failed} failed` : ''}`);
  }

  /** End every open batch now (the server closing). */
  dispose(): void {
    for (const key of [...this.batches.keys()]) this.finish(key);
  }
}

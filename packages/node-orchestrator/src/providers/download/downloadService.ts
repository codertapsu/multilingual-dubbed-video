import { EventEmitter } from 'node:events';
import path from 'node:path';

import { toAppError, type AppError } from '@videodubber/shared';

import { downloadMedia } from './media.js';
import { requireProviderFor } from './registry.js';
import type { ResolvedSourceVideo, SourceProvider } from './types.js';

/**
 * One download job, and the events it publishes.
 *
 * Modelled on {@link SetupEventBus}: the UI subscribes to an SSE stream rather
 * than polling, and a late subscriber is replayed the current state so the
 * screen is correct after a navigation or a reload mid-download.
 *
 * Provider-agnostic: everything here dispatches through the registry, so a new
 * source needs no change to the job lifecycle, the bus, or the routes.
 */

export type DownloadEvent = (
  | { type: 'progress'; jobId: string; phase: 'video' | 'audio' | 'merging'; percent: number | null }
  | { type: 'done'; jobId: string; filePath: string; title: string }
  | { type: 'error'; jobId: string; error: AppError }
) & {
  /**
   * Set on the catch-up copies sent to a newly connected subscriber.
   *
   * A client can resume a download that is still running, but must NOT
   * resurrect one that already finished: without this flag, opening the screen
   * replays the last job's outcome and greets the user with a stale error for
   * something they never started.
   */
  replay?: boolean;
};

export type DownloadListener = (event: DownloadEvent) => void;

const EVENT_NAME = 'download-event';

/** Live state per job, so a fresh subscriber can be brought up to date. */
interface JobState {
  last: DownloadEvent;
  /** Terminal jobs are retained briefly so a reconnect still sees the outcome. */
  finishedAt?: number;
}

/** How long a finished job stays replayable. */
const RETAIN_MS = 5 * 60 * 1000;

export class DownloadBus {
  private readonly emitter = new EventEmitter();
  private readonly jobs = new Map<string, JobState>();

  constructor() {
    // The SSE route adds one listener per open webview; the default cap of 10
    // would print a spurious leak warning on a screen the user revisits.
    this.emitter.setMaxListeners(64);
  }

  emit(event: DownloadEvent): void {
    const terminal = event.type === 'done' || event.type === 'error';
    this.jobs.set(event.jobId, {
      last: event,
      ...(terminal ? { finishedAt: Date.now() } : {}),
    });
    this.prune();
    this.emitter.emit(EVENT_NAME, event);
  }

  /** Subscribe, replaying the latest state of every live job first. */
  subscribe(listener: DownloadListener): () => void {
    this.prune();
    for (const state of this.jobs.values()) listener({ ...state.last, replay: true });
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  /** Drop finished jobs once nobody could reasonably still care. */
  private prune(now = Date.now()): void {
    for (const [id, state] of this.jobs) {
      if (state.finishedAt !== undefined && now - state.finishedAt > RETAIN_MS) this.jobs.delete(id);
    }
  }
}

export interface DownloadDeps {
  bus: DownloadBus;
  /** Where finished files land. */
  destDir: string;
  ffmpegPath: string;
  /** The providers this build carries. */
  providers: readonly SourceProvider[];
}

/** Look up a pasted link without downloading anything. */
export async function resolveVideo(
  input: string,
  deps: DownloadDeps,
): Promise<ResolvedSourceVideo> {
  return requireProviderFor(deps.providers, input).resolve(input);
}

/**
 * Start a download and return its id immediately; progress arrives on the bus.
 *
 * Deliberately fire-and-forget rather than awaited: a video is hundreds of
 * megabytes, and holding an HTTP request open for the duration means any proxy
 * timeout or webview reload silently kills the download with no way to observe
 * what happened.
 */
export function startDownload(
  input: string,
  page: number,
  deps: DownloadDeps,
  jobId: string,
  qualityId?: string,
): string {
  void (async () => {
    try {
      const provider = requireProviderFor(deps.providers, input);
      const prepared = await provider.prepare(input, page, qualityId);

      const filePath = await downloadMedia(
        {
          videoUrl: prepared.videoUrl,
          ...(prepared.audioUrl ? { audioUrl: prepared.audioUrl } : {}),
          destDir: deps.destDir,
          baseName: prepared.baseName,
          ffmpegPath: deps.ffmpegPath,
          headers: prepared.headers,
        },
        (p) => deps.bus.emit({ type: 'progress', jobId, phase: p.phase, percent: p.percent }),
      );

      deps.bus.emit({ type: 'done', jobId, filePath, title: prepared.title });
    } catch (err) {
      deps.bus.emit({ type: 'error', jobId, error: toAppError(err) });
    }
  })();

  return jobId;
}

/** Default download folder: alongside projects, so it is easy to find. */
export function defaultDownloadDir(configDir: string): string {
  return path.join(configDir, 'downloads');
}

/**
 * The long work the app already follows on its own streams, reported into the
 * activity list too, so one list (GET /activity, the per-project Activity
 * view, the agents) shows all of it: engine installs (/engines/events), model
 * downloads (/setup/events) and video downloads (/download/events). Each
 * follower subscribes to its stream and turns its events into one entry per
 * install, model or download.
 *
 * Who asked: an entry starts at the stream's first event of that piece of
 * work, which is emitted inside the request that asked for it (an Install
 * click, a download_videos call), so the activity context (context.ts) still
 * holds its initiator. What the app resumes by itself after a restart (the
 * download queue read back from disk) is the scheduler's.
 *
 * Progress is passed on when the percentage moves or a few seconds went by:
 * the streams report many times a second, and the activity list is followed
 * live by the window and written to disk (activityLog.ts throttles further).
 */
import path from 'node:path';

import type { AppError, DownloadItem, DownloadQueueEvent, EngineInstallEvent, SetupEvent } from '@videodubber/shared';

import { findPack } from '../engines/enginePackCatalog.js';
import { activity, type ActivityHandle, type ActivityRegistry } from './registry.js';

/** Least time between two progress updates whose percentage did not move. */
const PROGRESS_EVERY_MS = 2000;

interface Open {
  handle: ActivityHandle;
  percent: number | null;
  message: string;
  at: number;
}

/** Pass a progress change on when it moved, or after a while. */
function progressed(o: Open, percent: number | null, message: string, now: number): void {
  const p = percent === null || !Number.isFinite(percent) ? null : Math.round(percent);
  if (p === o.percent && (message === o.message || now - o.at < PROGRESS_EVERY_MS)) return;
  o.percent = p;
  o.message = message;
  o.at = now;
  o.handle.progress(p, message);
}

type Subscribable<E> = { subscribe(listener: (event: E) => void): () => void };

/** Engine-pack installs (Settings → Engines, install_engine, a model the run waits for). */
export function followEngineInstalls(
  bus: Subscribable<EngineInstallEvent>,
  registry: ActivityRegistry = activity,
  nameOf: (packId: string) => string = (id) => findPack(id)?.displayName ?? id,
  now: () => number = Date.now,
): () => void {
  const open = new Map<string, Open>();
  const entry = (packId: string): Open => {
    let o = open.get(packId);
    if (!o) {
      o = { handle: registry.start({ kind: 'engine.install', title: `Installing ${nameOf(packId)}` }), percent: null, message: '', at: 0 };
      open.set(packId, o);
    }
    return o;
  };
  return bus.subscribe((event) => {
    if (event.type === 'log') return;
    const o = entry(event.packId);
    if (event.type === 'progress') progressed(o, event.percent, event.message, now());
    else {
      if (event.type === 'done') o.handle.done('Installed');
      else o.handle.fail(event.error);
      open.delete(event.packId);
    }
  });
}

/** A model item's name (`whisper:large-v3`, `argos:en->vi`, `piper:<voice>`), as Settings words it. */
export function modelLabel(item: string): string {
  const [kind, rest = ''] = item.split(':');
  if (kind === 'whisper') return `speech model ${rest}`;
  if (kind === 'argos') {
    const [from, to] = rest.split('->');
    return `translation pack ${from ?? ''} → ${to ?? ''}`;
  }
  if (kind === 'piper') return `voice ${rest}`;
  return item;
}

/** Model downloads (speech, translation and voice models: setup/installer.ts). */
export function followModelInstalls(bus: Subscribable<SetupEvent>, registry: ActivityRegistry = activity, now: () => number = Date.now): () => void {
  const open = new Map<string, Open>();
  const entry = (item: string): Open => {
    let o = open.get(item);
    if (!o) {
      o = { handle: registry.start({ kind: 'model.install', title: `Downloading the ${modelLabel(item)}` }), percent: null, message: '', at: 0 };
      open.set(item, o);
    }
    return o;
  };
  const settle = (error?: AppError): void => {
    for (const o of open.values()) {
      if (error) o.handle.fail(error);
      else o.handle.done('Downloaded');
    }
    open.clear();
  };
  return bus.subscribe((event) => {
    switch (event.type) {
      case 'progress':
        progressed(entry(event.item), event.percent, event.message, now());
        return;
      case 'item-done': {
        const o = open.get(event.item);
        if (o) {
          o.handle.done('Downloaded');
          open.delete(event.item);
        }
        return;
      }
      case 'done':
        settle();
        return;
      case 'error':
        settle(event.error);
        return;
      default:
        return;
    }
  });
}

/** A download's name: the video's title once the site answered, else what was pasted. */
export const downloadTitle = (item: Pick<DownloadItem, 'input' | 'source'>): string => `Downloading “${item.source?.title ?? item.input}”`;

/** Why a download waits, in a sentence. */
function waitingMessage(item: DownloadItem): string {
  switch (item.heldBy) {
    case 'gpu-heavy':
      return 'Waiting: a dub is using the GPU';
    case 'dubbing':
      return 'Waiting: a dub is running';
    case 'pressure':
      return 'Waiting: the computer is short of memory';
    default:
      return item.retryAt ? `Waiting until ${item.retryAt} (the site limited the downloads)` : 'Waiting its turn';
  }
}

/** Source-video downloads (the Download screen, download_videos; providers/download/queue.ts). */
export function followDownloads(queue: Subscribable<DownloadQueueEvent>, registry: ActivityRegistry = activity, now: () => number = Date.now): () => void {
  const open = new Map<string, Open & { title: string; waiting: boolean }>();
  return queue.subscribe((event) => {
    if (event.type === 'removed') {
      open.get(event.id)?.handle.cancelled('Removed from the list');
      open.delete(event.id);
      return;
    }
    const { item } = event;
    const ended = item.state === 'done' || item.state === 'failed' || item.state === 'cancelled';
    let o = open.get(item.id);
    if (!o) {
      // The list replayed at start-up holds every finished download: history, not work.
      if (ended) return;
      const waiting = item.state === 'queued';
      const title = downloadTitle(item);
      o = {
        handle: registry.start({
          kind: 'download',
          title,
          waiting,
          ...(waiting ? { message: waitingMessage(item) } : {}),
          // What the app resumes by itself after a restart is its own doing.
          ...(event.replay ? { initiator: { kind: 'scheduler' as const } } : {}),
        }),
        percent: null,
        message: '',
        at: 0,
        title,
        waiting,
      };
      open.set(item.id, o);
    }
    const title = downloadTitle(item);
    if (title !== o.title) {
      o.title = title;
      registry.patch(o.handle.id, { title });
    }
    switch (item.state) {
      case 'queued':
        if (!o.waiting) {
          o.waiting = true;
          registry.patch(o.handle.id, { state: 'waiting', message: waitingMessage(item) });
        }
        return;
      case 'resolving':
      case 'downloading':
      case 'merging': {
        o.waiting = false;
        const message = item.state === 'resolving' ? 'Asking the site' : item.state === 'merging' ? 'Joining picture and sound' : `Downloading the ${item.phase ?? 'video'}`;
        progressed(o, item.percent, message, now());
        return;
      }
      case 'done':
        o.handle.done(item.filePath ? `Saved as ${path.basename(item.filePath)}` : 'Downloaded');
        break;
      case 'failed':
        o.handle.fail(item.error ?? 'The download failed.');
        break;
      case 'cancelled':
        o.handle.cancelled('Cancelled');
        break;
    }
    open.delete(item.id);
  });
}

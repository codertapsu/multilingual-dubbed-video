/**
 * The download queue: many links, two at a time, kept on disk.
 *
 * Replaces the one-link, in-memory jobs: a batch (pasted by the user or sent
 * by Mother Claude) survives a restart, an interrupted file continues from its
 * partial bytes, a rate-limited site is waited out instead of failing the
 * batch, and a link asked for twice is the same download (`sourceKey`).
 *
 * Provider-agnostic like the rest of the downloader: it dispatches through the
 * registry, and a provider's `sourceKey` / `prepare` are all it needs.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  AppErrorException,
  toAppError,
  type DownloadItem,
  type DownloadQueueEvent,
  type DownloadRequest,
} from '@videodubber/shared';

import { writeJsonAtomic } from '../../workspace/projectStore.js';
import type { DownloadGate } from './downloadGate.js';
import {
  downloadMediaJob,
  MediaLinkExpiredError,
  partialOutputPath,
  safeFilename,
  uniqueOutputPath,
  type FetchDeps,
} from './media.js';
import { providerFor, requireProviderFor } from './registry.js';
import type { PreparedDownload, SourceProvider } from './types.js';

/** A queue record: the public item plus what only the queue needs. */
interface QueueRecord extends DownloadItem {
  /** Where the file goes (chosen once, so a retry keeps its partials and name). */
  outputPath?: string;
  /** Not before this time (a rate-limit wait). */
  retryAtMs?: number;
  /** Rate-limit waits so far in this try. */
  rateLimitWaits?: number;
  /** Add the video's other parts when this one is looked up (`parts: 'all'`). */
  expandParts?: boolean;
}

interface QueueFile {
  version: 1;
  items: QueueRecord[];
}

export type DownloadQueueListener = (event: DownloadQueueEvent) => void;

export interface DownloadQueueDeps {
  /** The persisted records (`<config>/download-queue.json`). */
  file: string;
  /** Where finished files land (`<projects root>/downloads`); read at each start, so it follows a moved folder. */
  downloadsDir: () => string;
  providers: readonly SourceProvider[];
  ffmpegPath: string;
  ffprobePath?: string;
  /** Downloads at once. */
  concurrency?: number;
  /**
   * How many may run right now, and why fewer (downloadGate.ts: dubbing comes
   * first). Asked at every start; {@link DownloadQueue.reconsider} asks again.
   */
  gate?: () => DownloadGate;
  /** Least time between two downloads starting on the same site. */
  pacingMs?: number;
  /** Waits after a rate limit, then the download fails as rate-limited. */
  rateLimitWaitsMs?: readonly number[];
  /** Media fetch seams (tests). */
  fetch?: FetchDeps;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

/** The result of adding links. */
export interface AddResult {
  /** New downloads. */
  added: DownloadItem[];
  /** Links already in the queue (a failed or cancelled one is retried). */
  existing: DownloadItem[];
  /** Links no provider recognises. */
  rejected: { input: string; error: ReturnType<typeof toAppError> }[];
}

const ACTIVE_STATES = new Set(['resolving', 'downloading', 'merging']);
const FINAL_STATES = new Set(['done', 'failed', 'cancelled']);
/** At most this often per download: a progress event per network chunk flooded every client. */
const PROGRESS_EVERY_MS = 250;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** The public view of a record (what clients and the file's readers see). */
function publicItem(r: QueueRecord): DownloadItem {
  const { outputPath: _o, retryAtMs, rateLimitWaits: _w, expandParts: _e, ...item } = r;
  return retryAtMs !== undefined && r.state === 'queued' ? { ...item, retryAt: new Date(retryAtMs).toISOString() } : item;
}

export class DownloadQueue {
  private readonly items = new Map<string, QueueRecord>();
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<DownloadQueueListener>();
  private readonly lastStartAt = new Map<string, number>();
  private readonly lastProgressAt = new Map<string, number>();
  private readonly cancelling = new Set<string>();
  /** Downloads being paused for a dub (bytes kept, back in line), and why. */
  private readonly holding = new Map<string, NonNullable<DownloadGate['reason']>>();
  /** File names being chosen right now, by download (two of one title must not pick the same). */
  private readonly reserved = new Map<string, string>();
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DownloadQueueDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ------------------------------------------------------------ persistence

  /** Read the records and continue what an app exit interrupted. */
  async load(): Promise<void> {
    let file: Partial<QueueFile> = {};
    try {
      file = JSON.parse(await fsp.readFile(this.deps.file, 'utf8')) as Partial<QueueFile>;
    } catch {
      /* none yet, or unreadable: an empty queue */
    }
    for (const r of file.items ?? []) {
      if (!r?.id || !r.input) continue;
      // Interrupted mid-way: back in line, its partial bytes kept.
      const record: QueueRecord = ACTIVE_STATES.has(r.state) ? { ...r, state: 'queued', percent: r.percent ?? null } : r;
      this.items.set(r.id, record);
    }
    this.pump();
  }

  private persist(): Promise<void> {
    const snapshot: QueueFile = { version: 1, items: [...this.items.values()] };
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.deps.file, snapshot))
      .catch((err: unknown) => this.deps.logger?.warn(`Could not save the download list: ${String(err)}`));
    return this.saving;
  }

  // ----------------------------------------------------------------- events

  /** Subscribe, getting every current download first (`replay`). */
  subscribe(listener: DownloadQueueListener): () => void {
    for (const r of this.items.values()) listener({ type: 'item', item: publicItem(r), replay: true });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DownloadQueueEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* one broken subscriber must not stop the queue */
      }
    }
  }

  private update(id: string, patch: Partial<QueueRecord>, opts: { save?: boolean } = {}): QueueRecord | undefined {
    const current = this.items.get(id);
    if (!current) return undefined;
    const next: QueueRecord = { ...current, ...patch, updatedAt: new Date(this.now).toISOString() };
    for (const key of Object.keys(patch) as (keyof QueueRecord)[]) {
      if (patch[key] === undefined) delete next[key];
    }
    this.items.set(id, next);
    this.emit({ type: 'item', item: publicItem(next) });
    if (opts.save !== false) void this.persist();
    return next;
  }

  // ------------------------------------------------------------------ reads

  /** Every download, newest first. */
  list(): DownloadItem[] {
    return [...this.items.values()].reverse().map(publicItem);
  }

  get(id: string): DownloadItem | undefined {
    const r = this.items.get(id);
    return r ? publicItem(r) : undefined;
  }

  /** Finished downloads' files and the ones being written, for Storage and the folder move. */
  busy(): boolean {
    return this.running.size > 0;
  }

  // ----------------------------------------------------------------- writes

  /**
   * Add links. Each becomes one download; asking for a video that is already
   * in the list returns that one (retrying it when it failed or was
   * cancelled). `allParts`: a multi-part video's other parts are added when
   * the first is looked up.
   */
  async add(requests: readonly DownloadRequest[], opts: { allParts?: boolean } = {}): Promise<AddResult> {
    const result: AddResult = { added: [], existing: [], rejected: [] };
    // A list link (a collection, favourites, an uploader's page) is its videos.
    const expanded: DownloadRequest[] = [];
    for (const req of requests) {
      const provider = req.input ? providerFor(this.deps.providers, req.input.trim()) : undefined;
      if (!provider?.isList?.(req.input.trim()) || !provider.expand) {
        expanded.push(req);
        continue;
      }
      try {
        const list = await provider.expand(req.input.trim());
        for (const v of list?.videos ?? []) {
          expanded.push({ input: v.input, ...(req.targetHeightPx ? { targetHeightPx: req.targetHeightPx } : {}) });
        }
      } catch (err) {
        result.rejected.push({ input: req.input, error: toAppError(err) });
      }
    }
    for (const req of expanded) {
      const input = req.input?.trim() ?? '';
      const provider = input ? providerFor(this.deps.providers, input) : undefined;
      if (!provider) {
        try {
          requireProviderFor(this.deps.providers, input);
        } catch (err) {
          result.rejected.push({ input, error: toAppError(err) });
        }
        continue;
      }
      const key = provider.sourceKey?.(input, req.page);
      const page = req.page ?? (key ? pageOfKey(key) : undefined) ?? 1;
      const same = key ? [...this.items.values()].find((r) => r.sourceKey === key) : undefined;
      if (same) {
        if (same.state === 'failed' || same.state === 'cancelled') this.retry(same.id);
        result.existing.push(publicItem(this.items.get(same.id)!));
        continue;
      }
      const at = new Date(this.now).toISOString();
      const record: QueueRecord = {
        id: `dl_${randomBytes(6).toString('hex')}`,
        input,
        page,
        ...(req.targetHeightPx ? { targetHeightPx: req.targetHeightPx } : {}),
        state: 'queued',
        percent: null,
        ...(key ? { sourceKey: key } : {}),
        attempts: 0,
        createdAt: at,
        updatedAt: at,
        ...(opts.allParts ? { expandParts: true } : {}),
      };
      this.items.set(record.id, record);
      this.emit({ type: 'item', item: publicItem(record) });
      result.added.push(publicItem(record));
    }
    if (result.added.length > 0) await this.persist();
    this.pump();
    return result;
  }

  /** Stop a download (its partial files are removed) or take it out of the line. */
  async cancel(id: string): Promise<DownloadItem> {
    const r = this.require(id);
    if (FINAL_STATES.has(r.state)) return publicItem(r);
    const ctrl = this.running.get(id);
    if (ctrl) {
      this.cancelling.add(id);
      ctrl.abort();
      return publicItem(this.items.get(id)!);
    }
    await this.removePartials(r);
    return publicItem(this.update(id, { state: 'cancelled', percent: null, retryAtMs: undefined })!);
  }

  /** Try a failed or cancelled download again (from its partial bytes when it has them). */
  retry(id: string): DownloadItem {
    const r = this.require(id);
    if (r.state !== 'failed' && r.state !== 'cancelled') return publicItem(r);
    const next = this.update(id, { state: 'queued', error: undefined, retryAtMs: undefined, rateLimitWaits: undefined })!;
    this.pump();
    return publicItem(next);
  }

  /**
   * Take a download off the list. Its partial files go; the finished file too
   * when `deleteFile` (only inside the downloads folder: a project's hard
   * link to it is its own name for the bytes, and stays).
   */
  async remove(id: string, opts: { deleteFile?: boolean } = {}): Promise<void> {
    const r = this.require(id);
    const ctrl = this.running.get(id);
    if (ctrl) {
      this.cancelling.add(id);
      ctrl.abort();
    }
    await this.removePartials(r);
    if (opts.deleteFile && r.filePath && isInside(r.filePath, this.deps.downloadsDir())) {
      await fsp.rm(r.filePath, { force: true }).catch(() => undefined);
    }
    this.items.delete(id);
    this.emit({ type: 'removed', id });
    await this.persist();
  }

  /** Record that a project was made from this download. */
  linkProject(id: string, projectId: string): void {
    const r = this.items.get(id);
    if (!r || r.projectIds?.includes(projectId)) return;
    this.update(id, { projectIds: [...(r.projectIds ?? []), projectId] });
  }

  /**
   * The downloads folder moved with the projects folder: point the finished
   * files at their new place. Only when nothing is downloading (the caller
   * checks {@link busy}).
   */
  async relocate(fromDir: string, toDir: string): Promise<void> {
    for (const r of this.items.values()) {
      const patch: Partial<QueueRecord> = {};
      if (r.filePath && isInside(r.filePath, fromDir)) patch.filePath = path.join(toDir, path.relative(fromDir, r.filePath));
      if (r.outputPath && isInside(r.outputPath, fromDir)) patch.outputPath = path.join(toDir, path.relative(fromDir, r.outputPath));
      if (Object.keys(patch).length > 0) this.items.set(r.id, { ...r, ...patch });
    }
    await this.persist();
  }

  /**
   * Look at the gate again (a dub started or finished a step): pause the
   * downloads it no longer allows, start the ones it does.
   */
  reconsider(): void {
    this.pump();
  }

  /** The app is closing: stop every download where it is; each continues at the next start. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const ctrl of this.running.values()) ctrl.abort();
    await this.persist();
  }

  private require(id: string): QueueRecord {
    const r = this.items.get(id);
    if (!r) {
      throw new AppErrorException('INVALID_VIDEO_LINK', `There is no download "${id}".`, {
        remediation: 'It was removed from the list, or the id is mistyped: GET /downloads lists them.',
      });
    }
    return r;
  }

  private partialPaths(r: QueueRecord): string[] {
    const dir = this.deps.downloadsDir();
    return [
      path.join(dir, `.${r.id}.video.part`),
      path.join(dir, `.${r.id}.audio.part`),
      ...(r.outputPath ? [partialOutputPath(r.outputPath)] : []),
    ];
  }

  private async removePartials(r: QueueRecord): Promise<void> {
    await Promise.allSettled(this.partialPaths(r).map((p) => fsp.rm(p, { force: true })));
  }

  // -------------------------------------------------------------- the line

  private pump(): void {
    if (this.closing) return;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    const gate = this.deps.gate?.();
    const limit = Math.min(this.deps.concurrency ?? 2, gate ? gate.limit : Infinity);
    // Fewer allowed than running: the newest pause first (their bytes stay; each
    // continues from them, after asking the site for fresh links).
    if (this.running.size > limit) {
      for (const id of [...this.running.keys()].slice(limit).reverse()) {
        if (this.holding.has(id) || this.cancelling.has(id)) continue;
        this.holding.set(id, gate?.reason ?? 'dubbing');
        this.running.get(id)?.abort();
      }
    }
    // Say why the waiting ones wait (once, not at every look).
    const why = limit === 0 ? gate?.reason : undefined;
    for (const r of this.items.values()) {
      if (r.state === 'queued' && !this.running.has(r.id) && r.heldBy !== why) this.update(r.id, { heldBy: why }, { save: false });
    }
    let soonest: number | undefined;
    // Oldest first.
    for (const r of this.items.values()) {
      if (this.running.size >= limit) break;
      if (r.state !== 'queued' || this.running.has(r.id)) continue;
      if (r.retryAtMs !== undefined && r.retryAtMs > this.now) {
        soonest = Math.min(soonest ?? Infinity, r.retryAtMs);
        continue;
      }
      void this.run(r.id);
    }
    if (soonest !== undefined) {
      this.pumpTimer = setTimeout(() => this.pump(), Math.max(50, soonest - this.now));
      this.pumpTimer.unref?.();
    }
  }

  /** Space the starts on one site (a burst of lookups is what trips its rate limit). */
  private async pace(providerId: string, signal: AbortSignal): Promise<void> {
    const gap = this.deps.pacingMs ?? 1500;
    const last = this.lastStartAt.get(providerId);
    const at = Math.max(this.now, last === undefined ? 0 : last + gap);
    this.lastStartAt.set(providerId, at);
    const wait = at - this.now;
    if (wait > 0) await (this.deps.sleep ?? defaultSleep)(wait, signal);
  }

  private async run(id: string): Promise<void> {
    const start = this.items.get(id);
    if (!start) return;
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    const signal = ctrl.signal;
    try {
      const provider = requireProviderFor(this.deps.providers, start.input);
      this.update(id, { state: 'resolving', attempts: start.attempts + 1, error: undefined, retryAtMs: undefined, heldBy: undefined });
      await this.pace(provider.id, signal);
      if (signal.aborted) throw new AppErrorException('CANCELLED', 'The download was stopped.');
      let prepared = await provider.prepare(start.input, start.page, start.targetHeightPx);
      if (signal.aborted) throw new AppErrorException('CANCELLED', 'The download was stopped.');
      this.addOtherParts(this.items.get(id)!, prepared);

      const dir = this.deps.downloadsDir();
      const current = this.items.get(id)!;
      let outputPath = current.outputPath;
      if (!outputPath || path.dirname(outputPath) !== dir) {
        outputPath = await uniqueOutputPath(dir, safeFilename(prepared.baseName), (p) => {
          // Taken by another download, or being chosen by one right now:
          // claimed here, before the look at the disk, so two downloads of
          // the same title running side by side get two names.
          const chooser = this.reserved.get(p);
          if (this.claimed(p, id) || (chooser !== undefined && chooser !== id)) return true;
          this.reserved.set(p, id);
          return false;
        });
      }
      this.update(id, {
        state: 'downloading',
        outputPath,
        sourceKey: prepared.source.sourceKey,
        source: prepared.source,
        ...(prepared.heightPx ? { heightPx: prepared.heightPx } : {}),
      });
      this.releaseReservations(id);

      for (let fresh = 0; ; fresh++) {
        try {
          await downloadMediaJob(this.jobFor(id, prepared, outputPath), (p) => this.progress(id, p), {
            ...this.deps.fetch,
            signal,
          });
          break;
        } catch (err) {
          // Signed media links expire: ask the site again (twice) and go on
          // from the bytes already here.
          if (!(err instanceof MediaLinkExpiredError) || fresh >= 2 || signal.aborted) throw err;
          this.deps.logger?.info(`Media links for ${id} expired; asking the site for fresh ones.`);
          await this.pace(provider.id, signal);
          prepared = await provider.prepare(start.input, start.page, start.targetHeightPx);
        }
      }
      // The site's subtitles, saved beside the video (a project can use them
      // instead of speech-to-text: settings.useSourceSubtitles).
      const subtitles = await this.saveSubtitles(prepared, outputPath, signal);
      this.update(id, {
        state: 'done',
        percent: 100,
        phase: undefined,
        filePath: outputPath,
        finishedAt: new Date(this.now).toISOString(),
        rateLimitWaits: undefined,
        ...(subtitles.length > 0 ? { source: { ...prepared.source, subtitles } } : {}),
      });
    } catch (err) {
      await this.settleFailure(id, err, signal);
    } finally {
      this.running.delete(id);
      this.lastProgressAt.delete(id);
      this.releaseReservations(id);
      this.pump();
    }
  }

  /** Drop a download's reservations: the name it chose is in its record now (or it failed). */
  private releaseReservations(id: string): void {
    for (const [p, chooser] of this.reserved) if (chooser === id) this.reserved.delete(p);
  }

  /** Fetch each subtitle track and keep it as `<video name>.<language>.json`; best effort. */
  private async saveSubtitles(
    prepared: PreparedDownload,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<{ language: string; label: string; path: string; ai: boolean }[]> {
    const out: { language: string; label: string; path: string; ai: boolean }[] = [];
    const fetchImpl = this.deps.fetch?.fetchImpl ?? fetch;
    const stem = outputPath.replace(/\.mp4$/i, '');
    for (const track of prepared.subtitleTracks ?? []) {
      try {
        const res = await fetchImpl(track.url, { headers: prepared.headers, signal });
        if (!res.ok) continue;
        const body = await res.text();
        const parsed = JSON.parse(body) as { body?: unknown[] };
        if (!Array.isArray(parsed.body) || parsed.body.length === 0) continue;
        const file = `${stem}.${track.language.replace(/[^\w-]/g, '')}.json`;
        await fsp.writeFile(file, body, 'utf8');
        out.push({ language: track.language, label: track.label, path: file, ai: track.ai });
      } catch {
        /* a subtitle that does not come is just not there */
      }
    }
    return out;
  }

  /** The finished name another download already holds. */
  private claimed(candidate: string, self: string): boolean {
    for (const r of this.items.values()) {
      if (r.id !== self && (r.outputPath === candidate || r.filePath === candidate)) return true;
    }
    return false;
  }

  private jobFor(id: string, prepared: PreparedDownload, outputPath: string) {
    const dir = path.dirname(outputPath);
    return {
      video: { urls: [prepared.videoUrl, ...(prepared.videoFallbackUrls ?? [])], partialPath: path.join(dir, `.${id}.video.part`) },
      ...(prepared.audioUrl
        ? { audio: { urls: [prepared.audioUrl, ...(prepared.audioFallbackUrls ?? [])], partialPath: path.join(dir, `.${id}.audio.part`) } }
        : {}),
      outputPath,
      ffmpegPath: this.deps.ffmpegPath,
      ...(this.deps.ffprobePath ? { ffprobePath: this.deps.ffprobePath } : {}),
      headers: prepared.headers,
      ...(prepared.expectedBytes ? { expectedBytes: prepared.expectedBytes } : {}),
    };
  }

  private progress(id: string, p: { phase: 'video' | 'audio' | 'merging'; percent: number | null; bytesDone?: number; bytesTotal?: number }): void {
    const r = this.items.get(id);
    if (!r) return;
    const merging = p.phase === 'merging';
    const last = this.lastProgressAt.get(id) ?? 0;
    if (!merging && p.percent !== 100 && this.now - last < PROGRESS_EVERY_MS) return;
    this.lastProgressAt.set(id, this.now);
    this.update(
      id,
      {
        state: merging ? 'merging' : 'downloading',
        phase: p.phase,
        percent: p.percent,
        ...(p.bytesDone !== undefined ? { bytesDone: p.bytesDone } : {}),
        ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
      },
      // Progress is not worth a disk write; the partial bytes are the record.
      { save: merging },
    );
  }

  /** A multi-part video asked for whole: its other parts join the line after it. */
  private addOtherParts(r: QueueRecord, prepared: PreparedDownload): void {
    if (!r.expandParts) return;
    this.update(r.id, { expandParts: undefined });
    const { partCount } = prepared.source;
    if (partCount <= 1) return;
    const base = prepared.source.url.replace(/\?p=\d+$/, '');
    const extra: DownloadRequest[] = [];
    for (let page = 1; page <= partCount; page++) {
      if (page === r.page) continue;
      extra.push({ input: `${base}?p=${page}`, page, ...(r.targetHeightPx ? { targetHeightPx: r.targetHeightPx } : {}) });
    }
    void this.add(extra);
  }

  private async settleFailure(id: string, err: unknown, signal: AbortSignal): Promise<void> {
    const r = this.items.get(id);
    if (!r) return;
    if (signal.aborted) {
      if (this.cancelling.delete(id)) {
        this.holding.delete(id);
        await this.removePartials(r);
        this.update(id, { state: 'cancelled', percent: null, phase: undefined });
        return;
      }
      const held = this.holding.get(id);
      if (held) {
        // Paused for a dub: back in line with its bytes; the gate starts it again.
        this.holding.delete(id);
        this.update(id, { state: 'queued', phase: undefined, heldBy: held });
        return;
      }
      // The app is closing: back in line for the next start, partials kept.
      this.update(id, { state: 'queued', phase: undefined });
      return;
    }
    const error = toAppError(err);
    const waits = this.deps.rateLimitWaitsMs ?? [20_000, 45_000, 90_000];
    const waited = r.rateLimitWaits ?? 0;
    if (error.code === 'SOURCE_RATE_LIMITED' && waited < waits.length) {
      const delay = waits[waited]!;
      this.deps.logger?.warn(`${r.source?.title ?? id}: the site is limiting requests; trying again in ${Math.round(delay / 1000)} s.`);
      // The whole site waits, not just this download: the next start would be refused too.
      const site = r.source?.providerId ?? providerFor(this.deps.providers, r.input)?.id;
      if (site) this.lastStartAt.set(site, Math.max(this.lastStartAt.get(site) ?? 0, this.now + delay));
      this.update(id, { state: 'queued', phase: undefined, error, retryAtMs: this.now + delay, rateLimitWaits: waited + 1 });
      return;
    }
    this.update(id, { state: 'failed', phase: undefined, error, rateLimitWaits: undefined });
  }
}

/** The 1-based page in a `…:p2` source key. */
function pageOfKey(key: string): number | undefined {
  const m = /:p(\d+)$/.exec(key);
  return m ? Number(m[1]) : undefined;
}

/** Whether `file` is inside `dir` (case-insensitive on Windows). */
function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

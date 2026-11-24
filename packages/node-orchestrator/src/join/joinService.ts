/**
 * One project from several video files (New project → "Join several videos",
 * MCP `join_videos`): check that they fit together, make the project, and
 * join the files into its input in the background, as a job of the activity
 * list (kind `project.join`).
 *
 * WHY THE APP DOES IT: the 27.8-hour series was five files joined by hand
 * (claude-dubber report, 2026-11-23) and the hand-made join is where it broke:
 * mixed 44.1/48 kHz audio, an audio clock running fast, and a naive async
 * resample that garbled P3/P4 (media-worker join.ts has the details).
 *
 * The project exists from the start, so its id is known at once and its
 * settings or character sheet can be set while it joins. Its input appears
 * only when the join is complete and checked (written as a partial, verified,
 * renamed: an input that exists is whole). Until then the routes refuse to
 * run or probe it (joinRoutes.ts). The join's own record is
 * `input/join.json`: the files, how (copy, or a re-encode the user agreed
 * to), whether to start the dub after. A join the app was closed during
 * starts again at the next start (its partial is discarded), at most three
 * times in a row. One join runs at a time: two would only fight over the disk.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  AppErrorException,
  toAppError,
  type ActivityInitiator,
  type AppError,
  type JoinCheck,
  type JoinFileInfo,
  type JoinMismatch,
  type JoinMode,
  type JoinProjectRequest,
  type JoinProjectResult,
  type JoinState,
  type JoinStatus,
  type Project,
  type ProjectInputFile,
  type RenderQuality,
} from '@videodubber/shared';
import type {
  FfmpegProgress,
  JoinEncodeSample,
  JoinPlan,
  JoinPlanFile,
  JoinProbe,
  JoinTarget,
  JoinVideosOptions,
  VideoEncodePlan,
} from '@videodubber/media-worker';
import type * as MediaWorkerModule from '@videodubber/media-worker';

import { currentInitiator } from '../activity/context.js';
import { formatClock } from '../activity/history.js';
import { activity as appActivity, type ActivityHandle, type ActivityRegistry } from '../activity/registry.js';
import { freeBytes as volumeFreeBytes } from '../engines/diskSpace.js';
import { fileExistsNonEmpty } from '../workspace/paths.js';
import { writeJsonAtomic, type ProjectStore } from '../workspace/projectStore.js';

type MediaWorker = typeof MediaWorkerModule;
let mediaWorker: Promise<MediaWorker> | undefined;
/** The media worker, loaded on first use like the rest of the app's media (server.ts createLazyMediaService). */
const loadMediaWorker = (): Promise<MediaWorker> => (mediaWorker ??= import('@videodubber/media-worker'));

/** What the join does through ffmpeg (injected in tests). */
export interface JoinMedia {
  probe(filePath: string, signal?: AbortSignal): Promise<JoinProbe>;
  join(opts: JoinVideosOptions, signal?: AbortSignal): Promise<{ encoder?: { codec: string } }>;
  /** The encoders a re-encode uses here (as the render chooses them). */
  encodePlan(quality: RenderQuality | undefined, target: JoinTarget): Promise<VideoEncodePlan>;
  /** A short test encode: what a re-encode costs on this computer. */
  measureEncode(file: JoinPlanFile, target: JoinTarget, plan: VideoEncodePlan, scratchPath: string, signal?: AbortSignal): Promise<JoinEncodeSample>;
}

/** {@link JoinMedia} through the media worker's ffmpeg. */
export function ffmpegJoinMedia(): JoinMedia {
  const opts = (signal?: AbortSignal) => (signal ? { signal } : {});
  return {
    probe: async (p, signal) => (await loadMediaWorker()).probeJoinFile(p, opts(signal)),
    join: async (o, signal) => (await loadMediaWorker()).joinVideos(o, opts(signal)),
    encodePlan: async (quality, target) => (await loadMediaWorker()).joinEncodePlan(quality, target),
    measureEncode: async (file, target, plan, scratch, signal) =>
      (await loadMediaWorker()).measureJoinEncode(file, target, plan, scratch, opts(signal)),
  };
}

export interface JoinServiceDeps {
  store: ProjectStore;
  media?: JoinMedia;
  /** Free bytes on the volume holding a folder (undefined: cannot tell). */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /** After a join: probe the project, so it shows its length (orchestrator.probe). */
  probeProject?: (projectId: string) => Promise<unknown>;
  /** Start the dub after the join (join_videos start=true): the server's startWhenReady. */
  startRun?: (projectId: string) => Promise<{ started?: boolean; queued?: boolean; waiting?: boolean }>;
  activity?: ActivityRegistry;
  logger?: { info(msg: string): void; warn(msg: string): void };
  now?: () => number;
}

/** What `input/join.json` holds. */
interface JoinRecord {
  version: 1;
  projectId: string;
  videoPaths: string[];
  mode: JoinMode;
  /** The user agreed to encode the picture again: a re-encode never starts without it. */
  reencodeConfirmed: boolean;
  renderQuality?: RenderQuality;
  startWhenDone: boolean;
  state: JoinState;
  files: ProjectInputFile[];
  totalDurationMs: number;
  startedAt: string;
  endedAt?: string;
  attempts: number;
  /** Starts by the app itself after it was closed mid-join, in a row. */
  autoResumes?: number;
  activityId?: string;
  error?: AppError;
  started?: JoinStatus['started'];
  result?: JoinStatus['result'];
}

/** A join waiting or running in this process. */
interface Job {
  record: JoinRecord;
  /** The project's name, for the activity list. */
  name: string;
  controller: AbortController;
  /** How an abort ends it: the user's cancel, or the app closing (it starts again next time). */
  stopAs: 'cancelled' | 'interrupted';
  handle: ActivityHandle;
  live: { percent: number | null; etaSec?: number; currentFile?: number };
  done: Promise<void>;
}

/** Everything the files say about the join. */
interface Inspection {
  probes: (JoinProbe | undefined)[];
  infos: JoinFileInfo[];
  ok: boolean;
  mode: JoinMode;
  mismatches: JoinMismatch[];
  target?: JoinTarget;
  plan?: JoinPlan;
  files: ProjectInputFile[];
  totalDurationMs: number;
  sizeBytes: number;
  mixedSampleRates: boolean;
}

/** At most this many files in one join. */
export const MAX_JOIN_FILES = 100;
/** Kept free beyond the joined file, for everything else on the drive. */
const DISK_MARGIN_BYTES = 512 * 1024 ** 2;
/** Starts in a row by the app itself before a join stops for the user to look at it. */
const MAX_AUTO_RESUMES = 3;
/** The activity list is told at most this often while a join runs. */
const REPORT_EVERY_MS = 1000;

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
const baseName = (p: string): string => path.basename(p);

/** The paths a request names: 2 to {@link MAX_JOIN_FILES} absolute paths. Pure. */
export function validJoinPaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_JOIN_FILES) {
    throw new AppErrorException('INVALID_EDIT', `Give between 2 and ${MAX_JOIN_FILES} videos to join, in the order they play ("videoPaths").`);
  }
  return raw.map((p) => {
    if (typeof p !== 'string' || !p.trim() || !path.isAbsolute(p.trim())) {
      throw new AppErrorException('INVALID_EDIT', `"${String(p)}" is not a full path to a video file.`, {
        remediation: 'Give each video as a full path, e.g. D:\\Videos\\P1.mp4.',
      });
    }
    return path.resolve(p.trim());
  });
}

/**
 * A project name from the files: what their names share ("持械入大宋" from
 * "持械入大宋 P1" … "持械入大宋 P5"), else the first file's name. Pure.
 */
export function joinedName(paths: readonly string[]): string {
  const names = paths.map((p) => path.parse(p).name);
  const first = names[0] ?? 'Joined videos';
  let prefix = first;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  // "Show P" / "Show - Tập " / "Show_0": the shared part stops inside a part number.
  const trimmed = prefix.replace(/[\s._\-–—([{#]*(?:p|part|ep|tập|phần|第)?\s*\d*$/iu, '').trim();
  return trimmed.length >= 2 ? trimmed : first;
}

/** A mismatch in words, for errors and the plugin ("P3.mp4: 720×1280, the first file 1080×1920"). Pure. */
export function describeMismatch(m: JoinMismatch, names: readonly string[]): string {
  const what: Record<JoinMismatch['field'], string> = {
    codec: 'video codec',
    profile: 'codec profile',
    resolution: 'picture size',
    'frame-rate': 'frame rate',
    'pixel-format': 'pixel format',
    encoding: 'encoder settings',
  };
  return `${names[m.index] ?? `file ${m.index + 1}`}: ${what[m.field]} ${m.value}, the first file ${m.expected}`;
}

export class JoinService {
  private readonly media: JoinMedia;
  private readonly activity: ActivityRegistry;
  private readonly now: () => number;
  /** Joins waiting or running in this process, by project. */
  private readonly jobs = new Map<string, Job>();
  /** join.json as last read or written, by project; null: not a joined project. */
  private readonly records = new Map<string, JoinRecord | null>();
  /** One join at a time: each waits for the one before it. */
  private queue: Promise<void> = Promise.resolve();
  private running: Job | undefined;
  /** The app is closing: nothing new starts. */
  private stopping = false;

  constructor(private readonly deps: JoinServiceDeps) {
    this.media = deps.media ?? ffmpegJoinMedia();
    this.activity = deps.activity ?? appActivity;
    this.now = deps.now ?? Date.now;
  }

  /** Something is joining (or waiting to): the projects folder must not move now. */
  get busy(): boolean {
    return this.jobs.size > 0;
  }

  isJoining(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  // ------------------------------------------------------------------ check

  /**
   * Can these files be joined, how, and at what cost (POST /join/check). A
   * re-encode is timed with a short test encode, so the user sees what it
   * costs before agreeing to it.
   */
  async check(videoPaths: unknown, opts: { renderQuality?: RenderQuality; signal?: AbortSignal } = {}): Promise<JoinCheck> {
    const paths = validJoinPaths(videoPaths);
    const ins = await this.inspect(paths, opts.signal);
    let reencode: JoinCheck['reencode'];
    if (ins.ok && ins.mode === 'reencode' && ins.target && ins.plan) {
      reencode = {
        target: { width: ins.target.width, height: ins.target.height, fps: ins.target.fps },
        ...(await this.estimate(ins, opts.renderQuality, opts.signal)),
      };
    }
    const disk = await this.disk(this.deps.store.projectsDir, this.needBytes(ins, reencode?.estimatedBytes));
    return {
      files: ins.infos,
      ok: ins.ok,
      mode: ins.mode,
      mismatches: ins.mismatches,
      totalDurationMs: ins.totalDurationMs,
      mixedSampleRates: ins.mixedSampleRates,
      ...(reencode ? { reencode } : {}),
      disk,
    };
  }

  // ----------------------------------------------------------------- create

  /**
   * Make the project and start joining into it (POST /projects/join). Refused,
   * before anything is made, when a file cannot be joined, when the picture
   * must be encoded again and the user has not agreed (`reencode: true`), or
   * when the drive has no room for the joined file. `req.series` must already
   * name a usable AI (the route resolves it as POST /projects does).
   */
  async create(req: JoinProjectRequest): Promise<JoinProjectResult> {
    const paths = validJoinPaths(req?.videoPaths);
    if (!req.settings || typeof req.settings !== 'object') {
      throw new AppErrorException('INVALID_EDIT', 'Expected { videoPaths, name, settings }.');
    }
    const name = typeof req.name === 'string' && req.name.trim() ? req.name.trim() : joinedName(paths);
    const ins = await this.inspect(paths);
    if (!ins.ok) throw this.unusable(ins);
    if (ins.mode === 'reencode' && req.reencode !== true) throw this.needsConfirmation(ins);
    const disk = await this.disk(this.deps.store.projectsDir, this.needBytes(ins));
    if (!disk.enough) throw this.diskFull(disk);

    const mw = await loadMediaWorker();
    const ext = mw.joinOutputExtension(ins.mode, ins.probes[0]?.video?.codec);
    const project = await this.deps.store.createProject(
      {
        name,
        inputVideoPath: '',
        settings: req.settings,
        ...(req.outputDir?.trim() ? { outputDir: req.outputDir } : {}),
        ...(req.series ? { series: req.series } : {}),
      },
      { joined: { ext, files: ins.files } },
    );
    const record: JoinRecord = {
      version: 1,
      projectId: project.id,
      videoPaths: paths,
      mode: ins.mode,
      reencodeConfirmed: req.reencode === true,
      ...(req.settings.renderQuality ? { renderQuality: req.settings.renderQuality } : {}),
      startWhenDone: req.start === true,
      state: 'waiting',
      files: ins.files,
      totalDurationMs: ins.totalDurationMs,
      startedAt: new Date(this.now()).toISOString(),
      attempts: 0,
    };
    await this.saveRecord(record);
    this.enqueue(record, project.name, currentInitiator());
    return { project, join: this.statusOf(record) };
  }

  // ------------------------------------------------------ status and control

  /** A joined project's join, live (undefined: not a joined project). */
  async status(projectId: string): Promise<JoinStatus | undefined> {
    const r = await this.record(projectId);
    return r ? this.statusOf(r) : undefined;
  }

  /** Stop a join; the partial is removed. The project stays (join again, or delete it). */
  async cancel(projectId: string): Promise<JoinStatus> {
    const job = this.jobs.get(projectId);
    if (job) {
      job.stopAs = 'cancelled';
      job.controller.abort();
      await job.done;
    }
    const r = await this.record(projectId);
    if (!r) throw this.notJoined(projectId);
    return this.statusOf(r);
  }

  /**
   * Join again after a cancel, a failure, or three interrupted starts.
   * `reencode: true` agrees to a re-encode the files now need.
   */
  async restart(projectId: string, opts: { reencode?: boolean } = {}): Promise<JoinStatus> {
    const running = this.jobs.get(projectId);
    if (running) return this.statusOf(running.record);
    const r = await this.record(projectId);
    if (!r) throw this.notJoined(projectId);
    if (r.state === 'done') {
      throw new AppErrorException('INVALID_EDIT', "This project's videos are already joined.");
    }
    const project = await this.deps.store.getProject(projectId);
    const { error: _e, endedAt: _end, started: _s, result: _r, ...rest } = r;
    const next: JoinRecord = {
      ...rest,
      state: 'waiting',
      reencodeConfirmed: r.reencodeConfirmed || opts.reencode === true,
      startedAt: new Date(this.now()).toISOString(),
      autoResumes: 0,
    };
    await this.saveRecord(next);
    this.enqueue(next, project.name, currentInitiator());
    return this.statusOf(next);
  }

  /**
   * Why this project cannot be run or probed yet (undefined: it can): its
   * videos are still being joined, or the join did not finish.
   */
  async blockReason(projectId: string): Promise<AppErrorException | undefined> {
    const job = this.jobs.get(projectId);
    if (job) {
      const pct = job.live.percent !== null ? ` (${Math.floor(job.live.percent)}%)` : '';
      return new AppErrorException('RUN_IN_PROGRESS', `The videos are still being joined into this project${pct}. The dub can start once that is done.`, {
        remediation: 'Wait for the join to finish (the activity list shows it), or cancel it.',
      });
    }
    const r = await this.record(projectId);
    if (!r || r.state === 'done') return undefined;
    const why = r.state === 'failed' ? `it failed: ${r.error?.message ?? 'unknown error'}` : r.state === 'cancelled' ? 'it was cancelled' : 'it was interrupted';
    return new AppErrorException('INVALID_EDIT', `This project's videos have not been joined (${why}).`, {
      remediation: 'Join them again (POST /projects/:id/join/restart, or join_videos\' get_join), or delete the project.',
    });
  }

  // ------------------------------------------------------------ app lifecycle

  /**
   * At start: joins the app was closed (or died) during start again; one whose
   * file was already complete (renamed just before the app stopped) is
   * finished. Never throws.
   */
  async resumeInterrupted(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.deps.store.listProjects();
    } catch {
      return;
    }
    for (const p of projects) {
      if (!p.inputFiles?.length) continue;
      try {
        const r = await this.record(p.id);
        if (!r || !(r.state === 'running' || r.state === 'waiting' || r.state === 'interrupted')) continue;
        if (this.jobs.has(p.id)) continue;
        if (await fileExistsNonEmpty(p.inputVideoPath)) {
          // Only a complete, checked file is ever renamed into place.
          const size = (await fsp.stat(p.inputVideoPath)).size;
          const { error: _e, ...rest } = r;
          const done: JoinRecord = {
            ...rest,
            state: 'done',
            endedAt: new Date(this.now()).toISOString(),
            result: r.result ?? { durationMs: r.totalDurationMs, sizeBytes: size },
          };
          await this.saveRecord(done);
          await this.afterJoined(done);
          continue;
        }
        if ((r.autoResumes ?? 0) >= MAX_AUTO_RESUMES) {
          await this.saveRecord({
            ...r,
            state: 'failed',
            endedAt: new Date(this.now()).toISOString(),
            error: toAppError(
              new AppErrorException('UNKNOWN', `The join was interrupted ${MAX_AUTO_RESUMES} times in a row when VideoDubber stopped.`, {
                remediation: 'Join the videos again from the project, or delete it.',
              }),
            ),
          });
          continue;
        }
        const next: JoinRecord = { ...r, state: 'waiting', autoResumes: (r.autoResumes ?? 0) + 1 };
        await this.saveRecord(next);
        this.enqueue(next, p.name, { kind: 'scheduler' });
        this.deps.logger?.info(`resuming the join of ${p.id} after a restart`);
      } catch (err) {
        this.deps.logger?.warn(`could not resume the join of ${p.id}: ${toAppError(err).message}`);
      }
    }
  }

  /** The app is closing: stop every join (each starts again at the next start). Bounded. */
  async stopAll(timeoutMs = 4000): Promise<void> {
    this.stopping = true;
    const jobs = [...this.jobs.values()];
    for (const j of jobs) {
      j.stopAs = 'interrupted';
      j.controller.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(jobs.map((j) => j.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  // ------------------------------------------------------------------ the job

  private enqueue(record: JoinRecord, name: string, initiator: ActivityInitiator): void {
    if (this.stopping) return; // closing: the next start resumes it
    const waiting = this.running !== undefined || this.jobs.size > 0;
    const handle = this.activity.start({
      kind: 'project.join',
      title: `Joining ${record.videoPaths.length} videos into "${name}"`,
      projectId: record.projectId,
      initiator,
      ...(waiting ? { waiting: true, message: 'Waiting for another join to finish' } : { message: 'Starting' }),
    });
    record.activityId = handle.id;
    const job: Job = {
      record,
      name,
      controller: new AbortController(),
      stopAs: 'cancelled',
      handle,
      live: { percent: null },
      done: Promise.resolve(),
    };
    this.jobs.set(record.projectId, job);
    job.done = this.queue.then(() => this.runJob(job)).catch(() => undefined);
    this.queue = job.done;
  }

  private async runJob(job: Job): Promise<void> {
    const r = job.record;
    const id = r.projectId;
    const signal = job.controller.signal;
    this.running = job;
    try {
      if (signal.aborted) throw new AppErrorException('CANCELLED', 'Cancelled before it started.');
      r.state = 'running';
      r.attempts += 1;
      await this.saveRecord(r);
      job.handle.progress(null, 'Checking the files');

      // Again now: a file may have changed (or gone) since the project was made.
      const ins = await this.inspect(r.videoPaths, signal);
      if (!ins.ok || !ins.plan) throw this.unusable(ins);
      if (ins.mode === 'reencode' && !r.reencodeConfirmed) throw this.needsConfirmation(ins, true);
      const mw = await loadMediaWorker();
      const output = this.deps.store.paths(id).inputVideo(mw.joinOutputExtension(ins.mode, ins.probes[0]?.video?.codec));
      r.mode = ins.mode;
      r.files = ins.files;
      r.totalDurationMs = ins.totalDurationMs;
      const project = await this.deps.store.getProject(id);
      if (project.inputVideoPath !== output || JSON.stringify(project.inputFiles) !== JSON.stringify(ins.files)) {
        await this.deps.store.saveProject({ ...project, inputVideoPath: output, inputFiles: ins.files });
      }

      // An earlier try's partial is removed before this one writes: its bytes count as free.
      const partialBytes = await fsp.stat(mw.partialPathFor(output)).then((s) => s.size, () => 0);
      const disk = await this.disk(path.dirname(output), this.needBytes(ins), partialBytes);
      if (!disk.enough) throw this.diskFull(disk);

      const plan = ins.plan;
      const encoder = plan.mode === 'reencode' && plan.target ? await this.media.encodePlan(r.renderQuality, plan.target) : undefined;
      const names = plan.files.map((f) => baseName(f.path));
      const t0 = this.now();
      let reportedAt = 0;
      let reportedFile = -1;
      let measured: { durationMs: number; audioDurationMs?: number } | undefined;
      const joined = await this.media.join(
        {
          plan,
          outputPath: output,
          ...(encoder ? { encoder } : {}),
          audioBitrateKbps: mw.joinAudioBitrateKbps(ins.probes.filter((p): p is JoinProbe => p !== undefined)),
          onProgress: (p: FfmpegProgress) => {
            const pos = mw.joinPosition(plan, p);
            const elapsedSec = (this.now() - t0) / 1000;
            const etaSec = pos.fraction > 0.01 && elapsedSec >= 2 ? (elapsedSec * (1 - pos.fraction)) / pos.fraction : undefined;
            job.live = {
              percent: Math.min(99, pos.fraction * 100),
              ...(etaSec !== undefined ? { etaSec: Math.round(etaSec) } : {}),
              currentFile: pos.fileIndex,
            };
            const t = this.now();
            if (t - reportedAt < REPORT_EVERY_MS && pos.fileIndex === reportedFile) return;
            reportedAt = t;
            reportedFile = pos.fileIndex;
            const how = plan.mode === 'reencode' ? ', encoding the picture again' : '';
            job.handle.progress(job.live.percent, `File ${pos.fileIndex + 1} of ${names.length}: ${names[pos.fileIndex]}${how}`, job.live.etaSec);
          },
          verify: async (partial) => {
            measured = await this.verify(partial, ins, signal);
          },
        },
        signal,
      );

      const size = await fsp.stat(output).then((s) => s.size, () => 0);
      const result = {
        durationMs: measured?.durationMs ?? ins.totalDurationMs,
        ...(measured?.audioDurationMs !== undefined ? { audioDurationMs: measured.audioDurationMs } : {}),
        sizeBytes: size,
        ...(joined.encoder ? { encoder: joined.encoder.codec } : {}),
      };
      // The activity list first: the record's state is what callers wait on.
      job.live = { percent: 100 };
      job.handle.done(`Joined ${names.length} videos: ${formatClock(result.durationMs)}, ${gb(size)} GB`);
      r.state = 'done';
      r.endedAt = new Date(this.now()).toISOString();
      delete r.error;
      r.result = result;
      await this.saveRecord(r);
      this.deps.logger?.info(`joined ${names.length} files into ${id} (${plan.mode}, ${formatClock(result.durationMs)})`);
      await this.afterJoined(r);
    } catch (err) {
      if (signal.aborted) {
        job.handle.cancelled(job.stopAs === 'interrupted' ? 'Stopped: VideoDubber is closing (it starts again next time)' : 'Cancelled');
        r.state = job.stopAs;
        delete r.error;
      } else {
        job.handle.fail(err);
        r.state = 'failed';
        r.error = toAppError(err);
        this.deps.logger?.warn(`joining into ${id} failed: ${r.error.message}`);
      }
      r.endedAt = new Date(this.now()).toISOString();
      await this.saveRecord(r).catch(() => undefined);
    } finally {
      this.running = undefined;
      this.jobs.delete(id);
    }
  }

  /**
   * The joined file before it is published: a picture as long as the files
   * together (a damaged file can end the copy early, and ffmpeg still exits
   * 0), and sound as long as the picture.
   */
  private async verify(partial: string, ins: Inspection, signal: AbortSignal): Promise<{ durationMs: number; audioDurationMs?: number }> {
    const got = await this.media.probe(partial, signal);
    const expectedSec = ins.totalDurationMs / 1000;
    const tolerance = Math.max(1, expectedSec * 0.0002) + 0.05 * ins.files.length;
    if (!got.video) throw new AppErrorException('UNKNOWN', 'The joined file came out without a picture.');
    if (Math.abs(got.spanSec - expectedSec) > tolerance) {
      throw new AppErrorException(
        'UNKNOWN',
        `The joined video came out ${formatClock(got.spanSec * 1000)} long instead of ${formatClock(ins.totalDurationMs)}: one of the files may be damaged.`,
        { remediation: 'Check that each video plays to its end, then join again.' },
      );
    }
    if (got.audioSpanSec !== undefined && Math.abs(got.audioSpanSec - got.spanSec) > 0.5) {
      throw new AppErrorException(
        'UNKNOWN',
        `The joined sound came out ${(got.audioSpanSec - got.spanSec).toFixed(1)} s off the picture's length.`,
        { remediation: 'Join again; if it happens again, report it with the diagnostics.' },
      );
    }
    return {
      durationMs: Math.round(got.spanSec * 1000),
      ...(got.audioSpanSec !== undefined ? { audioDurationMs: Math.round(got.audioSpanSec * 1000) } : {}),
    };
  }

  /** After a join: the project's length, and the dub when it was asked for. */
  private async afterJoined(r: JoinRecord): Promise<void> {
    try {
      await this.deps.probeProject?.(r.projectId);
    } catch (err) {
      this.deps.logger?.warn(`probing ${r.projectId} after its join failed: ${toAppError(err).message}`);
    }
    if (!r.startWhenDone || r.started || !this.deps.startRun || this.stopping) return;
    try {
      const res = await this.deps.startRun(r.projectId);
      r.started = {
        ...(res.started ? { started: true } : {}),
        ...(res.queued ? { queued: true } : {}),
        ...(res.waiting ? { waiting: true } : {}),
      };
    } catch (err) {
      r.started = { error: toAppError(err) };
    }
    await this.saveRecord(r).catch(() => undefined);
  }

  // ------------------------------------------------------------------ helpers

  /** Probe every file (four at a time) and work out the join. */
  private async inspect(paths: readonly string[], signal?: AbortSignal): Promise<Inspection> {
    const mw = await loadMediaWorker();
    const probes: (JoinProbe | undefined)[] = new Array(paths.length).fill(undefined);
    const errors: (AppError | undefined)[] = new Array(paths.length).fill(undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= paths.length) return;
        try {
          probes[i] = await this.media.probe(paths[i]!, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          errors[i] = toAppError(err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, () => worker()));

    const infos: JoinFileInfo[] = paths.map((p, i) => {
      const probe = probes[i];
      const name = baseName(p);
      let error = errors[i];
      if (!error && probe && !probe.video) {
        error = { code: 'UNSUPPORTED_MEDIA', message: `${name} has no picture to join.` };
      } else if (!error && probe && !(probe.spanSec > 0)) {
        error = { code: 'UNSUPPORTED_MEDIA', message: `The length of ${name} could not be read.` };
      }
      const display = probe?.video ? mw.displaySize(probe.video) : undefined;
      return {
        path: p,
        name,
        sizeBytes: probe?.sizeBytes ?? 0,
        durationMs: Math.round((probe?.spanSec ?? 0) * 1000),
        ...(probe?.video && display
          ? {
              video: {
                codec: probe.video.codec,
                ...(probe.video.profile ? { profile: probe.video.profile } : {}),
                width: display.width,
                height: display.height,
                fps: probe.video.fps,
                ...(probe.video.pixFmt ? { pixFmt: probe.video.pixFmt } : {}),
              },
            }
          : {}),
        ...(probe?.audio ? { audio: { codec: probe.audio.codec, sampleRate: probe.audio.sampleRate, channels: probe.audio.channels } } : {}),
        ...(error ? { error } : {}),
      };
    });
    const ok = infos.every((f) => !f.error);
    const usable = probes.filter((p): p is JoinProbe => p !== undefined && p.video !== undefined);
    const mismatches = ok ? mw.compareJoinFiles(usable) : [];
    const mode: JoinMode = mismatches.length > 0 ? 'reencode' : 'copy';
    const target = mode === 'reencode' ? mw.joinTarget(usable) : undefined;
    const plan = ok ? mw.planJoin(usable, mode, target) : undefined;
    const bounds = plan ? mw.joinBoundariesMs(plan) : [];
    const files: ProjectInputFile[] = plan
      ? plan.files.map((f, i) => ({ path: f.path, name: baseName(f.path), startMs: bounds[i]!.startMs, durationMs: bounds[i]!.durationMs }))
      : [];
    const totalDurationMs = plan
      ? Math.round(plan.files.reduce((sum, f) => sum + f.spanSec, 0) * 1000)
      : infos.reduce((sum, f) => sum + f.durationMs, 0);
    const rates = new Set(usable.map((p) => p.audio?.sampleRate).filter((r): r is number => !!r));
    return {
      probes,
      infos,
      ok,
      mode,
      mismatches,
      ...(target ? { target } : {}),
      ...(plan ? { plan } : {}),
      files,
      totalDurationMs,
      sizeBytes: infos.reduce((sum, f) => sum + f.sizeBytes, 0),
      mixedSampleRates: rates.size > 1,
    };
  }

  /** Time a short test encode of the longest file: the re-encode's cost here. */
  private async estimate(
    ins: Inspection,
    quality: RenderQuality | undefined,
    signal?: AbortSignal,
  ): Promise<{ encoder?: string; estimatedSec?: number; estimatedBytes?: number }> {
    if (!ins.plan || !ins.target) return {};
    let plan: VideoEncodePlan | undefined;
    try {
      plan = await this.media.encodePlan(quality, ins.target);
      const longest = ins.plan.files.reduce((a, b) => (b.spanSec > a.spanSec ? b : a));
      const scratch = path.join(os.tmpdir(), `vd-join-sample-${crypto.randomBytes(6).toString('hex')}.mp4`);
      const sample = await this.media.measureEncode(longest, ins.target, plan, scratch, signal);
      const totalSec = ins.totalDurationMs / 1000;
      return {
        encoder: sample.encoder,
        // Every file is also decoded and its sound encoded: a little more than the picture alone.
        estimatedSec: Math.round((totalSec / Math.max(0.01, sample.speed)) * 1.15),
        estimatedBytes: Math.round(sample.bytesPerSec * totalSec + (192_000 / 8) * totalSec),
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      this.deps.logger?.warn(`could not time a test encode: ${toAppError(err).message}`);
      return plan ? { encoder: plan.primary.codec } : {};
    }
  }

  /** Bytes the joined file needs: about the files together for a copy, the estimate for a re-encode. */
  private needBytes(ins: Inspection, estimatedBytes?: number): number {
    const base = ins.mode === 'copy' ? ins.sizeBytes * 1.02 : (estimatedBytes ?? ins.sizeBytes) * 1.15;
    return Math.round(base) + DISK_MARGIN_BYTES;
  }

  private async disk(folder: string, needBytes: number, reclaimableBytes = 0): Promise<JoinCheck['disk']> {
    const free = await (this.deps.freeBytes ?? volumeFreeBytes)(folder).catch(() => undefined);
    const available = free === undefined ? undefined : free + reclaimableBytes;
    return { folder, needBytes, ...(available !== undefined ? { freeBytes: available } : {}), enough: available === undefined || available >= needBytes };
  }

  private diskFull(disk: JoinCheck['disk']): AppErrorException {
    return new AppErrorException(
      'DISK_FULL',
      `Joining these videos needs about ${gb(disk.needBytes)} GB free in ${disk.folder} (the joined video is about as big as the files together); ${gb(disk.freeBytes ?? 0)} GB is free.`,
      { remediation: 'Free some space on that drive, or move the projects to a bigger drive (Settings → Projects folder), then try again.' },
    );
  }

  private unusable(ins: Inspection): AppErrorException {
    const problems = ins.infos.filter((f) => f.error).map((f) => `${f.name}: ${f.error!.message}`);
    return new AppErrorException('UNSUPPORTED_MEDIA', `These videos cannot be joined: ${problems.join('; ') || 'a file could not be read'}.`, {
      remediation: 'Check that each file exists, plays, and has a picture; then try again.',
    });
  }

  private needsConfirmation(ins: Inspection, changed = false): AppErrorException {
    const names = ins.infos.map((f) => f.name);
    const shown = ins.mismatches.slice(0, 5).map((m) => describeMismatch(m, names));
    return new AppErrorException(
      'INVALID_EDIT',
      `${changed ? 'The videos changed since the project was made: they' : 'These videos'} differ (${shown.join('; ')}${ins.mismatches.length > 5 ? '; …' : ''}), so joining them means encoding the picture again, which takes a while.`,
      { remediation: 'Check the cost first (POST /join/check, or the check in New project), then agree to the re-encode (reencode: true).' },
    );
  }

  private notJoined(projectId: string): AppErrorException {
    return new AppErrorException('UNKNOWN', `Project ${projectId} was not made by joining videos.`);
  }

  private statusOf(r: JoinRecord): JoinStatus {
    const live = this.jobs.get(r.projectId)?.live;
    const percent = r.state === 'done' ? 100 : r.state === 'running' ? (live?.percent ?? null) : null;
    return {
      projectId: r.projectId,
      state: r.state,
      mode: r.mode,
      files: r.files,
      totalDurationMs: r.totalDurationMs,
      percent: percent === null ? null : Math.round(percent * 10) / 10,
      ...(r.state === 'running' && live?.etaSec !== undefined ? { etaSec: live.etaSec } : {}),
      ...(r.state === 'running' && live?.currentFile !== undefined ? { currentFile: live.currentFile } : {}),
      startedAt: r.startedAt,
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      attempts: r.attempts,
      ...(r.activityId ? { activityId: r.activityId } : {}),
      ...(r.error ? { error: r.error } : {}),
      startWhenDone: r.startWhenDone,
      ...(r.started ? { started: r.started } : {}),
      ...(r.result ? { result: r.result } : {}),
    };
  }

  private recordPath(projectId: string): string {
    return path.join(this.deps.store.paths(projectId).inputDir, 'join.json');
  }

  /** join.json, cached; undefined for a project not made by joining. */
  private async record(projectId: string): Promise<JoinRecord | undefined> {
    const live = this.jobs.get(projectId);
    if (live) return live.record;
    if (this.records.has(projectId)) return this.records.get(projectId) ?? undefined;
    try {
      const r = JSON.parse(await fsp.readFile(this.recordPath(projectId), 'utf8')) as JoinRecord;
      if (r?.version !== 1 || r.projectId !== projectId) return undefined;
      this.records.set(projectId, r);
      return r;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.records.set(projectId, null);
      return undefined;
    }
  }

  /** Write join.json (atomically), unless the project is gone: never a stray folder for a deleted one. */
  private async saveRecord(r: JoinRecord): Promise<void> {
    this.records.set(r.projectId, r);
    if (!(await this.deps.store.exists(r.projectId))) return;
    await writeJsonAtomic(this.recordPath(r.projectId), r);
  }
}

/**
 * Finding a project's watermark and the band of its source's own subtitles
 * (picture options 4.2 / 4.3), as a JOB: ~100 frames take 10–60 s, longer
 * than an MCP call should wait, so a request starts it (or joins the one
 * running) and waits a while; the rest is followed with GET, and the activity
 * list shows it whoever asked (activity/registry.ts).
 *
 * The work itself is the media worker's (`detectPicture`): frames by fast
 * seeks, statistics, no AI. This module decides WHAT to look at: the
 * project's window of the input (a series part's), file by file for a source
 * joined from several (Project.inputFiles; a part reads its parent's), and the
 * transcript's lines in the input's time, so frames during speech can be told
 * from frames in silence. A project's result is kept in
 * `<workspace>/picture/detection.json` beside the frame and preview it names
 * (JSON, so a projects-folder move rebases its paths).
 *
 * AI ON REQUEST: nothing here calls a model. `ai: true` asks the optional
 * {@link PictureDetectionDeps.aiCheck} hook to look at the preview (a box to
 * confirm, a mark that moves); without one the result says so, and over MCP
 * the agent can look at `previewPath` itself.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AppErrorException,
  toAppError,
  type PictureDetection,
  type PictureDetectionJob,
  type PictureFrame,
  type Project,
  type TranscriptSegment,
} from '@videodubber/shared';

import { activity as appActivity, type ActivityRegistry } from '../activity/registry.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** What the media worker is asked to look at (its DetectPictureInput). */
export interface PictureDetectInput {
  videoPath: string;
  segments?: { startMs: number; endMs?: number; fileName?: string }[];
  lines?: { startMs: number; endMs: number }[];
  watermark?: boolean;
  band?: boolean;
  frames?: number;
  outputDir?: string;
}

/** The media worker's picture functions (loaded when first used). */
export interface PictureDetector {
  detect(
    input: PictureDetectInput,
    opts: { signal?: AbortSignal; onProgress?: (fraction: number, message: string) => void },
  ): Promise<PictureDetection>;
  /** One JPEG at `atMs` (long side 960). */
  frame(videoPath: string, atMs: number, output: string, signal?: AbortSignal): Promise<{ path: string; width: number; height: number }>;
  /** The picture's length (0 when unknown). */
  videoLength(videoPath: string): Promise<number>;
}

/** The loose view of `@videodubber/media-worker` this module uses (see mediaAdapter.ts for why loose). */
interface MediaWorkerPicture {
  detectPicture?: (input: PictureDetectInput, opts?: { signal?: AbortSignal; onProgress?: (f: number, m: string) => void }) => Promise<PictureDetection>;
  renderPictureFrame?: (videoPath: string, atMs: number, output: string, opts?: { signal?: AbortSignal }) => Promise<{ path: string; width: number; height: number }>;
  probeVideoLengthMs?: (videoPath: string) => Promise<number>;
}

/** The real detector: the media worker's functions, imported on first use. */
export function mediaWorkerDetector(): PictureDetector {
  let loading: Promise<MediaWorkerPicture> | undefined;
  const load = async (): Promise<Required<MediaWorkerPicture>> => {
    loading ??= import('@videodubber/media-worker') as Promise<MediaWorkerPicture>;
    const mod = await loading;
    if (!mod.detectPicture || !mod.renderPictureFrame || !mod.probeVideoLengthMs) {
      throw new AppErrorException('UNKNOWN', 'The media worker cannot look at pictures (it is older than this app).', {
        remediation: 'Rebuild the app (pnpm --filter @videodubber/media-worker build) or reinstall VideoDubber.',
      });
    }
    return mod as Required<MediaWorkerPicture>;
  };
  return {
    detect: async (input, opts) => (await load()).detectPicture(input, opts),
    frame: async (videoPath, atMs, output, signal) => (await load()).renderPictureFrame(videoPath, atMs, output, signal ? { signal } : {}),
    videoLength: async (videoPath) => (await load()).probeVideoLengthMs(videoPath),
  };
}

/** What the service needs from the project store. */
export interface PictureProjectStore {
  getProject(projectId: string): Promise<Project>;
  paths(projectId: string): { sourceJson: string };
}

export interface PictureDetectionDeps {
  store: PictureProjectStore;
  detector?: PictureDetector;
  activity?: Pick<ActivityRegistry, 'start'>;
  /**
   * The AI check, asked only when a request says `ai: true` (a box to
   * confirm, a moving mark). Not wired today: none of the detection needs it.
   */
  aiCheck?: (detection: PictureDetection, project?: Project) => Promise<PictureDetection>;
  /** A finished result is handed out again for this long unless `fresh` (default 10 min). */
  reuseMs?: number;
}

export interface StartDetection {
  /** Look again even when a recent result exists. */
  fresh?: boolean;
  /** Wait up to this long (ms, ≤ 55 s) for it to finish before answering. */
  waitMs?: number;
  /** Ask the AI hook too (see the module doc). */
  ai?: boolean;
}

interface Job {
  state: 'running' | 'done' | 'failed';
  percent: number;
  message?: string;
  startedAt: string;
  endedAt?: number;
  result?: PictureDetection;
  error?: PictureDetectionJob['error'];
  activityId?: string;
  promise: Promise<void>;
}

const MAX_WAIT_MS = 55_000;
const DETECTION_FILE = 'detection.json';

/** The project's picture folder: the frame, the preview, the result. */
export function pictureDirOf(project: Pick<Project, 'workspaceDir'>): string {
  return path.join(project.workspaceDir, 'picture');
}

/** A short sentence of what was found, for the activity list. Pure. */
export function detectionSummary(d: PictureDetection): string {
  const marks = d.regions.length === 0 ? 'no watermark' : d.regions.length === 1 ? '1 watermark' : `${d.regions.length} watermarks`;
  const band = d.band
    ? `the subtitle band at ${Math.round(d.band.y * 100)}–${Math.round((d.band.y + d.band.h) * 100)} % of the height`
    : 'no subtitle band';
  return `${marks}, ${band} (${d.frames} frames)`;
}

/**
 * What to look at in a project: its window of the input (a part's), file by
 * file when the source was joined from several (the part's parent holds the
 * list), and the transcript's lines moved to the input's time. Pure.
 */
export function projectDetectInput(
  project: Project,
  opts: { parent?: Project; lines?: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[]; outputDir?: string },
): PictureDetectInput {
  const offset = project.sourceRange?.startMs ?? 0;
  const windowStart = offset;
  const windowEnd = project.sourceRange?.endMs;
  const files = project.inputFiles ?? opts.parent?.inputFiles;
  let segments: PictureDetectInput['segments'];
  if (files && files.length > 1) {
    segments = files
      .map((f) => ({
        startMs: Math.max(f.startMs, windowStart),
        endMs: windowEnd !== undefined ? Math.min(f.startMs + f.durationMs, windowEnd) : f.startMs + f.durationMs,
        fileName: f.name,
      }))
      .filter((s) => s.endMs > s.startMs);
  }
  if (!segments || segments.length === 0) segments = [{ startMs: windowStart, ...(windowEnd !== undefined ? { endMs: windowEnd } : {}) }];
  const lines = (opts.lines ?? [])
    .filter((l) => Number.isFinite(l.startMs) && Number.isFinite(l.endMs) && l.endMs > l.startMs)
    .map((l) => ({ startMs: l.startMs + offset, endMs: l.endMs + offset }));
  return {
    videoPath: project.inputVideoPath,
    segments,
    ...(lines.length > 0 ? { lines } : {}),
    ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
  };
}

async function readLines(file: string): Promise<TranscriptSegment[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { segments?: TranscriptSegment[] } | TranscriptSegment[];
    return (Array.isArray(parsed) ? parsed : parsed.segments) ?? [];
  } catch {
    return [];
  }
}

/** The picture detections of projects and of files (the new-project wizard's video). */
export class PictureDetectionService {
  private readonly jobs = new Map<string, Job>();
  private readonly detector: PictureDetector;
  private readonly activity: Pick<ActivityRegistry, 'start'>;

  constructor(private readonly deps: PictureDetectionDeps) {
    this.detector = deps.detector ?? mediaWorkerDetector();
    this.activity = deps.activity ?? appActivity;
  }

  /** Start (or join) a project's detection; answers after `waitMs` at most. */
  async detectProject(projectId: string, opts: StartDetection = {}): Promise<PictureDetectionJob> {
    const project = await this.deps.store.getProject(projectId);
    const key = `project:${project.id}`;
    this.startIfIdle(key, opts, project.id, async (report) => {
      const parent = project.series?.role === 'part' ? await this.deps.store.getProject(project.series.parentId).catch(() => undefined) : undefined;
      const lines = await readLines(this.deps.store.paths(project.id).sourceJson);
      const outputDir = pictureDirOf(project);
      let result = await this.detector.detect(projectDetectInput(project, { ...(parent ? { parent } : {}), lines, outputDir }), { onProgress: report });
      result = await this.withAi(result, opts, project);
      await writeJsonAtomic(path.join(outputDir, DETECTION_FILE), result);
      return result;
    });
    return this.answer(key, opts.waitMs, () => this.savedProjectResult(project));
  }

  /** What a project's detection is doing, or its last result (also from an earlier run of the app). */
  async projectState(projectId: string): Promise<PictureDetectionJob> {
    const project = await this.deps.store.getProject(projectId);
    const job = this.jobs.get(`project:${project.id}`);
    if (job) return this.view(job);
    return this.savedProjectResult(project);
  }

  /** Start (or join) the detection of a video that is no project yet (the wizard's). */
  async detectFile(videoPath: string, opts: StartDetection = {}): Promise<PictureDetectionJob> {
    const file = await this.checkedVideo(videoPath);
    const key = `file:${path.normalize(file).toLowerCase()}`;
    this.startIfIdle(key, opts, undefined, async (report) => {
      const result = await this.detector.detect({ videoPath: file }, { onProgress: report });
      return this.withAi(result, opts);
    });
    return this.answer(key, opts.waitMs, async () => ({ state: 'idle' }));
  }

  /** One frame of a project's input, in its window (`atMs`: input time; default the detection's frame, else the middle). */
  async projectFrame(projectId: string, atMs?: number): Promise<PictureFrame> {
    const project = await this.deps.store.getProject(projectId);
    const start = project.sourceRange?.startMs ?? 0;
    let end = project.sourceRange?.endMs ?? project.mediaInfo?.durationMs ?? 0;
    if (!end) end = await this.detector.videoLength(project.inputVideoPath).catch(() => 0);
    const saved = (await this.savedProjectResult(project)).result;
    const at = this.clampAt(atMs ?? saved?.frameAtMs, start, end);
    return this.frameOf(project.inputVideoPath, at, start, end);
  }

  /** One frame of a video that is no project yet. */
  async fileFrame(videoPath: string, atMs?: number): Promise<PictureFrame> {
    const file = await this.checkedVideo(videoPath);
    const end = await this.detector.videoLength(file).catch(() => 0);
    return this.frameOf(file, this.clampAt(atMs, 0, end), 0, end);
  }

  // ------------------------------------------------------------------ inner

  private clampAt(atMs: number | undefined, start: number, end: number): number {
    if (typeof atMs === 'number' && Number.isFinite(atMs)) return Math.round(Math.min(Math.max(atMs, start), end > start ? end - 1 : start));
    return Math.round(end > start ? start + (end - start) / 2 : start);
  }

  private async frameOf(videoPath: string, atMs: number, start: number, end: number): Promise<PictureFrame> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-picture-frame-'));
    try {
      const shot = await this.detector.frame(videoPath, atMs, path.join(dir, 'frame.jpg'));
      const bytes = await fsp.readFile(shot.path);
      return {
        image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        width: shot.width,
        height: shot.height,
        atMs,
        windowStartMs: start,
        windowEndMs: end,
      };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  private async checkedVideo(videoPath: unknown): Promise<string> {
    if (typeof videoPath !== 'string' || !videoPath.trim()) {
      throw new AppErrorException('UNSUPPORTED_MEDIA', 'No video was given to look at.');
    }
    const file = path.resolve(videoPath.trim());
    const st = await fsp.stat(file).catch(() => undefined);
    if (!st?.isFile()) {
      throw new AppErrorException('UNSUPPORTED_MEDIA', `This video is not on this computer: ${file}`, {
        remediation: 'Choose a video file first (a link is looked at once it is downloaded).',
      });
    }
    return file;
  }

  private async savedProjectResult(project: Project): Promise<PictureDetectionJob> {
    try {
      const result = JSON.parse(await fsp.readFile(path.join(pictureDirOf(project), DETECTION_FILE), 'utf8')) as PictureDetection;
      return { state: 'done', result };
    } catch {
      return { state: 'idle' };
    }
  }

  private async withAi(result: PictureDetection, opts: StartDetection, project?: Project): Promise<PictureDetection> {
    if (!opts.ai) return result;
    if (!this.deps.aiCheck) {
      return {
        ...result,
        notes: [...result.notes, 'An AI check was asked for, but none is set up here: look at the preview yourself, or ask Claude to look at it.'],
      };
    }
    return this.deps.aiCheck(result, project);
  }

  private startIfIdle(
    key: string,
    opts: StartDetection,
    projectId: string | undefined,
    work: (report: (fraction: number, message: string) => void) => Promise<PictureDetection>,
  ): void {
    const current = this.jobs.get(key);
    if (current?.state === 'running') return;
    if (current?.state === 'done' && !opts.fresh && current.endedAt !== undefined && Date.now() - current.endedAt < (this.deps.reuseMs ?? 10 * 60_000)) return;
    const handle = this.activity.start({
      kind: 'picture.detect',
      title: projectId ? 'Finding the watermark and the subtitle band' : 'Finding the watermark and the subtitle band of a new video',
      ...(projectId ? { projectId } : {}),
    });
    const job: Job = { state: 'running', percent: 0, startedAt: new Date().toISOString(), activityId: handle.id, promise: Promise.resolve() };
    const report = (fraction: number, message: string): void => {
      job.percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      job.message = message;
      handle.progress(job.percent, message);
    };
    job.promise = work(report).then(
      (result) => {
        Object.assign(job, { state: 'done', percent: 100, result, endedAt: Date.now(), message: detectionSummary(result) });
        handle.done(detectionSummary(result));
      },
      (err: unknown) => {
        const e = toAppError(err);
        Object.assign(job, {
          state: 'failed',
          endedAt: Date.now(),
          message: e.message,
          error: { code: e.code, message: e.message, ...(e.remediation ? { remediation: e.remediation } : {}) },
        });
        handle.fail(err);
      },
    );
    this.jobs.set(key, job);
  }

  private async answer(key: string, waitMs: number | undefined, fallback: () => Promise<PictureDetectionJob>): Promise<PictureDetectionJob> {
    const job = this.jobs.get(key);
    if (!job) return fallback();
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
    if (job.state === 'running' && wait > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.promise, new Promise<void>((r) => (timer = setTimeout(r, wait)))]);
      if (timer) clearTimeout(timer);
    }
    return this.view(job);
  }

  private view(job: Job): PictureDetectionJob {
    return {
      state: job.state,
      percent: job.percent,
      ...(job.message ? { message: job.message } : {}),
      startedAt: job.startedAt,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.activityId ? { activityId: job.activityId } : {}),
    };
  }
}

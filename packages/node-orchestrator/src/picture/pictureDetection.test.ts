import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import type { PictureDetection, Project } from '@videodubber/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActivityRegistry } from '../activity/registry.js';
import { toHttpError } from '../httpErrors.js';
import { createProjectInput, makeTempDir, writeDummyVideo } from '../test/fixtures.js';
import { ProjectStore, writeJsonAtomic } from '../workspace/projectStore.js';
import { detectionSummary, pictureDirOf, PictureDetectionService, projectDetectInput, type PictureDetectInput, type PictureDetector } from './pictureDetection.js';
import { registerPictureRoutes } from './pictureRoutes.js';
import { sanitizeBlurRegions, sanitizeCoverFields, withoutClearedCoverFields } from './pictureSanitize.js';

const found = (over: Partial<PictureDetection> = {}): PictureDetection => ({
  at: '2026-11-23T10:00:00.000Z',
  videoWidth: 1080,
  videoHeight: 1920,
  regions: [{ x: 0.66, y: 0.014, w: 0.31, h: 0.04, mode: 'blur', corner: 'top-right', confidence: 0.82 }],
  band: { y: 0.755, h: 0.06, confidence: 0.77, method: 'speech' },
  frameAtMs: 61_000,
  frames: 100,
  notes: [],
  ...over,
});

/** A detector that records what it was asked and answers when told to. */
class FakeDetector implements PictureDetector {
  public inputs: PictureDetectInput[] = [];
  public frames: { videoPath: string; atMs: number }[] = [];
  public fail?: Error;
  private release?: () => void;
  public hold = false;

  async detect(input: PictureDetectInput, opts: { onProgress?: (f: number, m: string) => void }): Promise<PictureDetection> {
    this.inputs.push(input);
    opts.onProgress?.(0.5, 'Looking at frames (50/100)');
    if (this.hold) await new Promise<void>((r) => (this.release = r));
    if (this.fail) throw this.fail;
    return found(input.outputDir ? { framePath: path.join(input.outputDir, 'frame.jpg'), previewPath: path.join(input.outputDir, 'preview.jpg') } : {});
  }

  finish(): void {
    this.hold = false;
    this.release?.();
  }

  async frame(videoPath: string, atMs: number, output: string): Promise<{ path: string; width: number; height: number }> {
    this.frames.push({ videoPath, atMs });
    await fsp.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { path: output, width: 540, height: 960 };
  }

  async videoLength(): Promise<number> {
    return 120_000;
  }
}

let tmp: string;
let store: ProjectStore;
let detector: FakeDetector;
let activity: ActivityRegistry;
let service: PictureDetectionService;

beforeEach(async () => {
  tmp = await makeTempDir('vd-picture-');
  store = new ProjectStore(path.join(tmp, 'projects'));
  detector = new FakeDetector();
  activity = new ActivityRegistry();
  service = new PictureDetectionService({ store, detector, activity });
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function project(over: Partial<Project> = {}): Promise<Project> {
  const p = await store.createProject(createProjectInput(await writeDummyVideo(tmp)));
  return store.saveProject({ ...p, ...over });
}

describe('projectDetectInput', () => {
  const base = { inputVideoPath: '/v.mp4', workspaceDir: '/w' } as Project;

  it("a whole video: one window, the lines as they are", () => {
    expect(projectDetectInput(base, { lines: [{ startMs: 1000, endMs: 2000 }], outputDir: '/w/picture' })).toEqual({
      videoPath: '/v.mp4',
      segments: [{ startMs: 0 }],
      lines: [{ startMs: 1000, endMs: 2000 }],
      outputDir: '/w/picture',
    });
  });

  it("a part: its window, its lines moved to the input's time, the parent's files cut to the window", () => {
    const part = { ...base, sourceRange: { startMs: 9_000_000, endMs: 11_000_000 } } as Project;
    const parent = {
      ...base,
      inputFiles: [
        { path: '/P1.mp4', name: 'P1.mp4', startMs: 0, durationMs: 10_000_000 },
        { path: '/P2.mp4', name: 'P2.mp4', startMs: 10_000_000, durationMs: 9_000_000 },
        { path: '/P3.mp4', name: 'P3.mp4', startMs: 19_000_000, durationMs: 5_000_000 },
      ],
    } as Project;
    expect(projectDetectInput(part, { parent, lines: [{ startMs: 0, endMs: 1500 }, { startMs: 5, endMs: 5 }] })).toEqual({
      videoPath: '/v.mp4',
      segments: [
        { startMs: 9_000_000, endMs: 10_000_000, fileName: 'P1.mp4' },
        { startMs: 10_000_000, endMs: 11_000_000, fileName: 'P2.mp4' },
      ],
      lines: [{ startMs: 9_000_000, endMs: 9_001_500 }],
      // A part is a window of its series, which looked for an advert tail already.
      adTail: false,
    });
  });
});

describe('PictureDetectionService', () => {
  it("looks at the project's video with its transcript, keeps the result, and shows in the activity list", async () => {
    const p = await project();
    await writeJsonAtomic(store.paths(p.id).sourceJson, { segments: [{ id: 'seg_0001', index: 0, startMs: 1000, endMs: 2500, sourceText: '你好' }] });

    const job = await service.detectProject(p.id, { waitMs: 5000 });

    expect(job.state).toBe('done');
    expect(job.result?.regions).toHaveLength(1);
    expect(detector.inputs[0]).toMatchObject({ videoPath: p.inputVideoPath, segments: [{ startMs: 0 }], lines: [{ startMs: 1000, endMs: 2500 }] });
    expect(detector.inputs[0]!.outputDir).toBe(path.join(p.workspaceDir, 'picture'));
    // Kept beside the project, so a restart still has it.
    const again = await new PictureDetectionService({ store, detector, activity }).projectState(p.id);
    expect(again).toEqual({ state: 'done', result: job.result });
    const entry = activity.get(job.activityId!);
    expect(entry).toMatchObject({ kind: 'picture.detect', projectId: p.id, state: 'done' });
    expect(entry?.result).toBe('1 watermark, the subtitle band at 76–82 % of the height (100 frames)');
  });

  it('a second request joins the running detection instead of starting another; it answers with the progress', async () => {
    const p = await project();
    detector.hold = true;
    const first = await service.detectProject(p.id);
    expect(first.state).toBe('running');
    // Once the frames are being looked at, a request sees how far it got.
    while (detector.inputs.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await service.detectProject(p.id, { fresh: true });
    expect(second).toMatchObject({ state: 'running', percent: 50, message: 'Looking at frames (50/100)' });
    expect(detector.inputs).toHaveLength(1);
    detector.finish();
    const done = await service.detectProject(p.id, { waitMs: 5000 });
    expect(done.state).toBe('done');
  });

  it('a recent result is handed out again; `fresh` looks again', async () => {
    const p = await project();
    await service.detectProject(p.id, { waitMs: 5000 });
    await service.detectProject(p.id, { waitMs: 5000 });
    expect(detector.inputs).toHaveLength(1);
    await service.detectProject(p.id, { waitMs: 5000, fresh: true });
    expect(detector.inputs).toHaveLength(2);
  });

  it('a failure is a failed job with the reason, and the next request tries again', async () => {
    const p = await project();
    detector.fail = new Error('ffmpeg exited with code 1');
    const job = await service.detectProject(p.id, { waitMs: 5000 });
    expect(job.state).toBe('failed');
    expect(job.error?.message).toContain('ffmpeg exited');
    expect(activity.get(job.activityId!)?.state).toBe('failed');
    detector.fail = undefined;
    expect((await service.detectProject(p.id, { waitMs: 5000 })).state).toBe('done');
  });

  it('detectNow waits for the whole detection, uses a saved result as it is, and throws what a failure said', async () => {
    const p = await project();
    detector.hold = true;
    const waiting = service.detectNow(p.id);
    while (detector.inputs.length === 0) await new Promise((r) => setTimeout(r, 5));
    // Past the routes' 55 s cap it would still wait: it answers only once the frames are looked at.
    detector.finish();
    expect((await waiting).regions).toHaveLength(1);
    // Saved beside the project: a later render (another run of the app) does not look again.
    await new PictureDetectionService({ store, detector, activity }).detectNow(p.id);
    expect(detector.inputs).toHaveLength(1);
    const q = await project();
    detector.fail = new Error('ffmpeg exited with code 1');
    await expect(service.detectNow(q.id)).rejects.toThrow(/ffmpeg exited/);
  });

  it('looks again, once, at a result saved before advert tails were looked for, when speech-to-text asks (2026-11-27)', async () => {
    const p = await project();
    await service.detectNow(p.id);
    expect(detector.inputs).toHaveLength(1);
    // The saved one has no tailChecked: a render reuses it, speech-to-text's start does not.
    await service.detectNow(p.id);
    expect(detector.inputs).toHaveLength(1);
    await service.detectNow(p.id, { tail: true });
    expect(detector.inputs).toHaveLength(2);
    // Saved again, with the check done: never again.
    await fsp.writeFile(path.join(pictureDirOf(p), 'detection.json'), JSON.stringify(found({ tailChecked: true })), 'utf8');
    await service.detectNow(p.id, { tail: true });
    expect(detector.inputs).toHaveLength(2);
    // A series part never asks for a tail: it is a window of its series.
    expect(projectDetectInput({ ...p, sourceRange: { startMs: 60_000, endMs: 120_000 } }, {})).toMatchObject({ adTail: false });
    expect(projectDetectInput(p, {})).not.toHaveProperty('adTail');
  });

  it('an AI check asked for without one set up says so in the notes', async () => {
    const p = await project();
    const job = await service.detectProject(p.id, { waitMs: 5000, ai: true });
    expect(job.result?.notes.at(-1)).toContain('An AI check was asked for, but none is set up here');
  });

  it("a project's frame: in its window, at the detection's frame when there is one, as a data URL", async () => {
    const p = await project({ sourceRange: { startMs: 60_000, endMs: 90_000 } });
    const frame = await service.projectFrame(p.id);
    expect(frame).toMatchObject({ atMs: 75_000, windowStartMs: 60_000, windowEndMs: 90_000, width: 540, height: 960 });
    expect(frame.image).toBe('data:image/jpeg;base64,/9j/2Q==');
    expect((await service.projectFrame(p.id, 10)).atMs).toBe(60_000);
  });

  it("a video that is no project yet (the wizard's): looked at where it is, no pictures written", async () => {
    const video = await writeDummyVideo(tmp, 'new.mp4');
    const job = await service.detectFile(video, { waitMs: 5000 });
    expect(job.state).toBe('done');
    expect(detector.inputs[0]).toEqual({ videoPath: video });
    expect((await service.fileFrame(video)).atMs).toBe(60_000);
    await expect(service.detectFile(path.join(tmp, 'missing.mp4'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    await expect(service.fileFrame('')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });
});

describe('picture routes', () => {
  it('detect, follow and take a frame over HTTP', async () => {
    const app = Fastify();
    registerPictureRoutes(app, {
      pictures: service,
      sendError: (reply, err) => {
        const { status, error } = toHttpError(err);
        return reply.status(status).send({ error });
      },
    });
    const p = await project();

    const started = await app.inject({ method: 'POST', url: `/projects/${p.id}/picture/detect`, payload: { waitMs: 5000 } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'done', result: { band: { y: 0.755 } } });
    expect((await app.inject({ method: 'GET', url: `/projects/${p.id}/picture/detect` })).json()).toMatchObject({ state: 'done' });
    expect((await app.inject({ method: 'POST', url: `/projects/${p.id}/picture/frame`, payload: { atMs: 1000 } })).json()).toMatchObject({ atMs: 1000 });

    const missing = await app.inject({ method: 'POST', url: '/picture/frame', payload: { videoPath: path.join(tmp, 'nope.mp4') } });
    expect(missing.statusCode).toBeGreaterThanOrEqual(400);
    expect(missing.json().error.code).toBe('UNSUPPORTED_MEDIA');
    expect((await app.inject({ method: 'GET', url: '/projects/nope/picture/detect' })).statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});

describe('detectionSummary', () => {
  it('says what was found in a sentence', () => {
    expect(detectionSummary(found({ regions: [], band: undefined, frames: 40 }))).toBe('no watermark, no subtitle band (40 frames)');
  });
});

describe('sanitizers', () => {
  it('regions: clipped to the frame, whole milliseconds, at most 20', () => {
    expect(sanitizeBlurRegions([{ x: -1, y: 0.5, w: 0.5, h: 2, mode: 'blur', startMs: 0 }])).toEqual([{ x: 0, y: 0.5, w: 0.5, h: 0.5, mode: 'blur' }]);
    expect(sanitizeBlurRegions(Array.from({ length: 30 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1, mode: 'blur' })))).toHaveLength(20);
    expect(sanitizeBlurRegions('x')).toBeUndefined();
    expect(sanitizeBlurRegions([])).toBeUndefined();
  });

  it('cover fields: known values only; null clears a band field', () => {
    expect(sanitizeCoverFields({ coverOriginal: 'blur', coverBand: { y: 0.2, h: 0.001 }, coverStrength: 0, subtitlesInBand: 'yes' })).toEqual({ coverOriginal: 'blur' });
    expect(withoutClearedCoverFields({ coverOriginal: 'blur', coverBand: { y: 0.7, h: 0.1 } }, { coverBand: null })).toEqual({ coverOriginal: 'blur' });
    expect(withoutClearedCoverFields({ coverBand: { y: 0.7, h: 0.1 } }, { coverBand: null })).toBeUndefined();
    expect(withoutClearedCoverFields({ coverOriginal: true }, undefined)).toEqual({ coverOriginal: true });
  });
});

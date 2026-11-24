import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JoinProbe, JoinVideoInfo, JoinVideosOptions } from '@videodubber/media-worker';
import type { ActivityEntry, JoinStatus } from '@videodubber/shared';

import { runWithInitiator } from '../activity/context.js';
import { ActivityRegistry } from '../activity/registry.js';
import { defaultSettings, makeTempDir } from '../test/fixtures.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { JoinService, joinedName, validJoinPaths, type JoinMedia } from './joinService.js';

const video = (over: Partial<JoinVideoInfo> = {}): JoinVideoInfo => ({
  codec: 'h264',
  profile: 'High',
  width: 1080,
  height: 1920,
  rotation: 0,
  fps: 25,
  fpsText: '25/1',
  pixFmt: 'yuv420p',
  ...over,
});

/** A deferred promise, to hold a fake join where a test wants it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * ffmpeg's part, faked: files are what `probes` says; a join reports half
 * way, waits for `gate` when set, has the partial verified, then publishes it.
 */
class FakeMedia implements JoinMedia {
  joins: JoinVideosOptions[] = [];
  gate: Promise<void> | undefined;
  /** What the joined file measures (null: as long as planned). */
  joinedSpan: number | null = null;
  constructor(public probes: Record<string, Partial<JoinProbe> | Error>) {}

  async probe(filePath: string): Promise<JoinProbe> {
    const known = this.probes[filePath];
    if (known instanceof Error) throw known;
    if (known) {
      return { path: filePath, sizeBytes: 1000, startSec: 0, spanSec: 10, video: video(), audio: { codec: 'aac', sampleRate: 48000, channels: 2 }, ...known };
    }
    // The joined partial.
    const planned = this.joins.at(-1)!.plan.files.reduce((s, f) => s + f.spanSec, 0);
    const span = this.joinedSpan ?? planned;
    return { path: filePath, sizeBytes: 5000, startSec: 0, spanSec: span, audioSpanSec: span, video: video() };
  }

  async join(o: JoinVideosOptions, signal?: AbortSignal): Promise<{ encoder?: { codec: string } }> {
    this.joins.push(o);
    const frames = o.plan.files.reduce((s, f) => s + f.frames, 0);
    o.onProgress?.({ outTimeMs: 0, frame: Math.floor(frames / 2), end: false });
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<void>((_, reject) =>
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('"ffmpeg" was cancelled.'), { code: 'CANCELLED' })), { once: true }),
        ),
      ]);
    }
    const partial = o.outputPath.replace(/\.(\w+)$/, '.partial.$1');
    await fsp.writeFile(partial, 'joined');
    try {
      await o.verify?.(partial);
    } catch (err) {
      await fsp.rm(partial, { force: true });
      throw err;
    }
    await fsp.rename(partial, o.outputPath);
    o.onProgress?.({ outTimeMs: 0, frame: frames, end: true });
    return o.plan.mode === 'reencode' ? { encoder: { codec: 'libx264' } } : {};
  }

  async encodePlan() {
    return { primary: { codec: 'libx264', hardware: false, args: [] } };
  }

  async measureEncode() {
    return { speed: 4, bytesPerSec: 250_000, encoder: 'libx264' };
  }
}

describe('validJoinPaths / joinedName', () => {
  it('takes 2 to 100 full paths', () => {
    const abs = (n: string) => path.resolve('/videos', n);
    expect(validJoinPaths([abs('P1.mp4'), abs('P2.mp4')])).toEqual([abs('P1.mp4'), abs('P2.mp4')]);
    expect(() => validJoinPaths([abs('P1.mp4')])).toThrow(/between 2 and 100/);
    expect(() => validJoinPaths([abs('P1.mp4'), 'P2.mp4'])).toThrow(/full path/);
    expect(() => validJoinPaths('P1.mp4')).toThrow(/between 2/);
  });

  it('names the project after what the files share', () => {
    expect(joinedName(['/v/持械入大宋 P1.mp4', '/v/持械入大宋 P2.mp4', '/v/持械入大宋 P5.mp4'])).toBe('持械入大宋');
    expect(joinedName(['/v/Show - Tập 01.mp4', '/v/Show - Tập 02.mp4'])).toBe('Show');
    expect(joinedName(['/v/alpha.mp4', '/v/beta.mp4'])).toBe('alpha');
  });
});

describe('JoinService', () => {
  let tmp: string;
  let store: ProjectStore;
  let reg: ActivityRegistry;
  let media: FakeMedia;
  let free: number | undefined;
  let started: string[];
  let probed: string[];
  const p = (n: string) => path.join(tmp, 'sources', n);

  const service = (over: Partial<ConstructorParameters<typeof JoinService>[0]> = {}) =>
    new JoinService({
      store,
      media,
      activity: reg,
      freeBytes: async () => free,
      probeProject: async (id) => probed.push(id),
      startRun: async (id) => {
        started.push(id);
        return { started: true };
      },
      ...over,
    });

  /** Until the project's join has ended, its follow-ups (probe, start) included. */
  async function settled(s: JoinService, projectId: string): Promise<JoinStatus> {
    for (let i = 0; i < 400; i++) {
      const st = await s.status(projectId);
      if (st && st.state !== 'running' && st.state !== 'waiting' && !s.isJoining(projectId)) return st;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the join never ended');
  }

  const joinsOf = (projectId: string): ActivityEntry[] => reg.list({ projectId }).filter((e) => e.kind === 'project.join');

  beforeEach(async () => {
    tmp = await makeTempDir('vd-join-');
    store = new ProjectStore(path.join(tmp, 'projects'));
    reg = new ActivityRegistry();
    free = 100 * 1024 ** 3;
    started = [];
    probed = [];
    media = new FakeMedia({
      [p('P1.mp4')]: { spanSec: 36000, sizeBytes: 6e9, video: video({ frames: 900_000 }) },
      [p('P2.mp4')]: { spanSec: 36000, sizeBytes: 6e9, audio: { codec: 'aac', sampleRate: 44100, channels: 2 } },
      [p('P3.mp4')]: { spanSec: 9826.357, sizeBytes: 2e9 },
    });
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('checks files that fit together: the picture is copied, the sizes add up, the drive has room', async () => {
    const check = await service().check([p('P1.mp4'), p('P2.mp4'), p('P3.mp4')]);
    expect(check).toMatchObject({ ok: true, mode: 'copy', mismatches: [], totalDurationMs: 81_826_357, mixedSampleRates: true });
    expect(check.reencode).toBeUndefined();
    expect(check.files.map((f) => [f.name, f.durationMs])).toEqual([
      ['P1.mp4', 36_000_000],
      ['P2.mp4', 36_000_000],
      ['P3.mp4', 9_826_357],
    ]);
    // About the files together, plus a margin for the rest of the drive.
    expect(check.disk.needBytes).toBe(Math.round(14e9 * 1.02) + 512 * 1024 ** 2);
    expect(check.disk.enough).toBe(true);
  });

  it('prices a re-encode with a test encode before anyone agrees to it', async () => {
    media.probes[p('P2.mp4')] = { spanSec: 3600, video: video({ width: 720, height: 1280 }) };
    const check = await service().check([p('P1.mp4'), p('P2.mp4')], { renderQuality: 'quality' });
    expect(check.mode).toBe('reencode');
    expect(check.mismatches).toEqual([{ field: 'resolution', index: 1, value: '720×1280', expected: '1080×1920' }]);
    // 39 600 s at 4× real time, plus the sound and the decoding (×1.15).
    expect(check.reencode).toEqual({
      target: { width: 1080, height: 1920, fps: 25 },
      encoder: 'libx264',
      estimatedSec: Math.round((39_600 / 4) * 1.15),
      estimatedBytes: Math.round(250_000 * 39_600 + 24_000 * 39_600),
    });
  });

  it('says which file cannot be joined, and that the drive is too small', async () => {
    media.probes[p('P2.mp4')] = new Error('Input file does not exist or is not readable');
    media.probes[p('P3.mp4')] = { video: undefined };
    free = 1024 ** 3;
    const check = await service().check([p('P1.mp4'), p('P2.mp4'), p('P3.mp4')]);
    expect(check.ok).toBe(false);
    expect(check.files[1]!.error?.message).toMatch(/not readable/);
    expect(check.files[2]!.error?.message).toBe('P3.mp4 has no picture to join.');
    expect(check.disk.enough).toBe(false);
  });

  it('makes nothing when the user has not agreed to a re-encode, or the drive is too small', async () => {
    const s = service();
    media.probes[p('P2.mp4')] = { video: video({ fps: 30, fpsText: '30/1' }) };
    await expect(s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'X', settings: defaultSettings() })).rejects.toMatchObject({
      code: 'INVALID_EDIT',
      message: expect.stringContaining('P2.mp4: frame rate 30 fps, the first file 25 fps'),
    });
    media.probes[p('P2.mp4')] = {};
    free = 2e9;
    await expect(s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'X', settings: defaultSettings() })).rejects.toMatchObject({
      code: 'DISK_FULL',
      // 6 GB of files (+2 %), and half a GB kept free for the rest of the drive.
      message: expect.stringMatching(/needs about 6\.2 GB free .* 1\.9 GB is free/),
    });
    expect(await store.listProjects()).toEqual([]);
  });

  it('makes the project at once, joins into it in the background, and records where each file starts', async () => {
    const s = service();
    const { project, join } = await runWithInitiator({ kind: 'mcp', client: 'claude-code' }, () =>
      s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4'), p('P3.mp4')], name: 'Đại Tống', settings: defaultSettings() }),
    );
    expect(project.inputVideoPath).toBe(store.paths(project.id).inputVideo('mp4'));
    expect(project.inputFiles).toEqual([
      { path: p('P1.mp4'), name: 'P1.mp4', startMs: 0, durationMs: 36_000_000 },
      { path: p('P2.mp4'), name: 'P2.mp4', startMs: 36_000_000, durationMs: 36_000_000 },
      { path: p('P3.mp4'), name: 'P3.mp4', startMs: 72_000_000, durationMs: 9_826_357 },
    ]);
    expect(join).toMatchObject({ state: 'waiting', mode: 'copy', startWhenDone: false });

    const done = await settled(s, project.id);
    expect(done).toMatchObject({ state: 'done', percent: 100, attempts: 1, result: { durationMs: 81_826_357, sizeBytes: 6 } });
    expect(await fsp.readFile(project.inputVideoPath, 'utf8')).toBe('joined');
    expect(media.joins[0]!.plan.mode).toBe('copy');
    // 192 kb/s or more for the joined sound.
    expect(media.joins[0]!.audioBitrateKbps).toBe(192);
    expect(probed).toEqual([project.id]);
    expect(started).toEqual([]);

    // One activity entry, from the agent that asked, with progress, done.
    const [entry] = joinsOf(project.id);
    expect(entry).toMatchObject({
      kind: 'project.join',
      title: 'Joining 3 videos into "Đại Tống"',
      initiator: { kind: 'mcp', client: 'claude-code' },
      state: 'done',
      percent: 100,
      result: 'Joined 3 videos: 22:43:46, 0.0 GB',
    });
    expect(done.activityId).toBe(entry!.id);
    // The record survives a restart of the app.
    expect(JSON.parse(await fsp.readFile(path.join(store.paths(project.id).inputDir, 'join.json'), 'utf8'))).toMatchObject({ state: 'done' });
    expect(await s.blockReason(project.id)).toBeUndefined();
  });

  it('starts the dub once joined when asked (join_videos start=true)', async () => {
    const s = service();
    const { project } = await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Go', settings: defaultSettings(), start: true });
    const done = await settled(s, project.id);
    expect(started).toEqual([project.id]);
    expect(done).toMatchObject({ startWhenDone: true, started: { started: true } });
  });

  it('refuses to run the project while it joins, and says how far it is', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const s = service();
    const { project } = await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Wait', settings: defaultSettings() });
    for (let i = 0; i < 100 && (await s.status(project.id))?.percent === null; i++) await new Promise((r) => setTimeout(r, 5));
    // Half the frames written: P1's 900 000 are done, P2's first is next.
    const running = await s.status(project.id);
    expect(running).toMatchObject({ state: 'running', percent: 50, currentFile: 1 });
    expect(s.isJoining(project.id)).toBe(true);
    expect(s.busy).toBe(true);
    await expect(s.blockReason(project.id)).resolves.toMatchObject({ code: 'RUN_IN_PROGRESS', message: expect.stringContaining('(50%)') });
    gate.resolve();
    expect((await settled(s, project.id)).state).toBe('done');
    expect(s.busy).toBe(false);
  });

  it('cancels (the project stays, with nothing as its input) and joins again on request', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const s = service();
    const { project } = await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Stop', settings: defaultSettings() });
    for (let i = 0; i < 100 && media.joins.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const cancelled = await s.cancel(project.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', percent: null });
    expect(await fsp.stat(project.inputVideoPath).then(() => true, () => false)).toBe(false);
    expect(joinsOf(project.id)[0]).toMatchObject({ state: 'cancelled' });
    await expect(s.blockReason(project.id)).resolves.toMatchObject({ code: 'INVALID_EDIT', message: expect.stringContaining('it was cancelled') });

    media.gate = undefined;
    const again = await s.restart(project.id);
    expect(again.state).toBe('waiting');
    expect(await settled(s, project.id)).toMatchObject({ state: 'done', attempts: 2 });
    // Each try is its own entry in the activity list.
    expect(joinsOf(project.id).map((e) => e.state).sort()).toEqual(['cancelled', 'done']);
    await expect(s.restart(project.id)).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  });

  it('joins one project at a time: the next waits its turn', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const s = service();
    const a = await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'A', settings: defaultSettings() });
    const b = await s.create({ videoPaths: [p('P2.mp4'), p('P3.mp4')], name: 'B', settings: defaultSettings() });
    expect(joinsOf(b.project.id)[0]).toMatchObject({ state: 'waiting', message: 'Waiting for another join to finish' });
    for (let i = 0; i < 100 && media.joins.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(media.joins).toHaveLength(1);
    gate.resolve();
    await settled(s, a.project.id);
    expect((await settled(s, b.project.id)).state).toBe('done');
    expect(media.joins).toHaveLength(2);
  });

  it('publishes nothing when the joined file comes out short', async () => {
    media.joinedSpan = 70_000; // 20 000 s missing: a damaged file ended the copy early
    const s = service();
    const { project } = await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Short', settings: defaultSettings() });
    const failed = await settled(s, project.id);
    expect(failed).toMatchObject({ state: 'failed', error: { message: expect.stringContaining('came out 19:26:40 long instead of 20:00:00') } });
    expect(await fsp.stat(project.inputVideoPath).then(() => true, () => false)).toBe(false);
    expect(joinsOf(project.id)[0]).toMatchObject({ state: 'failed' });
  });

  it('fails when a file changed into one that needs a re-encode nobody agreed to', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const s = service();
    // A first join holds the queue while the second project's file changes.
    await s.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'First', settings: defaultSettings() });
    const { project } = await s.create({ videoPaths: [p('P1.mp4'), p('P3.mp4')], name: 'Changed', settings: defaultSettings() });
    media.probes[p('P3.mp4')] = { spanSec: 100, video: video({ codec: 'hevc' }) };
    gate.resolve();
    expect(await settled(s, project.id)).toMatchObject({
      state: 'failed',
      error: { code: 'INVALID_EDIT', message: expect.stringContaining('changed since the project was made') },
    });
  });

  it('stops for the app closing, and starts again when it starts (as the scheduler)', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const first = service();
    const { project } = await first.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Again', settings: defaultSettings() });
    for (let i = 0; i < 100 && media.joins.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await first.stopAll();
    expect(await first.status(project.id)).toMatchObject({ state: 'interrupted' });

    media.gate = undefined;
    const second = service();
    await second.resumeInterrupted();
    expect(await settled(second, project.id)).toMatchObject({ state: 'done', attempts: 2 });
    const entries = joinsOf(project.id);
    expect(entries.find((e) => e.state === 'done')?.initiator).toEqual({ kind: 'scheduler' });
  });

  it('after a restart: a file already in place is finished, a join interrupted three times waits for the user', async () => {
    const gate = deferred();
    media.gate = gate.promise;
    const first = service();
    const a = await first.create({ videoPaths: [p('P1.mp4'), p('P2.mp4')], name: 'Renamed', settings: defaultSettings(), start: true });
    const b = await first.create({ videoPaths: [p('P2.mp4'), p('P3.mp4')], name: 'Tired', settings: defaultSettings() });
    for (let i = 0; i < 100 && media.joins.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await first.stopAll();
    // A: the app died just after the rename, before join.json said so.
    await fsp.writeFile(a.project.inputVideoPath, 'complete');
    const recordB = path.join(store.paths(b.project.id).inputDir, 'join.json');
    await fsp.writeFile(recordB, JSON.stringify({ ...JSON.parse(await fsp.readFile(recordB, 'utf8')), state: 'running', autoResumes: 3 }));

    media.gate = undefined;
    media.joins = [];
    const second = service();
    await second.resumeInterrupted();
    expect(await second.status(a.project.id)).toMatchObject({ state: 'done', result: { sizeBytes: 8 } });
    expect(started).toEqual([a.project.id]);
    expect(await second.status(b.project.id)).toMatchObject({ state: 'failed', error: { message: expect.stringContaining('interrupted 3 times') } });
    expect(media.joins).toEqual([]);
  });

  it('knows nothing of projects not made by joining', async () => {
    const s = service();
    expect(await s.status('proj_unknown')).toBeUndefined();
    expect(await s.blockReason('proj_unknown')).toBeUndefined();
    await expect(s.cancel('proj_unknown')).rejects.toMatchObject({ message: expect.stringContaining('not made by joining') });
  });
});

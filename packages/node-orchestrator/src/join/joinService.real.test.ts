/**
 * The join end to end with REAL ffmpeg: the service, the store and the media
 * worker together on two tiny generated clips (one 48 kHz, one 44.1 kHz),
 * which the faked tests cannot vouch for (the joined file's path and
 * extension, the check of the real partial, the project afterwards). Skipped
 * when ffmpeg/ffprobe are not available. CPU only: the re-encode estimate runs
 * with renderQuality "quality" (x264), so no hardware encoder is probed.
 */
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeJoinFile, resolveFfmpegBinary, resolveFfprobeBinary } from '@videodubber/media-worker';

import { ActivityRegistry } from '../activity/registry.js';
import { defaultSettings, makeTempDir } from '../test/fixtures.js';
import { ProjectStore } from '../workspace/projectStore.js';
import { JoinService } from './joinService.js';

const runs = (bin: string): boolean => spawnSync(bin, ['-version'], { windowsHide: true }).status === 0;
const available = runs(resolveFfmpegBinary()) && runs(resolveFfprobeBinary());

function clip(file: string, size: string, rate: number, color: string, tone: number, sampleRate: number): void {
  const r = spawnSync(
    resolveFfmpegBinary(),
    [
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${rate}:d=2`,
      '-f', 'lavfi', '-i', `sine=f=${tone}:r=${sampleRate}:d=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', String(sampleRate),
      file,
    ],
    { windowsHide: true },
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

describe.skipIf(!available)('JoinService with real ffmpeg', () => {
  let tmp: string;
  let a: string;
  let b: string;
  let odd: string;

  beforeAll(async () => {
    tmp = await makeTempDir('vd-join-real-');
    await fsp.mkdir(path.join(tmp, 'sources'));
    a = path.join(tmp, 'sources', 'Đại Tống P1.mp4');
    b = path.join(tmp, 'sources', 'Đại Tống P2.mp4');
    odd = path.join(tmp, 'sources', 'other size.mp4');
    clip(a, '160x90', 25, 'red', 440, 48000);
    clip(b, '160x90', 25, 'lime', 1000, 44100);
    clip(odd, '320x240', 30, 'blue', 2000, 48000);
  });

  afterAll(async () => {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('makes the project, joins its input whole, and records where each file starts', async () => {
    const store = new ProjectStore(path.join(tmp, 'projects'));
    const probed: string[] = [];
    const joins = new JoinService({ store, activity: new ActivityRegistry(), probeProject: async (id) => probed.push(id) });

    const check = await joins.check([a, b]);
    expect(check).toMatchObject({ ok: true, mode: 'copy', totalDurationMs: 4000, mixedSampleRates: true, disk: { enough: true } });

    const { project } = await joins.create({ videoPaths: [a, b], name: '', settings: defaultSettings() });
    expect(project.name).toBe('Đại Tống');
    for (let i = 0; i < 400 && joins.isJoining(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const status = await joins.status(project.id);
    expect(status).toMatchObject({ state: 'done', mode: 'copy', percent: 100 });

    const saved = await store.getProject(project.id);
    expect(saved.inputVideoPath).toBe(store.paths(project.id).inputVideo('mp4'));
    expect(saved.inputFiles).toEqual([
      { path: a, name: 'Đại Tống P1.mp4', startMs: 0, durationMs: 2000 },
      { path: b, name: 'Đại Tống P2.mp4', startMs: 2000, durationMs: 2000 },
    ]);
    const joined = await probeJoinFile(saved.inputVideoPath);
    expect(joined.spanSec).toBeCloseTo(4, 2);
    expect(Math.abs((joined.audioSpanSec ?? 0) - joined.spanSec)).toBeLessThan(0.03);
    expect(status?.result?.durationMs).toBe(4000);
    // Nothing left beside it: no partial, no concat list.
    expect((await fsp.readdir(store.paths(project.id).inputDir)).sort()).toEqual(['join.json', 'original.mp4']);
    expect(probed).toEqual([project.id]);
  });

  it('prices the re-encode of files that differ with a real test encode', async () => {
    const joins = new JoinService({ store: new ProjectStore(path.join(tmp, 'projects-2')), activity: new ActivityRegistry() });
    const check = await joins.check([a, odd], { renderQuality: 'quality' });
    expect(check.mode).toBe('reencode');
    expect(check.mismatches.map((m) => m.field)).toEqual(['resolution', 'frame-rate']);
    // Both 2 s long: the tie goes to the larger frame and the higher rate.
    expect(check.reencode).toMatchObject({ target: { width: 320, height: 240, fps: 30 }, encoder: 'libx264' });
    expect(check.reencode?.estimatedSec).toBeGreaterThanOrEqual(0);
    expect(check.reencode?.estimatedBytes).toBeGreaterThan(0);
  });
});

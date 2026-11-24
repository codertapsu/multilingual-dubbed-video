/**
 * A REAL join of tiny generated clips, end to end through ffmpeg: the one
 * media-worker test that is not ffmpeg-free, because what it proves lives in
 * ffmpeg's behaviour, not in our argv (a join that is 21 ms off, or whose
 * sound runs into the next file, has a perfectly plausible command line).
 * Skipped when ffmpeg/ffprobe are not on the PATH (or FFMPEG_PATH/FFPROBE_PATH).
 *
 * The clips, 2 s each, 160×90 at 25 fps, each its own colour and tone:
 *  - A: 48 kHz, 440 Hz (red);
 *  - B: 44.1 kHz, 1000 Hz (green): the production mixed 44.1 and 48 kHz;
 *  - C: sound that runs LONG, built with asetrate (2 s of a 2000 Hz tone
 *    played at 40/48 of its rate: 2.4 s of 1667 Hz under a 2 s picture);
 *  - D: a sound clock that runs fast, like P4 (2.2 s of samples under
 *    timestamps of 2.0 s, via -itsscale), whose last 0.2 s of samples are a
 *    3500 Hz marker after 3000 Hz.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinary, resolveFfprobeBinary } from './exec.js';
import { compareJoinFiles, joinBoundariesMs, joinPosition, joinVideos, planJoin, probeJoinFile, type JoinProbe } from './join.js';

const ffmpeg = resolveFfmpegBinary();
const runs = (bin: string): boolean => spawnSync(bin, ['-version'], { windowsHide: true }).status === 0;
const available = runs(ffmpeg) && runs(resolveFfprobeBinary());

function ff(args: string[]): Buffer {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout;
}

/** A 2 s 160×90 clip of one colour with the given sound (lavfi source). */
function clip(dir: string, name: string, color: string, sound: string, sampleRate: number): string {
  const out = join(dir, name);
  ff([
    '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=25:d=2`,
    '-f', 'lavfi', '-i', sound,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', String(sampleRate),
    out,
  ]);
  return out;
}

/** The joined sound as mono 48 kHz floats. */
function decodeMono(file: string): Float32Array {
  const buf = ff(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 4))));
}

/** Which of `tones` sounds in [fromMs, toMs) (zero crossings), or null in silence. */
function toneAt(samples: Float32Array, fromMs: number, toMs: number, tones: readonly number[]): number | null {
  const a = Math.round((fromMs / 1000) * 48000);
  const b = Math.min(samples.length, Math.round((toMs / 1000) * 48000));
  let crossings = 0;
  let energy = 0;
  for (let i = a + 1; i < b; i++) {
    if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings++;
    energy += samples[i]! * samples[i]!;
  }
  if (b - a < 2 || energy / (b - a) < 1e-5) return null;
  const hz = (crossings / 2) * (48000 / (b - a));
  return tones.reduce((best, t) => (Math.abs(t - hz) < Math.abs(best - hz) ? t : best));
}

/** The picture's colour at `sec` (one pixel, scaled down). */
function colorAt(file: string, sec: number): string {
  const px = ff(['-ss', sec.toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const [r = 0, g = 0, b = 0] = px;
  const hi = (v: number) => v > 128;
  return hi(r) && hi(g) && !hi(b) ? 'yellow' : hi(r) && !hi(g) ? 'red' : hi(g) && !hi(r) ? 'green' : hi(b) ? 'blue' : `rgb(${r},${g},${b})`;
}

describe.skipIf(!available)('a real join (ffmpeg)', () => {
  let dir: string;
  let a: string;
  let b: string;
  let c: string;
  let d: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-join-real-'));
    a = clip(dir, 'a 48k.mp4', 'red', 'sine=f=440:r=48000:d=2', 48000);
    // lime = #00FF00 (ffmpeg's "green" is #008000, too dark to tell apart).
    b = clip(dir, "b 44.1k (P2's).mp4", 'lime', 'sine=f=1000:r=44100:d=2', 44100);
    c = clip(dir, 'c long.mp4', 'blue', 'sine=f=2000:r=48000:d=2,asetrate=40000', 48000);
    // D: 2.2 s of samples (3000 Hz, then a 3500 Hz marker) under 2.0 s of timestamps.
    const sound = join(dir, 'd-sound.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=f=3000:r=48000:d=2', '-f', 'lavfi', '-i', 'sine=f=3500:r=48000:d=0.2', '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-c:a', 'aac', sound]);
    const picture = join(dir, 'd-picture.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=yellow:s=160x90:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', picture]);
    d = join(dir, 'd fast clock.mp4');
    ff(['-i', picture, '-itsscale', (2 / 2.2).toFixed(8), '-i', sound, '-map', '0:v', '-map', '1:a', '-c', 'copy', d]);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('measures each clip by its picture, whatever its sound does', async () => {
    const [pa, pb, pc, pd] = await Promise.all([a, b, c, d].map((f) => probeJoinFile(f)));
    for (const p of [pa, pb, pc, pd]) expect(p!.spanSec).toBeCloseTo(2, 3);
    expect(pb!.audio?.sampleRate).toBe(44100);
    expect(pc!.audioSpanSec).toBeCloseTo(2.4, 1); // runs 0.4 s past its picture
    // The fast clock: timestamps say ~2 s while the samples hold 2.2 s.
    expect(pd!.audioSpanSec).toBeLessThan(2.05);
    expect(compareJoinFiles([pa!, pb!, pc!, pd!])).toEqual([]);
  });

  it('joins 48 kHz, 44.1 kHz and a too-long sound: every file\'s sound and picture start and end together', async () => {
    const probes: JoinProbe[] = await Promise.all([a, c, b].map((f) => probeJoinFile(f)));
    const plan = planJoin(probes, 'copy');
    expect(joinBoundariesMs(plan)).toEqual([
      { startMs: 0, durationMs: 2000 },
      { startMs: 2000, durationMs: 2000 },
      { startMs: 4000, durationMs: 2000 },
    ]);
    const out = join(dir, 'joined.mp4');
    const progress: { frame?: number; fraction: number }[] = [];
    let verified = false;
    await joinVideos({
      plan,
      outputPath: out,
      onProgress: (p) => progress.push({ ...(p.frame !== undefined ? { frame: p.frame } : {}), fraction: joinPosition(plan, p).fraction }),
      verify: async (partial) => {
        verified = (await probeJoinFile(partial)).spanSec > 5.9;
      },
    });
    expect(verified).toBe(true);
    // ffmpeg's own count of the frames it wrote: all 150 of them, by the end.
    expect(progress.at(-1)).toEqual({ frame: 150, fraction: 1 });

    // In total: picture 6.000 s, sound 6.000 s.
    const joined = await probeJoinFile(out);
    expect(joined.spanSec).toBeCloseTo(6, 2);
    expect(joined.audioSpanSec).toBeCloseTo(6, 1);
    expect(Math.abs((joined.audioSpanSec ?? 0) - joined.spanSec)).toBeLessThan(0.03);
    expect(joined.audio?.sampleRate).toBe(48000);
    expect(joined.video?.codec).toBe('h264'); // copied, not re-encoded

    // Per file: each tone fills exactly its own two seconds. C's extra 0.4 s
    // is cut, so B's tone starts at 4.0 s, not 4.4 s.
    const s = decodeMono(out);
    // A plain decode also plays the padding of the last AAC frame (at most
    // 1024 samples, 21 ms); the stream's own length above is exact.
    expect(Math.abs(s.length / 48000 - 6)).toBeLessThan(0.022);
    const tones = [440, 1000, 1667];
    for (const [fromMs, toMs, tone] of [
      [30, 1970, 440],
      [2030, 3970, 1667],
      [4030, 5970, 1000],
    ] as const) {
      for (let t = fromMs; t + 20 <= toMs; t += 20) expect(toneAt(s, t, t + 20, tones), `${t} ms`).toBe(tone);
    }
    // The switch is at the boundary, to within 30 ms either side.
    expect(toneAt(s, 1950, 1980, tones)).toBe(440);
    expect(toneAt(s, 2020, 2050, tones)).toBe(1667);
    expect(toneAt(s, 3950, 3980, tones)).toBe(1667);
    expect(toneAt(s, 4020, 4050, tones)).toBe(1000);

    // And the picture changes at the same moments (40 ms frames).
    expect(colorAt(out, 1.95)).toBe('red');
    expect(colorAt(out, 2.05)).toBe('blue');
    expect(colorAt(out, 3.95)).toBe('blue');
    expect(colorAt(out, 4.05)).toBe('green');
  });

  it('re-times a sound whose clock runs fast (P4) instead of cutting off its end', async () => {
    const probes = await Promise.all([a, d, b].map((f) => probeJoinFile(f)));
    const out = join(dir, 'joined-fast.mp4');
    await joinVideos({ plan: planJoin(probes, 'copy'), outputPath: out });
    const joined = await probeJoinFile(out);
    expect(joined.spanSec).toBeCloseTo(6, 2);
    expect(Math.abs((joined.audioSpanSec ?? 0) - joined.spanSec)).toBeLessThan(0.03);
    const s = decodeMono(out);
    const tones = [440, 1000, 3000, 3500];
    // D's marker, the last 0.2 s of its SAMPLES (timestamps 1.818–2.0 s),
    // plays at the end of D's two seconds: the sound was fitted onto its
    // timestamps (squeezed up to 2 %, the rest trimmed whenever it is 0.1 s
    // behind, so the marker starts by 3.918 s). Decoding every sample and
    // cutting at 2 s, the old extraction, would end on 3000 Hz.
    expect(toneAt(s, 3930, 3990, tones)).toBe(3500);
    expect(toneAt(s, 2100, 3600, tones)).toBe(3000);
    // B still starts exactly at 4.0 s.
    expect(toneAt(s, 4020, 4100, tones)).toBe(1000);
    expect(colorAt(out, 3.95)).toBe('yellow');
    expect(colorAt(out, 4.05)).toBe('green');
  });

  it('leaves nothing behind when cancelled: no joined file, no partial, no list', async () => {
    const probes = await Promise.all([a, b].map((f) => probeJoinFile(f)));
    const out = join(dir, 'cancelled.mp4');
    const ctl = new AbortController();
    ctl.abort();
    await expect(joinVideos({ plan: planJoin(probes, 'copy'), outputPath: out }, { signal: ctl.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.startsWith('cancelled'))).toEqual([]);
  });

  it('refuses a joined file its check does not accept, and removes it', async () => {
    const probes = await Promise.all([a, b].map((f) => probeJoinFile(f)));
    const out = join(dir, 'refused.mp4');
    await expect(
      joinVideos({
        plan: planJoin(probes, 'copy'),
        outputPath: out,
        verify: async () => {
          throw new Error('too short');
        },
      }),
    ).rejects.toThrow('too short');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.startsWith('refused'))).toEqual([]);
  });

  it('re-encodes files that differ, fitting them to one frame with whole frames per file', async () => {
    const odd = join(dir, 'odd 320x240 30fps.mp4');
    ff([
      '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=30:d=1.5',
      '-f', 'lavfi', '-i', 'sine=f=2500:r=44100:d=1.5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', odd,
    ]);
    const probes = await Promise.all([a, odd].map((f) => probeJoinFile(f)));
    const mismatches = compareJoinFiles(probes);
    expect(mismatches.map((m) => m.field)).toEqual(['resolution', 'frame-rate']);
    const target = { width: 160, height: 90, fps: 25, fpsText: '25/1' };
    const plan = planJoin(probes, 'reencode', target);
    expect(plan.files.map((f) => f.spanSec)).toEqual([2, 1.52]);
    const out = join(dir, 'reencoded.mp4');
    const { encoder } = await joinVideos({ plan, outputPath: out, encoder: { primary: { codec: 'libx264', hardware: false, args: ['-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p'] } } });
    expect(encoder?.codec).toBe('libx264');
    const joined = await probeJoinFile(out);
    expect(joined.video).toMatchObject({ width: 160, height: 90, fps: 25 });
    expect(joined.spanSec).toBeCloseTo(3.52, 2);
    expect(Math.abs((joined.audioSpanSec ?? 0) - joined.spanSec)).toBeLessThan(0.03);
    expect(colorAt(out, 1.95)).toBe('red');
  });
});

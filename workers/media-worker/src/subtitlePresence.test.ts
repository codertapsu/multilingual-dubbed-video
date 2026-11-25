/**
 * When burned-in subtitles are on screen: the frame score, the subtitles a
 * run of frames makes, the crop, and one real ffmpeg pass over a generated
 * clip with two "subtitles" of white blocks (drawbox: no libass needed).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinary } from './exec.js';
import {
  bandCrop,
  buildPresenceArgs,
  PRESENCE_HEIGHT,
  PRESENCE_WIDTH,
  readBandFrames,
  readSize,
  sameColumns,
  scanSubtitlePresence,
  scoreBand,
  showsText,
  subtitleEvents,
  type BandScore,
} from './subtitlePresence.js';

const hasFfmpeg = spawnSync(resolveFfmpegBinary(), ['-hide_banner', '-version'], { windowsHide: true }).status === 0;

/** A strip with white blocks (8 px wide, rows 8–23) starting at these columns, on dark grey. */
function strip(blocks: readonly number[]): Uint8Array {
  const f = new Uint8Array(PRESENCE_WIDTH * PRESENCE_HEIGHT).fill(40);
  for (const x0 of blocks) for (let y = 8; y < 24; y++) for (let x = x0; x < x0 + 8; x++) f[y * PRESENCE_WIDTH + x] = 250;
  return f;
}

const score = (blocks: readonly number[]): BandScore => scoreBand(strip(blocks), PRESENCE_WIDTH, PRESENCE_HEIGHT);

describe('a frame of the band', () => {
  it('scores text strokes: bright pixels on a sharp step, and the columns they are in', () => {
    const s = score([100, 140, 180]);
    // Each block: two columns at each edge, 16 rows.
    expect(s.edges).toBe(3 * 4 * 16);
    expect(s.columns).toBe(12);
    expect(showsText(s)).toBe(true);
  });

  it('a bright picture without strokes, or one small block, is no subtitle', () => {
    const bright = new Uint8Array(PRESENCE_WIDTH * PRESENCE_HEIGHT).fill(235);
    expect(showsText(scoreBand(bright, PRESENCE_WIDTH, PRESENCE_HEIGHT))).toBe(false);
    expect(showsText(score([300]))).toBe(false);
  });

  it('tells the same subtitle from the next by its columns', () => {
    expect(sameColumns(score([100, 140]).signature, score([100, 140]).signature)).toBe(1);
    expect(sameColumns(score([100, 140]).signature, score([400, 440]).signature)).toBe(0);
  });
});

describe('the subtitles of a run of frames', () => {
  const at = (ms: number, blocks: readonly number[]) => ({ atMs: ms, score: score(blocks) });
  const none = (ms: number) => ({ atMs: ms, score: score([]) });

  it('one subtitle while the columns stay, the next when they change; a single frame is a flash', () => {
    const frames = [
      none(0),
      at(200, [100, 140, 180]),
      at(400, [100, 140, 180]),
      at(600, [100, 140, 180]),
      at(800, [400, 440, 480]),
      at(1000, [400, 440, 480]),
      none(1200),
      at(1400, [200, 240, 280]),
      none(1600),
    ];
    expect(subtitleEvents(frames, 200)).toEqual([
      { startMs: 200, endMs: 800 },
      { startMs: 800, endMs: 1200 },
    ]);
  });

  it('a flicker shorter than half a second does not split a subtitle', () => {
    const frames = [at(0, [100, 140, 180]), at(200, [100, 140, 180]), none(400), at(600, [100, 140, 180])];
    expect(subtitleEvents(frames, 200)).toEqual([{ startMs: 0, endMs: 800 }]);
  });
});

describe('the crop and the command', () => {
  it('holds the band in even pixels, the middle 80 % by default', () => {
    expect(bandCrop({ y: 0.915, h: 0.055 }, 1920, 1080)).toEqual({ x: 192, y: 988, w: 1536, h: 58 });
    expect(bandCrop({ y: 0.99, h: 0.2 }, 640, 360)).toEqual({ x: 64, y: 356, w: 512, h: 8 });
  });

  it('reads only the window, five frames a second, as grey raw frames (argv, no shell)', () => {
    const args = buildPresenceArgs('C:\\v ideo\\a b.mp4', { x: 192, y: 988, w: 1536, h: 58 }, { startMs: 60_000, endMs: 90_000 });
    expect(args).toEqual(expect.arrayContaining(['-ss', '60.000', '-t', '30.000', '-i', 'C:\\v ideo\\a b.mp4', 'pipe:1']));
    expect(args[args.indexOf('-vf') + 1]).toBe(`fps=5,crop=1536:58:192:988,scale=${PRESENCE_WIDTH}:${PRESENCE_HEIGHT}:flags=area,format=gray`);
    expect(args.indexOf('-skip_frame')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('the frames the subtitle reader gets', () => {
  it("the band's own pixels up to 96 high, in even sizes", () => {
    expect(readSize({ w: 1536, h: 58 })).toEqual({ width: 1536, height: 58 });
    expect(readSize({ w: 3072, h: 116 })).toEqual({ width: 2542, height: 96 });
    expect(readSize({ w: 511, h: 35 })).toEqual({ width: 496, height: 34 });
  });
});

describe.skipIf(!hasFfmpeg)('a real ffmpeg pass', () => {
  let dir: string;
  let video: string;
  const blocks = (xs: readonly number[], from: number, to: number): string =>
    xs.map((x) => `drawbox=x=${x}:y=315:w=10:h=20:color=white:t=fill:enable='between(t,${from},${to})'`).join(',');

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-presence-'));
    video = join(dir, 'clip.mp4');
    const graph = `color=c=0x303030:s=640x360:r=25:d=5,format=yuv420p,${blocks([150, 190, 230, 270], 1, 2.48)},${blocks([330, 370, 410, 450], 2.5, 3.98)}`;
    const made = spawnSync(resolveFfmpegBinary(), ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', graph, '-c:v', 'mpeg4', '-q:v', '2', video], {
      windowsHide: true,
    });
    if (made.status !== 0) throw new Error(`could not make the clip: ${made.stderr}`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the two subtitles where they are on screen', async () => {
    const progress: number[] = [];
    const found = await scanSubtitlePresence({ videoPath: video, band: { y: 0.85, h: 0.1 } }, { onProgress: (f) => progress.push(f) });
    expect(found.frames).toBeGreaterThanOrEqual(24);
    expect(found.events).toHaveLength(2);
    const [a, b] = found.events;
    expect(Math.abs(a!.startMs - 1000)).toBeLessThanOrEqual(200);
    expect(Math.abs(a!.endMs - 2500)).toBeLessThanOrEqual(250);
    expect(Math.abs(b!.startMs - 2500)).toBeLessThanOrEqual(250);
    expect(Math.abs(b!.endMs - 4000)).toBeLessThanOrEqual(250);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('cuts one frame of the band per time asked, into one raw file; times that share a frame share it', async () => {
    const out = join(dir, 'frames.u8');
    const frames = await readBandFrames({ videoPath: video, band: { y: 0.85, h: 0.1 }, timesMs: [1500, 1520, 3200], outputPath: out });
    expect(frames).toMatchObject({ count: 2, indexOf: [0, 0, 1] });
    const bytes = readFileSync(out);
    expect(bytes.length).toBe(2 * frames.width * frames.height);
    // The crop is x 64-576 of the 640-px picture. The first frame shows the left
    // blocks (x 150-280), the second the right ones (x 330-460).
    const brightIn = (frame: number, from: number, to: number): number => {
      const x0 = Math.floor((from - 64) * (frames.width / 512));
      const x1 = Math.floor((to - 64) * (frames.width / 512));
      let n = 0;
      for (let y = 0; y < frames.height; y++) {
        for (let x = x0; x < x1; x++) if (bytes[frame * frames.width * frames.height + y * frames.width + x]! > 200) n += 1;
      }
      return n;
    };
    expect(brightIn(0, 150, 280)).toBeGreaterThan(100);
    expect(brightIn(0, 330, 460)).toBe(0);
    expect(brightIn(1, 330, 460)).toBeGreaterThan(100);
  });

  it('only inside the window asked, in the input\'s time', async () => {
    const found = await scanSubtitlePresence({ videoPath: video, band: { y: 0.85, h: 0.1 }, startMs: 2600, endMs: 5000 });
    expect(found.events).toHaveLength(1);
    expect(Math.abs(found.events[0]!.startMs - 2600)).toBeLessThanOrEqual(200);
  });
});

/**
 * The picture options against a REAL ffmpeg, on small generated clips: a
 * changing picture (a scrolling cellular automaton), a semi-transparent text
 * mark top right, and hardsub lines at 77–80 % of the height while "someone
 * speaks". Detection end to end (fast seeks, rawvideo, analysis, preview), a
 * clean clip, and renders whose filter graph ffmpeg must accept and whose
 * length must stop at the picture. Skipped where no ffmpeg runs, and the
 * parts that draw text where that ffmpeg has no libass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinary, runFfmpeg } from './exec.js';
import { BUNDLED_FONT_FAMILY, packagedFontsDir } from './fonts.js';
import { detectPicture } from './pictureDetect.js';
import { probeDurationMs } from './probe.js';
import { renderFinalVideo } from './render.js';
import { buildSubtitlesFilter } from './subtitles.js';
import { probeVideoLengthMs } from './videoLength.js';

const hasFfmpeg = spawnSync(resolveFfmpegBinary(), ['-hide_banner', '-version'], { windowsHide: true }).status === 0;

/**
 * Drawing text (the test clips' mark and hardsubs, a burned-in render) needs
 * ffmpeg's `subtitles` filter, i.e. libass. The app ships an ffmpeg that has
 * it (fetch-ffmpeg); Homebrew's ffmpeg 8 has neither libass nor freetype, and
 * on a Mac using it these failed instead of skipping.
 */
const hasLibass =
  hasFfmpeg &&
  /^\s*\S+\s+subtitles\s/m.test(
    spawnSync(resolveFfmpegBinary(), ['-hide_banner', '-filters'], { windowsHide: true, encoding: 'utf8' }).stdout ?? '',
  );

const W = 540;
const H = 960;
const SECONDS = 40;
/** "Speech": 0.3–2.3 s of every 4 s. */
const LINES = Array.from({ length: SECONDS / 4 }, (_, k) => ({ startMs: k * 4000 + 300, endMs: k * 4000 + 2300 }));
const WORDS = ['trời', 'ơi', 'ngươi', 'là', 'ai', 'đi', 'mau', 'lên', 'binh', 'lính', 'tướng', 'quân', 'đánh', 'thành', 'xa'];

function assTime(ms: number): string {
  const cs = Math.round(ms / 10);
  return `0:${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** The mark for the whole clip, and a different line of "hardsub" for each spoken stretch (one in four on two lines). */
function hardsubScript(withMark: boolean, withSubs: boolean): string {
  const events: string[] = [];
  if (withMark) events.push(`Dialogue: 0,${assTime(0)},${assTime(SECONDS * 1000)},Mark,,0,0,0,,{\\pos(520,18)}VD bilibili`);
  if (withSubs) {
    LINES.forEach((l, k) => {
      const words = Array.from({ length: 5 + (k % 4) }, (_, i) => WORDS[(k * 7 + i * 3) % WORDS.length]).join(' ');
      events.push(`Dialogue: 1,${assTime(l.startMs)},${assTime(l.endMs)},Sub,,0,0,0,,${k % 4 === 1 ? `${words}\\N${words}` : words}`);
    });
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Half transparent white, top right.
    `Style: Mark,${BUNDLED_FONT_FAMILY},30,&H80FFFFFF,&H000000FF,&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,0,0,0,1`,
    // White with a black outline; the line's bottom at 80 % of the height.
    `Style: Sub,${BUNDLED_FONT_FAMILY},34,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,192,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

async function makeClip(dir: string, name: string, withMark: boolean, withSubs: boolean): Promise<string> {
  const ass = join(dir, `${name}.ass`);
  writeFileSync(ass, hardsubScript(withMark, withSubs), 'utf8');
  const out = join(dir, `${name}.mp4`);
  const burn = withMark || withSubs ? `,${buildSubtitlesFilter(ass, undefined, process.platform, packagedFontsDir())}` : '';
  await runFfmpeg([
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `cellauto=rule=110:s=${W / 2}x${H / 2}:r=25:scroll=1:full=1:seed=7`,
    '-t', String(SECONDS),
    '-vf', `scale=${W}:${H}:flags=neighbor,lutyuv=y=40+val*0.45${burn},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '12', '-an', out,
  ]);
  return out;
}

describe.skipIf(!hasLibass)('picture detection with ffmpeg', () => {
  let dir: string;
  let marked: string;
  let clean: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vd-picture-ffmpeg-'));
    [marked, clean] = await Promise.all([makeClip(dir, 'marked', true, true), makeClip(dir, 'clean', false, false)]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the mark top right and the hardsub band at its rows, and draws them on a frame', async () => {
    const progress: number[] = [];
    const out = join(dir, 'picture');
    const found = await detectPicture(
      { videoPath: marked, lines: LINES, frames: 60, outputDir: out },
      { onProgress: (f) => progress.push(f) },
    );
    expect(found.videoWidth).toBe(W);
    expect(found.videoHeight).toBe(H);
    expect(found.regions.map((r) => r.corner)).toEqual(['top-right']);
    const mark = found.regions[0]!;
    // "VD bilibili" at 30 px, right-aligned to x 520, top at y 18 (~0.79–0.96 × 0.019–0.05).
    expect(mark.x).toBeLessThan(0.79);
    expect(mark.x).toBeGreaterThan(0.7);
    expect(mark.x + mark.w).toBeGreaterThan(0.955);
    expect(mark.y).toBeLessThan(0.024);
    expect(mark.y + mark.h).toBeGreaterThan(0.045);
    expect(mark.y + mark.h).toBeLessThan(0.1);
    expect(mark.confidence).toBeGreaterThanOrEqual(0.5);
    expect(mark.startMs).toBeUndefined();
    // The lines' text sits at ~77–80 %; two-line lines reach ~74 %, and the
    // band (their 95th percentile) takes them in.
    expect(found.band).toBeDefined();
    expect(found.band!.method).toBe('speech');
    expect(found.band!.y).toBeGreaterThan(0.7);
    expect(found.band!.y).toBeLessThan(0.76);
    expect(found.band!.twoLineShare).toBeGreaterThan(0);
    expect(found.band!.y + found.band!.h).toBeGreaterThan(0.795);
    expect(found.band!.y + found.band!.h).toBeLessThan(0.83);
    expect(existsSync(found.framePath!)).toBe(true);
    expect(existsSync(found.previewPath!)).toBe(true);
    expect(found.frames).toBeGreaterThanOrEqual(40);
    expect(progress.at(-1)).toBe(1);
  }, 120_000);

  it('finds nothing on a clean clip', async () => {
    const found = await detectPicture({ videoPath: clean, lines: LINES, frames: 60 });
    expect(found.regions).toEqual([]);
    expect(found.band).toBeUndefined();
    expect(found.notes.length).toBeGreaterThan(0);
  }, 120_000);

  it('looks at each file of a joined source on its own', async () => {
    const found = await detectPicture({
      videoPath: marked,
      segments: [
        { startMs: 0, endMs: 20_000, fileName: 'P1.mp4' },
        { startMs: 20_000, fileName: 'P2.mp4' },
      ],
      watermark: true,
      band: false,
      frames: 80,
    });
    // The same mark in both files: one region for the whole video.
    expect(found.regions, JSON.stringify(found.regions)).toHaveLength(1);
    expect(found.regions[0]!.startMs).toBeUndefined();
    expect(found.band).toBeUndefined();
  }, 120_000);
});

describe.skipIf(!hasFfmpeg)('rendering hidden regions with ffmpeg', () => {
  let dir: string;
  let video: string;
  let audio: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vd-picture-render-'));
    video = join(dir, 'in.mp4');
    audio = join(dir, 'mix.wav');
    // 2 s of picture, 3 s of mix: the dub must not outlast the picture.
    await runFfmpeg(['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
    await runFfmpeg(['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '3', '-ac', '2', audio]);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the stream-copy render stops at the picture', async () => {
    const out = join(dir, 'copy.mp4');
    expect(await probeVideoLengthMs(video)).toBe(2000);
    const r = await renderFinalVideo({ inputVideoPath: video, audioPath: audio, outputPath: out, subtitleExportMode: 'none', copyVideoStream: true });
    expect(r.durationMs).toBeGreaterThan(1900);
    expect(r.durationMs).toBeLessThan(2150);
  }, 60_000);

  it('blur, pixelate and delogo (at the frame edge, for a while) and the blurred band render, and stop at the picture', async () => {
    const out = join(dir, 'regions.mp4');
    const r = await renderFinalVideo({
      inputVideoPath: video,
      audioPath: audio,
      outputPath: out,
      subtitleExportMode: 'none',
      renderQuality: 'quality',
      blurRegions: [
        { x: 0.7, y: 0.02, w: 0.28, h: 0.12, mode: 'blur', strength: 10 },
        { x: 0, y: 0, w: 0.2, h: 0.2, mode: 'delogo', startMs: 500, endMs: 1500 },
        { x: 0.4, y: 0.4, w: 0.2, h: 0.2, mode: 'pixelate', startMs: 1000 },
      ],
      burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: 0.75, h: 0.08 }, coverStrength: 8 },
    });
    expect(r.durationMs).toBeGreaterThan(1900);
    expect(r.durationMs).toBeLessThan(2150);
    expect(await probeDurationMs(out)).toBe(r.durationMs);
  }, 60_000);

  it.skipIf(!hasLibass)('burned-in subtitles inside the blurred band, through libass', async () => {
    const srt = join(dir, 'sub.srt');
    writeFileSync(srt, '1\n00:00:00,200 --> 00:00:01,800\nĐã nướng tôi lên.\n', 'utf8');
    const out = join(dir, 'burned.mp4');
    const r = await renderFinalVideo({
      inputVideoPath: video,
      audioPath: audio,
      outputPath: out,
      subtitleExportMode: 'burned-in',
      subtitlePath: srt,
      renderQuality: 'quality',
      burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: 0.72, h: 0.12 }, subtitlesInBand: true },
    });
    expect(r.durationMs).toBeLessThan(2150);
    expect(r.videoEncoder?.codec).toBe('libx264');
  }, 60_000);
});

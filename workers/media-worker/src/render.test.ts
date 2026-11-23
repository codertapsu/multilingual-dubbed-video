import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppErrorException } from '@videodubber/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// No real ffmpeg: the render's DECISIONS are under test — which encoder, the
// x264 retry, the atomic publish, the generated script — not ffmpeg itself.
vi.mock('./exec.js', () => ({
  runFfmpeg: vi.fn(),
  assertInputReadable: vi.fn(),
  assertOutputWritable: vi.fn(),
  ffmpegHasFilter: vi.fn(async () => true),
  listFfmpegEncoders: vi.fn(async () => new Set<string>()),
  resolveFfmpegBinary: vi.fn(() => 'ffmpeg'),
}));
vi.mock('./probe.js', () => ({
  probeDurationMs: vi.fn(async () => 120_000),
  probeVideoGeometry: vi.fn(async () => ({ width: 1280, height: 720, fps: 30, durationMs: 120_000 })),
}));
// The picture runs 118.5 s; the container says 120 s (its audio ran long).
vi.mock('./videoLength.js', () => ({ probeVideoLengthMs: vi.fn(async () => 118_500) }));

import { partialPathFor } from './atomic.js';
import type { HardwareEncoderProbe } from './encoder.js';
import { ffmpegHasFilter, runFfmpeg } from './exec.js';
import { BUNDLED_FONT_FAMILY, BUNDLED_FONT_FILE } from './fonts.js';
import { renderFinalVideo, type RenderFinalVideoOptions } from './render.js';
import { escapeSubtitlePathForFilter } from './subtitles.js';

const runFfmpegMock = vi.mocked(runFfmpeg);

describe('renderFinalVideo burned-in', () => {
  let dir: string;
  let fontsDir: string;
  let emptyFontsDir: string;
  let srt: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-render-test-'));
    fontsDir = mkdtempSync(join(tmpdir(), 'vd-render-fonts-'));
    // Only its presence is checked here; libass is never reached.
    writeFileSync(join(fontsDir, BUNDLED_FONT_FILE), 'ttf');
    emptyFontsDir = mkdtempSync(join(tmpdir(), 'vd-render-nofonts-'));
    srt = join(dir, 'translated.srt');
    writeFileSync(srt, '1\r\n00:00:01,000 --> 00:00:02,500\r\nNgộ Không, ngươi chớ có làm càn!\r\n', 'utf8');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fontsDir, { recursive: true, force: true });
    rmSync(emptyFontsDir, { recursive: true, force: true });
  });
  afterEach(() => runFfmpegMock.mockReset());

  const input = (o: Partial<RenderFinalVideoOptions> = {}): RenderFinalVideoOptions => ({
    inputVideoPath: join(dir, 'original.mp4'),
    audioPath: join(dir, 'final_mix.wav'),
    outputPath: join(dir, 'output.mp4'),
    subtitleExportMode: 'burned-in',
    subtitlePath: srt,
    renderQuality: 'auto',
    fontsDir,
    ...o,
  });
  const nvencFound = async (): Promise<HardwareEncoderProbe> => ({ selected: { codec: 'h264_nvenc' }, attempts: [] });
  const codecOf = (args: string[]) => args[args.indexOf('-c:v') + 1];
  const vfOf = (args: string[]) => args[args.indexOf('-vf') + 1]!;

  it('a failed hardware encode is retried once with x264; only the complete x264 file is published', async () => {
    const seen: Array<{ codec: string; out: string; script: string }> = [];
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      const out = args[args.length - 1]!;
      // The burn script lives in a scratch dir that is gone after the render:
      // capture it while ffmpeg would be reading it.
      const scriptPath = vfOf(args).match(/^subtitles=(.*?):fontsdir=/)![1]!.replace(/\\\\:/g, ':');
      seen.push({ codec: codecOf(args)!, out, script: readFileSync(scriptPath, 'utf8') });
      writeFileSync(out, codecOf(args) === 'h264_nvenc' ? 'HALF-WRITTEN' : 'X264-COMPLETE');
      if (codecOf(args) === 'h264_nvenc') {
        throw new AppErrorException({ code: 'UNKNOWN', message: '"ffmpeg" exited with code 1.', cause: 'No capable devices found' });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    const result = await renderFinalVideo(input(), {}, { probeHardwareEncoder: nvencFound });

    const dest = join(dir, 'output.mp4');
    expect(seen.map((s) => s.codec)).toEqual(['h264_nvenc', 'libx264']);
    // Both attempts wrote the partial; the destination only ever got the x264 one.
    expect(seen.map((s) => s.out)).toEqual([partialPathFor(dest), partialPathFor(dest)]);
    expect(readFileSync(dest, 'utf8')).toBe('X264-COMPLETE');
    expect(existsSync(partialPathFor(dest))).toBe(false);
    expect(result.videoEncoder).toEqual({
      codec: 'libx264',
      hardware: false,
      fallbackFrom: 'h264_nvenc',
      fallbackReason: 'No capable devices found',
      probe: [],
    });
    expect(result.sidecarSubtitlePaths).toEqual([]);
    // The script was sized to the video, set in the bundled font, and carries the cue.
    expect(seen[0]!.script).toContain('PlayResX: 1280\nPlayResY: 720');
    expect(seen[0]!.script).toContain(`Style: Text,${BUNDLED_FONT_FAMILY},60.4,`);
    expect(seen[0]!.script).toContain(',Text,,0,0,0,,Ngộ Không, ngươi chớ có làm càn!');
    expect(result.burnFont).toEqual({ family: BUNDLED_FONT_FAMILY, fontsDir });
  });

  it('burns the generated script through the fonts dir, and cleans its scratch dir up', async () => {
    let vf = '';
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      vf = vfOf(args);
      writeFileSync(args[args.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('vd-burn-')));

    const result = await renderFinalVideo(input(), {}, { probeHardwareEncoder: nvencFound });

    expect(result.videoEncoder).toMatchObject({ codec: 'h264_nvenc', hardware: true });
    expect(vf).toMatch(/^subtitles=.*burn\.ass:fontsdir=/);
    expect(vf.endsWith(`:fontsdir=${escapeSubtitlePathForFilter(fontsDir)}`)).toBe(true);
    expect(vf).not.toContain('force_style');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('vd-burn-') && !before.has(n));
    expect(after).toEqual([]);
  });

  it('without the bundled font file, asks for Arial at Arial metrics instead of a mis-sized substitute', async () => {
    let script = '';
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      script = readFileSync(vfOf(args).match(/^subtitles=(.*?):fontsdir=/)![1]!.replace(/\\\\:/g, ':'), 'utf8');
      writeFileSync(args[args.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    const result = await renderFinalVideo(input({ fontsDir: emptyFontsDir, renderQuality: 'quality' }));

    expect(result.burnFont).toEqual({ family: 'Arial', fontsDir: emptyFontsDir });
    // 39.6 px em at Arial's 1.117-em cell, not Be Vietnam Pro's 1.526.
    expect(script).toContain('Style: Text,Arial,44.2,');
  });

  it('quality never probes for hardware and encodes with x264', async () => {
    const probe = vi.fn(nvencFound);
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      writeFileSync(args[args.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    const result = await renderFinalVideo(input({ renderQuality: 'quality' }), {}, { probeHardwareEncoder: probe });

    expect(probe).not.toHaveBeenCalled();
    expect(codecOf(runFfmpegMock.mock.calls[0]![0])).toBe('libx264');
    expect(result.videoEncoder).toEqual({ codec: 'libx264', hardware: false });
  });

  it('a cancelled render is not retried, and leaves no file behind', async () => {
    const controller = new AbortController();
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      writeFileSync(args[args.length - 1]!, 'HALF');
      controller.abort();
      throw new AppErrorException('CANCELLED', '"ffmpeg" was cancelled.');
    }) as never);
    const dest = join(dir, 'cancelled.mp4');

    await expect(
      renderFinalVideo(input({ outputPath: dest }), { signal: controller.signal }, { probeHardwareEncoder: nvencFound }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(partialPathFor(dest))).toBe(false);
  });

  it('an .ass subtitle is burned as-is (it carries its own styling)', async () => {
    const ass = join(dir, 'custom.ass');
    writeFileSync(ass, '[Script Info]\nPlayResX: 640\n', 'utf8');
    let vf = '';
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      vf = vfOf(args);
      writeFileSync(args[args.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await renderFinalVideo(input({ subtitlePath: ass, renderQuality: 'quality' }));

    expect(vf.startsWith(`subtitles=${escapeSubtitlePathForFilter(ass)}:fontsdir=`)).toBe(true);
  });

  it('stops at the end of the picture, not of the longer mix', async () => {
    let args: string[] = [];
    runFfmpegMock.mockImplementation((async (a: string[]) => {
      args = a;
      writeFileSync(a[a.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await renderFinalVideo(input({ renderQuality: 'quality' }));
    expect(args[args.indexOf('-t') + 1]).toBe('118.500');

    // The stream-copy render too.
    await renderFinalVideo(input({ subtitleExportMode: 'srt-file', copyVideoStream: true }));
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy']));
    expect(args[args.indexOf('-t') + 1]).toBe('118.500');
  });
});

describe('renderFinalVideo hiding parts of the picture', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-render-picture-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    runFfmpegMock.mockReset();
    vi.mocked(ffmpegHasFilter).mockImplementation(async () => true);
  });

  const input = (o: Partial<RenderFinalVideoOptions> = {}): RenderFinalVideoOptions => ({
    inputVideoPath: join(dir, 'original.mp4'),
    audioPath: join(dir, 'final_mix.wav'),
    outputPath: join(dir, 'output.mp4'),
    subtitleExportMode: 'srt-file',
    renderQuality: 'quality',
    ...o,
  });
  const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;

  it('a watermark region re-encodes through the filter graph, whatever the subtitle mode, capped at the picture', async () => {
    let args: string[] = [];
    runFfmpegMock.mockImplementation((async (a: string[]) => {
      args = a;
      writeFileSync(a[a.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await renderFinalVideo(input({ blurRegions: [{ x: 0.66, y: 0.02, w: 0.31, h: 0.05, mode: 'blur' }] }));

    expect(graphOf(args)).toMatch(/^\[0:v\]split=2\[pr0m\]\[pr0c\];\[pr0c\]crop=\d+:\d+:\d+:\d+,boxblur=/);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-t') + 1]).toBe('118.500');
  });

  it("a part's regions move to its window: one over a file that ended before it is gone", async () => {
    let args: string[] = [];
    runFfmpegMock.mockImplementation((async (a: string[]) => {
      args = a;
      writeFileSync(a[a.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await renderFinalVideo(
      input({
        range: { startMs: 60_000, endMs: 90_000 },
        blurRegions: [
          { x: 0.66, y: 0.02, w: 0.31, h: 0.05, mode: 'blur', startMs: 0, endMs: 60_000 },
          { x: 0.02, y: 0.02, w: 0.2, h: 0.05, mode: 'delogo', startMs: 70_000 },
        ],
      }),
    );

    // 25.6–281.6 × 14.4–50.4 px, outward to even pixels; from 70 s = 10 s into the part.
    expect(graphOf(args)).toMatch(/^\[0:v\]delogo=x=24:y=14:w=258:h=38:enable='gte\(t,10\.000\)'\[vh\];\[vh\]null\[v0\]$/);
  });

  it('the blurred band is hidden even without burned-in subtitles; the solid one stays with the burn', async () => {
    let args: string[] = [];
    runFfmpegMock.mockImplementation((async (a: string[]) => {
      args = a;
      writeFileSync(a[a.length - 1]!, 'ok');
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await renderFinalVideo(input({ burnSubtitleStyle: { coverOriginal: 'blur', coverBand: { y: 0.76, h: 0.05 } } }));
    // Rows 547–583 of 720, outward to even rows.
    expect(graphOf(args)).toContain('crop=1280:38:0:546,boxblur=');

    // A solid band alone needs no picture filter: the plain stream copy.
    await renderFinalVideo(input({ burnSubtitleStyle: { coverOriginal: true } }));
    expect(args).not.toContain('-filter_complex');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy']));
  });

  it('an FFmpeg without boxblur fails with a clear error before it encodes', async () => {
    vi.mocked(ffmpegHasFilter).mockImplementation(async (name: string) => name !== 'boxblur');

    await expect(renderFinalVideo(input({ blurRegions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1, mode: 'blur' }] }))).rejects.toMatchObject({
      code: 'FFMPEG_FILTER_MISSING',
    });
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });
});

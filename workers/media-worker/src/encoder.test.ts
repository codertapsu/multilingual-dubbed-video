import { AppErrorException } from '@videodubber/shared';
import { describe, expect, it } from 'vitest';
import {
  buildEncoderProbeArgs,
  encodeWithFallback,
  hardwareEncoderArgs,
  hardwareEncoderCandidates,
  isEncoderFailure,
  LIBX264,
  planVideoEncode,
  probeHardwareEncoders,
  summarizeEncoderError,
  videoToolboxBitrateKbps,
  wantsHardwareEncoder,
  type HardwareEncoderProbe,
  type VideoEncoderChoice,
} from './encoder.js';

const g720 = { width: 1280, height: 720, fps: 30 };

/** What runFfmpeg throws for a non-zero exit: code UNKNOWN, stderr tail in `cause`. */
const ffmpegExit = (stderr: string) =>
  new AppErrorException({ code: 'UNKNOWN', message: '"ffmpeg" exited with code 1.', cause: stderr });

describe('hardwareEncoderCandidates', () => {
  it('tries NVIDIA, then Intel, then AMD on Windows and Linux', () => {
    for (const p of ['win32', 'linux'] as const) {
      expect(hardwareEncoderCandidates(p, 'x64').map((c) => c.codec)).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf']);
    }
  });

  it('macOS: constant quality first on Apple Silicon, bitrate mode as the second try', () => {
    expect(hardwareEncoderCandidates('darwin', 'arm64')).toEqual([
      { codec: 'h264_videotoolbox', rateControl: 'quality' },
      { codec: 'h264_videotoolbox', rateControl: 'bitrate' },
    ]);
  });

  it('macOS on Intel: bitrate mode only (VideoToolbox there is expected to reject -q:v)', () => {
    expect(hardwareEncoderCandidates('darwin', 'x64')).toEqual([{ codec: 'h264_videotoolbox', rateControl: 'bitrate' }]);
  });
});

describe('hardwareEncoderArgs', () => {
  /** The pixel format each encoder is pinned to (always 8-bit 4:2:0). */
  const pixFmt = (args: string[]) => args[args.indexOf('-pix_fmt') + 1];

  it('pins every encoder to 8-bit 4:2:0 (a 10-bit source made NVENC fail "No capable devices found")', () => {
    for (const c of [
      ...hardwareEncoderCandidates('win32', 'x64'),
      ...hardwareEncoderCandidates('darwin', 'arm64'),
      { codec: 'h264_something_new' },
    ]) {
      const args = hardwareEncoderArgs(c, g720);
      expect(['yuv420p', 'nv12']).toContain(pixFmt(args));
    }
    expect(pixFmt(LIBX264.args)).toBe('yuv420p');
  });

  it('NVENC: the measured p4 / vbr / cq 23 constant-quality setting, with a zero bitrate target', () => {
    expect(hardwareEncoderArgs({ codec: 'h264_nvenc' }, g720)).toEqual([
      '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p',
    ]);
  });

  it('QSV takes nv12, its only 8-bit input format', () => {
    expect(pixFmt(hardwareEncoderArgs({ codec: 'h264_qsv' }, g720))).toBe('nv12');
  });

  it('VideoToolbox: -q:v in quality mode, an average bitrate in bitrate mode', () => {
    expect(hardwareEncoderArgs({ codec: 'h264_videotoolbox', rateControl: 'quality' }, g720)).toContain('-q:v');
    const bitrate = hardwareEncoderArgs({ codec: 'h264_videotoolbox', rateControl: 'bitrate' }, g720);
    expect(bitrate).not.toContain('-q:v');
    expect(bitrate[bitrate.indexOf('-b:v') + 1]).toBe('5530k');
  });

  it('scales the VideoToolbox bitrate with pixels/s, within sane bounds', () => {
    expect(videoToolboxBitrateKbps(g720)).toBe(5530);
    expect(videoToolboxBitrateKbps({ width: 1920, height: 1080, fps: 30 })).toBe(12442);
    expect(videoToolboxBitrateKbps({ width: 320, height: 240, fps: 15 })).toBe(1500);
    expect(videoToolboxBitrateKbps({ width: 7680, height: 4320, fps: 60 })).toBe(50000);
    // Unknown frame rate: assume 30.
    expect(videoToolboxBitrateKbps({ width: 1280, height: 720, fps: 0 })).toBe(5530);
  });
});

describe('buildEncoderProbeArgs', () => {
  it('encodes 0.2 s of synthetic video with the EXACT args the render would use, to nowhere', () => {
    const args = buildEncoderProbeArgs({ codec: 'h264_nvenc' });
    expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-c:v', 'h264_nvenc', '-an']));
    expect(args.find((a) => a.startsWith('testsrc2='))).toContain('duration=0.2');
    const tuned = hardwareEncoderArgs({ codec: 'h264_nvenc' }, g720);
    const at = args.indexOf('h264_nvenc') + 1;
    expect(args.slice(at, at + tuned.length)).toEqual(tuned);
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });
});

describe('probeHardwareEncoders', () => {
  const listAll = async () => new Set(['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']);
  const codecOf = (args: string[]) => args[args.indexOf('-c:v') + 1];

  it('an AMD-only PC: NVENC and QSV are LISTED but fail; AMF is selected (the shipped bug)', async () => {
    const tried: string[] = [];
    const probe = await probeHardwareEncoders({
      platform: 'win32',
      arch: 'x64',
      listEncoders: listAll,
      tryEncode: async (args) => {
        const codec = codecOf(args)!;
        tried.push(codec);
        if (codec === 'h264_nvenc') throw ffmpegExit('[h264_nvenc @ 0000] Cannot load nvcuda.dll\nError while opening encoder');
        if (codec === 'h264_qsv') throw ffmpegExit('[h264_qsv @ 0000] Error creating a MFX session: -9.');
      },
    });
    expect(tried).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf']);
    expect(probe.selected).toEqual({ codec: 'h264_amf' });
    expect(probe.attempts.map((a) => [a.codec, a.ok])).toEqual([
      ['h264_nvenc', false],
      ['h264_qsv', false],
      ['h264_amf', true],
    ]);
    expect(probe.attempts[0]!.error).toBe('Cannot load nvcuda.dll');
    expect(probe.attempts[1]!.error).toBe('Error creating a MFX session: -9.');
  });

  it('stops at the first encoder that works', async () => {
    const tried: string[] = [];
    const probe = await probeHardwareEncoders({
      platform: 'linux',
      arch: 'x64',
      listEncoders: listAll,
      tryEncode: async (args) => void tried.push(codecOf(args)!),
    });
    expect(probe.selected?.codec).toBe('h264_nvenc');
    expect(tried).toEqual(['h264_nvenc']);
  });

  it('never spawns a test encode for an encoder this ffmpeg was built without', async () => {
    const tried: string[] = [];
    const probe = await probeHardwareEncoders({
      platform: 'win32',
      arch: 'x64',
      listEncoders: async () => new Set(['libx264', 'h264_amf']),
      tryEncode: async (args) => void tried.push(codecOf(args)!),
    });
    expect(tried).toEqual(['h264_amf']);
    expect(probe.attempts[0]).toMatchObject({ codec: 'h264_nvenc', ok: false, error: 'not in this ffmpeg build' });
  });

  it('macOS arm64 falls back to bitrate mode when constant quality is refused', async () => {
    const probe = await probeHardwareEncoders({
      platform: 'darwin',
      arch: 'arm64',
      listEncoders: listAll,
      tryEncode: async (args) => {
        if (args.includes('-q:v')) throw ffmpegExit('Error setting quality');
      },
    });
    expect(probe.selected).toEqual({ codec: 'h264_videotoolbox', rateControl: 'bitrate' });
  });

  it('reports no hardware (and never throws) when nothing works or the listing fails', async () => {
    const none = await probeHardwareEncoders({
      platform: 'win32',
      arch: 'x64',
      listEncoders: async () => {
        throw new Error('ffmpeg missing');
      },
      tryEncode: async () => undefined,
    });
    expect(none.selected).toBeUndefined();
    expect(none.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('times each test encode', async () => {
    let t = 1000;
    const probe = await probeHardwareEncoders({
      platform: 'win32',
      arch: 'x64',
      listEncoders: listAll,
      tryEncode: async () => {
        t += 250;
      },
      now: () => t,
    });
    expect(probe.attempts[0]).toMatchObject({ codec: 'h264_nvenc', ok: true, ms: 250 });
  });
});

describe('planVideoEncode', () => {
  const nvenc: HardwareEncoderProbe = { selected: { codec: 'h264_nvenc' }, attempts: [] };

  it('quality (and unset) is x264 with no fallback, exactly as before', () => {
    expect(planVideoEncode('quality', nvenc, g720)).toEqual({ primary: LIBX264 });
    expect(planVideoEncode(undefined, nvenc, g720)).toEqual({ primary: LIBX264 });
  });

  it('auto and fast: the probed hardware encoder first, x264 as the one retry', () => {
    for (const q of ['auto', 'fast'] as const) {
      const plan = planVideoEncode(q, nvenc, g720);
      expect(plan.primary).toEqual({ codec: 'h264_nvenc', hardware: true, args: hardwareEncoderArgs({ codec: 'h264_nvenc' }, g720) });
      expect(plan.fallback).toEqual(LIBX264);
    }
  });

  it('auto without a working hardware encoder is plain x264', () => {
    expect(planVideoEncode('auto', { attempts: [] }, g720)).toEqual({ primary: LIBX264 });
    expect(planVideoEncode('auto', undefined, g720)).toEqual({ primary: LIBX264 });
  });

  it('only fast/auto pay for a probe', () => {
    expect(wantsHardwareEncoder('auto')).toBe(true);
    expect(wantsHardwareEncoder('fast')).toBe(true);
    expect(wantsHardwareEncoder('quality')).toBe(false);
    expect(wantsHardwareEncoder(undefined)).toBe(false);
  });
});

describe('encodeWithFallback', () => {
  const hw: VideoEncoderChoice = { codec: 'h264_nvenc', hardware: true, args: ['-cq', '23'] };
  const plan = { primary: hw, fallback: LIBX264 };

  it('uses the primary encoder when it works', async () => {
    const seen: string[] = [];
    const out = await encodeWithFallback(plan, async (e) => {
      seen.push(e.codec);
      return 'ok';
    });
    expect(seen).toEqual(['h264_nvenc']);
    expect(out).toEqual({ result: 'ok', report: { codec: 'h264_nvenc', hardware: true } });
  });

  it('retries ONCE with x264 when the hardware encode fails, and says why', async () => {
    const seen: string[] = [];
    const out = await encodeWithFallback(plan, async (e) => {
      seen.push(e.codec);
      if (e.hardware) throw ffmpegExit('ffmpeg version n9.0.2\n[h264_nvenc @ 0x1] No capable devices found\nError while opening encoder');
      return 'ok';
    });
    expect(seen).toEqual(['h264_nvenc', 'libx264']);
    expect(out.report).toEqual({
      codec: 'libx264',
      hardware: false,
      fallbackFrom: 'h264_nvenc',
      fallbackReason: 'No capable devices found',
    });
  });

  it('surfaces the x264 error when the retry fails too (no loop)', async () => {
    let calls = 0;
    await expect(
      encodeWithFallback(plan, async (e) => {
        calls += 1;
        throw ffmpegExit(e.hardware ? '[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory' : `attempt ${calls} failed`);
      }),
    ).rejects.toThrow(/exited with code 1/);
    expect(calls).toBe(2);
  });

  it('does not re-encode for a failure x264 would hit too: a full disk, a bad input, libass', async () => {
    for (const stderr of [
      '[out#0/mp4 @ 0x1] Error writing trailer: No space left on device',
      'input.mp4: Invalid data found when processing input',
      "[Parsed_subtitles_0 @ 0x1] Unable to open burn.ass",
    ]) {
      let calls = 0;
      await expect(
        encodeWithFallback(plan, async () => {
          calls += 1;
          throw ffmpegExit(stderr);
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it("names the encoder's own error, not libass's font chatter", async () => {
    const out = await encodeWithFallback({ primary: { codec: 'h264_amf', hardware: true, args: [] }, fallback: LIBX264 }, async (e) => {
      if (e.hardware) {
        throw ffmpegExit(
          [
            "[Parsed_subtitles_0 @ 0x1] Error opening memory font 'OFL.txt'",
            '[h264_amf @ 0x2] DLL amfrt64.dll failed to open',
            '[vost#0:0/h264_amf @ 0x3] Error while opening encoder',
          ].join('\n'),
        );
      }
      return 'ok';
    });
    expect(out.report.fallbackReason).toBe('DLL amfrt64.dll failed to open');
  });

  it('never retries a cancel, a timeout, a missing ffmpeg or a filesystem error', async () => {
    const errors = [
      new AppErrorException('CANCELLED', 'cancelled'),
      new AppErrorException('WORKER_TIMEOUT', 'timed out'),
      new AppErrorException('FFMPEG_NOT_FOUND', 'no ffmpeg'),
      Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }),
    ];
    for (const err of errors) {
      let calls = 0;
      await expect(
        encodeWithFallback(plan, async () => {
          calls += 1;
          throw err;
        }),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('does not retry once the run was cancelled, even if ffmpeg reported a plain exit', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      encodeWithFallback(
        plan,
        async () => {
          calls += 1;
          throw ffmpegExit('killed');
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('rethrows when the plan has no fallback (x264 itself failed)', async () => {
    await expect(
      encodeWithFallback({ primary: LIBX264 }, async () => {
        throw ffmpegExit('boom');
      }),
    ).rejects.toThrow(/exited/);
  });
});

describe('summarizeEncoderError / isEncoderFailure', () => {
  it('skips the version banner and strips the [codec @ addr] prefix', () => {
    const stderr = [
      'ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers',
      '  built with gcc 16.2.0',
      "[vost#0:0 @ 0x1] Unknown encoder 'h264_bogus'",
      'Error opening output files: Encoder not found',
    ].join('\n');
    expect(summarizeEncoderError(ffmpegExit(stderr))).toBe("Unknown encoder 'h264_bogus'");
  });

  it('falls back to the last line, then the message', () => {
    expect(summarizeEncoderError(ffmpegExit('line one\nline two'))).toBe('line two');
    expect(summarizeEncoderError(new AppErrorException('UNKNOWN', 'plain message'))).toBe('plain message');
  });

  it('only an ffmpeg exit that blames the encoder counts as an encoder failure', () => {
    expect(isEncoderFailure(ffmpegExit('[h264_nvenc @ 0x1] No capable devices found'))).toBe(true);
    expect(isEncoderFailure(ffmpegExit('No capable devices found'))).toBe(true);
    expect(isEncoderFailure(ffmpegExit("[vost#0:0 @ 0x1] Unknown encoder 'h264_bogus'"), 'h264_bogus')).toBe(true);
    expect(isEncoderFailure(ffmpegExit('x'))).toBe(false);
    expect(isEncoderFailure(new AppErrorException('CANCELLED', 'c'))).toBe(false);
    expect(isEncoderFailure(new Error('EPERM'))).toBe(false);
  });
});

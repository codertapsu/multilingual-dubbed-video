import { describe, expect, it } from 'vitest';

import { LIBX264 } from './encoder.js';
import {
  FfmpegProgressParser,
  buildConcatList,
  buildJoinArgs,
  buildJoinFilterComplex,
  buildJoinProbeArgs,
  buildJoinSampleArgs,
  compareJoinFiles,
  joinAudioBitrateKbps,
  joinAudioChain,
  joinBoundariesMs,
  joinEndSample,
  joinListPathFor,
  joinOutputExtension,
  joinPosition,
  joinSampleSpeed,
  joinSpanSec,
  joinTarget,
  nextJoinSampleSec,
  parseDurationTag,
  parseJoinProbe,
  planJoin,
  quoteConcatPath,
  sameFrameRate,
  type JoinProbe,
  type JoinTarget,
  type JoinVideoInfo,
} from './join.js';

const video = (over: Partial<JoinVideoInfo> = {}): JoinVideoInfo => ({
  codec: 'h264',
  profile: 'High',
  width: 1080,
  height: 1920,
  rotation: 0,
  fps: 30,
  fpsText: '30/1',
  pixFmt: 'yuv420p',
  ...over,
});

const file = (path: string, spanSec: number, over: Partial<JoinProbe> = {}): JoinProbe => ({
  path,
  sizeBytes: 1000,
  startSec: 0,
  spanSec,
  video: video(),
  audio: { codec: 'aac', sampleRate: 48_000, channels: 2 },
  ...over,
});

describe('parseJoinProbe', () => {
  it('measures a file by where its PICTURE ends, not by its longest stream', () => {
    // P4-like: the sound runs past the picture. The container's duration is
    // the longer one; the next file must start where the picture ends.
    const json = {
      format: { start_time: '0.000000', duration: '2.400000', size: '24925' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          profile: 'High',
          width: 160,
          height: 90,
          pix_fmt: 'yuv420p',
          r_frame_rate: '25/1',
          avg_frame_rate: '25/1',
          start_time: '0.000000',
          duration: '2.000000',
          extradata_hash: 'SHA256:aa',
          bit_rate: '1200000',
        },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, start_time: '0.000000', duration: '2.400000', bit_rate: '128000' },
      ],
    };
    const p = parseJoinProbe(json, 'C:\\v\\c.mp4', 0);
    expect(p.spanSec).toBe(2);
    expect(p.audioSpanSec).toBeCloseTo(2.4, 6);
    expect(p.sizeBytes).toBe(24925);
    expect(p.video).toMatchObject({ codec: 'h264', profile: 'High', width: 160, height: 90, fps: 25, fpsText: '25/1', rotation: 0, extradataHash: 'SHA256:aa', bitrateKbps: 1200 });
    expect(p.audio).toEqual({ codec: 'aac', sampleRate: 48_000, channels: 1, bitrateKbps: 128 });
  });

  it('counts from the container start (an MPEG-TS starting at 1.4 s) and reads the rotation', () => {
    const p = parseJoinProbe(
      {
        format: { start_time: '1.400000', duration: '10.000000' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001', start_time: '1.483000', duration: '9.900000', side_data_list: [{ rotation: -90 }] },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2, start_time: '1.400000', duration: '10.000000' },
        ],
      },
      'p.ts',
      5,
    );
    expect(p.startSec).toBe(1.4);
    expect(p.spanSec).toBeCloseTo(0.083 + 9.9, 6);
    expect(p.video?.rotation).toBe(270);
    expect(p.video?.fps).toBe(29.97);
    expect(p.video?.fpsText).toBe('30000/1001');
  });

  it('skips cover art, reads Matroska DURATION tags, and falls back to the container length', () => {
    const p = parseJoinProbe(
      {
        format: { duration: '61.5' },
        streams: [
          { codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } },
          { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, r_frame_rate: '25/1', tags: { DURATION: '00:01:01.000000000' } },
        ],
      },
      'a.mkv',
      1,
    );
    expect(p.video?.codec).toBe('vp9');
    expect(p.spanSec).toBe(61);
    expect(p.audio).toBeUndefined();

    const noStreamLength = parseJoinProbe(
      { format: { duration: '12.5' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }] },
      'b.mkv',
    );
    expect(noStreamLength.spanSec).toBe(12.5);
  });

  it('has no picture for an audio-only file', () => {
    const p = parseJoinProbe({ format: { duration: '3' }, streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }] }, 'x.mp3');
    expect(p.video).toBeUndefined();
    expect(p.spanSec).toBe(3);
  });

  it('parses Matroska duration tags', () => {
    expect(parseDurationTag('01:02:03.500000000')).toBeCloseTo(3723.5, 6);
    expect(parseDurationTag('nonsense')).toBeUndefined();
    expect(parseDurationTag(undefined)).toBeUndefined();
  });

  it('asks ffprobe for the setup-data hash', () => {
    expect(buildJoinProbeArgs('in.mp4')).toEqual([
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_data_hash', 'SHA256', '-i', 'in.mp4',
    ]);
  });
});

describe('compareJoinFiles', () => {
  it('finds nothing when every file was encoded alike (the picture is copied)', () => {
    expect(compareJoinFiles([file('a', 10), file('b', 20), file('c', 5)])).toEqual([]);
  });

  it('names each difference that stops a copy, against the first file', () => {
    const files = [
      file('p1', 10),
      file('p2', 10, { video: video({ width: 720, height: 1280 }) }),
      file('p3', 10, { video: video({ fps: 25, fpsText: '25/1' }) }),
      file('p4', 10, { video: video({ codec: 'hevc', profile: 'Main' }) }),
      file('p5', 10, { video: video({ profile: 'Main' }) }),
      file('p6', 10, { video: video({ pixFmt: 'yuv420p10le' }) }),
    ];
    expect(compareJoinFiles(files)).toEqual([
      { field: 'resolution', index: 1, value: '720×1280', expected: '1080×1920' },
      { field: 'frame-rate', index: 2, value: '25 fps', expected: '30 fps' },
      { field: 'codec', index: 3, value: 'hevc', expected: 'h264' },
      { field: 'profile', index: 4, value: 'Main', expected: 'High' },
      { field: 'pixel-format', index: 5, value: 'yuv420p10le', expected: 'yuv420p' },
    ]);
  });

  it('tells a turned phone video from an upright one of the same display size', () => {
    const upright = file('a', 1, { video: video({ width: 1080, height: 1920 }) });
    const turned = file('b', 1, { video: video({ width: 1920, height: 1080, rotation: 90 }) });
    const m = compareJoinFiles([upright, turned]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ field: 'resolution', value: '1080×1920 (stored 1920×1080, turned 90°)' });
  });

  it('accepts the same frame rate written two ways, not 30 vs 29.97', () => {
    expect(sameFrameRate(29.97, 30000 / 1001)).toBe(true);
    expect(sameFrameRate(23.98, 24000 / 1001)).toBe(true);
    expect(sameFrameRate(30, 29.97)).toBe(false);
    expect(sameFrameRate(60, 59.94)).toBe(false);
    expect(compareJoinFiles([file('a', 1), file('b', 1, { video: video({ fps: 30.0004 }) })])).toEqual([]);
  });

  it('copies H.264 encoded with other settings (the concat demuxer carries each file\'s own), not HEVC', () => {
    // H.264: concat's auto_convert inserts every file's SPS/PPS in-band.
    const h264 = [file('a', 1, { video: video({ extradataHash: 'SHA256:1' }) }), file('b', 1, { video: video({ extradataHash: 'SHA256:2' }) })];
    expect(compareJoinFiles(h264)).toEqual([]);
    const hevc = [
      file('a', 1, { video: video({ codec: 'hevc', profile: 'Main', extradataHash: 'SHA256:1' }) }),
      file('b', 1, { video: video({ codec: 'hevc', profile: 'Main', extradataHash: 'SHA256:2' }) }),
    ];
    expect(compareJoinFiles(hevc)).toEqual([{ field: 'encoding', index: 1, value: 'encoded with other settings', expected: "the first file's settings" }]);
  });
});

describe('joinTarget', () => {
  it('takes the size and rate most of the video already has, so the fewest minutes are rescaled', () => {
    const t = joinTarget([
      file('intro', 60, { video: video({ width: 1920, height: 1080, fps: 60, fpsText: '60/1' }) }),
      file('p1', 3600),
      file('p2', 3600, { video: video({ fps: 25, fpsText: '25/1' }) }),
      file('p3', 3600, { video: video({ fps: 25, fpsText: '25/1' }) }),
    ]);
    expect(t).toEqual({ width: 1080, height: 1920, fps: 25, fpsText: '25/1' });
  });

  it('uses the display size and keeps it even', () => {
    const t = joinTarget([file('a', 10, { video: video({ width: 1081, height: 1921, rotation: 90 }) })]);
    expect(t).toMatchObject({ width: 1920, height: 1080 });
  });

  it('has nothing to fit to without a picture', () => {
    expect(joinTarget([file('a', 1, { video: undefined })])).toBeUndefined();
  });
});

describe('spans and samples', () => {
  const t25: JoinTarget = { width: 160, height: 90, fps: 25, fpsText: '25/1' };
  const ntsc: JoinTarget = { width: 160, height: 90, fps: 29.97, fpsText: '30000/1001' };

  it('keeps a copied picture\'s own length, rounded UP to the microsecond (never into the next file)', () => {
    expect(joinSpanSec(2, 'copy')).toBe(2);
    expect(joinSpanSec(2.0000004, 'copy')).toBe(2.000001);
    expect(joinSpanSec(9826.357, 'copy')).toBe(9826.357);
  });

  it('cuts a re-encoded file to a whole number of frames, so frames and sound end together', () => {
    expect(joinSpanSec(1.5, 'reencode', t25)).toBe(1.52);
    expect(joinSpanSec(1.5, 'reencode', ntsc)).toBe(1.5015);
    expect(joinSpanSec(0.001, 'reencode', t25)).toBe(0.04);
  });

  it('cuts each file\'s sound to exactly its span at 48 kHz', () => {
    expect(joinEndSample(2)).toBe(96_000);
    expect(joinEndSample(1.5015)).toBe(72_072);
    expect(joinEndSample(9826.357)).toBe(471_665_136);
  });

  it('places each file where the previous one ends (Project.inputFiles)', () => {
    // Rounded from the running total, so the ms never drift from the seconds.
    expect(joinBoundariesMs({ files: [{ spanSec: 2.0006 }, { spanSec: 3 }, { spanSec: 1.5 }] as never })).toEqual([
      { startMs: 0, durationMs: 2001 },
      { startMs: 2001, durationMs: 3000 },
      { startMs: 5001, durationMs: 1500 },
    ]);
  });

  it('plans a re-encode only with a target', () => {
    expect(() => planJoin([file('a', 1), file('b', 1)], 'reencode')).toThrow(/target/);
    const plan = planJoin([file('a', 1.5), file('b', 1, { audio: undefined, startSec: 1.4 })], 'reencode', t25);
    expect(plan).toEqual({
      mode: 'reencode',
      target: t25,
      files: [
        { path: 'a', startSec: 0, spanSec: 1.52, hasAudio: true, frames: 38 },
        { path: 'b', startSec: 1.4, spanSec: 1, hasAudio: false, frames: 25 },
      ],
    });
  });

  it('counts a copied file\'s frames as its container does, else from its length and rate', () => {
    const plan = planJoin([file('a', 10, { video: video({ frames: 299 }) }), file('b', 2)], 'copy');
    expect(plan.files.map((f) => f.frames)).toEqual([299, 60]);
  });
});

describe('joinPosition', () => {
  const plan = { files: [{ frames: 100, spanSec: 4 }, { frames: 300, spanSec: 10 }] as never[] };

  it('measures a join by frames written (a copy\'s out_time is unusable under -copyts)', () => {
    expect(joinPosition(plan, { outTimeMs: 0, frame: 50, end: false })).toEqual({ fraction: 0.125, fileIndex: 0 });
    expect(joinPosition(plan, { outTimeMs: 0, frame: 100, end: false })).toEqual({ fraction: 0.25, fileIndex: 1 });
    expect(joinPosition(plan, { outTimeMs: 0, frame: 399, end: false })).toEqual({ fraction: 399 / 400, fileIndex: 1 });
  });

  it('falls back to out_time without frames, and is done at the end', () => {
    expect(joinPosition(plan, { outTimeMs: 7000, end: false })).toEqual({ fraction: 0.5, fileIndex: 1 });
    expect(joinPosition(plan, { outTimeMs: 0, frame: 10, end: true })).toEqual({ fraction: 1, fileIndex: 1 });
  });
});

describe('the concat list', () => {
  it('quotes any path literally (Windows backslashes, apostrophes, any script)', () => {
    expect(quoteConcatPath("D:\\Phim\\dir with 'quote'\\持械入大宋 P2.mp4")).toBe("'D:\\Phim\\dir with '\\''quote'\\''\\持械入大宋 P2.mp4'");
  });

  it('lists every file with its exact length', () => {
    expect(buildConcatList([{ path: '/v/P1.mp4', spanSec: 36000.123456 }, { path: '/v/P2.mp4', spanSec: 2 }])).toBe(
      "ffconcat version 1.0\nfile '/v/P1.mp4'\nduration 36000.123456\nfile '/v/P2.mp4'\nduration 2.000000\n",
    );
  });

  it('sits beside the output', () => {
    expect(joinListPathFor('/p/input/original.mp4').replace(/\\/g, '/')).toBe('/p/input/original.join.ffconcat');
  });
});

describe('the join graph', () => {
  it('re-times each file\'s sound to its own picture and cuts it to exactly that length (plan 1.1\'s compensation)', () => {
    expect(joinAudioChain('[2:a:0]', 2, 'a1')).toBe(
      '[2:a:0]aformat=channel_layouts=stereo,aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=96000[a1]',
    );
  });

  it('gives a file without sound silence of its picture\'s length', () => {
    expect(joinAudioChain(null, 1.5, 'a0')).toBe('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=72000[a0]');
  });

  it('copy: opens only the files with sound again, in order, and concatenates the sound', () => {
    const plan = planJoin([file('a', 2), file('b', 1.5, { audio: undefined }), file('c', 3)], 'copy');
    expect(buildJoinFilterComplex(plan)).toBe(
      [
        '[1:a:0]aformat=channel_layouts=stereo,aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=96000[a0]',
        'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=72000[a1]',
        '[2:a:0]aformat=channel_layouts=stereo,aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=144000[a2]',
        '[a0][a1][a2]concat=n=3:v=0:a=1[aout]',
      ].join(';'),
    );
  });

  it('copy argv: -copyts, the list as input 0, each sound moved to its file\'s start, picture copied', () => {
    const plan = planJoin([file('C:\\v\\P1.mp4', 2), file('C:\\v\\P2.ts', 3, { startSec: 1.4 })], 'copy');
    const args = buildJoinArgs({ plan, listPath: 'C:\\w\\input\\original.join.ffconcat', outputPath: 'C:\\w\\input\\original.partial.mp4', audioBitrateKbps: 256 });
    expect(args.slice(0, 11)).toEqual(['-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1', '-copyts']);
    const head = args.slice(11, args.indexOf('-filter_complex'));
    expect(head).toEqual([
      '-f', 'concat', '-safe', '0', '-i', 'C:\\w\\input\\original.join.ffconcat',
      '-discard:v', 'all', '-i', 'C:\\v\\P1.mp4',
      '-itsoffset', '-1.400000', '-discard:v', 'all', '-i', 'C:\\v\\P2.ts',
    ]);
    const tail = args.slice(args.indexOf('-filter_complex') + 2);
    expect(tail).toEqual([
      '-map', '0:V:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
      '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '4096', 'C:\\w\\input\\original.partial.mp4',
    ]);
  });

  it('re-encode argv: every file once, fitted, whole frames, one encoder', () => {
    const target: JoinTarget = { width: 1080, height: 1920, fps: 30, fpsText: '30/1' };
    const plan = planJoin([file('a.mp4', 2), file('b.mp4', 1.5, { audio: undefined })], 'reencode', target);
    const args = buildJoinArgs({ plan, outputPath: 'out.mp4', encoder: LIBX264 });
    expect(args).not.toContain('-copyts');
    expect(args.slice(10, 14)).toEqual(['-i', 'a.mp4', '-i', 'b.mp4']);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph.split(';')).toEqual([
      '[0:V:0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30/1,format=yuv420p,trim=end=2.000000[v0]',
      '[0:a:0]aformat=channel_layouts=stereo,aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=96000[a0]',
      '[1:V:0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30/1,format=yuv420p,trim=end=1.500000[v1]',
      'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=72000[a1]',
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]',
    ]);
    expect(args.slice(args.indexOf('[vout]') - 1, args.indexOf('-c:a'))).toEqual(['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', ...LIBX264.args]);
  });

  it('refuses a join of one file, a copy without its list, a re-encode without a target', () => {
    expect(() => buildJoinArgs({ plan: { mode: 'copy', files: [planJoin([file('a', 1)], 'copy').files[0]!] }, listPath: 'l', outputPath: 'o' })).toThrow(/two/);
    expect(() => buildJoinArgs({ plan: planJoin([file('a', 1), file('b', 1)], 'copy'), outputPath: 'o' })).toThrow(/list/);
    expect(() => buildJoinArgs({ plan: { mode: 'reencode', files: planJoin([file('a', 1), file('b', 1)], 'copy').files }, outputPath: 'o' })).toThrow(/target/);
  });

  it('takes the speed from the extra seconds of a longer test encode, so the fixed costs cancel', () => {
    // The 2026-11-27 join, h264_nvenc: ~0.7 s every ffmpeg pays once, then 19.4x.
    const run = (seconds: number) => ({ seconds, elapsedSec: 0.7 + seconds / 19.4, bytes: seconds * 500_000 });
    const first = run(2);
    // One 4-s encode alone read 4.4x, the estimate four times too long.
    expect(4 / run(4).elapsedSec).toBeLessThan(5);
    const second = nextJoinSampleSec(first, undefined, 120)!;
    expect(second).toBeCloseTo(2 + 2 * (2 / first.elapsedSec), 5);
    // Its extra seconds took a quarter of a second: too short to believe, so once more, longer.
    const third = nextJoinSampleSec(first, run(second), 120)!;
    expect(third).toBeGreaterThan(30);
    expect(nextJoinSampleSec(first, run(third), 120)).toBeUndefined();
    expect(joinSampleSpeed(first, run(third))).toBeCloseTo(19.4, 1);
  });

  it('stops at the end of the window, and never answers slower than an encode with its fixed costs in', () => {
    const first = { seconds: 2, elapsedSec: 0.8, bytes: 1 };
    // A 5-s file: one more encode, to its end (7 s at this pace), then no further.
    expect(nextJoinSampleSec(first, undefined, 5)).toBe(5);
    expect(nextJoinSampleSec(first, { seconds: 5, elapsedSec: 1.1, bytes: 1 }, 5)).toBeUndefined();
    // A slow encoder: the first 1 s more already takes a believable while.
    const slow = { seconds: 2, elapsedSec: 4.5, bytes: 1 };
    expect(nextJoinSampleSec(slow, undefined, 120)).toBe(3);
    expect(nextJoinSampleSec(slow, { seconds: 3, elapsedSec: 6.5, bytes: 1 }, 120)).toBeUndefined();
    expect(joinSampleSpeed(slow, { seconds: 3, elapsedSec: 6.5, bytes: 1 })).toBeCloseTo(0.5, 5);
    // Noise: the longer encode took no longer, or far longer. Its own pace then, never a made-up one.
    expect(joinSampleSpeed(first, { seconds: 6, elapsedSec: 0.8, bytes: 1 })).toBeCloseTo(7.5, 5);
    expect(joinSampleSpeed(first, { seconds: 6, elapsedSec: 12, bytes: 1 })).toBeCloseTo(0.5, 5);
  });

  it('times a test encode the way the join encodes', () => {
    const target: JoinTarget = { width: 1080, height: 1920, fps: 30, fpsText: '30/1' };
    expect(buildJoinSampleArgs({ path: 'p3.mp4' }, target, LIBX264, 1800, 4, 'sample.mp4')).toEqual([
      '-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', '1800.000', '-t', '4.000', '-i', 'p3.mp4', '-an',
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30/1,format=yuv420p,trim=end=4.000000',
      '-c:v', 'libx264', ...LIBX264.args, 'sample.mp4',
    ]);
  });
});

describe('output choices', () => {
  it('writes MP4 unless a copied codec does not fit in one', () => {
    expect(joinOutputExtension('copy', 'h264')).toBe('mp4');
    expect(joinOutputExtension('copy', 'hevc')).toBe('mp4');
    expect(joinOutputExtension('copy', 'mpeg2video')).toBe('mkv');
    expect(joinOutputExtension('reencode', 'mpeg2video')).toBe('mp4');
  });

  it('encodes the sound at 192 kb/s or more, as much as the best source had, at most 320', () => {
    expect(joinAudioBitrateKbps([file('a', 1), file('b', 1)])).toBe(192);
    expect(joinAudioBitrateKbps([file('a', 1, { audio: { codec: 'aac', sampleRate: 48000, channels: 2, bitrateKbps: 250 } })])).toBe(256);
    expect(joinAudioBitrateKbps([file('a', 1, { audio: { codec: 'flac', sampleRate: 48000, channels: 2, bitrateKbps: 900 } })])).toBe(320);
  });
});

describe('FfmpegProgressParser', () => {
  it('reports each block of -progress output, N/A at first, and the end', () => {
    const p = new FfmpegProgressParser();
    const feed = (block: string) => block.split('\n').map((l) => p.push(l)).filter(Boolean);
    expect(feed('frame=0\nout_time_us=N/A\nout_time_ms=N/A\nspeed=N/A\nprogress=continue')).toEqual([{ outTimeMs: 0, frame: 0, end: false }]);
    expect(feed('frame=200\nout_time_us=8000000\nout_time_ms=8000000\nout_time=00:00:08.000000\nspeed=  36x\nprogress=continue')).toEqual([
      { outTimeMs: 8000, frame: 200, speed: 36, end: false },
    ]);
    expect(feed('out_time_us=9500000\nspeed=1.5x\nprogress=end')).toEqual([{ outTimeMs: 9500, frame: 200, speed: 1.5, end: true }]);
    expect(p.push('garbage')).toBeUndefined();
  });
});

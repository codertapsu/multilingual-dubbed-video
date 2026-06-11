import { describe, expect, it } from 'vitest';
import { parseFfmpegFilters } from './exec.js';
import { buildClip16kMonoArgs, buildExtract16kMonoArgs, buildExtractAudioArgs } from './extract.js';
import { buildProbeArgs, ffprobeJsonToMediaInfo, parseFrameRate } from './probe.js';
import {
  buildRenderArgs,
  sidecarDestinationPath,
  type RenderArgsContext,
} from './render.js';
import {
  buildMixArgs,
  buildMixFilterComplex,
  dbToVolumeArg,
  type DuckAndMixInput,
} from './mix.js';
import {
  alignedSegmentsToClips,
  buildTimelineFilterComplex,
  buildTimelineMixArgs,
  chunkClips,
  estimateTimelineTmpBytes,
  MAX_INPUTS_PER_MIX,
  type TimelineClip,
} from './tts-timeline.js';
import type { AlignedSegment } from '@videodubber/shared';

/** Count occurrences of a flag in an argv array. */
function countFlag(args: string[], flag: string): number {
  return args.filter((a) => a === flag).length;
}

describe('probe args + parsing', () => {
  it('builds a json show_format/show_streams probe', () => {
    const args = buildProbeArgs('/tmp/in.mp4');
    expect(args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-i',
      '/tmp/in.mp4',
    ]);
  });

  it('parses frame rates from num/den', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate('25')).toBe(25);
  });

  it('maps ffprobe json to MediaInfo', () => {
    const info = ffprobeJsonToMediaInfo(
      {
        format: { format_name: 'mov,mp4,m4a', duration: '12.500', size: '1048576' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30000/1001',
            bit_rate: '5000000',
          },
          {
            index: 1,
            codec_type: 'audio',
            codec_name: 'aac',
            channels: 2,
            sample_rate: '48000',
            bit_rate: '128000',
            tags: { language: 'eng' },
          },
        ],
      },
      '/tmp/in.mp4',
    );

    expect(info.durationMs).toBe(12500);
    expect(info.container).toBe('mov,mp4,m4a');
    expect(info.sizeBytes).toBe(1048576);
    expect(info.hasAudio).toBe(true);
    expect(info.videoStreams).toHaveLength(1);
    expect(info.videoStreams[0]).toMatchObject({
      codec: 'h264',
      width: 1920,
      height: 1080,
      bitrateKbps: 5000,
    });
    expect(info.videoStreams[0].fps).toBeCloseTo(29.97, 2);
    expect(info.audioStreams[0]).toMatchObject({
      codec: 'aac',
      channels: 2,
      sampleRate: 48000,
      bitrateKbps: 128,
      language: 'eng',
    });
  });

  it('reports hasAudio=false when there is no audio stream', () => {
    const info = ffprobeJsonToMediaInfo(
      {
        format: { format_name: 'mp4', duration: '3.0' },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 480 }],
      },
      '/x.mp4',
    );
    expect(info.hasAudio).toBe(false);
    expect(info.audioStreams).toHaveLength(0);
  });
});

describe('extract args', () => {
  it('builds 48k stereo extraction args', () => {
    const args = buildExtractAudioArgs('/in.mp4', '/out/original.wav');
    expect(args).toContain('-vn');
    expect(args).toContain('pcm_s16le');
    // stereo + 48k
    const acIdx = args.indexOf('-ac');
    expect(args[acIdx + 1]).toBe('2');
    const arIdx = args.indexOf('-ar');
    expect(args[arIdx + 1]).toBe('48000');
    // input then output operands present
    expect(args).toContain('/in.mp4');
    expect(args[args.length - 1]).toBe('/out/original.wav');
  });

  it('builds 16k mono extraction args for STT', () => {
    const args = buildExtract16kMonoArgs('/in.mp4', '/out/16k.wav');
    const acIdx = args.indexOf('-ac');
    expect(args[acIdx + 1]).toBe('1');
    const arIdx = args.indexOf('-ar');
    expect(args[arIdx + 1]).toBe('16000');
    expect(args).toContain('pcm_s16le');
  });
});

describe('render args', () => {
  const base: RenderArgsContext = {
    inputVideoPath: '/in.mp4',
    audioPath: '/dub.wav',
    outputPath: '/out/output.mp4',
    subtitleExportMode: 'none',
    platform: 'linux',
  };

  it('none mode copies video and encodes aac audio with correct maps', () => {
    const args = buildRenderArgs(base);
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args).toContain('aac');
    // map video from input 0, audio from input 1
    const maps = args.reduce<string[]>((acc, a, i) => {
      if (a === '-map') acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(maps).toContain('0:v:0');
    expect(maps).toContain('1:a:0');
    expect(args[args.length - 1]).toBe('/out/output.mp4');
  });

  it('srt-file mode behaves like none for the mux (sidecar handled separately)', () => {
    const args = buildRenderArgs({ ...base, subtitleExportMode: 'srt-file' });
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    // no subtitle stream mapping
    expect(countFlag(args, '-map')).toBe(2);
  });

  it('embedded-soft maps a 3rd input with mov_text codec', () => {
    const args = buildRenderArgs({
      ...base,
      subtitleExportMode: 'embedded-soft',
      subtitlePath: '/subs.srt',
    });
    expect(args).toContain('/subs.srt');
    expect(countFlag(args, '-map')).toBe(3);
    const maps = args.reduce<string[]>((acc, a, i) => {
      if (a === '-map') acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(maps).toContain('2:0');
    expect(args).toContain('mov_text');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
  });

  it('embedded-soft throws when subtitlePath is missing', () => {
    expect(() =>
      buildRenderArgs({ ...base, subtitleExportMode: 'embedded-soft' }),
    ).toThrow();
  });

  it('burned-in re-encodes video with a subtitles filter', () => {
    const args = buildRenderArgs({
      ...base,
      subtitleExportMode: 'burned-in',
      subtitlePath: '/subs.srt',
      burnSubtitleStyle: {
        fontFamily: 'Arial',
        fontSize: 24,
        primaryColor: '#FFFFFF',
        outlineColor: '#000000',
        outlineWidth: 2,
        alignment: 'bottom',
      },
    });
    expect(args).toContain('-vf');
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf.startsWith('subtitles=/subs.srt')).toBe(true);
    expect(vf).toContain('force_style=');
    // re-encode, not copy
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });

  it('burned-in throws without a subtitle path', () => {
    expect(() =>
      buildRenderArgs({ ...base, subtitleExportMode: 'burned-in' }),
    ).toThrow();
  });
});

describe('sidecarDestinationPath', () => {
  it('returns a .srt path next to the output for srt-file', () => {
    expect(sidecarDestinationPath('/out/movie.mp4', 'srt-file')).toBe('/out/movie.srt');
  });
  it('returns a .vtt path for vtt-file', () => {
    expect(sidecarDestinationPath('/out/movie.mp4', 'vtt-file')).toBe('/out/movie.vtt');
  });
  it('returns undefined for non-file modes', () => {
    expect(sidecarDestinationPath('/out/movie.mp4', 'none')).toBeUndefined();
    expect(sidecarDestinationPath('/out/movie.mp4', 'burned-in')).toBeUndefined();
  });
});

describe('mix', () => {
  const base: DuckAndMixInput = {
    originalAudio: '/orig.wav',
    ttsTimeline: '/tts.wav',
    output: '/final.wav',
    duckingLevelDb: -15,
    ttsGainDb: 2,
    includeBackground: true,
    duck: true,
  };

  it('dbToVolumeArg formats dB', () => {
    expect(dbToVolumeArg(-15)).toBe('-15dB');
    expect(dbToVolumeArg(0)).toBe('0dB');
  });

  it('duck=true uses sidechaincompress', () => {
    const f = buildMixFilterComplex(base);
    expect(f).toContain('sidechaincompress');
    expect(f).toContain('asplit');
    expect(f).toContain('loudnorm');
  });

  it('duck=false uses fixed volume attenuation, no sidechain', () => {
    const f = buildMixFilterComplex({ ...base, duck: false });
    expect(f).not.toContain('sidechaincompress');
    expect(f).toContain('volume=-15dB');
    expect(f).toContain('amix=inputs=2');
  });

  it('includeBackground=false outputs only the gained tts', () => {
    const f = buildMixFilterComplex({ ...base, includeBackground: false });
    expect(f).not.toContain('amix');
    expect(f).not.toContain('sidechaincompress');
    expect(f).toContain('[tts]loudnorm');
    expect(f).toContain('volume=2dB');
  });

  it('buildMixArgs passes original as input 0 and tts as input 1', () => {
    const args = buildMixArgs(base);
    expect(args.indexOf('/orig.wav')).toBeLessThan(args.indexOf('/tts.wav'));
    expect(args).toContain('-filter_complex');
    expect(args).toContain('[out]');
    expect(args[args.length - 1]).toBe('/final.wav');
  });
});

describe('tts-timeline', () => {
  function seg(id: string, startMs: number, audioPath: string): AlignedSegment {
    return {
      segmentId: id,
      startMs,
      endMs: startMs + 1000,
      audioPath,
      generatedDurationMs: 1000,
      placedDurationMs: 1000,
      speedRatio: 1,
      overflowMs: 0,
      status: 'ok',
    };
  }

  it('extracts and sorts clips, skipping empty audio paths', () => {
    const clips = alignedSegmentsToClips([
      seg('seg_0002', 2000, '/b.wav'),
      seg('seg_0001', 0, '/a.wav'),
      seg('seg_0003', 5000, ''), // skipped: no audio
    ]);
    expect(clips).toEqual<TimelineClip[]>([
      { audioPath: '/a.wav', startMs: 0 },
      { audioPath: '/b.wav', startMs: 2000 },
    ]);
  });

  it('builds an adelay+amix filtergraph for multiple clips', () => {
    const clips: TimelineClip[] = [
      { audioPath: '/a.wav', startMs: 0 },
      { audioPath: '/b.wav', startMs: 2000 },
    ];
    const f = buildTimelineFilterComplex(clips, 10000);
    expect(f).toContain('adelay=0|0');
    expect(f).toContain('adelay=2000|2000');
    expect(f).toContain('amix=inputs=2');
    expect(f).toContain('apad=whole_dur=10.000');
    expect(f).toContain('atrim=0:10.000');
    expect(f).toContain('[out]');
  });

  it('emits a silence-only graph when there are no clips', () => {
    const f = buildTimelineFilterComplex([], 4000);
    expect(f).toContain('atrim=0:4.000');
    expect(f).toContain('[out]');
  });

  it('builds mix args with one -i per clip', () => {
    const clips: TimelineClip[] = [
      { audioPath: '/a.wav', startMs: 0 },
      { audioPath: '/b.wav', startMs: 1000 },
    ];
    const args = buildTimelineMixArgs(clips, 5000, '/tts_full.wav');
    expect(countFlag(args, '-i')).toBe(2);
    expect(args).toContain('/a.wav');
    expect(args).toContain('/b.wav');
    expect(args[args.length - 1]).toBe('/tts_full.wav');
  });

  it('uses an anullsrc lavfi input when there are no clips', () => {
    const args = buildTimelineMixArgs([], 5000, '/tts_full.wav');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('lavfi');
    expect(args.some((a) => a.startsWith('anullsrc='))).toBe(true);
  });

  it('chunkClips splits beyond the limit', () => {
    const many: TimelineClip[] = Array.from({ length: MAX_INPUTS_PER_MIX + 5 }, (_, i) => ({
      audioPath: `/c${i}.wav`,
      startMs: i * 100,
    }));
    const chunks = chunkClips(many);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(MAX_INPUTS_PER_MIX);
    expect(chunks[1].length).toBe(5);
  });
});

describe('parseFfmpegFilters', () => {
  const sample = [
    'Filters:',
    '  T.. = Timeline support',
    '  .S. = Slice threading',
    ' ... avgblur           V->V       Apply Average Blur filter.',
    ' T.. subtitles         V->V       Render text subtitles onto input video using the libass library.',
    ' ..C ass               V->V       Render ASS subtitles onto input video using the libass library.',
    ' ... amix              N->A       Audio mixing.',
    ' ... anullsrc          |->A       Null audio source, return empty audio frames.',
  ].join('\n');

  it('extracts filter names from the name column', () => {
    const names = parseFfmpegFilters(sample);
    expect(names.has('subtitles')).toBe(true);
    expect(names.has('ass')).toBe(true);
    expect(names.has('avgblur')).toBe(true);
    expect(names.has('amix')).toBe(true);
    expect(names.has('anullsrc')).toBe(true);
  });

  it('does not pick up header/description words', () => {
    const names = parseFfmpegFilters(sample);
    expect(names.has('Timeline')).toBe(false);
    expect(names.has('libass')).toBe(false);
    expect(names.has('Render')).toBe(false);
  });

  it('reports the subtitles filter absent for a minimal (no-libass) build', () => {
    const minimal = ' ... amix              N->A       Audio mixing.\n ... volume            A->A       Change input volume.';
    const names = parseFfmpegFilters(minimal);
    expect(names.has('subtitles')).toBe(false);
    expect(names.has('volume')).toBe(true);
  });
});

describe('buildClip16kMonoArgs', () => {
  it('input-seeks and bounds the window, output 16k mono pcm_s16le', () => {
    const args = buildClip16kMonoArgs('in.wav', 'out.wav', 60_000, 150_000);
    // -ss must come BEFORE -i (fast input seek); -t bounds the window length.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('60.000');
    expect(args[args.indexOf('-t') + 1]).toBe('90.000'); // 150s - 60s
    expect(args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
    expect(args.at(-1)).toBe('out.wav');
  });

  it('clamps a negative start and never emits a negative duration', () => {
    const args = buildClip16kMonoArgs('in.wav', 'out.wav', -5_000, 1_000);
    expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
    expect(args[args.indexOf('-t') + 1]).toBe('1.000');
  });
});

describe('estimateTimelineTmpBytes', () => {
  it('is 0 for the single-pass path (<= MAX_INPUTS_PER_MIX clips)', () => {
    expect(estimateTimelineTmpBytes(MAX_INPUTS_PER_MIX, 60_000)).toBe(0);
    expect(estimateTimelineTmpBytes(1, 7_200_000)).toBe(0);
  });

  it('scales with intermediate count and full-clip length for chunked builds', () => {
    // 2-hour timeline, 2400 clips => ceil(2400/32)=75 level-1 + ceil(75/32)=3 level-2.
    const bytes = estimateTimelineTmpBytes(2400, 2 * 60 * 60 * 1000);
    const perFull = Math.ceil((7_200_000 / 1000) * 48_000 * 2 * 2);
    expect(bytes).toBe(Math.ceil((75 + 3) * perFull * 1.2));
    // Sanity: this is tens of GiB, which is exactly why the guard exists.
    expect(bytes / 1024 ** 3).toBeGreaterThan(50);
  });
});

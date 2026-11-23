import { describe, expect, it } from 'vitest';
import {
  buildAudioHeadArgs,
  buildAudioPacketsArgs,
  buildDecodedSamplesArgs,
  packetsToMs,
  parseAudioHead,
  parseAudioPackets,
  parseDecodedSamples,
  primingSamples,
  steadyFrameSize,
} from './drift.js';
import { silenceTimeoutMs } from './silences.js';

describe('counting the audio a source really holds', () => {
  it('asks for the first audio stream, its packets counted only when asked (or in a window)', () => {
    expect(buildAudioPacketsArgs('/p4.mp4', { countPackets: false })).toEqual([
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,nb_frames,nb_read_packets,initial_padding,duration:stream_tags=DURATION',
      '-print_format',
      'json',
      '-i',
      '/p4.mp4',
    ]);
    const window = buildAudioPacketsArgs('/p4.mp4', { range: { startMs: 600_000, endMs: 2_700_000 }, countPackets: true });
    expect(window.slice(4, 7)).toEqual(['-read_intervals', '600.000%2700.000', '-count_packets']);
    expect(buildAudioHeadArgs('/p4.mp4')).toContain('packet=pts_time:frame=nb_samples');
    expect(buildDecodedSamplesArgs('/x.webm', { startMs: 2000, endMs: 6000 })).toEqual([
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-v',
      'info',
      '-ss',
      '2.000',
      '-t',
      '4.000',
      '-i',
      '/x.webm',
      '-map',
      '0:a:0',
      '-af',
      'aformat=channel_layouts=mono,volumedetect',
      '-f',
      'null',
      '-',
    ]);
  });

  it('reads ffprobe 8 output: the container count, the counted packets, the claimed length', () => {
    // squeezed.mp4 (P4-like): timestamps say 10.000 s, 494 packets of 1024 samples say more.
    expect(
      parseAudioPackets({
        streams: [{ codec_name: 'aac', sample_rate: '48000', initial_padding: 0, duration: '10.000000', nb_frames: '494' }],
      }),
    ).toEqual({ codec: 'aac', sampleRate: 48000, containerPackets: 494, claimedMs: 10_000 });
    // Matroska: no container count, the length only as a tag.
    expect(
      parseAudioPackets({
        streams: [{ codec_name: 'mp3', sample_rate: '44100', initial_padding: 1105, nb_read_packets: '396', tags: { DURATION: '00:00:10.325000000' } }],
      }),
    ).toEqual({ codec: 'mp3', sampleRate: 44100, readPackets: 396, initialPadding: 1105, claimedMs: 10_325 });
    expect(parseAudioPackets({ streams: [] })).toBeUndefined();
  });

  it('the first seconds: the first packet time and each frame size', () => {
    const head = parseAudioHead({
      packets_and_frames: [
        { type: 'packet', pts_time: '-0.021333', side_data_list: [{}] },
        { type: 'packet', pts_time: '0.000000' },
        { type: 'frame', nb_samples: 1024 },
        { type: 'packet', pts_time: '0.021333' },
        { type: 'frame', nb_samples: 1024 },
      ],
    });
    expect(head).toEqual({ firstPtsSec: -0.021333, frameSamples: [1024, 1024] });
  });

  it('a steady frame size needs a few equal frames after the first (cut by the priming)', () => {
    expect(steadyFrameSize([47, 1152, 1152, 1152, 1152])).toBe(1152);
    expect(steadyFrameSize([1024, 1024, 1024])).toBeUndefined();
    expect(steadyFrameSize([648, 960, 1920, 960, 960])).toBeUndefined();
  });

  it('priming: the container value when it gives one, else the first packet before 0', () => {
    // MP4 AAC: priming only as a negative first timestamp.
    expect(primingSamples({ firstPtsSec: -0.021333, frameSamples: [] }, 48000, undefined)).toBe(1024);
    // An edit list's preroll counts too: a `-ss 2.5 -c copy` file starts 1.006667 s early.
    expect(primingSamples({ firstPtsSec: -1.006667, frameSamples: [] }, 48000)).toBe(48_320);
    // Matroska rounds times to the ms; its initial_padding is exact.
    expect(primingSamples({ firstPtsSec: -0.025, frameSamples: [] }, 44100, 1105)).toBe(1105);
    expect(primingSamples({ firstPtsSec: 0, frameSamples: [] }, 48000)).toBe(0);
  });

  it('packets to ms: the counts measured on real files', () => {
    // squeezed.mp4: (494 x 1024 - 1024) / 48000 = 10.517 s, a real decode counted 504832 samples.
    expect(packetsToMs(494, 1024, 1024, 48000)).toBe(10_517);
    // The -ss 2.5 copy: 423 demuxed packets less the 1.006667 s preroll = 8.017 s (decoded: 384832).
    expect(packetsToMs(423, 1024, 48_320, 48000)).toBe(8017);
    expect(packetsToMs(10, 1024, 0, 0)).toBe(0);
  });

  it('volumedetect: the largest n_samples (ffmpeg 8 sets the filter up twice)', () => {
    const stderr = [
      '[Parsed_volumedetect_0 @ 000001f7ae6ae980] n_samples: 0',
      '[Parsed_volumedetect_0 @ 000001f7ae6afd80] n_samples: 504832',
      '[Parsed_volumedetect_0 @ 000001f7ae6afd80] mean_volume: -21.0 dB',
    ].join('\n');
    expect(parseDecodedSamples(stderr)).toBe(504_832);
    expect(parseDecodedSamples('no audio here')).toBeUndefined();
  });

  it('a long track gets a long silence-detection timeout (27.8 h: over an hour)', () => {
    expect(silenceTimeoutMs(60_000)).toBe(300_000);
    expect(silenceTimeoutMs(100_080_000)).toBe(5_004_000);
  });
});

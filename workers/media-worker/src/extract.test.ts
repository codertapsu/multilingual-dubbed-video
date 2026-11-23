import { describe, expect, it } from 'vitest';
import {
  buildExtract16kMonoArgs,
  buildExtractAudioArgs,
  extractKeepMs,
  pictureClockFilter,
} from './extract.js';
import { ffprobeJsonToMediaInfo, pictureDurationMs, streamDurationMs } from './probe.js';

/**
 * Both audio tracks follow the picture's clock (plan 1.1): placed by their
 * timestamps and cut to the picture's length. The argv is pinned whole: these
 * two WAVs are what every later step is cut from.
 */
describe('extraction on the picture clock', () => {
  it('48 kHz stereo: re-timed and cut to the picture, exactly', () => {
    expect(buildExtractAudioArgs('/in.mp4', '/w/original.wav', undefined, 9_826_357)).toEqual([
      '-y',
      '-i',
      '/in.mp4',
      '-vn',
      '-af',
      'aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=471665136',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      '-rf64',
      'auto',
      '/w/original.wav',
    ]);
  });

  it('16 kHz mono: the same clock and length', () => {
    expect(buildExtract16kMonoArgs('/in.mp4', '/w/16k.wav', undefined, 9_826_357)).toEqual([
      '-y',
      '-i',
      '/in.mp4',
      '-vn',
      '-af',
      'aresample=16000:async=1000:first_pts=0,apad,atrim=end_sample=157221712',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '/w/16k.wav',
    ]);
  });

  it('a series part: its window, cut to the window (and never past the picture)', () => {
    const part = { startMs: 600_000, endMs: 2_700_000 };
    expect(buildExtractAudioArgs('/in.mp4', '/w/o.wav', part, 9_826_357)).toEqual([
      '-y',
      '-ss',
      '600.000',
      '-t',
      '2100.000',
      '-i',
      '/in.mp4',
      '-vn',
      '-af',
      'aresample=48000:async=1000:first_pts=0,apad,atrim=end_sample=100800000',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      '-rf64',
      'auto',
      '/w/o.wav',
    ]);
    // The last part ends where the container does, which can be past the picture.
    const last = buildExtract16kMonoArgs('/in.mp4', '/w/16k.wav', { startMs: 9_000_000, endMs: 9_831_200 }, 9_826_357);
    expect(last[last.indexOf('-af') + 1]).toBe('aresample=16000:async=1000:first_pts=0,apad,atrim=end_sample=13221712');
  });

  it('audio-only input: re-timed, never cut', () => {
    expect(pictureClockFilter(48000, undefined)).toBe('aresample=48000:async=1000:first_pts=0');
    const args = buildExtractAudioArgs('/in.m4a', '/w/o.wav');
    expect(args[args.indexOf('-af') + 1]).toBe('aresample=48000:async=1000:first_pts=0');
    // A window still has a length of its own.
    const part = buildExtract16kMonoArgs('/in.m4a', '/w/16k.wav', { startMs: 1000, endMs: 4000 });
    expect(part[part.indexOf('-af') + 1]).toBe('aresample=16000:async=1000:first_pts=0,apad,atrim=end_sample=48000');
  });

  it('extractKeepMs: the picture, or the window inside it', () => {
    expect(extractKeepMs(undefined, 10_000)).toBe(10_000);
    expect(extractKeepMs(undefined, undefined)).toBeUndefined();
    expect(extractKeepMs({ startMs: 2000, endMs: 6000 }, 10_000)).toBe(4000);
    expect(extractKeepMs({ startMs: 8000, endMs: 12_000 }, 10_000)).toBe(2000);
    expect(extractKeepMs({ startMs: -500, endMs: 3000 }, 10_000)).toBe(3000);
    expect(extractKeepMs({ startMs: 5000, endMs: 5000 }, 10_000)).toBeUndefined();
  });
});

describe('the picture length a probe gives', () => {
  it('per-stream durations, start times and cover pictures are kept from ffprobe', () => {
    const info = ffprobeJsonToMediaInfo(
      {
        format: { format_name: 'mov,mp4', duration: '9831.200000', start_time: '0.000000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, duration: '9826.357000', start_time: '0.000000' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '9826.354000', start_time: '0.000000' },
        ],
      },
      '/p4.mp4',
    );
    expect(info.videoStreams[0]).toMatchObject({ durationMs: 9_826_357, startMs: 0 });
    expect(info.audioStreams[0]).toMatchObject({ durationMs: 9_826_354, startMs: 0 });
    expect(info.startMs).toBe(0);
    expect(pictureDurationMs(info)).toBe(9_826_357);
  });

  it('Matroska keeps a track length only in its DURATION tag', () => {
    expect(streamDurationMs({ tags: { DURATION: '00:00:10.000000000' } })).toBe(10_000);
    expect(streamDurationMs({ tags: { DURATION: '27:48:03.250000000' } })).toBe(100_083_250);
    expect(streamDurationMs({ duration: 'N/A', tags: { DURATION: 'junk' } })).toBeUndefined();
    expect(streamDurationMs({ duration: '12.5' })).toBe(12_500);
  });

  it('a picture that starts after the container ends that much later on the audio clock', () => {
    const info = ffprobeJsonToMediaInfo(
      {
        format: { format_name: 'mpegts', duration: '60.000', start_time: '1.400000' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '58.000', start_time: '2.400000' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '60.000', start_time: '1.400000' },
        ],
      },
      '/x.ts',
    );
    expect(pictureDurationMs(info)).toBe(59_000);
  });

  it("an MP3's cover art is no picture: nothing to cut to", () => {
    const info = ffprobeJsonToMediaInfo(
      {
        format: { format_name: 'mp3', duration: '200.000' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } },
        ],
      },
      '/song.mp3',
    );
    expect(info.videoStreams[0]?.attachedPicture).toBe(true);
    expect(pictureDurationMs(info)).toBeUndefined();
  });

  it('a picture with no length of its own takes the container length', () => {
    const info = ffprobeJsonToMediaInfo(
      { format: { format_name: 'matroska', duration: '30.000' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'vp9', width: 640, height: 360 }] },
      '/x.mkv',
    );
    expect(pictureDurationMs(info)).toBe(30_000);
  });
});

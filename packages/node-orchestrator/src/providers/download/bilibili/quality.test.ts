import { describe, expect, it } from 'vitest';

import {
  CODEC_AV1,
  CODEC_AVC,
  CODEC_HEVC,
  availableQualities,
  pickAudio,
  pickVideo,
  qualityLabel,
  streamUrl,
  type DashVideo,
} from './quality.js';

/**
 * The fixture mirrors a REAL logged-out response: every quality is offered in
 * all three codecs, and the advertised `accept_quality` (1080p+ and below) is
 * far richer than what is actually served (480p and 360p).
 */
const REAL_VIDEO: DashVideo[] = [
  { id: 32, height: 480, codecid: CODEC_AVC, codecs: 'avc1.640033', bandwidth: 800210, baseUrl: 'v-480-avc' },
  { id: 32, height: 480, codecid: CODEC_HEVC, codecs: 'hvc1.1.6.L120.90', bandwidth: 398038, baseUrl: 'v-480-hevc' },
  { id: 32, height: 480, codecid: CODEC_AV1, codecs: 'av01.0.08M', bandwidth: 375598, baseUrl: 'v-480-av1' },
  { id: 16, height: 360, codecid: CODEC_HEVC, codecs: 'hvc1.1.6.L120.90', bandwidth: 278177, baseUrl: 'v-360-hevc' },
  { id: 16, height: 360, codecid: CODEC_AVC, codecs: 'avc1.640033', bandwidth: 641220, baseUrl: 'v-360-avc' },
  { id: 16, height: 360, codecid: CODEC_AV1, codecs: 'av01.0.08M', bandwidth: 262981, baseUrl: 'v-360-av1' },
];

describe('availableQualities', () => {
  it('reports only what the DASH streams can actually deliver', () => {
    // The same response advertised accept_quality [112, 80, 64, 32, 16] while
    // serving nothing above 480p. Listing the advertised set would offer the
    // user a 1080p they can never receive.
    expect(availableQualities(REAL_VIDEO)).toEqual([
      { qn: 32, label: '480p', heightPx: 480 },
      { qn: 16, label: '360p', heightPx: 360 },
    ]);
  });

  it('is empty for an empty stream list', () => {
    expect(availableQualities([])).toEqual([]);
  });

  it('labels the qn codes both reference implementations use', () => {
    expect(qualityLabel(120)).toBe('4K');
    expect(qualityLabel(116)).toBe('1080p60');
    expect(qualityLabel(112)).toBe('1080p+');
    expect(qualityLabel(80)).toBe('1080p');
    expect(qualityLabel(74)).toBe('720p60');
    expect(qualityLabel(64)).toBe('720p');
    // Unknown codes must still render as something rather than "undefined".
    expect(qualityLabel(999)).toBe('999');
  });
});

describe('pickVideo', () => {
  it('prefers AVC over the smaller HEVC/AV1 at the same quality', () => {
    // The opposite of a "smallest file" rule, and deliberately so: this file is
    // the INPUT to a pipeline that decodes it repeatedly. AV1 here is less than
    // half the size and would be the obvious pick for a plain downloader.
    expect(streamUrl(pickVideo(REAL_VIDEO))).toBe('v-480-avc');
  });

  it('honours a requested quality below the best available', () => {
    expect(streamUrl(pickVideo(REAL_VIDEO, 16))).toBe('v-360-avc');
  });

  it('falls back to the best on offer when the request cannot be served', () => {
    // Asking for 1080p as a logged-out viewer is the normal case, not an
    // error: quietly give the best that exists rather than failing.
    expect(streamUrl(pickVideo(REAL_VIDEO, 80))).toBe('v-480-avc');
  });

  it('does not trust response ordering', () => {
    // The API happens to list best-first; a reordered response must not
    // silently downgrade every download.
    const shuffled = [...REAL_VIDEO].reverse();
    expect(streamUrl(pickVideo(shuffled))).toBe('v-480-avc');
  });

  it('breaks a codec tie by bitrate', () => {
    const twoAvc: DashVideo[] = [
      { id: 32, codecid: CODEC_AVC, bandwidth: 100, baseUrl: 'low' },
      { id: 32, codecid: CODEC_AVC, bandwidth: 900, baseUrl: 'high' },
    ];
    expect(streamUrl(pickVideo(twoAvc))).toBe('high');
  });

  it('sorts an unrecognised codec last rather than first', () => {
    // A new codec id is far more likely to be exotic than to be the safe one,
    // so it must not outrank AVC by accident.
    const withUnknown: DashVideo[] = [
      { id: 32, codecid: 99, bandwidth: 999999, baseUrl: 'mystery' },
      { id: 32, codecid: CODEC_AVC, bandwidth: 1, baseUrl: 'avc' },
    ];
    expect(streamUrl(pickVideo(withUnknown))).toBe('avc');
  });

  it('returns undefined for no streams', () => {
    expect(pickVideo([])).toBeUndefined();
  });

  it('still returns something when no stream carries a quality id', () => {
    const noIds: DashVideo[] = [{ codecid: CODEC_AVC, bandwidth: 5, baseUrl: 'only' }];
    expect(streamUrl(pickVideo(noIds, 80))).toBe('only');
  });
});

describe('pickAudio', () => {
  it('picks by bitrate, not by id', () => {
    // Within the plain audio list the ids ascend with bitrate, which makes
    // id-ordering look right. Invert them here so only a bitrate-based rule
    // passes — Dolby (30250) and Hi-Res (30251) carry higher ids and would
    // turn that coincidence into a real bug.
    const audios = [
      { id: 30280, bandwidth: 65739, baseUrl: 'quiet' },
      { id: 30216, bandwidth: 206939, baseUrl: 'loud' },
    ];
    expect(streamUrl(pickAudio(audios))).toBe('loud');
  });

  it('returns undefined for no streams', () => {
    expect(pickAudio([])).toBeUndefined();
  });
});

describe('streamUrl', () => {
  it('accepts both spellings the API uses', () => {
    expect(streamUrl({ baseUrl: 'a' })).toBe('a');
    expect(streamUrl({ base_url: 'b' })).toBe('b');
    expect(streamUrl(undefined)).toBeUndefined();
  });
});

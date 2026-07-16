/**
 * Tests for the cross-segment cohesion upgrades: join-smoothing micro-fades,
 * the Rubber Band stretch fragment, and the room-tone bed in the final mix.
 * All builders are pure — no ffmpeg needed.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFadeChain,
  buildTimelineFilterComplex,
  FADE_IN_MS,
  FADE_OUT_MS,
  type TimelineClip,
} from './tts-timeline.js';
import { buildRubberbandFilterChain } from './stretch.js';
import { buildMixFilterComplex, ROOM_TONE_AMPLITUDE, type DuckAndMixInput } from './mix.js';

describe('buildFadeChain (join smoothing)', () => {
  it('emits fade-in + placed fade-out when the duration is known', () => {
    const chain = buildFadeChain(2000);
    expect(chain).toContain(`afade=t=in:d=${(FADE_IN_MS / 1000).toFixed(3)}`);
    expect(chain).toContain(`afade=t=out:st=${((2000 - FADE_OUT_MS) / 1000).toFixed(3)}`);
    expect(chain.endsWith(',')).toBe(true);
  });
  it('emits only the fade-in when the duration is unknown', () => {
    const chain = buildFadeChain(undefined);
    expect(chain).toContain('afade=t=in');
    expect(chain).not.toContain('afade=t=out');
  });
  it('skips fades entirely on clips too short to carry them', () => {
    expect(buildFadeChain(40)).toBe('');
  });
});

describe('buildRubberbandFilterChain', () => {
  it('emits a formant-preserving tempo fragment', () => {
    expect(buildRubberbandFilterChain(1.25)).toBe('rubberband=tempo=1.2500:formant=preserved,');
  });
  it('is a no-op at (or effectively at) unity', () => {
    expect(buildRubberbandFilterChain(1)).toBe('');
    expect(buildRubberbandFilterChain(undefined)).toBe('');
  });
});

describe('timeline filtergraph with stretch policy', () => {
  const clips: TimelineClip[] = [
    { audioPath: '/a.wav', startMs: 0, speedRatio: 1.3, durationMs: 2000, stretchWith: 'rubberband' },
    { audioPath: '/b.wav', startMs: 3000, speedRatio: 1.3, durationMs: 1500 },
  ];

  it('uses rubberband for clips resolved to it and atempo otherwise', () => {
    const f = buildTimelineFilterComplex(clips, 10_000);
    expect(f).toContain('rubberband=tempo=1.3000:formant=preserved');
    expect(f).toContain('atempo=1.3000');
  });

  it('places fades before the stretch and keeps adelay/asetpts ordering', () => {
    const f = buildTimelineFilterComplex(clips, 10_000);
    const clip0 = f.split(';')[0]!;
    expect(clip0.indexOf('afade=t=in')).toBeLessThan(clip0.indexOf('rubberband='));
    expect(clip0.indexOf('rubberband=')).toBeLessThan(clip0.indexOf('adelay=0|0'));
    expect(clip0).toMatch(/adelay=0\|0,asetpts=N\/SR\/TB/);
  });
});

describe('room-tone bed in the mix', () => {
  const base: DuckAndMixInput = {
    originalAudio: '/orig.wav',
    ttsTimeline: '/tts.wav',
    output: '/out.wav',
    duckingLevelDb: -15,
    ttsGainDb: 0,
    includeBackground: false,
    duck: false,
  };

  it('adds a pink-noise bed pinned to the TTS length when enabled without background', () => {
    const f = buildMixFilterComplex({ ...base, roomTone: true });
    expect(f).toContain(`anoisesrc=color=pink:amplitude=${ROOM_TONE_AMPLITUDE}`);
    expect(f).toContain('duration=first');
    expect(f).toContain('loudnorm');
  });

  it('stays out of the graph when disabled or when the original bed is kept', () => {
    expect(buildMixFilterComplex(base)).not.toContain('anoisesrc');
    expect(buildMixFilterComplex({ ...base, includeBackground: true, roomTone: true })).not.toContain('anoisesrc');
  });
});

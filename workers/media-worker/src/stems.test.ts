import { describe, expect, it } from 'vitest';
import { buildStemInputArgs, buildStemMixArgs } from './stems.js';

describe('separation stems', () => {
  it('feeds HTDemucs the 44.1 kHz stereo it insists on', () => {
    const args = buildStemInputArgs('in.wav', 'out.wav');
    expect(args.slice(args.indexOf('-ac'), args.indexOf('-ac') + 4)).toEqual(['-ac', '2', '-ar', '44100']);
    expect(args.at(-1)).toBe('out.wav');
  });

  it('sums the music stems unscaled, and returns everything at the mix rate', () => {
    const music = buildStemMixArgs(['drums.wav', 'bass.wav', 'other.wav'], 'acc.wav');
    expect(music.filter((a) => a === '-i')).toHaveLength(3);
    expect(music).toContain('amix=inputs=3:normalize=0:duration=longest');
    expect(music.slice(music.indexOf('-ar'), music.indexOf('-ar') + 2)).toEqual(['-ar', '48000']);
    const voices = buildStemMixArgs(['vocals.wav'], 'v.wav');
    expect(voices).not.toContain('-filter_complex');
    expect(() => buildStemMixArgs([], 'x.wav')).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { segmentsToVtt } from './vtt.js';

describe('segmentsToVtt', () => {
  const segments = [
    { startMs: 0, endMs: 1500, text: 'Hello' },
    { startMs: 1500, endMs: 3000, text: 'World' },
  ];

  it('starts with the WEBVTT header', () => {
    const vtt = segmentsToVtt(segments);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  });

  it('has a blank line after the WEBVTT header', () => {
    const vtt = segmentsToVtt(segments);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('uses dot timestamps (not comma)', () => {
    const vtt = segmentsToVtt(segments);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500');
    expect(vtt).not.toContain(',');
  });

  it('separates cues with a blank line', () => {
    const vtt = segmentsToVtt(segments);
    const afterHeader = vtt.slice('WEBVTT\n\n'.length);
    expect(afterHeader).toContain('\n\n');
  });

  it('returns just the header for empty input', () => {
    expect(segmentsToVtt([])).toBe('WEBVTT\n');
  });

  it('includes cue index identifiers', () => {
    const vtt = segmentsToVtt(segments);
    const body = vtt.slice('WEBVTT\n\n'.length).split('\n');
    expect(body[0]).toBe('1');
  });

  it('ends with a trailing newline', () => {
    const vtt = segmentsToVtt(segments);
    expect(vtt.endsWith('\n')).toBe(true);
  });

  it('skips empty segments', () => {
    const vtt = segmentsToVtt([
      { startMs: 0, endMs: 1000, text: '' },
      { startMs: 1000, endMs: 2000, text: 'Real' },
    ]);
    expect(vtt).toContain('Real');
  });
});

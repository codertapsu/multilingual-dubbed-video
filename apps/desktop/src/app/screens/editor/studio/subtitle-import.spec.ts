import { describe, expect, it } from 'vitest';
import { matchCuesToLines, parseSubtitles } from './subtitle-import';

const SRT = `1
00:00:01,000 --> 00:00:02,500
Xin chào

2
00:00:03,000 --> 00:00:05,000
<i>Hôm nay</i> trời đẹp
quá

`;

const VTT = `WEBVTT

intro
00:01.000 --> 00:02.500 align:start
Hello there
`;

describe('parseSubtitles', () => {
  it('reads SRT, stripping tags and joining line breaks', () => {
    expect(parseSubtitles(SRT)).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Xin chào' },
      { startMs: 3000, endMs: 5000, text: 'Hôm nay trời đẹp quá' },
    ]);
  });

  it('reads WebVTT with cue ids, short timestamps and settings', () => {
    expect(parseSubtitles(VTT)).toEqual([{ startMs: 1000, endMs: 2500, text: 'Hello there' }]);
  });

  it('tolerates CRLF and a BOM, and skips broken cues', () => {
    const text = '﻿1\r\n00:00:01,000 --> 00:00:00,500\r\nbackwards\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nok\r\n';
    expect(parseSubtitles(text)).toEqual([{ startMs: 2000, endMs: 3000, text: 'ok' }]);
  });
});

describe('matchCuesToLines', () => {
  it('matches by time overlap, not by index', () => {
    const lines = [
      { id: 'a', startMs: 900, endMs: 2600 },
      { id: 'b', startMs: 2700, endMs: 3900 },
      { id: 'c', startMs: 4000, endMs: 5100 },
    ];
    const map = matchCuesToLines(lines, parseSubtitles(SRT));
    expect(map.get('a')).toBe('Xin chào');
    // One long subtitle over two short recogniser lines: both get it.
    expect(map.get('b')).toBe('Hôm nay trời đẹp quá');
    expect(map.get('c')).toBe('Hôm nay trời đẹp quá');
  });

  it('joins several short cues that fall inside one long line', () => {
    const map = matchCuesToLines(
      [{ id: 'x', startMs: 0, endMs: 4000 }],
      [
        { startMs: 0, endMs: 1800, text: 'one' },
        { startMs: 2000, endMs: 3900, text: 'two' },
      ],
    );
    expect(map.get('x')).toBe('one two');
  });

  it('leaves lines with no meaningful overlap untouched', () => {
    const map = matchCuesToLines([{ id: 'x', startMs: 0, endMs: 1000 }], [{ startMs: 900, endMs: 5000, text: 'late' }]);
    expect(map.size).toBe(0);
  });
});

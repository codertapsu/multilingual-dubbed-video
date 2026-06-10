import { describe, expect, it } from 'vitest';
import {
  alignmentToAssCode,
  buildBurnSubtitlesStyle,
  buildSubtitlesFilter,
  escapeSubtitlePathForFilter,
  hexToAssColor,
} from './subtitles.js';
import type { SubtitleStyle } from '@videodubber/shared';

describe('escapeSubtitlePathForFilter', () => {
  it('escapes colons and backslashes on posix paths', () => {
    const out = escapeSubtitlePathForFilter('/home/user/My: Subs/translated.srt', 'linux');
    // colon escaped, no backslashes originally so none doubled.
    expect(out).toBe('/home/user/My\\: Subs/translated.srt');
  });

  it('escapes single quotes and brackets', () => {
    const out = escapeSubtitlePathForFilter("/a/o'brien/[x].srt", 'linux');
    expect(out).toBe("/a/o\\'brien/\\[x\\].srt");
  });

  it('escapes commas', () => {
    const out = escapeSubtitlePathForFilter('/a/b,c.srt', 'linux');
    expect(out).toBe('/a/b\\,c.srt');
  });

  it('handles windows drive paths by normalizing slashes and escaping the drive colon', () => {
    const out = escapeSubtitlePathForFilter('C:\\Users\\me\\sub.srt', 'win32');
    // backslashes -> forward slashes, then drive colon escaped.
    expect(out).toBe('C\\:/Users/me/sub.srt');
  });
});

describe('hexToAssColor', () => {
  it('converts #RRGGBB to &HAABBGGRR (BGR order, opaque alpha)', () => {
    // White
    expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF');
    // Pure red -> RR=FF GG=00 BB=00 -> &H000000FF
    expect(hexToAssColor('#FF0000')).toBe('&H000000FF');
    // Pure blue -> &H00FF0000
    expect(hexToAssColor('#0000FF')).toBe('&H00FF0000');
    // Pure green -> &H0000FF00
    expect(hexToAssColor('#00FF00')).toBe('&H0000FF00');
  });

  it('expands shorthand #rgb', () => {
    expect(hexToAssColor('#f00')).toBe('&H000000FF');
  });

  it('honours a custom alpha byte', () => {
    expect(hexToAssColor('#000000', 0x80)).toBe('&H80000000');
  });

  it('falls back to white on malformed input', () => {
    expect(hexToAssColor('not-a-color')).toBe('&H00FFFFFF');
  });
});

describe('alignmentToAssCode', () => {
  it('maps bottom/center/top to ASS numpad codes', () => {
    expect(alignmentToAssCode('bottom')).toBe(2);
    expect(alignmentToAssCode('center')).toBe(5);
    expect(alignmentToAssCode('top')).toBe(8);
  });
});

describe('buildBurnSubtitlesStyle', () => {
  const style: SubtitleStyle = {
    fontFamily: 'Arial',
    fontSize: 24,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 3,
    alignment: 'bottom',
  };

  it('produces a force_style string with mapped values', () => {
    const out = buildBurnSubtitlesStyle(style);
    expect(out).toContain('FontName=Arial');
    expect(out).toContain('FontSize=24');
    expect(out).toContain('PrimaryColour=&H00FFFFFF');
    expect(out).toContain('OutlineColour=&H00000000');
    expect(out).toContain('Outline=3');
    expect(out).toContain('Alignment=2');
  });

  it('strips commas from font names to avoid breaking force_style', () => {
    const out = buildBurnSubtitlesStyle({ ...style, fontFamily: 'Bad,Font' });
    expect(out).toContain('FontName=Bad Font');
    // exactly one comma-separated FontName field
    expect(out.split(',').filter((p) => p.startsWith('FontName=')).length).toBe(1);
  });

  it('maps top alignment to 8 and rounds font size', () => {
    const out = buildBurnSubtitlesStyle({ ...style, alignment: 'top', fontSize: 23.6 });
    expect(out).toContain('Alignment=8');
    expect(out).toContain('FontSize=24');
  });
});

describe('buildSubtitlesFilter', () => {
  it('builds a plain subtitles filter without style', () => {
    const f = buildSubtitlesFilter('/tmp/a.srt', undefined, 'linux');
    expect(f).toBe('subtitles=/tmp/a.srt');
  });

  it('appends a quoted force_style when a style is provided', () => {
    const f = buildSubtitlesFilter(
      '/tmp/a.srt',
      {
        fontFamily: 'Arial',
        fontSize: 20,
        primaryColor: '#FFFFFF',
        outlineColor: '#000000',
        outlineWidth: 2,
        alignment: 'bottom',
      },
      'linux',
    );
    expect(f.startsWith('subtitles=/tmp/a.srt:force_style=')).toBe(true);
    expect(f).toContain("force_style='FontName=Arial");
  });
});

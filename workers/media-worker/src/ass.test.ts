import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAssDocument,
  computeAssLayout,
  coverBandRect,
  coverModeOf,
  cueTextToAss,
  formatAssTime,
  parseSubtitleCues,
  sourceBandRect,
  type SubtitleCue,
} from './ass.js';
import {
  BUNDLED_FONT_CELL_RATIO,
  BUNDLED_FONT_FAMILY,
  BUNDLED_FONT_FILE,
  chooseBurnFont,
  FALLBACK_FONT_FAMILY,
  packagedFontsDir,
  resolveFontsDir,
} from './fonts.js';

describe('parseSubtitleCues', () => {
  it('reads the SRT the pipeline writes (BOM, CRLF, multi-line cues)', () => {
    const srt =
      '\uFEFF1\r\n00:00:03,020 --> 00:00:04,373\r\nLại đưa ta đi đâu rồi\r\n\r\n' +
      '2\r\n00:00:25,390 --> 00:00:38,081\r\nĐây không phải\r\nTam giới\r\n';
    expect(parseSubtitleCues(srt)).toEqual<SubtitleCue[]>([
      { startMs: 3020, endMs: 4373, text: 'Lại đưa ta đi đâu rồi' },
      { startMs: 25_390, endMs: 38_081, text: 'Đây không phải\nTam giới' },
    ]);
  });

  it('reads WebVTT: header, NOTE blocks, cue ids, settings, hour-less times', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE an arrow --> but no timing is not a cue',
      '',
      'cue-1',
      '00:01.500 --> 00:02.250 align:center line:85%',
      'Ngộ Không',
      '',
      '01:00:00.000 --> 01:00:01.000',
      'Một giờ',
      '',
    ].join('\n');
    expect(parseSubtitleCues(vtt)).toEqual<SubtitleCue[]>([
      { startMs: 1500, endMs: 2250, text: 'Ngộ Không' },
      { startMs: 3_600_000, endMs: 3_601_000, text: 'Một giờ' },
    ]);
  });

  it('skips empty and backwards cues', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:05,000 --> 00:00:04,000\nBackwards\n';
    expect(parseSubtitleCues(srt)).toEqual([]);
  });
});

describe('formatAssTime', () => {
  it('writes H:MM:SS.cc, rounded to the centisecond', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00');
    expect(formatAssTime(3020)).toBe('0:00:03.02');
    expect(formatAssTime(4373)).toBe('0:00:04.37');
    expect(formatAssTime(4375)).toBe('0:00:04.38');
    expect(formatAssTime(1_899_067)).toBe('0:31:39.07');
  });

  it('clamps to the format range', () => {
    expect(formatAssTime(-5)).toBe('0:00:00.00');
    expect(formatAssTime(Number.MAX_SAFE_INTEGER)).toBe('9:59:59.99');
  });
});

describe('cueTextToAss', () => {
  it('turns line breaks into \\N', () => {
    expect(cueTextToAss('Đây không phải\nTam giới')).toBe('Đây không phải\\NTam giới');
  });

  it('escapes braces so they print instead of swallowing the words between them', () => {
    expect(cueTextToAss('Ngộ Không, ngươi chớ có làm càn! {x}')).toBe('Ngộ Không, ngươi chớ có làm càn! \\{x\\}');
  });

  it('keeps a literal backslash from reading as an ASS escape', () => {
    expect(cueTextToAss('a\\nb')).toBe('a\\\u2060nb');
    expect(cueTextToAss('C:\\Path')).toBe('C:\\Path');
  });

  it('keeps a backslash before a tag a backslash, and the tag a working override', () => {
    const wordJoiner = String.fromCharCode(0x2060);
    expect(cueTextToAss('C:\\<i>nghiêng</i>')).toBe(`C:\\${wordJoiner}{\\i1}nghiêng{\\i0}`);
  });

  it('maps <i>/<b>/<u> to overrides and drops every other tag', () => {
    expect(cueTextToAss('<i>nghiêng</i> <b>đậm</b> <font color="red">đỏ</font> <v Ngộ Không>xin</v>')).toBe(
      '{\\i1}nghiêng{\\i0} {\\b1}đậm{\\b0} đỏ xin',
    );
    expect(cueTextToAss('<c.yellow>vàng</c> <00:00:01.000>sau')).toBe('vàng sau');
  });

  it('decodes the HTML entities WebVTT uses, after tags are stripped', () => {
    expect(cueTextToAss('a &lt;i&gt; b &amp; c')).toBe('a <i> b & c');
  });
});

describe('computeAssLayout', () => {
  it('720p defaults: canvas = video, bundled font at a 5.5% em, outline, shadow, bottom margin', () => {
    const l = computeAssLayout(undefined, 1280, 720);
    expect(l).toMatchObject({
      width: 1280,
      height: 720,
      fontName: BUNDLED_FONT_FAMILY,
      // 5.5% of 720 = 39.6 px em; libass' size is the 1.526-em cell.
      fontSize: 60.4,
      outline: 3.2,
      shadowOffset: 2.4,
      shadowBlur: 4,
      alignment: 2,
      marginL: 77,
      marginR: 77,
      marginV: 32,
      primaryColour: '&H00FFFFFF',
      outlineColour: '&H00000000',
    });
    expect(l.band).toBeUndefined();
  });

  it('scales with the frame: 4K is 3x 720p', () => {
    const l = computeAssLayout(undefined, 3840, 2160);
    expect(l.fontSize).toBeCloseTo(181.3, 1);
    expect(l.marginV).toBe(97);
  });

  it('sizes portrait video by its SHORTER side (a phone clip must not get 1280-based text)', () => {
    const portrait = computeAssLayout(undefined, 720, 1280);
    expect(portrait.fontSize).toBe(computeAssLayout(undefined, 1280, 720).fontSize);
    expect(portrait.marginV).toBe(58);
  });

  it('positions: raised clears a two-line source subtitle strip; top flips the anchor', () => {
    expect(computeAssLayout({ position: 'raised' }, 1280, 720)).toMatchObject({ alignment: 2, marginV: 130 });
    expect(computeAssLayout({ position: 'top' }, 1280, 720)).toMatchObject({ alignment: 8, marginV: 32 });
  });

  it("auto (nothing chosen) sits just above the video's own subtitles when they were found and are left in view (claude-dubber, 2026-11-25)", () => {
    // The report's landscape source: its Chinese line at 0.92–0.965 of the height, where bottom draws.
    const band = { y: 0.92, h: 0.045 };
    // 720 - 662 (the band's top) + 2 % of 720.
    const auto = computeAssLayout(undefined, 1280, 720, { sourceBand: band });
    expect(auto).toMatchObject({ alignment: 2, marginV: 72 });
    expect(computeAssLayout({ position: 'auto' }, 1280, 720, { sourceBand: band })).toEqual(auto);
    // Vertical sources alike: 76–81 % of a 1080×1920 frame.
    expect(computeAssLayout(undefined, 1080, 1920, { sourceBand: { y: 0.755, h: 0.06 } }).marginV).toBe(508);
    // Chosen by hand, the strip stays where it was chosen.
    expect(computeAssLayout({ position: 'bottom' }, 1280, 720, { sourceBand: band }).marginV).toBe(32);
    // Nothing found: the conventional strip, as before.
    expect(computeAssLayout(undefined, 1280, 720)).toEqual(computeAssLayout({ position: 'bottom' }, 1280, 720));
  });

  it('auto leaves a band in the top half alone, and a covered band to the cover', () => {
    expect(computeAssLayout(undefined, 1280, 720, { sourceBand: { y: 0.05, h: 0.06 } }).marginV).toBe(32);
    const style = { coverOriginal: 'blur' as const, coverBand: { y: 0.92, h: 0.045 } };
    expect(computeAssLayout(style, 1280, 720, { sourceBand: { y: 0.92, h: 0.045 } })).toEqual(computeAssLayout(style, 1280, 720));
    expect(sourceBandRect({ y: 0.92, h: 0.045 }, 720)).toEqual({ top: 662, height: 32 });
    expect(sourceBandRect({ y: 0.3, h: 0.1 }, 720)).toBeUndefined();
    expect(sourceBandRect({ y: 0.9, h: 0 }, 720)).toBeUndefined();
  });

  it("raised keeps clear of the video's own subtitles found higher than its strip; top stays at the top", () => {
    // 76–81 % of a 1280×720 frame, above raised's 18 % (130 px): 720 - 547 + 14.4.
    expect(computeAssLayout({ position: 'raised' }, 1280, 720, { sourceBand: { y: 0.76, h: 0.05 } }).marginV).toBe(187);
    expect(computeAssLayout({ position: 'raised' }, 1280, 720, { sourceBand: { y: 0.92, h: 0.045 } }).marginV).toBe(130);
    expect(computeAssLayout({ position: 'top' }, 1280, 720, { sourceBand: { y: 0.92, h: 0.045 } })).toMatchObject({ alignment: 8, marginV: 32 });
  });

  it('coverOriginal: an opaque band over the bottom strip, tall enough for two lines', () => {
    const l = computeAssLayout({ coverOriginal: true }, 1280, 720);
    // max(18% of 720 = 129.6, 32.4 margin + 2 lines of 50.1 + 11.9 air) = 144.
    expect(l.band).toEqual({ top: 576, height: 144, opacity: 1 });
    expect(l.marginV).toBe(32);
  });

  it('coverOriginal honours height/opacity overrides, clamped', () => {
    const l = computeAssLayout({ coverOriginal: true, coverHeightPercent: 30, coverOpacity: 7 }, 1280, 720);
    expect(l.band).toEqual({ top: 504, height: 216, opacity: 1 });
  });

  it('raised + coverOriginal puts the text above the band, never across its edge', () => {
    const l = computeAssLayout({ position: 'raised', coverOriginal: true }, 1280, 720);
    expect(l.marginV).toBeGreaterThan(l.band!.height);
  });

  it("'solid' is today's band; a detected band (coverBand) puts it where the source's subtitles are", () => {
    expect(computeAssLayout({ coverOriginal: 'solid' }, 1280, 720)).toEqual(computeAssLayout({ coverOriginal: true }, 1280, 720));
    // The series' hardsubs: 76–81 % of a 1080×1920 frame.
    const l = computeAssLayout({ coverOriginal: true, coverBand: { y: 0.755, h: 0.06 } }, 1080, 1920);
    expect(l.band).toEqual({ top: 1450, height: 115, opacity: 1 });
    expect(coverBandRect({ coverOriginal: 'solid', coverBand: { y: 0.755, h: 0.06 } }, 1080, 1920)).toEqual({ top: 1450, height: 115 });
    // Raised keeps clear of it wherever it is: 1920 - 1450 + 2 % of 1920.
    expect(computeAssLayout({ coverOriginal: true, coverBand: { y: 0.755, h: 0.06 }, position: 'raised' }, 1080, 1920).marginV).toBe(508);
  });

  it('a blurred band draws nothing in the script (the filter graph blurs it), but the text still keeps clear of it', () => {
    const blur = computeAssLayout({ coverOriginal: 'blur', position: 'raised' }, 1280, 720);
    expect(blur.band).toBeUndefined();
    expect(blur.marginV).toBe(computeAssLayout({ coverOriginal: true, position: 'raised' }, 1280, 720).marginV);
    expect(buildAssDocument([], computeAssLayout({ coverOriginal: 'blur' }, 1280, 720), 60_000)).not.toContain(',Band,,');
    expect(coverModeOf({ coverOriginal: 'blur' })).toBe('blur');
    expect(coverModeOf({ coverOriginal: false })).toBeUndefined();
    expect(coverBandRect({ coverOriginal: false, coverBand: { y: 0.7, h: 0.1 } }, 1280, 720)).toBeUndefined();
  });

  it('subtitlesInBand: one line centred in the band where the source had its own; two when two fit', () => {
    // 59.4 px em on 1080 wide, line 75.1 px: one line in a 115-px band.
    const one = computeAssLayout({ coverOriginal: 'blur', coverBand: { y: 0.755, h: 0.06 }, subtitlesInBand: true }, 1080, 1920);
    expect(one).toMatchObject({ alignment: 2, marginV: 375 });
    // Its line sits inside the band: bottom at 1920 - 375 = 1545 <= 1565, top at 1470 >= 1450.
    const two = computeAssLayout({ coverOriginal: 'blur', coverBand: { y: 0.7, h: 0.1 }, subtitlesInBand: true }, 1080, 1920);
    expect(two.marginV).toBe(Math.round(1920 - (1344 + 192) + (192 - 2 * 59.4 * 1.265) / 2));
    // Position is overruled; without a band it is not.
    expect(computeAssLayout({ coverOriginal: 'solid', subtitlesInBand: true, position: 'top' }, 1280, 720).alignment).toBe(2);
    expect(computeAssLayout({ subtitlesInBand: true, position: 'top' }, 1280, 720).alignment).toBe(8);
  });

  it('a style saved by the old force_style renderer keeps its size and placement', () => {
    const l = computeAssLayout(
      { fontFamily: 'Arial', fontSize: 24, primaryColor: '#FFFF00', outlineColor: '#000000', outlineWidth: 2, alignment: 'top' },
      1280,
      720,
    );
    // 24 and 2 were on libass' 288-line SRT canvas.
    expect(l).toMatchObject({ fontName: 'Arial', fontSize: 60, outline: 5, alignment: 8, primaryColour: '&H0000FFFF' });
    expect(computeAssLayout({ alignment: 'center' }, 1280, 720)).toMatchObject({ alignment: 5, marginV: 0 });
  });

  it('sizePercent wins over the legacy fontSize; position wins over alignment', () => {
    const l = computeAssLayout({ sizePercent: 8, fontSize: 24, position: 'bottom', alignment: 'top' }, 1280, 720);
    expect(l.fontSize).toBeCloseTo(57.6 * BUNDLED_FONT_CELL_RATIO, 1);
    expect(l.alignment).toBe(2);
  });

  it('strips commas from a family name (they separate ASS style fields)', () => {
    expect(computeAssLayout({ fontFamily: 'Bad,Font' }, 1280, 720).fontName).toBe('Bad Font');
  });
});

describe('buildAssDocument', () => {
  const cues: SubtitleCue[] = [
    { startMs: 3020, endMs: 4373, text: 'Ngộ Không, ngươi chớ có làm càn!' },
    { startMs: 5000, endMs: 5004, text: 'Ở.' },
    { startMs: 6000, endMs: 7000, text: '<i></i>' },
  ];

  it('declares the video-sized canvas and the three styles', () => {
    const doc = buildAssDocument(cues, computeAssLayout(undefined, 1280, 720), 10_000);
    expect(doc).toContain('PlayResX: 1280\nPlayResY: 720');
    expect(doc).toContain('ScaledBorderAndShadow: yes');
    expect(doc).toMatch(/^Style: Text,Be Vietnam Pro SemiBold,60\.4,&H00FFFFFF,/m);
    expect(doc).toMatch(/^Style: Shadow,Be Vietnam Pro SemiBold,60\.4,&HFF000000,&HFF0000FF,&HFF000000,&H73000000,/m);
  });

  it('emits each cue twice — blurred shadow layer under a crisp text layer', () => {
    const doc = buildAssDocument(cues, computeAssLayout(undefined, 1280, 720), 10_000);
    expect(doc).toContain('Dialogue: 1,0:00:03.02,0:00:04.37,Shadow,,0,0,0,,{\\blur4}Ngộ Không, ngươi chớ có làm càn!');
    expect(doc).toContain('Dialogue: 2,0:00:03.02,0:00:04.37,Text,,0,0,0,,Ngộ Không, ngươi chớ có làm càn!');
    // A 4 ms cue still lasts one centisecond; a cue with no visible text is dropped.
    expect(doc).toContain('Dialogue: 2,0:00:05.00,0:00:05.01,Text,,0,0,0,,Ở.');
    expect(doc.match(/^Dialogue:/gm)).toHaveLength(4);
    expect(doc).not.toContain('Band,,');
  });

  it('draws the band for the whole video when covering the original subtitles', () => {
    const doc = buildAssDocument(cues, computeAssLayout({ coverOriginal: true }, 1280, 720), 1_900_067);
    expect(doc).toContain(
      'Dialogue: 0,0:00:00.00,0:31:40.07,Band,,0,0,0,,{\\pos(0,576)\\1a&H00&\\p1}m 0 0 l 1280 0 1280 144 0 144{\\p0}',
    );
  });
});

/** Minimal sfnt reader: just what the cell-ratio check needs. */
function readFontFacts(file: string): { family: string; cellRatio: number } {
  const buf = readFileSync(file);
  const tables = new Map<string, number>();
  for (let i = 0; i < buf.readUInt16BE(4); i++) {
    const r = 12 + i * 16;
    tables.set(buf.toString('latin1', r, r + 4), buf.readUInt32BE(r + 8));
  }
  const upem = buf.readUInt16BE(tables.get('head')! + 18);
  const os2 = tables.get('OS/2')!;
  const cellRatio = (buf.readUInt16BE(os2 + 74) + buf.readUInt16BE(os2 + 76)) / upem;
  const name = tables.get('name')!;
  const strings = name + buf.readUInt16BE(name + 4);
  let family = '';
  for (let i = 0; i < buf.readUInt16BE(name + 2); i++) {
    const r = name + 6 + i * 12;
    const [platform, encoding, lang, id] = [0, 2, 4, 6].map((o) => buf.readUInt16BE(r + o));
    if (platform === 3 && encoding === 1 && lang === 0x409 && id === 1) {
      const raw = buf.subarray(strings + buf.readUInt16BE(r + 10), strings + buf.readUInt16BE(r + 10) + buf.readUInt16BE(r + 8));
      family = Buffer.from(raw).swap16().toString('utf16le');
    }
  }
  return { family, cellRatio };
}

describe('bundled font', () => {
  // Sizes are converted with BUNDLED_FONT_CELL_RATIO and the family is matched
  // by name, so swapping the font file without updating both would silently
  // resize the subtitles or fall back to a system font. This reads the file.
  const fontFile = join(packagedFontsDir()!, BUNDLED_FONT_FILE);

  it('ships with the package, its license OUTSIDE the fonts dir (libass loads every file there)', () => {
    expect(readFileSync(fontFile).readUInt32BE(0)).toBe(0x00010000);
    expect(readdirSync(packagedFontsDir()!)).toEqual([BUNDLED_FONT_FILE]);
    const license = join(packagedFontsDir()!, '..', 'licenses', 'BeVietnamPro-OFL.txt');
    expect(readFileSync(license, 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('matches the family name and cell ratio the layout code assumes', () => {
    const facts = readFontFacts(fontFile);
    expect(facts.family).toBe(BUNDLED_FONT_FAMILY);
    expect(facts.cellRatio).toBeCloseTo(BUNDLED_FONT_CELL_RATIO, 3);
  });
});

describe('resolveFontsDir', () => {
  it('prefers an explicit dir, then VIDEODUBBER_FONTS_DIR, then the packaged assets', () => {
    const a = mkdtempSync(join(tmpdir(), 'vd-fonts-a-'));
    const b = mkdtempSync(join(tmpdir(), 'vd-fonts-b-'));
    try {
      expect(resolveFontsDir(a, { VIDEODUBBER_FONTS_DIR: b })).toBe(a);
      expect(resolveFontsDir(undefined, { VIDEODUBBER_FONTS_DIR: b })).toBe(b);
      expect(resolveFontsDir(undefined, {})).toBe(packagedFontsDir());
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('skips a dir that does not exist instead of handing libass a dead path', () => {
    const missing = join(tmpdir(), 'vd-fonts-does-not-exist-7f3a');
    expect(resolveFontsDir(missing, { VIDEODUBBER_FONTS_DIR: missing })).toBe(packagedFontsDir());
  });
});

describe('chooseBurnFont', () => {
  it('the bundled family when its file is in the fonts dir', () => {
    expect(chooseBurnFont(packagedFontsDir())).toEqual({ family: BUNDLED_FONT_FAMILY, fontsDir: packagedFontsDir() });
  });

  it('Arial (sized as Arial) when the bundled file cannot be reached', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vd-fonts-empty-'));
    try {
      expect(chooseBurnFont(empty)).toEqual({ family: FALLBACK_FONT_FAMILY, fontsDir: empty });
      expect(chooseBurnFont(undefined)).toEqual({ family: FALLBACK_FONT_FAMILY });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("the caller's family always wins", () => {
    expect(chooseBurnFont(packagedFontsDir(), ' Noto Sans ')).toEqual({ family: 'Noto Sans', fontsDir: packagedFontsDir() });
  });
});

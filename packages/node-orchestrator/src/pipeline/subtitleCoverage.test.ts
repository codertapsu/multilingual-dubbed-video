import { describe, expect, it } from 'vitest';

import { coverageWarnings, sameRead, speechWithSubtitles, subtitleBandFor, subtitleCoverage, type SubtitlePresenceReport } from './subtitleCoverage.js';

const ev = (startMs: number, endMs: number) => ({ startMs, endMs });
const line = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

describe('the band the subtitle check reads', () => {
  const settings = (coverBand?: { y: number; h: number }) => ({ settings: { burnSubtitleStyle: coverBand ? { coverBand } : {} } }) as never;

  it("the user's cover band first, else picture detection's when sure enough", () => {
    const detection = { band: { y: 0.915, h: 0.055, confidence: 0.7, method: 'appearance' as const } };
    expect(subtitleBandFor(settings({ y: 0.9, h: 0.08 }), detection)).toEqual({ band: { y: 0.9, h: 0.08 }, from: 'settings' });
    expect(subtitleBandFor(settings(), detection)).toEqual({ band: { y: 0.915, h: 0.055 }, from: 'detection' });
    expect(subtitleBandFor(settings(), { band: { ...detection.band, confidence: 0.2 } })).toBeUndefined();
    expect(subtitleBandFor(settings(), undefined)).toBeUndefined();
  });

  it('reads again only for another band or window', () => {
    const report = { band: { y: 0.915, h: 0.055 }, window: { startMs: 0 } } as SubtitlePresenceReport;
    expect(sameRead(report, { y: 0.9151, h: 0.055 }, { startMs: 0 })).toBe(true);
    expect(sameRead(report, { y: 0.9, h: 0.055 }, { startMs: 0 })).toBe(false);
    expect(sameRead(report, { y: 0.915, h: 0.055 }, { startMs: 0, endMs: 60_000 })).toBe(false);
  });
});

describe('the subtitles as speech for the silence test', () => {
  it('adds the subtitle times to the speech map, merged', () => {
    expect(speechWithSubtitles([ev(0, 1000), ev(5000, 6000)], [ev(800, 2000), ev(3000, 3500)])).toEqual([ev(0, 2000), ev(3000, 3500), ev(5000, 6000)]);
  });
});

describe('the subtitles against the lines (《反相之地》, claude-dubber 2026-11-25)', () => {
  it('names the subtitles no line covers, joined into stretches, the longest first', () => {
    const subs = [ev(1000, 2000), ev(2200, 3000), ev(60_000, 61_000), ev(61_500, 62_500), ev(63_000, 64_000), ev(100_000, 101_000)];
    const lines = [line('a', 950, 2050), line('b', 2150, 3050), line('c', 99_900, 101_100)];
    const r = subtitleCoverage(subs, lines);
    expect(r.missing).toEqual([ev(60_000, 61_000), ev(61_500, 62_500), ev(63_000, 64_000)]);
    expect(r.missingMs).toBe(3000);
    expect(r.stretches).toEqual([{ fromMs: 60_000, toMs: 64_000, count: 3 }]);
  });

  it('a line just off a subtitle still covers it (subtitles come up early, stay late)', () => {
    expect(subtitleCoverage([ev(1000, 2000)], [line('a', 1250, 1700)]).missing).toEqual([]);
  });

  it('names lines with no subtitle only where the subtitles follow the dialogue', () => {
    const subs = [ev(0, 4000), ev(5000, 9000)];
    const followed = subtitleCoverage(subs, [line('a', 0, 4000), line('b', 5000, 9000), line('h', 20_000, 23_000), line('s', 30_000, 31_000)]);
    expect(followed.followsDialogue).toBe(true);
    expect(followed.unseen.map((l) => l.id)).toEqual(['h']); // a 1-s line is never named
    // Subtitles only now and then (a title, a sign): no line is suspect for lacking one.
    const sparse = subtitleCoverage([ev(0, 1000)], [line('a', 0, 1000), line('b', 5000, 15_000), line('c', 20_000, 30_000)]);
    expect(sparse.followsDialogue).toBe(false);
    expect(sparse.unseen).toEqual([]);
  });

  it('says so in the STT step\'s warnings, never for a title card or two', () => {
    const subs = Array.from({ length: 8 }, (_, k) => ev(10_000 + k * 2000, 11_500 + k * 2000));
    const warnings = coverageWarnings(subtitleCoverage(subs, []));
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'subtitles-without-lines',
        key: 'warning.subtitles-without-lines',
        params: { count: 8, seconds: 12, biggest: '0:10–0:26 (8)' },
      }),
    ]);
    expect(coverageWarnings(subtitleCoverage([ev(0, 2000)], []))).toEqual([]);
    const lines = [line('a', 0, 4000), line('h1', 10_000, 12_000), line('h2', 20_000, 22_000), line('h3', 30_000, 32_000)];
    const all = coverageWarnings(subtitleCoverage([ev(0, 4000), ev(4500, 9000)], [...lines, line('b', 4500, 9000)]));
    expect(all).toContainEqual(expect.objectContaining({ code: 'lines-without-subtitles', params: { count: 3, examples: '0:10, 0:20, 0:30' } }));
  });
});

import { describe, expect, it } from 'vitest';

import { cjkSubtitles, enoughRead, linesFromSubtitles, readingTimeOf, sourceText } from './burnedInTranscript.js';

const ev = (startMs: number, endMs: number) => ({ startMs, endMs });
const said = (text: string, confidence = 0.95) => ({ text, confidence });

describe('the video\'s own subtitles as its transcript (claude-dubber A3)', () => {
  it('reads each subtitle 40 % in, away from a fade, and a short one in its middle', () => {
    expect(readingTimeOf(ev(10_000, 12_000))).toBe(10_800);
    expect(readingTimeOf(ev(10_000, 10_400))).toBe(10_200);
    expect(readingTimeOf(ev(10_000, 10_300))).toBe(10_150);
  });

  it('one line per subtitle read, timed by when it shows, numbered as speech-to-text numbers them', () => {
    const out = linesFromSubtitles([ev(1000, 2500), ev(3000, 4200)], [said('大家小点声 后面有东西！'), said('快 快跑')]);
    expect(out.lines).toEqual([
      { id: 'seg_0001', index: 0, startMs: 1000, endMs: 2500, sourceText: '大家小点声 后面有东西！' },
      { id: 'seg_0002', index: 1, startMs: 3000, endMs: 4200, sourceText: '快 快跑' },
    ]);
    expect(out).toMatchObject({ read: 2, unreadable: 0, merged: 0 });
  });

  it('leaves out what could not be read, and joins a subtitle split by a flicker', () => {
    const events = [ev(0, 1000), ev(1200, 2000), ev(2100, 3000), ev(5000, 6000), ev(6100, 7000)];
    const reads = [said('潘博文是我哥'), said('潘博文是我哥！'), undefined, said('???', 0.95), said('别松', 0.3)];
    const out = linesFromSubtitles(events, reads);
    expect(out.lines.map((l) => [l.startMs, l.endMs, l.sourceText])).toEqual([[0, 2000, '潘博文是我哥']]);
    expect(out).toMatchObject({ read: 2, unreadable: 3, merged: 1 });
  });

  it('the same words far apart are two lines', () => {
    const out = linesFromSubtitles([ev(0, 1000), ev(5000, 6000)], [said('快跑'), said('快跑')]);
    expect(out.lines).toHaveLength(2);
  });

  it('is the transcript only when enough of it was read', () => {
    const lines = (n: number) => ({ lines: Array.from({ length: n }, () => ({}) as never) });
    expect(enoughRead(lines(9), 10)).toBe(false); // fewer than ten lines
    expect(enoughRead(lines(29), 100)).toBe(false); // under 30 % of the subtitles
    expect(enoughRead(lines(30), 100)).toBe(true);
  });

  it("keeps a bilingual subtitle's own rows: Chinese above English read as one line (Phong Thủy Thiên Sư, 2026-11-27)", () => {
    const both = { text: '竹子长成这么一大片 Bamboo grows into such a large area', confidence: 0.93, texts: ['竹子长成这么一大片', 'Bamboo grows into such a large area'] };
    const out = linesFromSubtitles([ev(1000, 2500), ev(3000, 4200), ev(5000, 6000)], [both, said('快 快跑'), { ...said('这是 iPhone 15'), texts: ['这是 iPhone 15'] }], {
      sourceLanguage: 'zh',
    });
    expect(out.lines.map((l) => l.sourceText)).toEqual(['竹子长成这么一大片', '快 快跑', '这是 iPhone 15']);
    expect(out.translationRows).toBe(1);
    // English above Chinese is the same; two Chinese rows (a two-line subtitle) stay together.
    expect(sourceText({ text: 'x', texts: ['Go now', '快走'] }, true)).toEqual({ text: '快走', dropped: true });
    expect(sourceText({ text: '大家小点声 后面有东西', texts: ['大家小点声', '后面有东西'] }, true)).toEqual({ text: '大家小点声 后面有东西', dropped: false });
    // An English source keeps its rows, and a read saved without them is as it was.
    expect(sourceText(both, false).text).toBe(both.text);
    expect(sourceText({ text: both.text }, true).text).toBe(both.text);
  });

  it('knows Chinese, Japanese and Korean subtitles from the source language, or from what was read when it is "auto"', () => {
    expect(cjkSubtitles([], 'zh-CN')).toBe(true);
    expect(cjkSubtitles([], 'ja')).toBe(true);
    expect(cjkSubtitles([], 'en')).toBe(false);
    expect(cjkSubtitles([said('快跑'), said('别松'), said('OK')], 'auto')).toBe(true);
    expect(cjkSubtitles([said('Run'), said('Now'), said('快跑')], undefined)).toBe(false);
  });
});

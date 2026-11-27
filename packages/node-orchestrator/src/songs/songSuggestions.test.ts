import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptSegment, TranscriptWord } from '@videodubber/shared';

import { scriptCounts, SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from './chineseScript.js';
import {
  heardSuggestions,
  keptRepeatLines,
  openSuggestions,
  readSongSuggestions,
  recordSongSuggestions,
  settleSuggestions,
  SONG_RULE,
  songsWarning,
  songSuggestionsPath,
  soundsSung,
  suggestSongLines,
  traditionalLines,
  type SongSuggestion,
} from './songSuggestions.js';

let n = 0;
const line = (startMs: number, endMs: number, sourceText: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => {
  n++;
  return { id: `seg_${String(n).padStart(4, '0')}`, index: n - 1, startMs, endMs, sourceText, ...extra };
};
/** Words spread evenly over the line, one per character (how whisper writes Chinese). */
const sung = (startMs: number, endMs: number, text: string): TranscriptSegment => {
  const chars = [...text];
  const per = (endMs - startMs) / chars.length;
  const words: TranscriptWord[] = chars.map((c, i) => ({ word: c, startMs: Math.round(startMs + i * per), endMs: Math.round(startMs + (i + 1) * per) }));
  return line(startMs, endMs, text, { words });
};
// Dialogue in simplified characters (说, 们, 这, 过, 还, 时, 么, 对...).
const dialogue = (startMs: number): TranscriptSegment[] => [
  line(startMs, startMs + 1500, '我们说过这件事'),
  line(startMs + 1600, startMs + 3000, '你还记得那时候吗'),
  line(startMs + 3100, startMs + 4500, '这么多年过去了'),
  line(startMs + 4600, startMs + 6000, '对不起我来晚了'),
  line(startMs + 6100, startMs + 7200, '没关系们说话'),
  line(startMs + 7300, startMs + 8800, '这里还有东西'),
];

beforeEach(() => {
  n = 0;
});

describe('traditional characters in a simplified transcript (on-screen lyrics)', () => {
  it('knows the two scripts apart, character by character', () => {
    for (const c of TRADITIONAL_ONLY) expect(SIMPLIFIED_ONLY.has(c)).toBe(false);
    expect(TRADITIONAL_ONLY.size).toBeGreaterThan(500);
    expect(scriptCounts('夢裡的淚水')).toEqual({ traditional: 2, simplified: 0, han: 5 });
    expect(scriptCounts('我们说过的话')).toEqual({ traditional: 0, simplified: 4, han: 6 });
    expect(scriptCounts('hello')).toEqual({ traditional: 0, simplified: 0, han: 0 });
  });

  it('flags the traditional lines, a short one next to a sure one too, and nothing in a traditional transcript', () => {
    const lines = [
      ...dialogue(0),
      ...dialogue(10_000),
      line(20_000, 24_000, '夢裡淚水為誰流'),
      line(24_500, 26_000, '愛你'),
      line(26_500, 28_000, '這一生'),
      ...dialogue(40_000),
      line(60_000, 61_000, '愛'), // one traditional character, far from any lyric: not enough
    ];
    const flagged = traditionalLines(lines);
    expect([...flagged].map((id) => lines.find((l) => l.id === id)!.sourceText)).toEqual(['夢裡淚水為誰流', '愛你', '這一生']);
    // A transcript written in traditional characters: nothing stands out.
    expect(traditionalLines([line(0, 1000, '我們說過這件事'), line(1000, 2000, '夢裡淚水為誰流')]).size).toBe(0);
  });
});

describe('repeats the loop pass kept', () => {
  it('flags a kept range whose lines repeat, not one kept because the second decode heard nothing', () => {
    // A loop range is one line said 4+ times in a run (pipeline/loopRepair.ts): a chorus.
    const chorus = [
      ...Array.from({ length: 8 }, (_, i) => line(i * 2000, i * 2000 + 1800, '月亮代表我的心')),
      line(16_000, 18_000, '你问我爱你有多深'),
    ];
    const varied = [line(20_000, 22_000, '第一句'), line(22_000, 24_000, '第二句'), line(24_000, 26_000, '第三句')];
    const flagged = keptRepeatLines(
      [...chorus, ...varied],
      [
        { fromMs: 0, toMs: 18_000, kind: 'repeat', status: 'kept', before: 9, after: 9, reason: 'it repeats in a fresh decode too' },
        { fromMs: 20_000, toMs: 26_000, kind: 'low-diversity', status: 'kept', before: 3, after: 3, reason: 'the second decode heard nothing' },
        { fromMs: 30_000, toMs: 40_000, kind: 'repeat', status: 'replaced', before: 9, after: 2 },
      ],
    );
    expect([...flagged]).toEqual(chorus.map((l) => l.id));
  });
});

describe('slow, sustained singing', () => {
  it('tells a sung line (0.6 s a syllable) from speech (0.2 s), with or without word timings', () => {
    expect(soundsSung(sung(0, 4200, '月亮代表我的心'), 'zh')).toBe(true);
    expect(soundsSung(sung(0, 1400, '月亮代表我的心'), 'zh')).toBe(false);
    // A slow line whose words are short (a pause inside it) is speech.
    const paused = line(0, 4200, '月亮代表我的心', {
      words: [...'月亮代表我的心'].map((c, i) => ({ word: c, startMs: i * 200, endMs: i * 200 + 180 })),
    });
    expect(soundsSung(paused, 'zh')).toBe(false);
    // No word timings: only a much slower line counts.
    expect(soundsSung(line(0, 5000, '月亮代表'), 'zh')).toBe(true);
    expect(soundsSung(line(0, 2000, '月亮代表'), 'zh')).toBe(false);
    // Words, for languages written with spaces.
    expect(soundsSung(line(0, 6000, 'love me tender'), 'en')).toBe(true);
    expect(soundsSung(line(0, 2000, 'love me tender, love me sweet'), 'en')).toBe(false);
  });

  it('suggests a passage of three sung lines, or one next to a line suggested otherwise, never a lone slow line', () => {
    const lines = [
      ...dialogue(0),
      sung(20_000, 24_000, '月亮代表我的心'),
      sung(25_000, 29_000, '你问我爱你有多深'),
      sung(30_000, 34_000, '我爱你有几分'),
      ...dialogue(40_000),
      sung(60_000, 64_000, '轻轻的一个吻'), // alone
      ...dialogue(70_000),
    ];
    const out = suggestSongLines(lines, { language: 'zh' });
    expect(out.map((s) => [s.text, s.reasons])).toEqual([
      ['月亮代表我的心', ['sung']],
      ['你问我爱你有多深', ['sung']],
      ['我爱你有几分', ['sung']],
    ]);
  });
});

describe('the suggestions together', () => {
  it('give every reason a line has, skip lines kept as a song already, and say where in a warning', () => {
    const lines = [
      ...dialogue(0),
      ...dialogue(9_000),
      sung(20_000, 24_000, '夢裡淚水為誰流'),
      sung(25_000, 29_000, '這一生為了誰'),
      sung(30_000, 34_000, '風雨中的你'),
      line(35_000, 37_000, '還記得', { song: true }),
    ];
    const out = suggestSongLines(lines, { language: 'zh-CN' });
    expect(out.map((s) => [s.lineId, s.reasons])).toEqual([
      ['seg_0013', ['traditional', 'sung']],
      ['seg_0014', ['traditional', 'sung']],
      ['seg_0015', ['traditional', 'sung']],
    ]);
    const warning = songsWarning(out);
    expect(warning).toMatchObject({ code: 'songs-suggested', key: 'warning.songs-suggested', params: { count: 3, ranges: '0:20–0:34' } });
    expect(warning.message).toMatch(/^3 line\(s\) look like a song \(0:20–0:34\)\. Nothing was changed/);
  });

  it('never suggests dialogue whisper wrote in traditional characters, nor the slow lines near it (2026-11-27)', () => {
    const lines = [
      ...dialogue(0),
      ...dialogue(10_000),
      // Spoken at speech rate, whisper's window in traditional characters.
      line(20_000, 21_500, '這個時候還說什麼'),
      line(21_600, 23_000, '對不起我們走吧'),
      // One slow line nearby: the lines above pulled it in as "sung".
      sung(25_000, 29_000, '你还好吗'),
      ...dialogue(40_000),
      // A song: slow lines, one faster lyric between them, all in traditional characters.
      sung(60_000, 64_000, '夢裡淚水為誰流'),
      line(64_500, 66_000, '這一生為了誰'),
      sung(66_500, 70_500, '風雨中的你'),
      sung(71_000, 75_000, '還記得當時'),
      // Enough simplified dialogue for the transcript to read as simplified.
      ...[80_000, 90_000, 100_000, 110_000].flatMap((ms) => dialogue(ms)),
    ];
    const out = suggestSongLines(lines, { language: 'zh' });
    expect(out.map((s) => [s.text, s.reasons])).toEqual([
      ['夢裡淚水為誰流', ['traditional', 'sung']],
      ['這一生為了誰', ['traditional']],
      ['風雨中的你', ['traditional', 'sung']],
      ['還記得當時', ['traditional', 'sung']],
    ]);
  });
});

describe('suggestions saved under the older rule', () => {
  const at = (lineId: string, startMs: number, reasons: SongSuggestion['reasons']): SongSuggestion => ({ lineId, startMs, endMs: startMs + 2000, text: lineId, reasons });
  const old = [
    // Dialogue in traditional characters, and a slow line it pulled in.
    at('d1', 20_000, ['traditional']),
    at('d2', 21_600, ['traditional']),
    at('d3', 25_000, ['sung']),
    // A sung passage, and a faster lyric in it.
    at('s1', 60_000, ['traditional', 'sung']),
    at('s2', 64_500, ['traditional']),
    at('s3', 66_500, ['sung']),
    at('s4', 71_000, ['sung']),
    // What is left of a run whose other lines the user settled, and a kept chorus.
    at('left', 150_000, ['sung']),
    at('r1', 200_000, ['repeats']),
  ];

  it('are read under the rule in force: what nothing heard backs leaves the list, a run left over stays', () => {
    expect(heardSuggestions(old).map((s) => s.lineId)).toEqual(['s1', 's2', 's3', 's4', 'left', 'r1']);
    const lines = old.map((o, i) => line(o.startMs, o.endMs, o.text, { id: o.lineId, index: i }));
    expect(openSuggestions({ checkedAt: 'x', suggestions: old }, lines).map((s) => s.lineId)).toEqual(['s1', 's2', 's3', 's4', 'left', 'r1']);
    // A file of the rule in force is taken as it is.
    expect(openSuggestions({ checkedAt: 'x', rule: SONG_RULE, suggestions: old }, lines)).toHaveLength(old.length);
  });
});

describe('on disk', () => {
  let tmp: string;
  let paths: { subtitlesDir: string; loopRangesJson: string };
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-songs-'));
    paths = { subtitlesDir: path.join(tmp, 'subtitles'), loopRangesJson: path.join(tmp, 'audio', 'loop_ranges.json') };
    await fsp.mkdir(paths.subtitlesDir, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('records the suggestions at the end of speech-to-text, warns once, and clears them for a transcript with none', async () => {
    const lines = [...dialogue(0), sung(20_000, 24_000, '月亮代表我的心'), sung(25_000, 29_000, '你问我爱你有多深'), sung(30_000, 34_000, '我爱你有几分')];
    const warnings: unknown[] = [];
    const found = await recordSongSuggestions(paths, lines, { language: 'zh', warn: (w) => warnings.push(w) });
    expect(found).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    const file = await readSongSuggestions(songSuggestionsPath(paths));
    expect(file?.suggestions.map((s) => s.lineId)).toEqual(['seg_0007', 'seg_0008', 'seg_0009']);
    // A new transcript without songs: the old suggestions go.
    expect(await recordSongSuggestions(paths, dialogue(0), { language: 'zh' })).toEqual([]);
    expect(await readSongSuggestions(songSuggestionsPath(paths))).toBeUndefined();
  });

  it('reads the loop pass\'s kept ranges, and never fails the step on a bad file', async () => {
    const chorus = [line(0, 2000, '月亮代表我的心'), line(2000, 4000, '月亮代表我的心'), line(4000, 6000, '月亮代表我的心')];
    await fsp.mkdir(path.dirname(paths.loopRangesJson), { recursive: true });
    await fsp.writeFile(paths.loopRangesJson, JSON.stringify({ ranges: [{ fromMs: 0, toMs: 6000, kind: 'repeat', status: 'kept', before: 3, after: 3 }] }));
    expect((await recordSongSuggestions(paths, chorus, { language: 'zh' })).map((s) => s.reasons)).toEqual([['repeats'], ['repeats'], ['repeats']]);
    await fsp.writeFile(paths.loopRangesJson, '{ not json');
    await expect(recordSongSuggestions(paths, chorus, { language: 'zh' })).resolves.toEqual([]);
  });

  it('follows a suggestion to its line after the lines moved, and settles the ones decided', async () => {
    const lines = [...dialogue(0), sung(20_000, 24_000, '月亮代表我的心'), sung(25_000, 29_000, '你问我爱你有多深'), sung(30_000, 34_000, '我爱你有几分')];
    await recordSongSuggestions(paths, lines, { language: 'zh' });
    const file = songSuggestionsPath(paths);
    // The lines were renumbered (a range restructured before them): matched by time.
    const renumbered = lines.map((l, i) => ({ ...l, id: `seg_${String(i + 10).padStart(4, '0')}` }));
    expect(openSuggestions(await readSongSuggestions(file), renumbered).map((s) => s.lineId)).toEqual(['seg_0016', 'seg_0017', 'seg_0018']);
    // Kept as a song: no longer suggested.
    const kept = renumbered.map((l) => (l.id === 'seg_0016' ? { ...l, song: true } : l));
    expect(openSuggestions(await readSongSuggestions(file), kept).map((s) => s.lineId)).toEqual(['seg_0017', 'seg_0018']);
    // Settled: one kept, one said not to be a song; one left.
    await settleSuggestions(file, ['seg_0016', 'seg_0017'], kept);
    expect((await readSongSuggestions(file))?.suggestions.map((s) => s.text)).toEqual(['我爱你有几分']);
    await settleSuggestions(file, ['seg_0018'], kept);
    expect(await readSongSuggestions(file)).toBeUndefined();
  });

  it('marks the rule it suggests by, and brings an older file to it once, when a line is settled', async () => {
    const lines = [...dialogue(0), sung(20_000, 24_000, '月亮代表我的心'), sung(25_000, 29_000, '你问我爱你有多深'), sung(30_000, 34_000, '我爱你有几分')];
    await recordSongSuggestions(paths, lines, { language: 'zh' });
    const file = songSuggestionsPath(paths);
    expect((await readSongSuggestions(file))?.rule).toBe(SONG_RULE);

    // An older file, with dialogue in traditional characters among the songs.
    const trad = line(60_000, 61_500, '這個時候還說什麼');
    const all = [...lines, trad];
    const now = (await readSongSuggestions(file))!;
    const extra = { lineId: trad.id, startMs: trad.startMs, endMs: trad.endMs, text: trad.sourceText, reasons: ['traditional'] };
    await fsp.writeFile(file, JSON.stringify({ checkedAt: 'old', suggestions: [...now.suggestions, extra] }));
    expect(openSuggestions(await readSongSuggestions(file), all).map((s) => s.lineId)).toEqual(['seg_0007', 'seg_0008', 'seg_0009']);
    // Settling a line writes it under the rule in force: the run's other lines stay.
    await settleSuggestions(file, ['seg_0007'], all);
    const after = await readSongSuggestions(file);
    expect(after).toMatchObject({ rule: SONG_RULE });
    expect(after?.suggestions.map((s) => s.lineId)).toEqual(['seg_0008', 'seg_0009']);
    expect(openSuggestions(after, all).map((s) => s.lineId)).toEqual(['seg_0008', 'seg_0009']);
  });
});

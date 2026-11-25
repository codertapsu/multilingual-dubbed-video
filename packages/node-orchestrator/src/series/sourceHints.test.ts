import { describe, expect, it } from 'vitest';

import { transcriptExcerpt } from './seriesAi.js';
import { sourceNameHints } from './sourceHints.js';

describe('the source names itself', () => {
  it('its title, part, project name and joined files, each once', () => {
    expect(
      sourceNameHints({
        name: '反相之地',
        source: { providerId: 'bilibili', sourceKey: 'k', url: 'u', title: '反相之地 第7集', partTitle: 'P7' } as never,
        inputFiles: [
          { name: '反相之地 01.mp4', startMs: 0, durationMs: 1 },
          { name: '反相之地 02.mp4', startMs: 1, durationMs: 1 },
        ] as never,
      }),
    ).toEqual(['Title: 反相之地 第7集', 'Part title: P7', 'Project: 反相之地', 'File: 反相之地 01', 'File: 反相之地 02']);
    expect(sourceNameHints({ name: '  ' })).toEqual([]);
  });
});

describe('a part excerpt for its title and summary', () => {
  it('says who speaks each line, by name where the sheet knows them (F3)', () => {
    const lines = [
      { startMs: 8_589_000, endMs: 8_591_000, sourceText: '潘博文是我哥', speakerId: 'SPEAKER_02' },
      { startMs: 8_592_000, endMs: 8_593_000, sourceText: '真的吗', speakerId: 'SPEAKER_07' },
    ];
    expect(transcriptExcerpt(lines, 8_500_000, 8_600_000, 1000, new Map([['SPEAKER_02', 'Phan Bác Nhã']]))).toBe(
      '[2:23:09] Phan Bác Nhã: 潘博文是我哥\n[2:23:12] SPEAKER_07: 真的吗',
    );
  });
});

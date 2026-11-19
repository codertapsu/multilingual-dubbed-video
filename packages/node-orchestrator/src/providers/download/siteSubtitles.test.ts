import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseLanguage, bilibiliSubtitleLines, siteTranscript } from './siteSubtitles.js';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-sitesubs-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('bilibiliSubtitleLines', () => {
  it('reads Bilibili subtitle JSON into ordered, numbered lines', () => {
    expect(
      bilibiliSubtitleLines({
        body: [
          { from: 3.5, to: 5.25, content: '第二句' },
          { from: 0.32, to: 2.56, content: '  第一句\n ' },
          { from: 6, to: 6, content: 'empty span' },
          { from: 7, to: 8, content: '' },
        ],
      }),
    ).toEqual([
      { id: 'seg_0001', index: 0, startMs: 320, endMs: 2560, sourceText: '第一句' },
      { id: 'seg_0002', index: 1, startMs: 3500, endMs: 5250, sourceText: '第二句' },
    ]);
    expect(bilibiliSubtitleLines('nope')).toEqual([]);
  });

  it('matches languages the way Bilibili names them', () => {
    expect(baseLanguage('ai-zh')).toBe('zh');
    expect(baseLanguage('zh-Hans')).toBe('zh');
    expect(baseLanguage('en-US')).toBe('en');
  });
});

describe('siteTranscript', () => {
  it("prefers the uploader's subtitles in the spoken language over the AI's", async () => {
    const cc = path.join(dir, 'v.zh-CN.json');
    const ai = path.join(dir, 'v.ai-zh.json');
    await fsp.writeFile(cc, JSON.stringify({ body: [{ from: 1, to: 2, content: '字幕' }] }));
    await fsp.writeFile(ai, JSON.stringify({ body: [{ from: 1, to: 2, content: 'AI 字幕' }] }));
    const project = {
      settings: { sourceLanguage: 'zh' } as never,
      source: {
        providerId: 'bilibili',
        sourceKey: 'k',
        url: 'u',
        title: 't',
        page: 1,
        partCount: 1,
        subtitles: [
          { language: 'ai-zh', label: '中文（自动生成）', path: ai, ai: true },
          { language: 'zh-CN', label: '中文（中国）', path: cc, ai: false },
        ],
      },
    };
    const t = await siteTranscript(project);
    expect(t?.label).toBe('中文（中国）');
    expect(t?.segments[0]?.sourceText).toBe('字幕');
    expect(await siteTranscript({ ...project, settings: { sourceLanguage: 'ja' } as never })).toBeUndefined();
  });

  it("gives a series part only its own stretch, on the part's clock", async () => {
    const cc = path.join(dir, 'long.zh-CN.json');
    await fsp.writeFile(
      cc,
      JSON.stringify({ body: [{ from: 10, to: 12, content: '一' }, { from: 620, to: 623, content: '二' }, { from: 1300, to: 1302, content: '三' }] }),
    );
    const t = await siteTranscript({
      settings: { sourceLanguage: 'zh' } as never,
      sourceRange: { startMs: 600_000, endMs: 1_200_000 },
      source: {
        providerId: 'bilibili',
        sourceKey: 'k',
        url: 'u',
        title: 't',
        page: 1,
        partCount: 1,
        subtitles: [{ language: 'zh-CN', label: '中文（中国）', path: cc, ai: false }],
      },
    });
    expect(t?.segments).toEqual([expect.objectContaining({ id: 'seg_0001', index: 0, startMs: 20_000, endMs: 23_000, sourceText: '二' })]);
  });
});

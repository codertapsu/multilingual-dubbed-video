import { describe, expect, it } from 'vitest';

import type { DownloadItem } from '../../core/models/download';
import { downloadCounts, downloadGroup, filterDownloads, shortUrl, sourcePageOf } from './download-list';

function item(id: string, state: DownloadItem['state'], over: Partial<DownloadItem> = {}): DownloadItem {
  return { id, input: `BV${id}`, page: 1, state, percent: null, attempts: 1, createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z', ...over } as DownloadItem;
}

const source = (title: string, url: string, over: Partial<NonNullable<DownloadItem['source']>> = {}): DownloadItem['source'] => ({
  providerId: 'bilibili',
  sourceKey: `bilibili:${title}`,
  url,
  title,
  page: 1,
  partCount: 1,
  ...over,
});

describe('the download list', () => {
  it('puts each download under one filter, and counts them', () => {
    const list = [
      item('a', 'queued'),
      item('b', 'resolving'),
      item('c', 'downloading'),
      item('d', 'merging'),
      item('e', 'done'),
      item('f', 'failed'),
      item('g', 'cancelled'),
    ];
    expect(list.map(downloadGroup)).toEqual(['active', 'active', 'active', 'active', 'done', 'problem', 'problem']);
    expect(downloadCounts(list)).toEqual({ all: 7, active: 4, done: 1, problem: 2 });
    expect(filterDownloads(list, { query: '', filter: 'problem' }).map((i) => i.id)).toEqual(['f', 'g']);
  });

  it("searches the title, the part, the uploader, the link and the file name, without minding accents", () => {
    const list = [
      item('a', 'done', {
        source: source('持械入大宋', 'https://www.bilibili.com/video/BV1aa?p=2', { partTitle: '第2集 入城', ownerName: '老番茄' }),
        filePath: 'C:\\Videos\\Downloads\\Đà Lạt vlog.mp4',
      }),
      item('b', 'failed', { input: 'https://v.douyin.com/abc123/' }),
    ];
    const ids = (query: string) => filterDownloads(list, { query, filter: 'all' }).map((i) => i.id);
    expect(ids('入城')).toEqual(['a']);
    expect(ids('老番茄')).toEqual(['a']);
    expect(ids('BV1aa')).toEqual(['a']);
    expect(ids('da lat')).toEqual(['a']);
    expect(ids('douyin')).toEqual(['b']);
    expect(ids('nothing here')).toEqual([]);
  });

  it('names where a video came from: the site page once known, else the pasted link, never a bare id', () => {
    expect(sourcePageOf(item('a', 'done', { source: source('t', 'https://www.bilibili.com/video/BV1aa') }))).toBe('https://www.bilibili.com/video/BV1aa');
    expect(sourcePageOf(item('b', 'queued', { input: ' https://b23.tv/xyz ' }))).toBe('https://b23.tv/xyz');
    expect(sourcePageOf(item('c', 'queued', { input: 'BV1xx411c7mD' }))).toBeUndefined();
  });

  it('shortens a link for a row', () => {
    expect(shortUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2')).toBe('bilibili.com/video/BV1xx411c7mD?p=2');
    expect(shortUrl('https://v.douyin.com/abc/')).toBe('v.douyin.com/abc');
    expect(shortUrl(`https://example.com/${'x'.repeat(80)}`, 30)).toHaveLength(30);
  });
});

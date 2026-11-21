import { describe, expect, it } from 'vitest';

import type { DownloadItem } from '../../core/models/download';
import { dubResultRows } from './dub-results';

function item(id: string, title?: string): DownloadItem {
  return {
    id,
    input: `https://www.bilibili.com/video/${id}`,
    page: 1,
    state: 'done',
    percent: 100,
    attempts: 1,
    createdAt: '2026-11-21T00:00:00Z',
    updatedAt: '2026-11-21T00:00:00Z',
    ...(title ? { source: { title } as DownloadItem['source'] } : {}),
  } as DownloadItem;
}

describe('dubResultRows', () => {
  it('gives every video its own line, in the order sent, under the title the list shows', () => {
    const rows = dubResultRows(
      [
        { downloadId: 'a', projectId: 'p1', name: 'Project A', started: true },
        { downloadId: 'b', projectId: 'p2', name: 'Project B', queued: true },
        { downloadId: 'c', projectId: 'p3', name: 'Project C', waiting: true },
        { downloadId: 'd', projectId: 'p4', name: 'Project D' },
      ],
      [item('a', 'Video A'), item('b', 'Video B'), item('c'), item('d', 'Video D')],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['started', 'queued', 'waiting', 'created']);
    expect(rows.map((r) => r.title)).toEqual(['Video A', 'Video B', 'Project C', 'Video D']);
  });

  it('links a project to its progress page, and a video in parts to its series page', () => {
    const [single, series] = dubResultRows(
      [
        { downloadId: 'a', projectId: 'p1', started: true },
        { downloadId: 'b', projectId: 's1', series: true, started: true },
      ],
      [item('a'), item('b')],
    );
    expect(single!.link).toEqual(['/project', 'p1', 'processing']);
    expect(series!.outcome).toBe('series');
    expect(series!.link).toEqual(['/project', 's1', 'series']);
  });

  it('keeps every failure with its own error, not only the first', () => {
    const rows = dubResultRows(
      [
        { downloadId: 'a', error: { code: 'INVALID_EDIT', message: 'not finished' } },
        { downloadId: 'b', projectId: 'p2', started: true },
        { downloadId: 'c', error: { code: 'NO_AUDIO_STREAM', message: 'no audio' } },
      ],
      [item('a', 'A'), item('b', 'B'), item('c', 'C')],
    );
    expect(rows.filter((r) => r.outcome === 'failed').map((r) => r.error?.code)).toEqual(['INVALID_EDIT', 'NO_AUDIO_STREAM']);
    expect(rows[0]!.link).toBeUndefined();
  });

  it('names a video the list no longer has by what it can', () => {
    const [row] = dubResultRows([{ downloadId: 'gone', error: { code: 'INVALID_EDIT', message: 'no such download' } }], []);
    expect(row!.title).toBe('gone');
  });
});

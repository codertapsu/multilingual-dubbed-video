import { describe, expect, it } from 'vitest';

import type { Project, ProjectListItem } from '../../core/models';
import {
  clockDuration,
  fileName,
  filterCounts,
  fold,
  partCaption,
  projectEntries,
  shortDate,
  summarizeSeries,
  type ListOptions,
} from './project-list';

const settings = { minMinutes: 15, maxMinutes: 20, aiProviderId: 'x', recapSec: 4, autoStart: true };

function p(id: string, over: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id,
    name: id,
    inputVideoPath: `C:\\Videos\\${id}.mp4`,
    status: 'completed',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  } as ProjectListItem;
}

const parent = (id: string, over: Partial<ProjectListItem> = {}, state = 'parts'): ProjectListItem =>
  p(id, { series: { role: 'parent', settings, state } as Project['series'], ...over });
const part = (id: string, parentId: string, index: number, over: Partial<ProjectListItem> = {}, title?: string): ProjectListItem =>
  p(id, {
    series: { role: 'part', parentId, index, count: 3, seriesName: parentId, recapEndMs: 0, ...(title ? { title } : {}) } as Project['series'],
    ...over,
  });

const all: ListOptions = { query: '', filter: 'all', sort: 'recent' };
const ids = (opts: Partial<ListOptions>, list: ProjectListItem[]) =>
  projectEntries(list, { ...all, ...opts }).map((e) => (e.kind === 'series' ? `${e.parent.id}[${e.parts.map((x) => x.id).join(',')}]` : e.project.id));

describe('the Projects list', () => {
  it('shows a series once, with its parts in order, and lets a part whose series is gone stand on its own', () => {
    const list = [part('p2', 's', 2), p('a'), parent('s'), part('p1', 's', 1), part('p3', 's', 3), part('orphan', 'gone', 1)];
    expect(ids({}, list)).toEqual(['a', 's[p1,p2,p3]', 'orphan']);
  });

  it("searches names, files and part titles without minding case or Vietnamese accents; a series' name finds all its parts", () => {
    const list = [
      parent('Xuyên Không'),
      part('x1', 'Xuyên Không', 1, {}, 'Mở đầu'),
      part('x2', 'Xuyên Không', 2, {}, 'Đại chiến'),
      p('Tây Du Ký', { inputVideoPath: 'D:/dl/journey_west.mp4' }),
    ];
    expect(ids({ query: 'xuyen khong' }, list)).toEqual(['Xuyên Không[x1,x2]']);
    expect(ids({ query: 'dai chien' }, list)).toEqual(['Xuyên Không[x2]']);
    expect(ids({ query: 'JOURNEY' }, list)).toEqual(['Tây Du Ký']);
    expect(ids({ query: 'nothing like it' }, list)).toEqual([]);
    expect(fold('Đường Tăng')).toBe('duong tang');
  });

  it('narrows to what is under way, what needs the user (failed, flagged lines, a plan to review) and what is done', () => {
    const list = [
      parent('s'),
      part('s1', 's', 1, { status: 'completed' }),
      part('s2', 's', 2, { status: 'running' }),
      part('s3', 's', 3, { status: 'completed', issues: { flagged: 2, overruns: 0 } }),
      p('queued', { status: 'queued' }),
      p('failed', { status: 'failed' }),
      p('done', { status: 'completed' }),
      p('new', { status: 'created' }),
      parent('analysing', { status: 'running' }, 'analysing'),
      parent('review', { status: 'completed' }, 'review'),
    ];
    expect(ids({ filter: 'active' }, list)).toEqual(['s[s2]', 'queued', 'analysing[]']);
    expect(ids({ filter: 'attention' }, list)).toEqual(['s[s3]', 'failed', 'review[]']);
    expect(ids({ filter: 'finished' }, list)).toEqual(['s[s1,s3]', 'done']);
    const narrowed = projectEntries(list, { ...all, filter: 'active' })[0]!;
    expect(narrowed.kind === 'series' && narrowed.narrowed).toBe(true);
    // A made series' parent counts as its parts do; a parent still at work counts once.
    expect(filterCounts(list)).toEqual({ active: 3, attention: 3, finished: 3 });
  });

  it("sums up a series' parts for its header", () => {
    const parts = [
      part('a', 's', 1, { status: 'completed', mediaInfo: { durationMs: 60_000 } as Project['mediaInfo'], issues: { flagged: 3, overruns: 1 } }),
      part('b', 's', 2, { status: 'running', mediaInfo: { durationMs: 30_000 } as Project['mediaInfo'] }),
      part('c', 's', 3, { status: 'paused' }),
      part('d', 's', 4, { status: 'queued' }),
      part('e', 's', 5, { status: 'failed' }),
      part('f', 's', 6, { status: 'created' }),
    ];
    expect(summarizeSeries(parent('s'), parts)).toEqual({ parts: 6, done: 1, running: 1, waiting: 2, failed: 1, notStarted: 1, flagged: 3, durationMs: 90_000 });
    // Before the parts exist: the whole video's length.
    expect(summarizeSeries(parent('s', { mediaInfo: { durationMs: 7_200_000 } as Project['mediaInfo'] }), []).durationMs).toBe(7_200_000);
  });

  it("sorts by last change (a series by its parts' latest), by name with numbers in order, or newest first", () => {
    const list = [
      p('Tập 10', { updatedAt: '2026-11-03T00:00:00Z', createdAt: '2026-11-03T00:00:00Z' }),
      p('Tập 2', { updatedAt: '2026-11-02T00:00:00Z', createdAt: '2026-11-04T00:00:00Z' }),
      parent('Series', { updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }),
      part('sp', 'Series', 1, { updatedAt: '2026-11-05T00:00:00Z' }),
    ];
    expect(ids({ sort: 'recent' }, list)).toEqual(['Series[sp]', 'Tập 10', 'Tập 2']);
    expect(ids({ sort: 'name' }, list)).toEqual(['Series[sp]', 'Tập 2', 'Tập 10']);
    expect(ids({ sort: 'created' }, list)).toEqual(['Tập 2', 'Tập 10', 'Series[sp]']);
  });

  it("says a part's title, or its name without the series' name, and nothing when that is only its number", () => {
    expect(partCaption(part('a', 's', 1, { name: 'Xuyên Không - Phần 07' }, 'Hồi một'), 'Xuyên Không')).toBe('Hồi một');
    expect(partCaption(part('a', 's', 7, { name: 'Xuyên Không - Phần 07' }), 'Xuyên Không')).toBe('');
    expect(partCaption(part('a', 's', 7, { name: 'xuyen khong: Part 7' }), 'Xuyên Không')).toBe('');
    expect(partCaption(part('a', 's', 7, { name: 'Xuyên Không – Hồi 7: Đại chiến' }), 'Xuyên Không')).toBe('Hồi 7: Đại chiến');
    expect(partCaption(part('a', 's', 7, { name: 'Tập cuối' }), 'Xuyên Không')).toBe('Tập cuối');
  });

  it('writes lengths the way players do', () => {
    expect(clockDuration(150_000)).toBe('2:30');
    expect(clockDuration(48 * 60_000)).toBe('48:00');
    expect(clockDuration((8 * 3600 + 12 * 60 + 5) * 1000)).toBe('8:12:05');
    expect(clockDuration(0)).toBe('0:00');
  });

  it('writes a date as short as it can be told apart, and a file name without its folder', () => {
    const now = new Date(2026, 10, 26, 18, 0);
    expect(shortDate(new Date(2026, 10, 26, 9, 5).toISOString(), 'en', now)).toMatch(/09:05|9:05/);
    expect(shortDate(new Date(2026, 10, 3).toISOString(), 'en', now)).toBe('Nov 3');
    expect(shortDate(new Date(2025, 0, 9).toISOString(), 'en', now)).toBe('Jan 9, 2025');
    expect(shortDate('not a date', 'en', now)).toBe('');
    expect(fileName('C:\\Users\\me\\Videos\\Tập 1.mp4')).toBe('Tập 1.mp4');
    expect(fileName('/Users/me/clip.mov')).toBe('clip.mov');
  });
});

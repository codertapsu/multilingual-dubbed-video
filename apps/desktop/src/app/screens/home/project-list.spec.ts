import { describe, expect, it } from 'vitest';

import type { Project } from '../../core/models';
import { groupSeries } from './project-list';

const p = (id: string, series?: Project['series']): Project => ({ id, name: id, ...(series ? { series } : {}) }) as Project;

describe('groupSeries', () => {
  it('shows a series once, with its parts right under it in order', () => {
    const settings = { minMinutes: 15, maxMinutes: 20, aiProviderId: 'x', recapSec: 4, autoStart: true };
    const part = (id: string, index: number): Project =>
      p(id, { role: 'part', parentId: 's', index, count: 3, seriesName: 'S', recapEndMs: 0 } as Project['series']);
    const list = [part('p2', 2), p('a'), p('s', { role: 'parent', settings, state: 'parts' }), part('p1', 1), part('p3', 3), p('b')];
    expect(groupSeries(list).map((r) => `${r.project.id}${r.nested ? '*' : ''}`)).toEqual(['a', 's', 'p1*', 'p2*', 'p3*', 'b']);
  });

  it('lets a part whose series was deleted stand on its own', () => {
    const orphan = p('p1', { role: 'part', parentId: 'gone', index: 1, count: 2, seriesName: 'S', recapEndMs: 0 } as Project['series']);
    expect(groupSeries([orphan, p('a')])).toEqual([
      { project: orphan, nested: false },
      { project: expect.objectContaining({ id: 'a' }), nested: false },
    ]);
  });
});

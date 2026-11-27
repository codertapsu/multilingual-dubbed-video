import { describe, expect, it } from 'vitest';

import { linkedPage, partRanges, pickParts } from './part-pick';

const pages = [1, 2, 3, 4, 5, 6, 7, 8];

describe('linkedPage', () => {
  it('is the part the link pointed at, else the first', () => {
    const parts = [{ page: 1 }, { page: 2 }, { page: 3 }];
    expect(linkedPage({ parts, requestedPage: 3 })).toBe(3);
    expect(linkedPage({ parts, requestedPage: 9 })).toBe(1);
    expect(linkedPage({ parts })).toBe(1);
    expect(linkedPage({ parts: [] })).toBe(1);
  });
});

describe('pickParts', () => {
  it('ticks and unticks one part', () => {
    expect([...pickParts(new Set([1]), pages, 4, true)].sort()).toEqual([1, 4]);
    expect([...pickParts(new Set([1, 4]), pages, 1, false)]).toEqual([4]);
  });

  it('with Shift, gives every part between the two clicks the same state, either way round', () => {
    expect([...pickParts(new Set([3]), pages, 7, true, 3)].sort()).toEqual([3, 4, 5, 6, 7]);
    expect([...pickParts(new Set([3]), pages, 1, true, 3)].sort()).toEqual([1, 2, 3]);
    expect([...pickParts(new Set(pages), pages, 6, false, 2)].sort()).toEqual([1, 7, 8]);
  });

  it('never ticks a part the video does not have', () => {
    expect([...pickParts(new Set(), [1, 2, 5], 5, true, 1)].sort()).toEqual([1, 2, 5]);
  });
});

describe('partRanges', () => {
  it('runs of parts in short, in order', () => {
    expect(partRanges([7, 1, 2, 3, 10, 11, 12])).toBe('P1–P3, P7, P10–P12');
    expect(partRanges([4])).toBe('P4');
    expect(partRanges([])).toBe('');
  });
});

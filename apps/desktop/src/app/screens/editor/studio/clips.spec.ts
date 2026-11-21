import { describe, expect, it } from 'vitest';

import { clipOf, clipsToVoice, unitIndex } from './clips';

// seg_2 and seg_3 were voiced as one take (unit seg_2); seg_1 alone.
const units = [
  { id: 'seg_1', segmentIds: ['seg_1'] },
  { id: 'seg_2', segmentIds: ['seg_2', 'seg_3'] },
];

describe('clips (what a re-voice asks the server for)', () => {
  const index = unitIndex(units);

  it('finds the clip of every member of a merged take', () => {
    expect(clipOf('seg_3', index)).toBe('seg_2');
    expect(clipOf('seg_2', index)).toBe('seg_2');
    expect(clipOf('seg_1', index)).toBe('seg_1');
  });

  it('falls back to the line itself before there are units', () => {
    expect(clipOf('seg_9', new Map())).toBe('seg_9');
  });

  it('asks for a merged take once, whichever of its lines are selected', () => {
    expect(clipsToVoice(['seg_3', 'seg_1', 'seg_2'], index, new Set())).toEqual(['seg_2', 'seg_1']);
  });

  it('skips a clip already being voiced: a second click must not queue it again', () => {
    // The merged take is busy: asking from its SECOND line finds it busy too.
    expect(clipsToVoice(['seg_3'], index, new Set(['seg_2']))).toEqual([]);
    expect(clipsToVoice(['seg_3', 'seg_1'], index, new Set(['seg_2']))).toEqual(['seg_1']);
  });

  it('stops at the limit', () => {
    expect(clipsToVoice(['seg_1', 'seg_2'], index, new Set(), 1)).toEqual(['seg_1']);
  });
});

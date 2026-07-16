import { describe, expect, it } from 'vitest';
import { planSynthesisGroups, singletonGroups, type GroupableSegmentInput } from './grouping.js';

function seg(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  speakerId?: string,
): GroupableSegmentInput {
  return { id, startMs, endMs, text, ...(speakerId ? { speakerId } : {}) };
}

describe('planSynthesisGroups', () => {
  it('merges adjacent cues within the gap into one utterance', () => {
    const groups = planSynthesisGroups([
      seg('seg_0001', 0, 1000, 'Hello'),
      seg('seg_0002', 1200, 2000, 'world'),
      seg('seg_0003', 2100, 3000, 'again'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe('seg_0001');
    expect(groups[0]!.segmentIds).toEqual(['seg_0001', 'seg_0002', 'seg_0003']);
    expect(groups[0]!.text).toBe('Hello world again');
    expect(groups[0]!.startMs).toBe(0);
    expect(groups[0]!.endMs).toBe(3000);
  });

  it('breaks the group at a real pause (gap > maxGapMs)', () => {
    const groups = planSynthesisGroups([
      seg('seg_0001', 0, 1000, 'One'),
      seg('seg_0002', 2000, 3000, 'Two'), // 1000 ms gap > 750 default
    ]);
    expect(groups.map((g) => g.segmentIds)).toEqual([['seg_0001'], ['seg_0002']]);
  });

  it('never merges across speaker changes', () => {
    const groups = planSynthesisGroups([
      seg('seg_0001', 0, 1000, 'Hi', 'SPEAKER_00'),
      seg('seg_0002', 1100, 2000, 'Hello', 'SPEAKER_01'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('does not merge overlapping cues (cross-talk)', () => {
    const groups = planSynthesisGroups([
      seg('seg_0001', 0, 1500, 'A'),
      seg('seg_0002', 1000, 2000, 'B'), // starts before the previous ends
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps empty-text cues as singletons', () => {
    const groups = planSynthesisGroups([
      seg('seg_0001', 0, 1000, 'A'),
      seg('seg_0002', 1100, 2000, '   '),
      seg('seg_0003', 2100, 3000, 'C'),
    ]);
    expect(groups.map((g) => g.segmentIds)).toEqual([['seg_0001'], ['seg_0002'], ['seg_0003']]);
  });

  it('caps the group size (maxSegments)', () => {
    const segs = Array.from({ length: 6 }, (_, i) =>
      seg(`seg_000${i + 1}`, i * 1000, i * 1000 + 900, `t${i}`),
    );
    const groups = planSynthesisGroups(segs, { maxSegments: 4 });
    expect(groups.map((g) => g.segmentIds.length)).toEqual([4, 2]);
  });

  it('caps the joined text length (maxChars)', () => {
    const groups = planSynthesisGroups(
      [seg('seg_0001', 0, 1000, 'x'.repeat(60)), seg('seg_0002', 1100, 2000, 'y'.repeat(60))],
      { maxChars: 100 },
    );
    expect(groups).toHaveLength(2);
  });

  it('caps the merged window (maxWindowMs)', () => {
    const groups = planSynthesisGroups(
      [seg('seg_0001', 0, 9000, 'long line'), seg('seg_0002', 9200, 12_000, 'tail')],
      { maxWindowMs: 10_000 },
    );
    expect(groups).toHaveLength(2);
  });

  it('enabled:false yields one singleton per segment (legacy behavior)', () => {
    const segs = [seg('seg_0001', 0, 1000, 'A'), seg('seg_0002', 1000, 2000, 'B')];
    expect(planSynthesisGroups(segs, { enabled: false })).toHaveLength(2);
    expect(singletonGroups(segs)).toHaveLength(2);
  });
});

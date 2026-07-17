import { describe, expect, it } from 'vitest';
import {
  estimateGroupDriftMs,
  planSynthesisGroups,
  singletonGroups,
  type GroupableSegmentInput,
  type SynthesisGroup,
} from './grouping.js';

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

describe('estimateGroupDriftMs (voice-vs-subtitle sync inside a group)', () => {
  const group: SynthesisGroup = {
    id: 'seg_0001',
    segmentIds: ['seg_0001', 'seg_0002'],
    text: 'một hai ba bốn năm sáu',
    startMs: 0,
    endMs: 6000,
  };
  const members = [
    { id: 'seg_0001', startMs: 0, text: 'một hai ba' },
    { id: 'seg_0002', startMs: 5000, text: 'bốn năm sáu' },
  ];

  it('measures how far mid-group cues lead/lag their subtitles', () => {
    // 3s of speech over a 6s window: member 2's words start at 1.5s but its
    // subtitle shows at 5s -> voice leads by 3.5s.
    expect(estimateGroupDriftMs(group, members, 3000)).toBe(3500);
    // Speech that matches the original spacing drifts little.
    expect(estimateGroupDriftMs(group, members, 6000)).toBeLessThanOrEqual(2000);
  });

  it('weights members by token count and falls back to chars for unsegmented text', () => {
    const zhMembers = [
      { id: 'seg_0001', startMs: 0, text: '你好' },
      { id: 'seg_0002', startMs: 1000, text: '再见了朋友们' },
    ];
    const zhGroup: SynthesisGroup = { ...group, segmentIds: ['seg_0001', 'seg_0002'], startMs: 0, endMs: 2000 };
    // char weights 2:6 -> member 2 voice start at 0.25 * placed.
    expect(estimateGroupDriftMs(zhGroup, zhMembers, 2000)).toBe(500);
  });

  it('returns 0 for singletons and degenerate durations', () => {
    const single: SynthesisGroup = { id: 'a', segmentIds: ['a'], text: 'x', startMs: 0, endMs: 1000 };
    expect(estimateGroupDriftMs(single, [{ id: 'a', startMs: 0, text: 'x' }], 900)).toBe(0);
    expect(estimateGroupDriftMs(group, members, 0)).toBe(0);
  });
});

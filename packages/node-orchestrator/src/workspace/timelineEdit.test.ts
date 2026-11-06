import { describe, expect, it } from 'vitest';
import { AppErrorException, type TranscriptSegment } from '@videodubber/shared';
import { makeSegments } from '../test/fixtures.js';
import {
  alignmentInputsForUnits,
  applySegmentPatches,
  MIN_SEGMENT_MS,
  reconcileGroups,
  singletonUnits,
} from './timelineEdit.js';
import type { SynthesisGroup } from '../pipeline/grouping.js';

function translated(windows: [number, number, string][]): TranscriptSegment[] {
  return makeSegments(windows).map((s) => ({ ...s, translatedText: `vi:${s.sourceText}` }));
}

function expectInvalid(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppErrorException);
    expect((err as AppErrorException).code).toBe('INVALID_EDIT');
    expect((err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected INVALID_EDIT');
}

describe('applySegmentPatches', () => {
  const base = translated([
    [0, 1000, 'a'],
    [1500, 2500, 'b'],
    [3000, 4000, 'c'],
  ]);

  it('moves a line within its neighbours and reports a timing change only', () => {
    const out = applySegmentPatches(base, [{ id: 'seg_0002', startMs: 1200, endMs: 2200 }]);
    expect(out.segments[1]).toMatchObject({ startMs: 1200, endMs: 2200 });
    expect([...out.timingChanged]).toEqual(['seg_0002']);
    // Moving a clip does not change its audio: not stale, not locked.
    expect(out.segments[1]!.ttsStale).toBeUndefined();
    expect(out.segments[1]!.locked).toBeUndefined();
    // The input is never mutated.
    expect(base[1]).toMatchObject({ startMs: 1500, endMs: 2500 });
  });

  it('locks a line whose text really changed and marks its clip stale', () => {
    const out = applySegmentPatches(base, [{ id: 'seg_0001', translatedText: 'mới' }]);
    expect(out.segments[0]).toMatchObject({ translatedText: 'mới', locked: true, ttsStale: true });
    expect([...out.textChanged]).toEqual(['seg_0001']);
  });

  it('does not lock a line sent with its unchanged text', () => {
    const out = applySegmentPatches(base, [{ id: 'seg_0001', translatedText: 'vi:a' }]);
    expect(out.textChanged.size).toBe(0);
    expect(out.segments[0]!.locked).toBeUndefined();
  });

  it('honours an explicit unlock even alongside a text change', () => {
    const out = applySegmentPatches(base, [{ id: 'seg_0001', translatedText: 'x', locked: false }]);
    expect(out.segments[0]!.locked).toBeUndefined();
    expect(out.segments[0]!.ttsStale).toBe(true);
  });

  it('sets and clears a per-line voice', () => {
    const set = applySegmentPatches(base, [{ id: 'seg_0003', voiceId: 'vi_VN-vais1000-medium' }]);
    expect(set.segments[2]).toMatchObject({ voiceId: 'vi_VN-vais1000-medium', ttsStale: true });
    const cleared = applySegmentPatches(set.segments, [{ id: 'seg_0003', voiceId: null }]);
    expect(cleared.segments[2]!.voiceId).toBeUndefined();
    expect([...cleared.voiceChanged]).toEqual(['seg_0003']);
  });

  it('stores a 1× rate as "no override" so the line still groups with its neighbours', () => {
    const fast = applySegmentPatches(base, [{ id: 'seg_0002', speakingRate: 1.25 }]);
    expect(fast.segments[1]!.speakingRate).toBe(1.25);
    const natural = applySegmentPatches(fast.segments, [{ id: 'seg_0002', speakingRate: 1 }]);
    expect(natural.segments[1]!.speakingRate).toBeUndefined();
  });

  it('rejects a rate outside what the engines honour', () => {
    expectInvalid(() => applySegmentPatches(base, [{ id: 'seg_0001', speakingRate: 3 }]), /speaking rate/);
    expectInvalid(() => applySegmentPatches(base, [{ id: 'seg_0001', speakingRate: Number.NaN }]), /speaking rate/);
  });

  it('refuses to reorder lines (the WAV names and alignment windows assume this order)', () => {
    expectInvalid(
      () => applySegmentPatches(base, [{ id: 'seg_0003', startMs: 1000, endMs: 1400 }]),
      /cannot move before line seg_0002/,
    );
  });

  it('refuses to CREATE an overlap with a neighbour', () => {
    expectInvalid(() => applySegmentPatches(base, [{ id: 'seg_0001', endMs: 1600 }]), /would overlap line seg_0002/);
  });

  it('tolerates an overlap the recogniser already produced', () => {
    const overlapping = translated([
      [0, 1800, 'a'],
      [1500, 2500, 'b'],
    ]);
    const out = applySegmentPatches(overlapping, [{ id: 'seg_0002', endMs: 2600 }]);
    expect(out.segments[1]!.endMs).toBe(2600);
  });

  it('judges a multi-line drag on where the lines END, not one patch at a time', () => {
    // Shift all three lines right by 300 ms: seg_0001 alone would overlap seg_0002.
    const out = applySegmentPatches(base, [
      { id: 'seg_0001', startMs: 300, endMs: 1300 },
      { id: 'seg_0002', startMs: 1800, endMs: 2800 },
      { id: 'seg_0003', startMs: 3300, endMs: 4300 },
    ]);
    expect(out.segments.map((s) => s.startMs)).toEqual([300, 1800, 3300]);
  });

  it('enforces bounds: not before 0, not past the media, not shorter than the minimum', () => {
    expectInvalid(() => applySegmentPatches(base, [{ id: 'seg_0001', startMs: -10 }]), /before the video/);
    expectInvalid(
      () => applySegmentPatches(base, [{ id: 'seg_0003', endMs: 9000 }], { durationMs: 5000 }),
      /after the video/,
    );
    expectInvalid(
      () => applySegmentPatches(base, [{ id: 'seg_0002', startMs: 1500, endMs: 1500 + MIN_SEGMENT_MS - 1 }]),
      /at least/,
    );
  });

  it('rejects unknown and duplicated ids', () => {
    expectInvalid(() => applySegmentPatches(base, [{ id: 'seg_9999', startMs: 0 }]), /Unknown line/);
    expectInvalid(
      () => applySegmentPatches(base, [{ id: 'seg_0001', translatedText: 'x' }, { id: 'seg_0001', translatedText: 'y' }]),
      /twice/,
    );
  });

  it('rounds timings to whole milliseconds', () => {
    const out = applySegmentPatches(base, [{ id: 'seg_0002', startMs: 1600.6, endMs: 2400.4 }]);
    expect(out.segments[1]).toMatchObject({ startMs: 1601, endMs: 2400 });
  });
});

describe('reconcileGroups', () => {
  const segments = translated([
    [0, 1000, 'a'],
    [1200, 2000, 'b'],
    [5000, 6000, 'c'],
  ]);
  const groups: SynthesisGroup[] = [
    { id: 'seg_0001', segmentIds: ['seg_0001', 'seg_0002'], text: 'vi:a vi:b', startMs: 0, endMs: 2000 },
    { id: 'seg_0003', segmentIds: ['seg_0003'], text: 'vi:c', startMs: 5000, endMs: 6000 },
  ];

  it('places a group at its first member and ends it at its last', () => {
    const moved = segments.map((s) => (s.id === 'seg_0001' ? { ...s, startMs: 200 } : s.id === 'seg_0002' ? { ...s, endMs: 2300 } : s));
    const out = reconcileGroups(groups, moved);
    expect(out[0]).toMatchObject({ id: 'seg_0001', startMs: 200, endMs: 2300, text: 'vi:a vi:b' });
    expect(out[1]).toMatchObject({ startMs: 5000, endMs: 6000 });
  });

  it('drops members that no longer exist instead of crashing', () => {
    const out = reconcileGroups(groups, segments.filter((s) => s.id !== 'seg_0002'));
    expect(out[0]!.segmentIds).toEqual(['seg_0001']);
    expect(out[0]!.endMs).toBe(1000);
  });
});

describe('alignmentInputsForUnits', () => {
  it('re-places existing clips with their known durations, overriding re-synthesized ones', () => {
    const units = singletonUnits(translated([[0, 1000, 'a'], [2000, 3000, 'b']]));
    const previous = new Map([
      ['seg_0001', { audioPath: '/a.wav', generatedDurationMs: 900 }],
      ['seg_0002', { audioPath: '/b.wav', generatedDurationMs: 1500 }],
    ]);
    const inputs = alignmentInputsForUnits(units, previous, (id) => `/fallback/${id}.wav`, new Map([['seg_0002', 800]]));
    expect(inputs).toEqual([
      { segmentId: 'seg_0001', startMs: 0, endMs: 1000, audioPath: '/a.wav', generatedDurationMs: 900 },
      { segmentId: 'seg_0002', startMs: 2000, endMs: 3000, audioPath: '/b.wav', generatedDurationMs: 800 },
    ]);
  });

  it('keeps a never-synthesized unit in the list (as empty) so neighbours stay gap-aware', () => {
    const units = singletonUnits(translated([[0, 1000, 'a']]));
    const [input] = alignmentInputsForUnits(units, new Map(), (id) => `/fallback/${id}.wav`);
    expect(input).toMatchObject({ audioPath: '/fallback/seg_0001.wav', generatedDurationMs: 0 });
  });
});

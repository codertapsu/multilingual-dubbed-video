import { describe, expect, it } from 'vitest';
import type { AlignedSegment, TranscriptSegment } from '@videodubber/shared';

import type { SynthesisGroup } from '../pipeline/grouping.js';
import { lineInWindow, setSongFlags, songMixPlan, songTargets, songUnits, songWindows, windowsInPart } from './songLines.js';

const line = (n: number, startMs: number, endMs: number, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: `seg_${String(n).padStart(4, '0')}`,
  index: n - 1,
  startMs,
  endMs,
  sourceText: `line ${n}`,
  translatedText: `dòng ${n}`,
  ...extra,
});
const group = (ids: number[], lines: readonly TranscriptSegment[], extra: Partial<SynthesisGroup> = {}): SynthesisGroup => {
  const members = ids.map((n) => lines[n - 1]!);
  return {
    id: members[0]!.id,
    segmentIds: members.map((m) => m.id),
    text: members.map((m) => m.translatedText).join(' '),
    startMs: members[0]!.startMs,
    endMs: members[members.length - 1]!.endMs,
    ...extra,
  };
};

describe('which lines a mark names', () => {
  const lines = [line(1, 0, 1000), line(2, 1000, 3000), line(3, 3000, 4000)];

  it('by id, refusing an unknown one', () => {
    expect(songTargets(lines, { song: true, lineIds: ['seg_0003', 'seg_0001'] }).map((l) => l.id)).toEqual(['seg_0001', 'seg_0003']);
    expect(() => songTargets(lines, { song: true, lineIds: ['seg_0009'] })).toThrow(/Unknown line/);
  });

  it('by a range: the lines at least half inside it', () => {
    expect(songTargets(lines, { song: true, fromMs: 900, toMs: 2100 }).map((l) => l.id)).toEqual(['seg_0002']);
    expect(songTargets(lines, { song: true, fromMs: 0, toMs: 2000 }).map((l) => l.id)).toEqual(['seg_0001', 'seg_0002']);
    expect(() => songTargets(lines, { song: true, fromMs: 2000, toMs: 1000 })).toThrow(/must end after it starts/);
    expect(() => songTargets(lines, { song: true })).toThrow(/Name the lines/);
    // A part with none of the parent's windows in it: nothing to do, not an error.
    expect(songTargets(lines, { song: true, windows: [] })).toEqual([]);
    expect(lineInWindow({ startMs: 0, endMs: 1000 }, { startMs: 500, endMs: 2000 })).toBe(true);
    expect(lineInWindow({ startMs: 0, endMs: 1000 }, { startMs: 501, endMs: 2000 })).toBe(false);
  });
});

describe('setting the flag', () => {
  it('a song line has no voice to be out of date; a line that sings no more needs one once there are voices', () => {
    const lines = [line(1, 0, 1000, { ttsStale: true }), line(2, 1000, 2000, { song: true })];
    const marked = setSongFlags(lines, new Set(['seg_0001', 'seg_0002']), true, true);
    expect(marked.changed).toEqual(['seg_0001']);
    expect(marked.lines[0]).toMatchObject({ song: true });
    expect(marked.lines[0]!.ttsStale).toBeUndefined();
    const unmarked = setSongFlags(marked.lines, new Set(['seg_0002']), false, true);
    expect(unmarked.lines[1]).toMatchObject({ ttsStale: true });
    expect(unmarked.lines[1]!.song).toBeUndefined();
    // Before any voice exists there is nothing to re-voice.
    expect(setSongFlags(marked.lines, new Set(['seg_0002']), false, false).lines[1]!.ttsStale).toBeUndefined();
  });
});

describe('the synthesis units around song lines', () => {
  it('drops a unit of songs only, cuts a mixed one into runs of its spoken lines (re-voiced), and gives a line that sings no more its own', () => {
    const lines = [
      line(1, 0, 1000),
      line(2, 1000, 2000, { song: true }),
      line(3, 2000, 3000),
      line(4, 3000, 4000),
      line(5, 5000, 6000, { song: true }),
      line(6, 6000, 7000, { song: true }),
      line(7, 8000, 9000),
    ];
    const groups = [group([1, 2, 3, 4], lines, { speakerId: 'SPEAKER_01', voiceId: 'v' }), group([5, 6], lines)];
    const fixed = songUnits(groups, lines);
    expect(fixed.changed).toBe(true);
    expect(fixed.groups.map((g) => [g.id, g.segmentIds, g.text, g.startMs, g.endMs])).toEqual([
      ['seg_0001', ['seg_0001'], 'dòng 1', 0, 1000],
      ['seg_0003', ['seg_0003', 'seg_0004'], 'dòng 3 dòng 4', 2000, 4000],
      // seg_0007 was in no unit (it sang before): a unit of its own.
      ['seg_0007', ['seg_0007'], 'dòng 7', 8000, 9000],
    ]);
    expect(fixed.groups[1]).toMatchObject({ speakerId: 'SPEAKER_01', voiceId: 'v' });
    expect(fixed.revoice).toEqual(['seg_0001', 'seg_0003', 'seg_0004', 'seg_0007']);
    expect(fixed.touched.sort()).toEqual(['seg_0001', 'seg_0002', 'seg_0003', 'seg_0004', 'seg_0005', 'seg_0006', 'seg_0007']);
    // Nothing to do: the plan comes back as it is.
    const clean = songUnits(fixed.groups, lines);
    expect(clean.changed).toBe(false);
    expect(clean.groups).toEqual(fixed.groups);
  });
});

describe('where the original plays', () => {
  it('one window per passage of song lines; a spoken line between them splits it', () => {
    const lines = [
      line(1, 0, 1000, { song: true }),
      line(2, 2000, 3000, { song: true }),
      line(3, 3500, 4000),
      line(4, 4500, 5000, { song: true }),
      line(5, 30_000, 31_000, { song: true }),
    ];
    expect(songWindows(lines)).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 4500, endMs: 5000 },
      { startMs: 30_000, endMs: 31_000 },
    ]);
    expect(songWindows([line(1, 0, 1000)])).toEqual([]);
  });

  it('moves a series parent\'s windows into a part\'s time', () => {
    expect(
      windowsInPart(
        [
          { startMs: 1000, endMs: 2000 },
          { startMs: 9000, endMs: 12_000 },
          { startMs: 20_000, endMs: 21_000 },
        ],
        { startMs: 10_000, endMs: 19_000 },
      ),
    ).toEqual([{ startMs: 0, endMs: 2000 }]);
  });

  it('plays no clip of song lines, and a clip not made yet only when its lines all wait for a voice', async () => {
    const lines = [line(1, 0, 1000), line(2, 1000, 2000, { song: true }), line(3, 3000, 4000, { ttsStale: true }), line(4, 5000, 6000)];
    const aligned = (id: string, audioPath: string): AlignedSegment => ({
      segmentId: id,
      startMs: 0,
      endMs: 1,
      audioPath,
      generatedDurationMs: 1,
      placedDurationMs: 1,
      speedRatio: 1,
      overflowMs: 0,
      status: 'ok',
    });
    const plan = await songMixPlan(
      [aligned('seg_0001', 'a.wav'), aligned('seg_0002', 'b.wav'), aligned('seg_0003', 'missing.wav'), aligned('seg_0004', 'gone.wav')],
      undefined,
      lines,
      async (file) => file === 'a.wav' || file === 'b.wav',
    );
    expect(plan.aligned.map((a) => a.segmentId)).toEqual(['seg_0001', 'seg_0004']); // seg_0004's missing clip still fails the mix, loudly
    expect(plan.dropped).toEqual(['seg_0002']);
    expect(plan.waiting).toEqual(['seg_0003']);
    expect(plan.keepOriginal).toEqual([{ startMs: 1000, endMs: 2000 }]);
  });
});

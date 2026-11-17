import { describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';
import { displayCuesFor } from './subtitleTiming.js';

const seg = (n: number, startMs: number, endMs: number, translatedText: string): TranscriptSegment => ({
  id: `seg_${String(n).padStart(4, '0')}`,
  index: n - 1,
  startMs,
  endMs,
  sourceText: `src ${n}`,
  translatedText,
});

describe('displayCuesFor', () => {
  const lines = [
    seg(1, 1000, 2500, 'Ngươi là ai mà dám tới đây?'),
    seg(2, 2600, 4000, 'Ta là người của Thanh Khâu.'),
    seg(3, 9000, 10_000, 'Đi thôi.'),
  ];

  it('without a dub: cues planned for reading only', () => {
    const cues = displayCuesFor(lines);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 2600], // 27 columns need 1.589 s: held to 2.589 s, then the 11 ms flicker gap closes
      [2600, 4189], // held into the long pause after it
      [9000, 10_000],
    ]);
  });

  it("holds a unit's LAST line until its voice ends, and applies voice-sync overrides", () => {
    const cues = displayCuesFor(lines, {
      groups: [
        { id: 'seg_0001', segmentIds: ['seg_0001', 'seg_0002'] },
        { id: 'seg_0003', segmentIds: ['seg_0003'] },
      ],
      // The merged clip starts at 1.0 s and plays 4.8 s: the voice ends at 5.8 s.
      units: [
        { segmentId: 'seg_0001', startMs: 1000, placedDurationMs: 4800 },
        { segmentId: 'seg_0003', startMs: 9000, placedDurationMs: 700 },
      ],
      overrides: new Map([['seg_0002', { startMs: 3100, endMs: 4200 }]]),
    });
    expect(cues.map((c) => [c.startMs, c.endMs, c.text])).toEqual([
      [1000, 2589, 'Ngươi là ai mà dám tới đây?'], // readable on its own: NOT merged
      [3100, 5800, 'Ta là người của Thanh Khâu.'], // voice-synced start, held to the voice end
      [9000, 10_000, 'Đi thôi.'],
    ]);
  });
});

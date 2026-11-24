/**
 * The 0.18.0 series helpers, pure: file boundaries as cuts (5.1), numbering
 * after a continued series (5.2), titles kept by a replan (2.3), what a part
 * changed after its dub must do again (2.2, 2.4), voices matched by print.
 */
import { createInitialPipelineState, setStepStatus, type PipelineState, type SeriesPlanPart } from '@videodubber/shared';
import { describe, expect, it } from 'vitest';

import { continuedVoices, matchSpeakersByVoice } from './seriesContinue.js';
import { partList, partNumbering, seriesNameOf } from './seriesNumbering.js';
import {
  BOUNDARY_BONUS,
  candidateCuts,
  cutWindows,
  fallbackCut,
  fileBoundaries,
  keepEditedTitles,
  markEdited,
  partEffects,
  partsFromCuts,
} from './seriesPlanner.js';
import { redoFrom, stepDone } from './seriesRedo.js';

const MIN = 60_000;

/** A line every 5 s lasting 4 s. */
function speech(fromMs: number, toMs: number): { startMs: number; endMs: number; sourceText: string }[] {
  const out = [];
  for (let t = fromMs; t + 4000 <= toMs; t += 5000) out.push({ startMs: t, endMs: t + 4000, sourceText: `line ${t}` });
  return out;
}

describe('a joined project: where its files meet is a preferred cut', () => {
  it('cuts exactly at the boundary inside a pause, above every other pause', () => {
    // Two files joined at 30:00.0: the first one's talk ends at 28:54, the second's starts at 30:03.
    const lines = [...speech(0, 29 * MIN + 58_000), ...speech(30 * MIN + 3000, 60 * MIN)];
    const candidates = candidateCuts(lines, { boundaries: [30 * MIN] });
    const atJoin = candidates.find((c) => c.boundary);
    // A pause of a minute scores like any long one (6), plus the boundary.
    expect(atJoin).toEqual({ ms: 30 * MIN, score: 6 + BOUNDARY_BONUS, boundary: true });
    // The fallback near an even split takes it, even off its target.
    const [w] = cutWindows(60 * MIN, 2, { minMinutes: 25, maxMinutes: 35 }, candidates);
    expect(fallbackCut({ ...w!, targetMs: 29 * MIN })).toBe(30 * MIN);
  });

  it('offers a boundary in no pause as a cut of its own, never inside a line', () => {
    const lines = [
      { startMs: 0, endMs: 10_000, sourceText: 'a' },
      { startMs: 10_200, endMs: 20_000, sourceText: 'b' }, // a breath at 10.0–10.2 s
      { startMs: 30_000, endMs: 40_000, sourceText: 'c' },
    ];
    const cuts = candidateCuts(lines, { boundaries: [10_100, 35_000, 50_000] });
    expect(cuts.filter((c) => c.boundary).map((c) => c.ms)).toEqual([10_100, 50_000]);
    expect(cuts.map((c) => c.ms)).toEqual([...cuts.map((c) => c.ms)].sort((a, b) => a - b));
    // Without boundaries nothing changes (no field added).
    expect(candidateCuts(lines).some((c) => 'boundary' in c)).toBe(false);
  });

  it('reads the boundaries from the files, inside the video only', () => {
    const files = [
      { startMs: 0, durationMs: 5 * MIN },
      { startMs: 5 * MIN, durationMs: 5 * MIN },
      { startMs: 10 * MIN, durationMs: 5 * MIN },
    ];
    expect(fileBoundaries(files, 15 * MIN)).toEqual([5 * MIN, 10 * MIN]);
    expect(fileBoundaries(undefined, 15 * MIN)).toEqual([]);
  });
});

describe('numbering after a continued series', () => {
  it('numbers the parts after the offset, out of a total never below what there is', () => {
    expect(partNumbering({}, 12)).toEqual({ offset: 0, total: 12 });
    expect(partNumbering({ partNumberOffset: 48 }, 12)).toEqual({ offset: 48, total: 60 });
    expect(partNumbering({ partNumberOffset: 48, totalParts: 70 }, 12)).toEqual({ offset: 48, total: 70 });
    expect(partNumbering({ partNumberOffset: 48, totalParts: 50 }, 12)).toEqual({ offset: 48, total: 60 });
    const parts = partsFromCuts(30 * MIN, [{ ms: 15 * MIN, by: 'pause' }], 4, speech(0, 30 * MIN), [], 48);
    expect(parts.map((p) => p.index)).toEqual([49, 50]);
    expect(parts[0]!.recapStartMs).toBe(0);
    expect(partList([24, 23, 1, 5, 6, 7])).toBe('1, 5–7, 23–24');
    expect(seriesNameOf({ name: 'Mùa 12', series: { settings: { seriesName: 'Xuyên Không' } as never } })).toBe('Xuyên Không');
  });

  it('draws the continued numbers on the cards, and no plain title there', () => {
    const fx = partEffects({ index: 49, count: 60, seriesName: 'X', title: 'Phần 49', recapEndMs: 0, durationMs: 60_000, targetLanguage: 'vi' });
    expect(fx.cards![0]!.text).toBe('X\nPhần 49/60');
    expect(fx.cards!.at(-1)!.text).toBe('Còn tiếp · Phần 50');
    const titled = partEffects({ index: 3, count: 3, seriesName: 'X', title: 'Kết', recapEndMs: 0, durationMs: 60_000, targetLanguage: 'vi' });
    expect(titled.cards![0]!.text).toBe('X\nPhần 3/3: Kết');
  });
});

describe('titles the user wrote in review', () => {
  const part = (index: number, startMs: number, endMs: number, title: string, summary = ''): SeriesPlanPart => ({
    index,
    startMs,
    endMs,
    recapStartMs: startMs,
    title,
    summary,
    cutBy: index === 1 ? 'start' : 'ai',
  });

  it('are marked when they differ from the plan, and stay marked while kept', () => {
    const before = [part(1, 0, 20 * MIN, 'AI một'), part(2, 20 * MIN, 40 * MIN, 'AI hai')];
    const next = [part(1, 0, 20 * MIN, 'AI một'), part(2, 20 * MIN, 40 * MIN, 'Của tôi', 'Tóm tắt')];
    markEdited(next, before);
    expect(next[0]!.edited).toBeUndefined();
    expect(next[1]!.edited).toEqual({ title: true, summary: true });
    const again = [part(1, 0, 20 * MIN, 'AI một'), part(2, 20 * MIN, 40 * MIN, 'Của tôi', 'Tóm tắt')];
    markEdited(again, next);
    expect(again[1]!.edited).toEqual({ title: true, summary: true });
  });

  it('go to the new part over the same stretch of video when the plan is made again', () => {
    const before = [
      { ...part(1, 0, 20 * MIN, 'Mở đầu'), edited: { title: true } },
      part(2, 20 * MIN, 40 * MIN, 'AI hai'),
      { ...part(3, 40 * MIN, 60 * MIN, 'Kết', 'Tóm tắt của tôi'), edited: { summary: true } },
    ];
    const replanned = [part(1, 0, 21 * MIN, 'AI A'), part(2, 21 * MIN, 39 * MIN, 'AI B'), part(3, 39 * MIN, 60 * MIN, 'AI C', 'AI tóm tắt')];
    expect(keepEditedTitles(replanned, before)).toBe(2);
    expect(replanned.map((p) => p.title)).toEqual(['Mở đầu', 'AI B', 'AI C']);
    expect(replanned[2]!.summary).toBe('Tóm tắt của tôi');
    // Parts that no longer cover the same stretch keep the AI's.
    const other = [part(1, 0, 45 * MIN, 'AI X'), part(2, 45 * MIN, 60 * MIN, 'AI Y')];
    expect(keepEditedTitles(other, [{ ...part(1, 0, 20 * MIN, 'Mở đầu'), edited: { title: true } }])).toBe(0);
  });
});

describe('what a part changed after its dub must do again', () => {
  const done = (): PipelineState => {
    let s = createInitialPipelineState('p1', '2026-11-23T00:00:00Z');
    for (const step of s.steps) s = setStepStatus(s, step.id, step.id === 'stt' ? 'skipped' : 'completed');
    return s;
  };

  it('pauses at the step, so the next run does it and everything after it again', () => {
    const s = redoFrom(done(), 'render', '2026-11-23T01:00:00Z');
    expect(s).toMatchObject({ status: 'paused', pausedStep: 'render', pausedAt: '2026-11-23T01:00:00Z' });
    expect(s.steps.find((x) => x.id === 'audio-mix')!.status).toBe('completed');
    expect(s.steps.find((x) => x.id === 'render')!.status).toBe('pending');
    const t = redoFrom(done(), 'translation');
    expect(t.pausedStep).toBe('translation');
    expect(t.steps.filter((x) => x.status === 'pending').map((x) => x.id)).toEqual([
      'translation',
      'refine',
      'tts',
      'alignment',
      'audio-mix',
      'render',
    ]);
    expect(stepDone(done(), 'render')).toBe(true);
    expect(stepDone(t, 'render')).toBe(false);
  });

  it('leaves a pipeline alone when nothing from the step on was done', () => {
    const fresh = createInitialPipelineState('p1');
    expect(redoFrom(fresh, 'translation')).toBe(fresh);
  });
});

describe('voices for a series that continues another', () => {
  const print = (...v: number[]): number[] => v;

  it('matches speakers by voice print, one to one, most alike first', () => {
    const theirs = [
      { speakerId: 'SPEAKER_00', print: print(1, 0, 0) },
      { speakerId: 'SPEAKER_01', print: print(0, 1, 0) },
      { speakerId: 'SPEAKER_02', print: print(0.7, 0.7, 0) },
    ];
    const ours = [
      { speakerId: 'SPEAKER_00', print: print(0, 0.98, 0.2) }, // their 01
      { speakerId: 'SPEAKER_01', print: print(0.99, 0.1, 0) }, // their 00 (closer than 02)
      { speakerId: 'SPEAKER_02', print: print(0, 0, 1) }, // no one
    ];
    const m = matchSpeakersByVoice(theirs, ours);
    expect(m.map((x) => [x.ours, x.theirs])).toEqual([
      ['SPEAKER_00', 'SPEAKER_01'],
      ['SPEAKER_01', 'SPEAKER_00'],
    ]);
    expect(m.every((x) => x.similarity >= 0.7)).toBe(true);
  });

  it('gives a matched speaker its match\'s voice, never over a voice of its own', () => {
    const { table, given } = continuedVoices(
      [{ speakerId: 'SPEAKER_01', voiceId: 'mine' }],
      [
        { ours: 'SPEAKER_00', theirs: 'SPEAKER_03', similarity: 0.9 },
        { ours: 'SPEAKER_01', theirs: 'SPEAKER_04', similarity: 0.85 },
        { ours: 'SPEAKER_02', theirs: 'SPEAKER_09', similarity: 0.8 }, // their speaker had no voice
      ],
      [
        { speakerId: 'SPEAKER_03', voiceId: 'clone-a' },
        { speakerId: 'SPEAKER_04', voiceId: 'clone-b' },
      ],
    );
    expect(table).toEqual([
      { speakerId: 'SPEAKER_00', voiceId: 'clone-a' },
      { speakerId: 'SPEAKER_01', voiceId: 'mine' },
    ]);
    expect(given.map((g) => g.ours)).toEqual(['SPEAKER_00']);
  });
});

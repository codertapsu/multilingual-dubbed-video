import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptSegment } from '@videodubber/shared';

import type { ChunkSpeaker, DiarizationChunk, DiarizationPart, DiarizationService } from '../providers/diarization/sherpaDiarizationProvider.js';
import {
  labelRange,
  linkPartsToSpeakers,
  pitchGender,
  readDiarizationCache,
  redetectSpeakersInRange,
  spliceTurns,
  windowsForRange,
  type CachedSpeaker,
  type DiarizationCache,
} from './diarization.js';

const MIN = 60_000;

const known = (speaker: number, print: number[], speakerId?: string, extra: Partial<CachedSpeaker> = {}): CachedSpeaker => ({
  speaker,
  sec: 600,
  f0Hz: 120,
  gender: 'male',
  genderConfidence: 0.9,
  print,
  ...(speakerId ? { speakerId } : {}),
  ...extra,
});

const local = (n: number, print: number[], sec = 30, printSec = 20, f0Hz: number | null = 200): ChunkSpeaker => ({
  local: n,
  sec,
  printSec,
  print,
  f0Hz,
  lowShare: f0Hz === null ? null : 0.05,
});

function lines(spec: [number, number, string?][]): TranscriptSegment[] {
  return spec.map(([startMs, endMs, speakerId], i) => ({
    id: `seg_${String(i + 1).padStart(4, '0')}`,
    index: i,
    startMs,
    endMs,
    sourceText: `line ${i + 1}`,
    ...(speakerId ? { speakerId } : {}),
  }));
}

describe('linking the parts of a ranged detection to the known speakers', () => {
  const k0 = known(0, [1, 0, 0], 'SPEAKER_00');
  const k1 = known(1, [0, 1, 0], 'SPEAKER_01', { gender: 'female' });

  it('gives each part speaker the most alike known one, and someone new where none is alike', () => {
    const linked = linkPartsToSpeakers([k0, k1], [
      { speakers: [local(0, [0.99, 0.1, 0]), local(1, [0, 0, 1], 25, 12, 230)] },
      { speakers: [local(0, [0.05, 0.99, 0]), local(1, [0.02, 0, 0.99], 10, 8, 240)] },
    ]);
    expect(linked.speakerOf.get('0:0')).toBe(0);
    expect(linked.speakerOf.get('1:0')).toBe(1);
    // The voice nobody knew, heard in both parts: one new speaker, numbered after the known ones.
    expect(linked.speakerOf.get('0:1')).toBe(2);
    expect(linked.speakerOf.get('1:1')).toBe(2);
    expect(linked.added).toHaveLength(1);
    expect(linked.added[0]).toMatchObject({ speaker: 2, sec: 35, gender: 'female', genderConfidence: 0.3 });
    expect(Math.hypot(...linked.added[0]!.print)).toBeCloseTo(1);
  });

  it("keeps two voices a part's diarizer kept apart as two people", () => {
    // Both like SPEAKER_00 (0.8), unlike each other (0.28), both talk 15 s or more.
    const linked = linkPartsToSpeakers([k0], [{ speakers: [local(0, [0.8, 0.6, 0]), local(1, [0.8, -0.6, 0])] }]);
    expect(linked.speakerOf.get('0:0')).toBe(0);
    expect(linked.speakerOf.get('0:1')).toBe(1);
    // Alike enough (one voice the diarizer split), they may share it.
    const same = linkPartsToSpeakers([k0], [{ speakers: [local(0, [0.95, 0.31, 0]), local(1, [0.95, 0.2, 0.24])] }]);
    expect([same.speakerOf.get('0:0'), same.speakerOf.get('0:1')]).toEqual([0, 0]);
  });

  it('lets a print from under 3 s only join a known speaker it is close to', () => {
    const linked = linkPartsToSpeakers([k0, k1], [{ speakers: [local(0, [0.6, 0.8, 0], 2, 2), local(1, [0, 0, 1], 2, 2), local(2, [], 1, 0)] }]);
    expect(linked.speakerOf.get('0:0')).toBe(1);
    expect(linked.speakerOf.has('0:1')).toBe(false);
    expect(linked.speakerOf.has('0:2')).toBe(false);
    expect(linked.added).toEqual([]);
  });

  it('past the known number of speakers, gives a new voice to the most alike one', () => {
    const linked = linkPartsToSpeakers([k0, k1], [{ speakers: [local(0, [0.3, 0.1, 0.95])] }], { maxSpeakers: 2 });
    expect(linked.speakerOf.get('0:0')).toBe(0);
    expect(linked.added).toEqual([]);
  });

  it('guesses a gender from pitch alone as the engine does', () => {
    expect(pitchGender(120, 0.9)).toBe('male');
    expect(pitchGender(175, 0.2)).toBe('female');
    expect(pitchGender(175, 0.7)).toBe('male');
    expect(pitchGender(230, 0.05)).toBe('female');
    expect(pitchGender(350, 0)).toBe('unknown');
    expect(pitchGender(null, null)).toBe('unknown');
  });
});

describe('the turns and lines of a range', () => {
  it('cuts the re-detected windows out of the known turns and puts the new ones in', () => {
    const turns = [
      { startMs: 0, endMs: 5000, speaker: 0 },
      { startMs: 8000, endMs: 14_000, speaker: 1 },
      { startMs: 30_000, endMs: 31_000, speaker: 0 },
    ];
    expect(spliceTurns(turns, [{ startMs: 10_000, endMs: 20_000 }], [{ startMs: 11_000, endMs: 19_000, speaker: 2 }])).toEqual([
      { startMs: 0, endMs: 5000, speaker: 0 },
      { startMs: 8000, endMs: 10_000, speaker: 1 },
      { startMs: 11_000, endMs: 19_000, speaker: 2 },
      { startMs: 30_000, endMs: 31_000, speaker: 0 },
    ]);
  });

  it('detects only the parts that touch the range (all of a short video)', () => {
    expect(windowsForRange(12 * MIN, 5 * MIN, 6 * MIN)).toEqual([{ index: 0, startMs: 0, endMs: 12 * MIN }]);
    expect(windowsForRange(65 * MIN, 25 * MIN, 41 * MIN).map((w) => w.index)).toEqual([2, 3, 4]);
  });

  it('labels only the lines in the range, with the project ids, and a new id for a new voice', () => {
    const segments = lines([
      [0, 1000, 'SPEAKER_00'],
      [10_000, 11_000],
      [12_000, 13_000],
      [14_000, 15_000, 'SPEAKER_05'],
      [30_000, 31_000, 'SPEAKER_01'],
    ]);
    const turns = [
      { startMs: 9_000, endMs: 11_500, speaker: 1 },
      { startMs: 11_500, endMs: 13_500, speaker: 7 },
      { startMs: 13_500, endMs: 15_500, speaker: 0 },
      { startMs: 29_000, endMs: 32_000, speaker: 0 },
    ];
    const out = labelRange(segments, 9_000, 16_000, turns, new Map([[0, 'SPEAKER_00'], [1, 'SPEAKER_01']]));
    expect(out.segments.map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_06', 'SPEAKER_00', 'SPEAKER_01']);
    expect(out.ids.get(7)).toBe('SPEAKER_06');
    expect(out).toMatchObject({ lines: 3, relabelled: 3, lowConfidence: 0 });
    // Outside the range: the very same objects.
    expect(out.segments[4]).toBe(segments[4]);
  });
});

describe('detecting the speakers of a range', () => {
  let tmp: string;
  let audio: string;
  let cachePath: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-rangedet-'));
    audio = path.join(tmp, 'original_16k_mono.wav');
    cachePath = path.join(tmp, 'diarization.json');
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  /** A WAV of `minutes` (only its size matters). */
  async function wav(minutes: number): Promise<{ sizeBytes: number; mtimeMs: number }> {
    await fsp.writeFile(audio, '');
    await fsp.truncate(audio, 44 + minutes * 60 * 32_000);
    const st = await fsp.stat(audio);
    return { sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
  }

  function service(parts?: (windows: readonly DiarizationChunk[]) => DiarizationPart[]): DiarizationService & { asked: DiarizationChunk[][]; whole: number } {
    const asked: DiarizationChunk[][] = [];
    const svc = {
      modelKey: 'm1',
      asked,
      whole: 0,
      available: async () => true,
      diarize: async () => {
        svc.whole += 1;
        return null;
      },
      ...(parts
        ? {
            diarizeWindows: async (_audio: string, windows: readonly DiarizationChunk[], opts: { onProgress?: (d: number, t: number) => void }) => {
              asked.push([...windows]);
              opts.onProgress?.(windows.length, windows.length);
              return parts(windows);
            },
          }
        : {}),
    };
    return svc;
  }

  async function writeCache(cache: Omit<DiarizationCache, 'format'>): Promise<void> {
    await fsp.writeFile(cachePath, JSON.stringify({ format: 2, ...cache }));
  }

  it('labels the range from the saved detection when it was made on this audio, detecting nothing', async () => {
    const stamp = await wav(1);
    await writeCache({
      audio: stamp,
      model: 'm1',
      turns: [
        { startMs: 0, endMs: 5000, speaker: 0 },
        { startMs: 5000, endMs: 9000, speaker: 1 },
      ],
      speakers: [known(0, [1, 0], 'SPEAKER_00'), known(1, [0, 1])],
    });
    const svc = service(() => []);
    const segments = lines([[0, 4000, 'SPEAKER_00'], [5500, 8000], [9000, 9500, 'SPEAKER_00']]);
    const out = (await redetectSpeakersInRange({ service: svc, audioPath: audio, cachePath, segments, fromMs: 5000, toMs: 8500 }))!;
    expect(svc.asked).toEqual([]);
    expect(svc.whole).toBe(0);
    expect(out.segments.map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    expect(out).toMatchObject({ lines: 1, relabelled: 1, detectedParts: 0 });
    expect(out.added.map((s) => s.speakerId)).toEqual(['SPEAKER_01']);
    // The new id is recorded for casting (get_speakers), the stamp kept.
    const cache = (await readDiarizationCache(cachePath))!;
    expect(cache.speakers.find((s) => s.speaker === 1)!.speakerId).toBe('SPEAKER_01');
    expect(cache.audio).toEqual(stamp);
  });

  it('detects only the parts over the range when the audio changed, linked to the known speakers', async () => {
    const old = { sizeBytes: 1, mtimeMs: 1 };
    await wav(35);
    await writeCache({
      audio: old,
      model: 'm1',
      numSpeakers: 3,
      turns: [
        { startMs: 0, endMs: 20 * MIN, speaker: 0 },
        { startMs: 20 * MIN, endMs: 35 * MIN, speaker: 1 },
      ],
      speakers: [known(0, [1, 0, 0], 'SPEAKER_00'), known(1, [0, 1, 0], 'SPEAKER_01')],
    });
    const svc = service((windows) =>
      windows.map((window) => ({
        window,
        turns: [
          { startMs: window.startMs + 1000, endMs: window.startMs + 4 * MIN, speaker: 0 },
          { startMs: window.startMs + 5 * MIN, endMs: window.startMs + 6 * MIN, speaker: 1 },
        ],
        speakers: [local(0, [0.02, 0.99, 0], 200, 40), local(1, [0, 0, 1], 60, 30, 120)],
      })),
    );
    const segments = lines([
      [60_000, 70_000, 'SPEAKER_00'],
      [20 * MIN + 2000, 20 * MIN + 9000],
      [25 * MIN + 30_000, 25 * MIN + 40_000],
      [32 * MIN, 32 * MIN + 5000, 'SPEAKER_01'],
    ]);
    const progress: [number, number][] = [];
    const out = (await redetectSpeakersInRange({
      service: svc,
      audioPath: audio,
      cachePath,
      segments,
      fromMs: 20 * MIN,
      toMs: 26 * MIN,
      onProgress: (d, t) => progress.push([d, t]),
    }))!;
    // 35 minutes are parts of 10: only the third touches 20:00-26:00.
    expect(svc.asked).toEqual([[{ index: 2, startMs: 20 * MIN, endMs: 30 * MIN }]]);
    expect(progress).toEqual([[1, 1]]);
    expect(out.segments.map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02', 'SPEAKER_01']);
    expect(out.added).toHaveLength(1);
    expect(out.added[0]).toMatchObject({ speakerId: 'SPEAKER_02', gender: 'male' });
    expect(out.detectedParts).toBe(1);
    const cache = (await readDiarizationCache(cachePath))!;
    // Only the range is known to be current: the old stamp stays, so a full detection still detects everything.
    expect(cache.audio).toEqual(old);
    expect(cache.turns).toEqual([
      { startMs: 0, endMs: 20 * MIN, speaker: 0 },
      { startMs: 20 * MIN + 1000, endMs: 24 * MIN, speaker: 1 },
      { startMs: 25 * MIN, endMs: 26 * MIN, speaker: 2 },
      { startMs: 30 * MIN, endMs: 35 * MIN, speaker: 1 },
    ]);
    expect(cache.speakers.map((s) => [s.speaker, s.speakerId])).toEqual([
      [0, 'SPEAKER_00'],
      [1, 'SPEAKER_01'],
      [2, 'SPEAKER_02'],
    ]);
  });

  it('refuses without a saved detection, or with one another model made on other audio', async () => {
    await wav(1);
    const svc = service(() => []);
    const input = { service: svc, audioPath: audio, cachePath, segments: lines([[0, 1000]]), fromMs: 0, toMs: 1000 };
    await expect(redetectSpeakersInRange(input)).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    await writeCache({ audio: { sizeBytes: 1, mtimeMs: 1 }, model: 'old-model', turns: [], speakers: [known(0, [1, 0], 'SPEAKER_00')] });
    await expect(redetectSpeakersInRange(input)).rejects.toMatchObject({ appError: { code: 'INVALID_EDIT' } });
    expect(svc.asked).toEqual([]);
  });
});

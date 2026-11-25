import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptSegment } from '@videodubber/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedVoice, DiarizationService, SpeakerTurn } from '../providers/diarization/sherpaDiarizationProvider.js';
import {
  assignSpeakers,
  cachedDiarization,
  cachedSpeakerTurns,
  copySpeakerLabels,
  detectLineSpeakers,
  labelSpeakers,
  readDiarizationCache,
  readSpeakerProfiles,
  redetectSpeakers,
  remapSpeakers,
  remapSpeakerVoices,
  speakerDetectionProgress,
} from './diarization.js';

const line = (startMs: number, endMs: number, speakerId?: string) => ({ startMs, endMs, ...(speakerId ? { speakerId } : {}) });

describe('labelSpeakers', () => {
  it('gives each line the speaker who says most of it, numbered by first line', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 5000, speaker: 3 },
      { startMs: 5000, endMs: 9000, speaker: 0 },
      { startMs: 9000, endMs: 12_000, speaker: 3 },
    ];
    const out = labelSpeakers([line(500, 4500), line(5200, 8800), line(8500, 11_500)], turns);
    expect(out.segments.map((l) => l.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    expect(out.segments.some((l) => 'speakerLowConfidence' in l)).toBe(false);
    expect(out.lowConfidence).toBe(0);
    expect([...out.idBySpeaker]).toEqual([
      [3, 'SPEAKER_00'],
      [0, 'SPEAKER_01'],
    ]);
  });

  it('gives a line that fails the strict rule its best guess, and marks it', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 2000, endMs: 3000, speaker: 0 },
      { startMs: 3000, endMs: 4000, speaker: 1 },
    ];
    // 1 s of a 4 s line: 25% covered, so only the largest overlap.
    expect(labelSpeakers([line(0, 4000)], turns.slice(0, 1)).segments[0]).toEqual({
      ...line(0, 4000),
      speakerId: 'SPEAKER_00',
      speakerLowConfidence: true,
    });
    // Half and half: the guess is the first-numbered of the two.
    expect(labelSpeakers([line(2000, 4000)], turns).segments[0]).toMatchObject({ speakerId: 'SPEAKER_00', speakerLowConfidence: true });
    // No turn over it, one 2.5 s away: that one.
    expect(labelSpeakers([line(6500, 7000)], turns).segments[0]).toMatchObject({ speakerId: 'SPEAKER_00', speakerLowConfidence: true });
    const far = labelSpeakers([line(500, 900), line(9000, 9500)], turns);
    // Nothing within 3 s: the nearest labelled line's speaker.
    expect(far.segments.map((l) => [l.speakerId, l.speakerLowConfidence])).toEqual([
      ['SPEAKER_00', undefined],
      ['SPEAKER_00', true],
    ]);
    expect(far.lowConfidence).toBe(1);
    // No turns at all: nobody's, as before (and an old speaker is not kept).
    expect(labelSpeakers([line(10_000, 11_000, 'SPEAKER_07')], []).segments[0]).toEqual(line(10_000, 11_000));
  });

  it('takes a neighbour only from lines the turns labelled, so a guess does not travel', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 30_000, endMs: 31_000, speaker: 1 },
    ];
    const out = labelSpeakers([line(0, 1000), line(12_000, 13_000), line(20_000, 21_000), line(30_000, 31_000)], turns);
    // The third line is 9 s from the last one and 19 s from the first: the last one's speaker,
    // although the second line (itself a guess) is nearer still, 7 s away.
    expect(out.segments.map((l) => l.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_00', 'SPEAKER_01', 'SPEAKER_01']);
    expect(out.segments.map((l) => l.speakerLowConfidence === true)).toEqual([false, true, true, false]);
    // Equally far from both: the line before.
    const tie = labelSpeakers([line(0, 1000), line(15_500, 15_500), line(30_000, 31_000)], turns);
    expect(tie.segments[1]!.speakerId).toBe('SPEAKER_00');
  });

  it('keeps numbers contiguous when the engine heard someone who says no line', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 300, speaker: 0 }, // a cough
      { startMs: 1000, endMs: 3000, speaker: 1 },
    ];
    const out = labelSpeakers([line(1000, 3000)], turns);
    expect(out.segments[0]!.speakerId).toBe('SPEAKER_00');
    expect(out.idBySpeaker.has(0)).toBe(false);
  });

  it('replaces an earlier speaker and its mark', () => {
    const turns: SpeakerTurn[] = [{ startMs: 0, endMs: 2000, speaker: 4 }];
    const stale = { ...line(0, 2000, 'SPEAKER_09'), speakerLowConfidence: true as const };
    expect(labelSpeakers([stale], turns).segments[0]).toEqual(line(0, 2000, 'SPEAKER_00'));
    expect(assignSpeakers([stale], turns)).toEqual([line(0, 2000, 'SPEAKER_00')]);
  });

  it('labels a 10-hour transcript quickly', () => {
    const turns: SpeakerTurn[] = [];
    for (let t = 0; t < 36_000_000; t += 1000) turns.push({ startMs: t, endMs: t + 950, speaker: (t / 1000) % 7 });
    const lines = Array.from({ length: 19_000 }, (_, i) => line(i * 1890, i * 1890 + 1500));
    const started = Date.now();
    const out = labelSpeakers(lines, turns);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.segments.every((l) => l.speakerId)).toBe(true);
  });
});

describe('copySpeakerLabels', () => {
  it('puts the labelled speakers on the lines with the same id, and nothing else', () => {
    const translated = [
      { id: 'a', startMs: 0, endMs: 1, voiceId: 'anna', speakerId: 'SPEAKER_04' },
      { id: 'b', startMs: 1, endMs: 2, speakerId: 'SPEAKER_04', speakerLowConfidence: true as const },
      { id: 'c', startMs: 2, endMs: 3, speakerId: 'SPEAKER_02' },
    ];
    const labelled = [
      { id: 'a', startMs: 0, endMs: 1, speakerId: 'SPEAKER_00', speakerLowConfidence: true as const },
      { id: 'b', startMs: 1, endMs: 2 },
    ];
    expect(copySpeakerLabels(translated, labelled)).toEqual([
      { id: 'a', startMs: 0, endMs: 1, voiceId: 'anna', speakerId: 'SPEAKER_00', speakerLowConfidence: true },
      { id: 'b', startMs: 1, endMs: 2 },
      { id: 'c', startMs: 2, endMs: 3, speakerId: 'SPEAKER_02' },
    ]);
  });
});

const voice = (speaker: number, print: number[], extra: Partial<DetectedVoice> = {}): DetectedVoice => ({
  speaker,
  sec: 60,
  f0Hz: 120,
  gender: 'male',
  genderConfidence: 0.9,
  print,
  ...extra,
});

const seg = (id: string, startMs: number, endMs: number, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  index: Number(id.slice(4)) - 1,
  startMs,
  endMs,
  sourceText: id,
  ...extra,
});

describe('the speaker detection cache', () => {
  let tmp: string;
  let audio: string;
  let cache: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-diar-'));
    audio = path.join(tmp, 'a.wav');
    cache = path.join(tmp, 'diarization.json');
    await fsp.writeFile(audio, 'RIFF....');
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('detects once per audio file and model, and passes "not installed" through', async () => {
    const turns = [{ startMs: 0, endMs: 1000, speaker: 0 }];
    const diarize = vi.fn(async () => turns);
    const service: DiarizationService = { diarize, available: async () => true, modelKey: 'm1' };

    expect(await cachedSpeakerTurns(service, audio, cache, {})).toEqual(turns);
    expect(await cachedSpeakerTurns(service, audio, cache, {})).toEqual(turns);
    expect(diarize).toHaveBeenCalledTimes(1);
    // Another model, or a known speaker count: detect again.
    await cachedSpeakerTurns({ ...service, modelKey: 'm2' }, audio, cache, {});
    await cachedSpeakerTurns({ ...service, modelKey: 'm2' }, audio, cache, { numSpeakers: 2 });
    expect(diarize).toHaveBeenCalledTimes(3);
    // A re-extracted track: detect again.
    await fsp.writeFile(audio, 'RIFF........');
    await cachedSpeakerTurns({ ...service, modelKey: 'm2' }, audio, cache, { numSpeakers: 2 });
    expect(diarize).toHaveBeenCalledTimes(4);

    const none: DiarizationService = { diarize: async () => null, available: async () => false, modelKey: 'm3' };
    expect(await cachedSpeakerTurns(none, audio, path.join(tmp, 'other.json'), {})).toBeNull();
    await expect(fsp.stat(path.join(tmp, 'other.json'))).rejects.toThrow();
  });

  it("keeps each speaker's voice, and detects again over a turns-only file of 0.16", async () => {
    const stat = await fsp.stat(audio);
    const turns = [{ startMs: 0, endMs: 1000, speaker: 0 }];
    await fsp.writeFile(cache, JSON.stringify({ audio: { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }, model: 'm', turns }));
    const found = { turns, speakers: [voice(0, [1, 0])] };
    const diarize = vi.fn(async () => found);
    const service: DiarizationService = { diarize, available: async () => true, modelKey: 'm' };
    expect(await cachedDiarization(service, audio, cache, {})).toEqual(found);
    expect(diarize).toHaveBeenCalledTimes(1);
    const saved = await readDiarizationCache(cache);
    expect(saved).toMatchObject({ format: 2, model: 'm', turns, speakers: found.speakers });
    expect(await cachedDiarization(service, audio, cache, {})).toEqual(found);
    expect(diarize).toHaveBeenCalledTimes(1);
  });

  it("a detection linked by older rules is linked again: the service's linkKey (《反相之地》, 2026-11-25)", async () => {
    const turns = [{ startMs: 0, endMs: 1000, speaker: 0 }];
    const found = { turns, speakers: [voice(0, [1, 0])] };
    const diarize = vi.fn(async () => found);
    const before: DiarizationService = { diarize, available: async () => true, modelKey: 'm' };
    await cachedDiarization(before, audio, cache, {});
    expect((await readDiarizationCache(cache))?.link).toBeUndefined();
    const after: DiarizationService = { ...before, linkKey: 'link-2' };
    await cachedDiarization(after, audio, cache, {});
    expect(diarize).toHaveBeenCalledTimes(2);
    expect((await readDiarizationCache(cache))?.link).toBe('link-2');
    await cachedDiarization(after, audio, cache, {});
    expect(diarize).toHaveBeenCalledTimes(2);
  });

  it('labels the lines, and records which line id each detected speaker became', async () => {
    const turns = [
      { startMs: 0, endMs: 2000, speaker: 1 },
      { startMs: 2000, endMs: 4000, speaker: 0 },
      { startMs: 9000, endMs: 9500, speaker: 2 }, // says no line
    ];
    const speakers = [voice(0, [0, 1], { gender: 'female', f0Hz: 220 }), voice(1, [1, 0]), voice(2, [0.6, 0.8])];
    const diarize = vi.fn(async () => ({ turns, speakers }));
    const service: DiarizationService = { diarize, available: async () => true, modelKey: 'm' };
    const onProgress = vi.fn();
    const found = await detectLineSpeakers({
      service,
      audioPath: audio,
      cachePath: cache,
      checkpointDir: path.join(tmp, 'parts'),
      segments: [seg('seg_0001', 0, 1900), seg('seg_0002', 2100, 3900, { voiceId: 'mine' }), seg('seg_0003', 5000, 5500)],
      numSpeakers: 3,
      onProgress,
    });
    expect(diarize).toHaveBeenCalledWith(audio, { numSpeakers: 3, onProgress, checkpointDir: path.join(tmp, 'parts') }, undefined);
    expect(found!.segments.map((s) => [s.speakerId, s.speakerLowConfidence, s.voiceId])).toEqual([
      ['SPEAKER_00', undefined, undefined],
      ['SPEAKER_01', undefined, 'mine'],
      ['SPEAKER_01', true, undefined],
    ]);
    expect(found!.lowConfidence).toBe(1);
    expect(found!.speakers.map((s) => [s.speakerId, s.speaker, s.gender])).toEqual([
      ['SPEAKER_00', 1, 'male'],
      ['SPEAKER_01', 0, 'female'],
    ]);
    const profiles = await readSpeakerProfiles(cache);
    expect(profiles).toEqual(found!.speakers);
    // The speaker who says no line has no id in the file either.
    expect((await readDiarizationCache(cache))!.speakers.find((s) => s.speaker === 2)).not.toHaveProperty('speakerId');

    const none: DiarizationService = { diarize: async () => null, available: async () => false, modelKey: 'x' };
    expect(await detectLineSpeakers({ service: none, audioPath: audio, cachePath: path.join(tmp, 'n.json'), segments: [] })).toBeNull();
    expect(await readSpeakerProfiles(path.join(tmp, 'n.json'))).toEqual([]);
  });

  it("detects again over the transcript as it is, and says where each old speaker's voice goes", async () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const lines = [seg('seg_0001', 0, 1000), seg('seg_0002', 2000, 3000, { voiceId: 'custom' }), seg('seg_0003', 4000, 5000)];
    // The first detection: A says lines 1 and 3, B line 2.
    const first: DiarizationService = {
      diarize: async () => ({
        turns: [
          { startMs: 0, endMs: 1000, speaker: 0 },
          { startMs: 2000, endMs: 3000, speaker: 1 },
          { startMs: 4000, endMs: 5000, speaker: 0 },
        ],
        speakers: [voice(0, a), voice(1, b)],
      }),
      available: async () => true,
      modelKey: 'm',
    };
    const before = await detectLineSpeakers({ service: first, audioPath: audio, cachePath: cache, segments: lines });
    expect(before!.segments.map((s) => s.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);

    // Detected again with a known count: B is now heard on line 1 too, so B is SPEAKER_00.
    const again: DiarizationService = {
      diarize: async () => ({
        turns: [
          { startMs: 0, endMs: 3000, speaker: 7 },
          { startMs: 4000, endMs: 5000, speaker: 3 },
        ],
        speakers: [voice(7, [0.02, 0.999, 0]), voice(3, [0.999, 0.02, 0])],
      }),
      available: async () => true,
      modelKey: 'm',
    };
    const out = await redetectSpeakers({ service: again, audioPath: audio, cachePath: cache, segments: before!.segments, numSpeakers: 2 });
    expect(out!.segments.map((s) => [s.id, s.startMs, s.endMs, s.sourceText, s.speakerId, s.voiceId])).toEqual([
      ['seg_0001', 0, 1000, 'seg_0001', 'SPEAKER_00', undefined],
      ['seg_0002', 2000, 3000, 'seg_0002', 'SPEAKER_00', 'custom'],
      ['seg_0003', 4000, 5000, 'seg_0003', 'SPEAKER_01', undefined],
    ]);
    expect(out!.remap).toEqual({ SPEAKER_00: 'SPEAKER_01', SPEAKER_01: 'SPEAKER_00' });
    expect(
      remapSpeakerVoices(
        [
          { speakerId: 'SPEAKER_00', voiceId: 'anna' },
          { speakerId: 'SPEAKER_01', voiceId: 'bao' },
        ],
        out!.remap,
      ),
    ).toEqual([
      { speakerId: 'SPEAKER_00', voiceId: 'bao' },
      { speakerId: 'SPEAKER_01', voiceId: 'anna' },
    ]);
    expect((await readSpeakerProfiles(cache)).map((s) => [s.speakerId, s.speaker])).toEqual([
      ['SPEAKER_00', 7],
      ['SPEAKER_01', 3],
    ]);
  });
});

describe('remapSpeakers', () => {
  const lines = [
    { id: '1', startMs: 0, endMs: 1000, speakerId: 'SPEAKER_00' },
    { id: '2', startMs: 1000, endMs: 3000, speakerId: 'SPEAKER_05' },
    { id: '3', startMs: 3000, endMs: 4000, speakerId: 'SPEAKER_05' },
    { id: '4', startMs: 4000, endMs: 5000, speakerId: 'SPEAKER_06' },
    { id: '5', startMs: 5000, endMs: 6000, speakerId: 'SPEAKER_06' },
  ];

  it('matches prints one to one, the most alike first', () => {
    const before = [
      { speakerId: 'SPEAKER_00', print: [1, 0] },
      { speakerId: 'SPEAKER_01', print: [0.95, 0.31] },
    ];
    const after = [{ speakerId: 'SPEAKER_03', print: [0.99, 0.1] }];
    // Both are alike SPEAKER_03; SPEAKER_00 is more so, and SPEAKER_01 has no line to go by.
    expect(remapSpeakers(before, after, lines.slice(0, 1), [])).toEqual({ SPEAKER_00: 'SPEAKER_03' });
    // Not alike enough to be one voice.
    expect(remapSpeakers([{ speakerId: 'SPEAKER_00', print: [1, 0] }], [{ speakerId: 'SPEAKER_00', print: [0.6, 0.8] }], [], [])).toEqual({});
  });

  it('follows the lines for speakers without a matching print, when they hold half of them', () => {
    const now = [
      { id: '1', speakerId: 'SPEAKER_00' },
      { id: '2', speakerId: 'SPEAKER_01' },
      { id: '3', speakerId: 'SPEAKER_01' },
      { id: '4', speakerId: 'SPEAKER_00' },
      { id: '5', speakerId: 'SPEAKER_02' },
    ];
    // SPEAKER_05's lines are all SPEAKER_01's now; SPEAKER_06's split between a taken id and
    // SPEAKER_02, which holds exactly half: enough.
    expect(remapSpeakers([{ speakerId: 'SPEAKER_00', print: [1, 0] }], [{ speakerId: 'SPEAKER_00', print: [1, 0] }], lines, now)).toEqual({
      SPEAKER_00: 'SPEAKER_00',
      SPEAKER_05: 'SPEAKER_01',
      SPEAKER_06: 'SPEAKER_02',
    });
    // SPEAKER_06's lines now spread over three speakers, a third each: no counterpart.
    const spread = [...now.slice(0, 4), { id: '5', speakerId: 'SPEAKER_02' }, { id: '6', speakerId: 'SPEAKER_03' }];
    const more = [...lines, { id: '6', startMs: 6000, endMs: 7000, speakerId: 'SPEAKER_06' }];
    expect(remapSpeakers([{ speakerId: 'SPEAKER_00', print: [1, 0] }], [{ speakerId: 'SPEAKER_00', print: [1, 0] }], more, spread)).toEqual({
      SPEAKER_00: 'SPEAKER_00',
      SPEAKER_05: 'SPEAKER_01',
    });
  });
});

describe('speakerDetectionProgress', () => {
  it('moves the bar over the parts with a detail, and logs each part of long audio', async () => {
    const step = vi.fn(async () => {});
    const log = vi.fn();
    const report = speakerDetectionProgress(step, log);
    report(0, 3);
    report(2, 3);
    report(0, 0);
    expect(step.mock.calls).toEqual([
      [0, { key: 'step-detail.speakers', params: { done: 0, total: 3 }, text: 'Detecting speakers 0/3' }],
      [2 / 3, { key: 'step-detail.speakers', params: { done: 2, total: 3 }, text: 'Detecting speakers 2/3' }],
    ]);
    expect(log.mock.calls).toEqual([['Detecting speakers in 3 parts of up to 10 minutes...'], ['Speaker detection: part 2/3 done.']]);
    // One pass: the bar and its detail, no log; a failed progress write is not the detection's problem.
    const failing = speakerDetectionProgress(async () => {
      throw new Error('disk full');
    }, log);
    failing(1, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledTimes(2);
  });
});

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectWarning, TranscriptSegment } from '@videodubber/shared';

import type { RepairedRange } from './loopRepair.js';
import { detectionRange, readSpeakerJob, saveSpeakerJob, speakerJobSummary, speakerJobView } from './speakerJob.js';
import { loopWarnings, settledByRewrite, transcriptWarnings, unassignedWarning, withTranscriptWarnings } from './transcriptWarnings.js';

const line = (startMs: number, endMs: number, extra: Partial<TranscriptSegment> = {}) => ({ startMs, endMs, ...extra });
const range = (fromMs: number, toMs: number, status: RepairedRange['status']): RepairedRange => ({ fromMs, toMs, kind: 'repeat', status, before: 10, after: 2 });

describe('the transcript warnings', () => {
  it('counts a loop left unrepaired only while its lines still carry the mark', () => {
    const report = [range(0, 10_000, 'replaced'), range(20_000, 30_000, 'left'), range(40_000, 50_000, 'kept')];
    const marked = [line(21_000, 22_000, { loopSuspect: true })];
    expect(loopWarnings(report, marked).map((w) => [w.code, w.params])).toEqual([
      ['loops-repaired', { count: 1 }],
      ['loops-left', { count: 1 }],
    ]);
    expect(loopWarnings(report, marked)[0]!.message).toContain('1 repetition(s) were real and kept');
    // replace_lines took the marked lines out: nothing is left.
    expect(loopWarnings(report, [line(21_000, 22_000)]).map((w) => w.code)).toEqual(['loops-repaired']);
  });

  it('names the lines without a speaker, by stretch, in a project that has speakers', () => {
    const lines = [
      line(0, 1000, { speakerId: 'SPEAKER_00' }),
      line(87_124_000, 87_125_000),
      line(87_400_000, 88_024_000),
      line(95_000_000, 95_001_000),
    ];
    const w = unassignedWarning(lines)!;
    expect(w).toMatchObject({ code: 'speakers-unassigned', key: 'warning.speakers-unassigned', params: { count: 3, ranges: '24:12:04–24:27:04, 26:23:20–26:23:21' } });
    expect(w.message).toContain('detect_speakers with fromMs and toMs');
    // Every line has one, or none has (never detected): nothing to say.
    expect(unassignedWarning([line(0, 1000, { speakerId: 'SPEAKER_00' })])).toBeUndefined();
    expect(unassignedWarning([line(0, 1000)])).toBeUndefined();
    // Speakers are said only in a project that detects them.
    expect(transcriptWarnings(lines, [], false)).toEqual([]);
    expect(transcriptWarnings(lines, [], true).map((w) => w.code)).toEqual(['speakers-unassigned']);
  });

  it('replaces only its own warnings, keeps an unchanged one as it was, and says when nothing changes', () => {
    const at = '2026-11-23T10:00:00.000Z';
    const gpu: ProjectWarning = { code: 'gpu-fallback', step: 'tts', at, message: 'busy', key: 'warning.gpu-fallback-busy' };
    const loops = loopWarnings([range(0, 1000, 'removed')], []);
    const current: ProjectWarning[] = [gpu, { ...loops[0]!, step: 'stt', at }];
    expect(withTranscriptWarnings(current, loops, 'later')).toBeUndefined();
    const speakers = unassignedWarning([line(0, 1, { speakerId: 'SPEAKER_00' }), line(5, 9)])!;
    const next = withTranscriptWarnings(current, [...loops, speakers], 'later')!;
    expect(next.map((w) => [w.code, w.step, w.at])).toEqual([
      ['gpu-fallback', 'tts', at],
      ['loops-repaired', 'stt', at],
      ['speakers-unassigned', 'stt', 'later'],
    ]);
    expect(withTranscriptWarnings(next, [], 'later')!.map((w) => w.code)).toEqual(['gpu-fallback']);
  });
});

describe('the saved speaker detection job', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-spkjob-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('reads back what it saved, and shows a job nobody runs any more as interrupted', async () => {
    const file = path.join(tmp, 'speaker_detection.json');
    expect(await readSpeakerJob(file)).toBeUndefined();
    await saveSpeakerJob(file, { state: 'running', done: 3, total: 12, startedAt: 'then', range: { fromMs: 0, toMs: 60_000 } });
    const saved = (await readSpeakerJob(file))!;
    expect(saved).toMatchObject({ state: 'running', done: 3, total: 12, range: { fromMs: 0, toMs: 60_000 } });
    expect(speakerJobView(saved, false).state).toBe('interrupted');
    expect(speakerJobView(saved, true).state).toBe('running');
    expect(speakerJobView({ ...saved, state: 'done' }, false).state).toBe('done');
    // Another format, or garbage: none.
    await fsp.writeFile(file, '{"format":9,"state":"running"}');
    expect(await readSpeakerJob(file)).toBeUndefined();
  });

  it('takes a range with both ends or none', () => {
    expect(detectionRange({})).toBeUndefined();
    expect(detectionRange({ fromMs: 1000.4, toMs: 5000 })).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(() => detectionRange({ fromMs: 1000 })).toThrow(/both fromMs and toMs/);
    expect(() => detectionRange({ fromMs: 5000, toMs: 1000 })).toThrow();
    expect(() => detectionRange({ fromMs: -1, toMs: 1000 })).toThrow();
  });

  it('says how it ended', () => {
    expect(speakerJobSummary({ state: 'done', done: 1, total: 1, startedAt: '', speakers: 12, lowConfidence: 40 })).toBe('12 speaker(s), 40 best guess(es)');
    expect(speakerJobSummary({ state: 'done', done: 1, total: 1, startedAt: '', range: { fromMs: 0, toMs: 1 }, relabelled: 9, added: 1, detectedParts: 0 })).toBe(
      '9 line(s) changed speaker, 1 new speaker(s), from the saved detection',
    );
  });
});

describe('stretch warnings settled by a rewrite', () => {
  const w = (code: ProjectWarning['code'], fromMs?: number, toMs?: number): ProjectWarning => ({
    code,
    at: '',
    key: 'k',
    message: 'm',
    ...(fromMs !== undefined ? { params: { fromMs, toMs: toMs! } } : {}),
  });
  it('a rewrite covering most of a stretch settles its warning; other warnings and other stretches stay', () => {
    const all = [w('stt-no-speech', 1000, 11_000), w('transcript-mismatch', 50_000, 60_000), w('speakers-failed'), w('stt-no-speech', 100_000, 200_000)];
    expect(settledByRewrite(all, { fromMs: 0, toMs: 10_000 }).map((x) => x.code)).toEqual(['transcript-mismatch', 'speakers-failed', 'stt-no-speech']);
    // Only a part of it rewritten: it stays.
    expect(settledByRewrite([w('stt-no-speech', 100_000, 200_000)], { fromMs: 100_000, toMs: 150_000 })).toHaveLength(1);
  });
});

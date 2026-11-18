import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiarizationService, SpeakerTurn } from '../providers/diarization/sherpaDiarizationProvider.js';
import { assignSpeakers, cachedSpeakerTurns } from './diarization.js';

const line = (startMs: number, endMs: number, speakerId?: string) => ({ startMs, endMs, ...(speakerId ? { speakerId } : {}) });

describe('assignSpeakers', () => {
  it('gives each line the speaker who says most of it, numbered by first line', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 5000, speaker: 3 },
      { startMs: 5000, endMs: 9000, speaker: 0 },
      { startMs: 9000, endMs: 12_000, speaker: 3 },
    ];
    const out = assignSpeakers([line(500, 4500), line(5200, 8800), line(8500, 11_500), line(12_500, 13_000)], turns);
    expect(out.map((l) => l.speakerId)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00', undefined]);
  });

  it('leaves a line nobody\'s when too little of it is covered or no one dominates', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1000, speaker: 0 },
      { startMs: 2000, endMs: 3000, speaker: 0 },
      { startMs: 3000, endMs: 4000, speaker: 1 },
    ];
    // 1 s of a 4 s line: 25% covered.
    expect(assignSpeakers([line(0, 4000)], turns.slice(0, 1))[0]!.speakerId).toBeUndefined();
    // Half and half: nobody dominates.
    expect(assignSpeakers([line(2000, 4000)], turns)[0]!.speakerId).toBeUndefined();
    // A previous (STT) speaker is replaced, also by nobody.
    expect(assignSpeakers([line(10_000, 11_000, 'SPEAKER_07')], turns)[0]!.speakerId).toBeUndefined();
  });

  it('keeps numbers contiguous when the engine heard someone who says no line', () => {
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 300, speaker: 0 }, // a cough
      { startMs: 1000, endMs: 3000, speaker: 1 },
    ];
    expect(assignSpeakers([line(1000, 3000)], turns)[0]!.speakerId).toBe('SPEAKER_00');
  });
});

describe('cachedSpeakerTurns', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-diar-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('detects once per audio file and model, and passes "not installed" through', async () => {
    const audio = path.join(tmp, 'a.wav');
    await fsp.writeFile(audio, 'RIFF....');
    const turns = [{ startMs: 0, endMs: 1000, speaker: 0 }];
    const diarize = vi.fn(async () => turns);
    const service: DiarizationService = { diarize, available: async () => true, modelKey: 'm1' };
    const cache = path.join(tmp, 'diarization.json');

    expect(await cachedSpeakerTurns(service, audio, cache, {})).toEqual(turns);
    expect(await cachedSpeakerTurns(service, audio, cache, {})).toEqual(turns);
    expect(diarize).toHaveBeenCalledTimes(1);
    // Another model, or a known speaker count: detect again.
    await cachedSpeakerTurns({ ...service, modelKey: 'm2' }, audio, cache, {});
    await cachedSpeakerTurns({ ...service, modelKey: 'm2' }, audio, cache, { numSpeakers: 2 });
    expect(diarize).toHaveBeenCalledTimes(3);

    const none: DiarizationService = { diarize: async () => null, available: async () => false, modelKey: 'm3' };
    expect(await cachedSpeakerTurns(none, audio, path.join(tmp, 'other.json'), {})).toBeNull();
    await expect(fsp.stat(path.join(tmp, 'other.json'))).rejects.toThrow();
  });
});

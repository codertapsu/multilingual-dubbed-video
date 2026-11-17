import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedSpeechRegions, sttWorkerSpeechMap, type SpeechMapService } from './speechMap.js';
import { setWorkerTransport } from '../providers/workerHttp.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-speechmap-'));
});
afterEach(async () => {
  setWorkerTransport(null);
  await fsp.rm(tmp, { recursive: true, force: true });
});

function countingService(): SpeechMapService & { calls: number } {
  const svc = {
    calls: 0,
    async regions() {
      svc.calls++;
      return [{ startMs: 1000, endMs: 2000 }];
    },
  };
  return svc;
}

describe('cachedSpeechRegions', () => {
  it('measures once per audio file, and again when the audio is re-extracted', async () => {
    const audio = path.join(tmp, 'original_16k_mono.wav');
    const cache = path.join(tmp, 'speech_regions.json');
    await fsp.writeFile(audio, 'first extraction');
    const svc = countingService();
    const signal = new AbortController().signal;

    expect(await cachedSpeechRegions(svc, audio, cache, signal)).toEqual([{ startMs: 1000, endMs: 2000 }]);
    await cachedSpeechRegions(svc, audio, cache, signal);
    expect(svc.calls).toBe(1);

    await fsp.writeFile(audio, 'a different, longer extraction');
    await cachedSpeechRegions(svc, audio, cache, signal);
    expect(svc.calls).toBe(2);
  });

  it('measures again when the cache file is corrupt', async () => {
    const audio = path.join(tmp, 'a.wav');
    const cache = path.join(tmp, 'speech_regions.json');
    await fsp.writeFile(audio, 'x');
    await fsp.writeFile(cache, '{"audio": {"sizeBytes": 1');
    const svc = countingService();
    await cachedSpeechRegions(svc, audio, cache, new AbortController().signal);
    expect(svc.calls).toBe(1);
    expect(JSON.parse(await fsp.readFile(cache, 'utf8')).regions).toHaveLength(1);
  });
});

describe('sttWorkerSpeechMap', () => {
  it('posts the audio path and keeps only well-formed regions, sorted', async () => {
    const sent: { url: string; body: string | undefined }[] = [];
    setWorkerTransport(async (_method, url, payload) => {
      sent.push({ url, body: payload });
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          durationMs: 9000,
          regions: [{ startMs: 5000, endMs: 6000 }, { startMs: 3000, endMs: 2000 }, { startMs: 1000, endMs: 1500 }, null],
        }),
      };
    });
    const regions = await sttWorkerSpeechMap('http://127.0.0.1:5101/').regions('/p/a.wav', new AbortController().signal);
    expect(sent).toEqual([{ url: 'http://127.0.0.1:5101/speech-regions', body: JSON.stringify({ audioPath: '/p/a.wav' }) }]);
    expect(regions).toEqual([
      { startMs: 1000, endMs: 1500 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });
});

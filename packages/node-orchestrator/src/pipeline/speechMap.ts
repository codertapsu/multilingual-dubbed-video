/**
 * The speech map: where speech is in a project's audio, measured by the STT
 * worker's Silero VAD (POST /speech-regions). segmentTiming uses it to anchor
 * lines without word timings (whisper.cpp's) and to settle words whose place
 * is in doubt.
 *
 * Cached in audio/speech_regions.json with the size and modification time of
 * the audio it was measured on: a retried speech-to-text step does not measure
 * again, and a re-extracted audio track is never matched with an old map.
 */
import fsp from 'node:fs/promises';
import { postWorkerJson } from '../providers/workerHttp.js';
import { writeJsonAtomic } from '../workspace/projectStore.js';
import type { SpeechRegion } from './segmentTiming.js';

export interface SpeechMapService {
  /** Speech regions of a 16 kHz mono WAV, in ms, sorted by start. */
  regions(audioPath: string, signal: AbortSignal): Promise<SpeechRegion[]>;
}

/** A 31-minute track measures in ~4 s on a laptop CPU; this only stops a hung worker. */
const SPEECH_MAP_TIMEOUT_MS = 10 * 60_000;

function isRegion(r: unknown): r is SpeechRegion {
  const v = r as Partial<SpeechRegion> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite(v.startMs) &&
    Number.isFinite(v.endMs) &&
    (v.endMs as number) > (v.startMs as number)
  );
}

/** The STT worker's speech map. */
export function sttWorkerSpeechMap(baseUrl: string, timeoutMs = SPEECH_MAP_TIMEOUT_MS): SpeechMapService {
  const url = `${baseUrl.replace(/\/$/, '')}/speech-regions`;
  return {
    async regions(audioPath, signal) {
      const res = await postWorkerJson<{ regions?: unknown[] }>(
        url,
        { audioPath },
        { timeoutMs, workerName: 'STT worker', signal },
      );
      return (res.regions ?? []).filter(isRegion).sort((a, b) => a.startMs - b.startMs);
    },
  };
}

interface SpeechMapFile {
  /** The audio the map was measured on. */
  audio: { sizeBytes: number; mtimeMs: number };
  regions: SpeechRegion[];
}

/** The speech map of `audioPath`, from the cache when it was measured on this very file. */
export async function cachedSpeechRegions(
  service: SpeechMapService,
  audioPath: string,
  cachePath: string,
  signal: AbortSignal,
): Promise<SpeechRegion[]> {
  const stat = await fsp.stat(audioPath);
  const audio = { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  try {
    const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as Partial<SpeechMapFile>;
    if (
      saved.audio?.sizeBytes === audio.sizeBytes &&
      saved.audio.mtimeMs === audio.mtimeMs &&
      Array.isArray(saved.regions)
    ) {
      return saved.regions.filter(isRegion);
    }
  } catch {
    /* absent or unreadable: measure */
  }
  const regions = await service.regions(audioPath, signal);
  await writeJsonAtomic(cachePath, { audio, regions } satisfies SpeechMapFile);
  return regions;
}

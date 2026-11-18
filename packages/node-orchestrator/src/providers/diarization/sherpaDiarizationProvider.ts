/**
 * Speaker detection, backed by the `diarization-sherpa` engine pack
 * (workers/diarization-engine, sherpa-onnx). Answers who speaks when, as turns
 * with a speaker number; pipeline/diarization.ts turns those into the lines'
 * speaker ids. Returns null when the pack isn't installed: the dub then goes
 * on without speakers, and says so.
 */
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { DIARIZATION_EMBEDDING } from '../../engines/enginePackCatalog.js';
import { pickInstalledPack } from '../../engines/packSelection.js';
import { postWorkerJson } from '../workerHttp.js';

/** A stretch of audio said by one speaker (numbers from 0, by first appearance). */
export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speaker: number;
}

export interface DiarizationService {
  /** Who speaks when in a 16 kHz mono WAV; null when no engine is installed. */
  diarize(audioPath: string, opts: { numSpeakers?: number }, signal?: AbortSignal): Promise<SpeakerTurn[] | null>;
  /** Whether `diarize` can do anything here. */
  available(): Promise<boolean>;
  /** What the turns depend on besides the audio (the model and its threshold), for caching. */
  readonly modelKey: string;
}

export class SherpaDiarizationProvider implements DiarizationService {
  readonly modelKey = `sherpa-2.0.1:${DIARIZATION_EMBEDDING.sha256.slice(0, 12)}:${DIARIZATION_EMBEDDING.threshold}`;

  constructor(
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  async available(): Promise<boolean> {
    return (await pickInstalledPack(this.store, 'speaker-diarization')) !== undefined;
  }

  async diarize(audioPath: string, opts: { numSpeakers?: number }, signal?: AbortSignal): Promise<SpeakerTurn[] | null> {
    const packId = await pickInstalledPack(this.store, 'speaker-diarization');
    if (!packId) return null;
    const baseUrl = (await this.engines.ensureRunning(packId)).replace(/\/$/, '');
    const data = await postWorkerJson<{ turns?: SpeakerTurn[] }>(
      `${baseUrl}/diarize`,
      {
        audioPath,
        threshold: DIARIZATION_EMBEDDING.threshold,
        ...(opts.numSpeakers && opts.numSpeakers > 0 ? { numSpeakers: opts.numSpeakers } : {}),
      },
      { timeoutMs: this.timeoutMs, workerName: 'Speaker detection engine', signal },
    );
    return (data.turns ?? []).filter(
      (t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs) && t.endMs > t.startMs && Number.isInteger(t.speaker) && t.speaker >= 0,
    );
  }
}

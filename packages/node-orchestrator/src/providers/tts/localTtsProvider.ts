/**
 * Local TTS provider backed by the Piper/system/fallback Python worker
 * (port 5103). One WAV per segment is written into `outputDir`; the worker
 * reports the real measured duration of each WAV.
 */
import {
  type TtsInput,
  type TtsProvider,
  type TtsResult,
  type TtsSegment,
} from '@videodubber/shared';
import { getWorkerJson, postWorkerJson } from '../workerHttp.js';

/** Raw shape of POST /synthesize-segments. */
interface WorkerSynthesizeResponse {
  segments: {
    segmentId: string;
    audioPath: string;
    durationMs: number;
    startMs: number;
    endMs: number;
    speedRatio: number;
  }[];
}

/** Raw shape of GET /voices. */
export interface WorkerVoicesResponse {
  voices: { id: string; language: string; displayName: string; engine: string }[];
}

/** Local Piper/system/fallback TTS provider. */
export class LocalTtsProvider implements TtsProvider {
  readonly id = 'piper-local';
  readonly displayName = 'Piper / system / fallback (local)';
  readonly isLocal = true;

  constructor(
    private readonly workerUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Synthesize each segment into `input.outputDir`. The worker echoes back the
   * `text` is not part of the response, so we re-attach it from the request so
   * downstream consumers have the full {@link TtsSegment}.
   */
  async synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const body = {
      language: input.language,
      voiceId: input.voiceId,
      segments: input.segments,
      outputDir: input.outputDir,
      speed: input.speed ?? 1.0,
    };

    const data = await postWorkerJson<WorkerSynthesizeResponse>(
      `${this.workerUrl.replace(/\/$/, '')}/synthesize-segments`,
      body,
      { timeoutMs: this.timeoutMs, workerName: 'TTS worker', signal },
    );

    const textById = new Map(input.segments.map((s) => [s.id, s.text]));
    const segments: TtsSegment[] = (data.segments ?? []).map((s) => ({
      segmentId: s.segmentId,
      text: textById.get(s.segmentId) ?? '',
      audioPath: s.audioPath,
      durationMs: s.durationMs,
      startMs: s.startMs,
      endMs: s.endMs,
      speedRatio: s.speedRatio,
    }));

    return { segments };
  }

  /** Fetch available voices for a language for the UI voice picker. */
  async listVoices(language?: string, signal?: AbortSignal): Promise<WorkerVoicesResponse> {
    const url = new URL(`${this.workerUrl.replace(/\/$/, '')}/voices`);
    if (language) url.searchParams.set('language', language);
    return getWorkerJson<WorkerVoicesResponse>(url.toString(), {
      timeoutMs: this.timeoutMs,
      workerName: 'TTS worker',
      signal,
    });
  }
}

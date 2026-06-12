/**
 * Neural TTS provider backed by a VieNeu engine pack — a higher-quality
 * Vietnamese voice than Piper. Parameterized so the registry can register the
 * two variants as SEPARATE options:
 *   - id "neural-tts"    -> VieNeu v3-Turbo (pack "tts-neural", 48 kHz, Apache-2.0)
 *   - id "neural-tts-v2" -> VieNeu v2       (pack "tts-neural-v2", 24 kHz; preset
 *                            voices are CC BY-NC 4.0 / non-commercial)
 * Each pack runs the same FastAPI server (`vd_tts_engine`) selecting its variant
 * via VIENEU_VARIANT, exposing the SAME `/synthesize-segments` + `/voices`
 * contract as the bundled local TTS worker — only the base URL differs (resolved
 * on demand via the EngineManager).
 *
 * Stock/preset voices only; any zero-shot cloning inputs the underlying models
 * expose are not surfaced (policy).
 */
import { type TtsInput, type TtsProvider, type TtsResult, type TtsSegment } from '@videodubber/shared';
import { getWorkerJson, postWorkerJson } from '../workerHttp.js';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { requireInstalledPack } from '../../engines/packSelection.js';
import type { WorkerVoicesResponse } from './localTtsProvider.js';

interface WorkerSynthesizeResponse {
  segments: {
    segmentId: string;
    audioPath: string;
    durationMs: number;
    startMs: number;
    endMs: number;
    speedRatio: number;
  }[];
  engine?: string;
  fallbackSegments?: number;
}

export class NeuralTtsProvider implements TtsProvider {
  readonly isLocal = true;

  constructor(
    readonly id: string,
    readonly displayName: string,
    readonly requiresEnginePack: string,
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  private async baseUrl(): Promise<string> {
    const packId = await requireInstalledPack(this.store, this.id);
    return this.engines.ensureRunning(packId);
  }

  async synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const base = (await this.baseUrl()).replace(/\/$/, '');
    const data = await postWorkerJson<WorkerSynthesizeResponse>(
      `${base}/synthesize-segments`,
      {
        language: input.language,
        voiceId: input.voiceId,
        segments: input.segments,
        outputDir: input.outputDir,
        speed: input.speed ?? 1.0,
      },
      { timeoutMs: this.timeoutMs, workerName: 'Neural TTS engine', signal },
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
    return { segments, engine: data.engine ?? this.id, fallbackSegments: data.fallbackSegments };
  }

  /** List voices the engine offers for a language (UI voice picker). */
  async listVoices(language?: string, signal?: AbortSignal): Promise<WorkerVoicesResponse> {
    const base = (await this.baseUrl()).replace(/\/$/, '');
    const url = new URL(`${base}/voices`);
    if (language) url.searchParams.set('language', language);
    return getWorkerJson<WorkerVoicesResponse>(url.toString(), {
      timeoutMs: this.timeoutMs,
      workerName: 'Neural TTS engine',
      signal,
    });
  }
}

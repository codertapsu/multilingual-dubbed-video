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
import {
  AppErrorException,
  type TtsInput,
  type TtsProvider,
  type TtsResult,
  type TtsSegment,
} from '@videodubber/shared';
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
    /**
     * Load this engine EXCLUSIVELY for synthesis — i.e. unload other resident
     * heavy engines (whisper.cpp / llama.cpp) first to free RAM/VRAM. Set for
     * memory-heavy engines like OmniVoice (a ~2 GB MLX model); left false for the
     * light ONNX VieNeu engines. Only applied on the synth path, NOT the
     * interactive voice picker (which must not evict a resident engine).
     */
    private readonly exclusive = false,
  ) {}

  private async baseUrl(exclusive = false): Promise<string> {
    const packId = await requireInstalledPack(this.store, this.id);
    return this.engines.ensureRunning(packId, exclusive ? { exclusive: true } : {});
  }

  /**
   * Block until the engine reports its model RESIDENT (`/health.loaded === true`),
   * so the one-time download/load happens OUTSIDE the synth request's timeout. A
   * reported `loadError` fails fast (no point waiting); polling is bounded by
   * `timeoutMs` (the first-run model download can take minutes). Health bodies
   * without a `loaded` field (e.g. the bundled Piper worker) are treated as ready
   * immediately, so this is a no-op for non-lazy backends.
   */
  private async waitUntilWarm(base: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Cancelled while loading the neural TTS model.');
      let health: { loaded?: boolean; loadError?: string | null } | undefined;
      try {
        health = await getWorkerJson<{ loaded?: boolean; loadError?: string | null }>(`${base}/health`, {
          timeoutMs: 5_000,
          workerName: 'Neural TTS engine',
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err; // run cancelled — propagate
        // else: engine still booting / transient — keep polling until the deadline
      }
      if (health && health.loaded !== false) return; // loaded, or a backend that omits the field
      if (health?.loadError) {
        throw new AppErrorException(
          'ENGINE_UNAVAILABLE',
          `The neural TTS model failed to load: ${health.loadError}`,
          {
            remediation:
              'Reinstall the engine pack in Settings → Engines, or switch this phase to a local CPU provider (e.g. Piper).',
          },
        );
      }
      if (Date.now() >= deadline) {
        throw new AppErrorException('WORKER_TIMEOUT', 'The neural TTS model did not finish loading in time.', {
          remediation:
            'The first run downloads the voice model — check your connection and retry, or switch to a local CPU provider (Piper).',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  async synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    // Synthesis is the heavy phase: load exclusively (for OmniVoice) so a resident
    // llama.cpp/whisper.cpp is evicted before the ~2 GB MLX model loads — otherwise
    // co-resident models pressure RAM and can OOM-kill the bundled workers.
    const base = (await this.baseUrl(this.exclusive)).replace(/\/$/, '');
    // The engine loads its (large, first-run-downloaded) model lazily. Wait for it
    // to become RESIDENT before the synth request, so the one-time load isn't
    // charged to the synth timeout — over 200+ segments that overrun would abort
    // the whole run with WORKER_TIMEOUT. /voices does NOT wait, so the wizard's
    // voice picker stays responsive (and starts this warm-up early).
    await this.waitUntilWarm(base, signal);
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

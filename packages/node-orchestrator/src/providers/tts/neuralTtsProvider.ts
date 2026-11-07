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
import { installedPacksForProvider, requireInstalledPack } from '../../engines/packSelection.js';
import { getSystemProfile } from '../../system/systemProfile.js';
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
  reusedSegments?: number;
}

/** GET /health of a VieNeu engine (fields absent on older engines). */
interface WorkerHealth {
  loaded?: boolean;
  loadError?: string | null;
  device?: string | null;
  deviceName?: string | null;
  deviceNote?: string | null;
}

/**
 * Utterances per /synthesize-segments call. The pipeline used to send a whole
 * dub in one request: 120 utterances for a 21-minute video, which this engine
 * (then ~5x slower than real time on CPU) needed ~48 minutes for, against a
 * 30-minute request timeout. Six keeps one request to about half a minute at
 * the engine's current speed and under ten minutes even on a machine where the
 * thread fix in vd_tts_engine/engine.py does not take, while still updating
 * the progress bar every few lines.
 */
export const NEURAL_TTS_UNITS_PER_REQUEST = 6;

/**
 * Utterances per request when the engine runs on the GPU: one batch of its
 * batched path (vd_tts_engine `_GPU_BATCH_LINES`). One line at a time the GPU
 * was SLOWER than the CPU (RTF 1.36 vs 0.97); 24 together ran at 0.18.
 */
export const NEURAL_TTS_GPU_UNITS_PER_REQUEST = 24;

export class NeuralTtsProvider implements TtsProvider {
  readonly isLocal = true;
  /** Where the running engine synthesizes ("cuda" | "cpu"), from its /health. */
  private device: string | undefined;

  get maxSegmentsPerRequest(): number {
    return this.device === 'cuda' ? NEURAL_TTS_GPU_UNITS_PER_REQUEST : NEURAL_TTS_UNITS_PER_REQUEST;
  }

  /** The device the engine reported at its last warm-up, for the run log. */
  get activeDevice(): { device?: string; name?: string; note?: string } {
    return { ...this.deviceInfo };
  }
  private deviceInfo: { device?: string; name?: string; note?: string } = {};

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

  /**
   * Start the engine on the best installed pack (the GPU build first), falling
   * back down the list when one cannot start: installing the GPU pack must never
   * make synthesis WORSE than the CPU pack alone. `exclusive` is for synthesis:
   * a GPU pack then takes the heavy lane and evicts a resident llama.cpp first.
   */
  private async baseUrl(exclusive = false): Promise<string> {
    const profile = await getSystemProfile().catch(() => undefined);
    const ids = await installedPacksForProvider(this.store, this.id, process.platform, process.arch, profile);
    if (ids.length === 0) await requireInstalledPack(this.store, this.id); // throws ENGINE_PACK_MISSING
    return this.engines.ensureRunningFirstUsable(ids, exclusive || this.exclusive ? { exclusive: true } : {});
  }

  /** Start + warm the engine before the first batch, so the batch size fits the device. */
  async prepare(signal?: AbortSignal): Promise<void> {
    const base = (await this.baseUrl(true)).replace(/\/$/, '');
    await this.waitUntilWarm(base, signal);
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
    // The GPU build loads only when asked (vd_tts_engine POST /warmup), so the
    // model reaches the card while this run holds the GPU. Engines that load at
    // startup treat it as a no-op; one too old to have the route just 404s.
    await postWorkerJson(`${base}/warmup`, {}, { timeoutMs: 10_000, workerName: 'Neural TTS engine', signal }).catch(
      (err: unknown) => {
        if (signal?.aborted) throw err;
      },
    );
    for (;;) {
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Cancelled while loading the neural TTS model.');
      let health: WorkerHealth | undefined;
      try {
        health = await getWorkerJson<WorkerHealth>(`${base}/health`, {
          timeoutMs: 5_000,
          workerName: 'Neural TTS engine',
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err; // run cancelled — propagate
        // else: engine still booting / transient — keep polling until the deadline
      }
      if (health && health.loaded !== false) {
        // loaded, or a backend that omits the field
        this.device = health.device ?? undefined;
        this.deviceInfo = {
          ...(health.device ? { device: health.device } : {}),
          ...(health.deviceName ? { name: health.deviceName } : {}),
          ...(health.deviceNote ? { note: health.deviceNote } : {}),
        };
        return;
      }
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
    // Exclusive for synthesis: a GPU pack takes the heavy lane and evicts a
    // resident llama.cpp before its model claims VRAM. (The CPU pack is not
    // heavy, so for it this changes nothing.)
    const base = (await this.baseUrl(true)).replace(/\/$/, '');
    // The engine loads its (large, first-run-downloaded) model lazily. Wait for it
    // to become RESIDENT before the synth request, so the one-time load isn't
    // charged to the synth timeout — over 200+ segments that overrun would abort
    // the whole run with WORKER_TIMEOUT. /voices does NOT wait, so the wizard's
    // voice picker stays responsive (and starts this warm-up early).
    await this.waitUntilWarm(base, signal);
    let data: WorkerSynthesizeResponse;
    try {
      data = await postWorkerJson<WorkerSynthesizeResponse>(
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
    } catch (err) {
      // The generic WORKER_TIMEOUT advice is about speech-to-text models. Say
      // what is true here: the engine was slow, not broken; finished clips are
      // kept; and there is a fast alternative if this machine can't keep up.
      if (err instanceof AppErrorException && err.code === 'WORKER_TIMEOUT' && !signal?.aborted) {
        throw new AppErrorException(
          'WORKER_TIMEOUT',
          `${this.displayName} was still working on ${input.segments.length} line(s) when the ` +
            `${Math.round(this.timeoutMs / 60_000)}-minute limit for one batch ran out.`,
          {
            cause: err.appError.cause,
            remediation:
              'Retry the step: clips that were already finished are kept and reused, so it continues where it ' +
              'stopped. If it keeps happening, close other heavy apps (another dub, a game, a browser with many ' +
              'tabs) or switch Speech (TTS) to Piper in the project settings, which is many times faster on CPU.',
            docsRef: 'docs/TROUBLESHOOTING.md#worker-timeout',
          },
        );
      }
      throw err;
    }

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
    return {
      segments,
      engine: data.engine ?? this.id,
      fallbackSegments: data.fallbackSegments,
      ...(data.reusedSegments ? { reusedSegments: data.reusedSegments } : {}),
    };
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

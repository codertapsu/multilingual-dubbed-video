/**
 * First-run model installer.
 *
 * Given a {@link SetupInstallRequest}, downloads the selected models in order
 * and streams progress over the global {@link SetupEventBus}:
 *   1. Ensure the chosen whisper model (POST to the STT worker /models/ensure,
 *      which constructs the faster-whisper model to trigger an HF-cache download).
 *   2. Ensure each Argos pair (POST to the Translation worker /packages/ensure).
 *   3. Download each Piper voice (.onnx + .onnx.json) into `<modelsDir>/piper`
 *      via a streaming fetch, emitting percent from the Content-Length header.
 *
 * As each item completes its installed entry is recorded in setup.json (so a
 * partial install is remembered). Failures are caught and emitted as a
 * `{type:"error", error}` event; the run then stops.
 *
 * Only one install runs at a time (guarded by {@link SetupInstaller.isRunning}).
 */
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  AppErrorException,
  toAppError,
  type ArgosPair,
  type SetupInstallRequest,
} from '@videodubber/shared';
import type { OrchestratorConfig } from '../config.js';
import { postWorkerJson } from '../providers/workerHttp.js';
import { findPiperVoice } from './catalog.js';
import type { SetupEventBus } from './setupBus.js';
import type { SetupStore } from './setupStore.js';

/** Injected dependencies for the installer (all mockable in tests). */
export interface InstallerDeps {
  config: OrchestratorConfig;
  store: SetupStore;
  bus: SetupEventBus;
  /**
   * Fetch implementation (defaults to global fetch). Injectable so tests can
   * stub Piper downloads without hitting the network.
   */
  fetchImpl?: typeof fetch;
}

/** Response shape from the STT worker POST /models/ensure. */
interface SttEnsureResponse {
  ok: boolean;
  model: string;
  alreadyCached: boolean;
}

/** Response shape from the Translation worker POST /packages/ensure. */
interface TranslationEnsureResponse {
  ok: boolean;
  installed: boolean;
}

/** Normalize a base URL by stripping a trailing slash. */
function trimUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Runs a first-run install and reports progress over the setup bus. A single
 * instance is created per server; {@link run} guards against concurrent starts.
 */
export class SetupInstaller {
  private running = false;

  constructor(private readonly deps: InstallerDeps) {}

  /** True while an install is in progress. */
  isRunning(): boolean {
    return this.running;
  }

  /** The effective fetch implementation. */
  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /**
   * Run the install to completion. Resolves when done or after emitting an
   * error event; never rejects (the SSE channel is the result channel). The
   * `running` flag is cleared in a finally so a failed run does not wedge the
   * installer.
   */
  async run(request: SetupInstallRequest): Promise<void> {
    if (this.running) {
      this.emitLog('warn', 'An install is already in progress; ignoring the new request.');
      return;
    }
    this.running = true;
    try {
      await this.installAll(request);
      const status = await this.deps.store.getStatus();
      this.deps.bus.emit({ type: 'done', status });
    } catch (err) {
      this.deps.bus.emit({ type: 'error', error: toAppError(err) });
    } finally {
      this.running = false;
    }
  }

  // ----- Steps -------------------------------------------------------------

  private async installAll(request: SetupInstallRequest): Promise<void> {
    if (request.whisperModel) {
      await this.installWhisperModel(request.whisperModel);
    }
    for (const pair of request.argosPairs ?? []) {
      await this.installArgosPair(pair);
    }
    for (const voiceId of request.piperVoices ?? []) {
      await this.installPiperVoice(voiceId);
    }
  }

  /** Ensure a whisper model is cached via the STT worker. */
  private async installWhisperModel(model: string): Promise<void> {
    const item = `whisper:${model}`;
    this.emitProgress(item, null, `Downloading speech model "${model}"…`);
    const data = await postWorkerJson<SttEnsureResponse>(
      `${trimUrl(this.deps.config.sttWorkerUrl)}/models/ensure`,
      { model },
      { timeoutMs: this.deps.config.workerRequestTimeoutMs, workerName: 'STT worker' },
    );
    if (!data?.ok) {
      throw new AppErrorException('STT_MODEL_MISSING', `Failed to install whisper model "${model}".`);
    }
    await this.deps.store.addWhisperModel(model);
    this.emitProgress(item, 100, data.alreadyCached ? `Speech model "${model}" already present.` : `Speech model "${model}" ready.`);
    this.deps.bus.emit({ type: 'item-done', item });
  }

  /** Ensure an Argos translation pair is installed via the Translation worker. */
  private async installArgosPair(pair: ArgosPair): Promise<void> {
    const item = `argos:${pair.from}->${pair.to}`;
    this.emitProgress(item, null, `Downloading translation pack ${pair.from} → ${pair.to}…`);
    const data = await postWorkerJson<TranslationEnsureResponse>(
      `${trimUrl(this.deps.config.translationWorkerUrl)}/packages/ensure`,
      { from: pair.from, to: pair.to },
      { timeoutMs: this.deps.config.workerRequestTimeoutMs, workerName: 'Translation worker' },
    );
    if (!data?.ok) {
      throw new AppErrorException(
        'TRANSLATION_PACKAGE_MISSING',
        `Failed to install translation pack ${pair.from} → ${pair.to}.`,
      );
    }
    await this.deps.store.addArgosPair(pair);
    this.emitProgress(item, 100, `Translation pack ${pair.from} → ${pair.to} ready.`);
    this.deps.bus.emit({ type: 'item-done', item });
  }

  /** Download a Piper voice (.onnx + .onnx.json) into <modelsDir>/piper. */
  private async installPiperVoice(voiceId: string): Promise<void> {
    const item = `piper:${voiceId}`;
    const voice = findPiperVoice(voiceId);
    if (!voice) {
      throw new AppErrorException('TTS_VOICE_MISSING', `Unknown Piper voice id "${voiceId}".`, {
        remediation: 'Pick a voice from the catalog returned by GET /setup/catalog.',
      });
    }

    const piperDir = path.join(this.deps.config.modelsDir, 'piper');
    await fsp.mkdir(piperDir, { recursive: true });

    const onnxPath = path.join(piperDir, `${voiceId}.onnx`);
    const configPath = path.join(piperDir, `${voiceId}.onnx.json`);

    // The .onnx model is the large file — report percent for it. The small
    // .onnx.json config is fetched without per-byte progress.
    this.emitProgress(item, 0, `Downloading voice "${voice.label}"…`);
    await this.downloadFile(voice.url, onnxPath, item, voice.label);
    this.emitProgress(item, null, `Downloading voice config for "${voice.label}"…`);
    await this.downloadFile(voice.configUrl, configPath, item, voice.label, true);

    await this.deps.store.addPiperVoice(voiceId);
    this.emitProgress(item, 100, `Voice "${voice.label}" ready.`);
    this.deps.bus.emit({ type: 'item-done', item });
  }

  /**
   * Stream a remote file to disk. When `quiet` is false and the response has a
   * Content-Length, percent progress is emitted as bytes arrive. The file is
   * written to a temp path and renamed on success so a partial download never
   * leaves a corrupt model in place.
   */
  private async downloadFile(
    url: string,
    destPath: string,
    item: string,
    label: string,
    quiet = false,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { redirect: 'follow' });
    } catch (err) {
      throw new AppErrorException('TTS_VOICE_MISSING', `Failed to reach voice download for "${label}".`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (!response.ok || !response.body) {
      throw new AppErrorException('TTS_VOICE_MISSING', `Voice download failed for "${label}" (HTTP ${response.status}).`, {
        cause: url,
      });
    }

    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
    const hasTotal = Number.isFinite(total) && total > 0;

    const tmpPath = `${destPath}.download`;
    let received = 0;
    let lastPercent = -1;

    // Wrap the web ReadableStream as a Node Readable.
    // The fetch body is a WHATWG ReadableStream; Readable.fromWeb wants the
    // node:stream/web flavor — cast through unknown to bridge the two nominal
    // (but structurally identical) types.
    const webStream = response.body as unknown as NodeWebReadableStream<Uint8Array>;
    const nodeStream = Readable.fromWeb(webStream);

    // Count bytes inside a pass-through transform so progress reporting does not
    // interfere with pipeline back-pressure (attaching a bare 'data' listener
    // would put the source into flowing mode and risk losing chunks).
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        if (!quiet && hasTotal) {
          received += chunk.length;
          const percent = Math.min(100, Math.floor((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.emitProgress(item, percent, `Downloading voice "${label}"… ${percent}%`);
          }
        }
        done(null, chunk);
      },
    });

    try {
      await streamPipeline(nodeStream, counter, createWriteStream(tmpPath));
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {
        /* best effort cleanup */
      });
      throw new AppErrorException('TTS_VOICE_MISSING', `Voice download interrupted for "${label}".`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    await fsp.rename(tmpPath, destPath);
  }

  // ----- Event helpers -----------------------------------------------------

  private emitProgress(item: string, percent: number | null, message: string): void {
    this.deps.bus.emit({ type: 'progress', item, percent, message });
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.bus.emit({ type: 'log', level, message });
  }
}

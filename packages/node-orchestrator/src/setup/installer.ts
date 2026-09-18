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
import { createWriteStream, type Dirent } from 'node:fs';
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
import { findPiperVoice, findWhisperModel } from './catalog.js';
import { resolvePiperVoice } from './voicesCatalog.js';
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
  /** Backoff sleep (defaults to a real timer). Injectable so retry tests are instant. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Download attempts per file, and the backoff before each retry.
 *
 * A 64 MB voice from HuggingFace over a throttled or flaky link (the common
 * case in Vietnam and much of Asia — the app's primary audience) used to restart
 * from byte 0 on every drop, and one failure aborted the whole install run. Four
 * attempts with resume covers the realistic transient cases without turning a
 * genuinely dead URL into a two-minute wait.
 */
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_BACKOFF_MS = [1000, 3000, 8000];

/**
 * Download failures that retrying cannot fix (moved, forbidden, malformed).
 *
 * Tracked out-of-band instead of as a marker inside `AppError.cause`: `cause` is
 * user-visible (the error banner) and is what goes into pipeline.log, so it has
 * to hold the real reason. A first cut of this retry loop stuffed the literal
 * string "permanent" in there, and a user whose voice URL 404'd was told the
 * cause of the failure was "permanent".
 */
const permanentFailures = new WeakSet<AppErrorException>();

/** Size of a file in bytes, or 0 when it does not exist. */
async function fileSizeOrZero(filePath: string): Promise<number> {
  return fsp
    .stat(filePath)
    .then((st) => (st.isFile() ? st.size : 0))
    .catch(() => 0);
}

/** HTTP statuses worth retrying: rate limits, timeouts and server-side faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Turn a failing status into something a user can act on. "(HTTP 429)" told
 * nobody anything; a rate limit, a moved file and a blocked proxy need three
 * different reactions.
 */
export function describeDownloadFailure(status: number): { message: string; remediation: string } {
  if (status === 429) {
    return {
      message: 'the model server is rate-limiting this download',
      remediation: 'Wait a minute and retry — Hugging Face limits how fast one address can download.',
    };
  }
  if (status === 404 || status === 410) {
    return {
      message: 'the file is no longer at that address',
      remediation: 'Update VideoDubber — this voice moved upstream and the new address ships with the app.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      message: 'the model server refused the request',
      remediation:
        'A proxy, firewall or VPN is likely blocking huggingface.co. Try another network, or install the voice manually into the models folder.',
    };
  }
  if (status >= 500) {
    return {
      message: `the model server failed (HTTP ${status})`,
      remediation: 'The server is having trouble. Retry in a few minutes.',
    };
  }
  return {
    message: `the download failed (HTTP ${status})`,
    remediation: 'Check your network connection and retry.',
  };
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

/** Format a millisecond duration as `m:ss` (e.g. 75_000 -> "1:15"). */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * True when BOTH files exist and are non-empty.
 *
 * A Piper voice is only usable as a pair (`<id>.onnx` + `<id>.onnx.json`), and a
 * zero-byte file is what an interrupted download leaves behind — so "present"
 * has to mean both, non-empty, or the short-circuit would skip a broken voice.
 */
async function bothFilesPresent(...filePaths: string[]): Promise<boolean> {
  for (const filePath of filePaths) {
    const ok = await fsp
      .stat(filePath)
      .then((st) => st.isFile() && st.size > 0)
      .catch(() => false);
    if (!ok) return false;
  }
  return true;
}

/**
 * faster-whisper model id -> HuggingFace repo id. A faithful mirror of
 * `_SYSTRAN_REPOS` in workers/stt-worker/app/whisper_service.py — keep the two
 * in sync, or the orchestrator watches the wrong cache folder. Unknown ids fall
 * back the same way the worker does.
 */
const WHISPER_REPOS: Readonly<Record<string, string>> = {
  tiny: 'Systran/faster-whisper-tiny',
  base: 'Systran/faster-whisper-base',
  small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium',
  'large-v2': 'Systran/faster-whisper-large-v2',
  'large-v3': 'Systran/faster-whisper-large-v3',
  'large-v3-turbo': 'deepdml/faster-whisper-large-v3-turbo-ct2',
  turbo: 'deepdml/faster-whisper-large-v3-turbo-ct2',
  'distil-large-v3.5': 'distil-whisper/distil-large-v3.5-ct2',
  'phowhisper-small': 'kiendt/PhoWhisper-small-ct2',
  'phowhisper-medium': 'kiendt/PhoWhisper-medium-ct2',
  'phowhisper-large': 'kiendt/PhoWhisper-large-ct2',
};

/** The on-disk HF snapshot dir name for a whisper model (e.g. "small" ->
 *  "models--Systran--faster-whisper-small"); mirrors _model_repo_dir_name. */
function whisperRepoDirName(model: string): string {
  const repo =
    WHISPER_REPOS[model] ?? (model.includes('/') ? model : `Systran/faster-whisper-${model}`);
  return `models--${repo.replaceAll('/', '--')}`;
}

/**
 * Sum the bytes of every regular file under a directory (recursively); returns 0
 * if the directory doesn't exist yet. Walking only the HF `blobs/` dir counts
 * the real downloaded bytes (incl. `*.incomplete` partials) without
 * double-counting the `snapshots/` symlinks that point back into it.
 */
async function dirSize(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // not created yet (or gone) — treat as zero bytes
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      total += await fsp
        .stat(full)
        .then((s) => s.size)
        .catch(() => 0);
    }
  }
  return total;
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
    this.deps.bus.reset(); // fresh run — drop any prior run's replay snapshot
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
    const label = `Downloading speech model "${model}"`;
    this.emitProgress(item, null, `${label}…`);
    const data = await this.withWhisperProgress(
      item,
      label,
      model,
      postWorkerJson<SttEnsureResponse>(
        `${trimUrl(this.deps.config.sttWorkerUrl)}/models/ensure`,
        { model },
        { timeoutMs: this.deps.config.workerRequestTimeoutMs, workerName: 'STT worker' },
      ),
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
    const label = `Downloading translation pack ${pair.from} → ${pair.to}`;
    this.emitProgress(item, null, `${label}…`);
    const data = await this.withHeartbeat(
      item,
      label,
      postWorkerJson<TranslationEnsureResponse>(
        `${trimUrl(this.deps.config.translationWorkerUrl)}/packages/ensure`,
        { from: pair.from, to: pair.to },
        { timeoutMs: this.deps.config.workerRequestTimeoutMs, workerName: 'Translation worker' },
      ),
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
    // Curated voices first; otherwise resolve ANY voice from the full
    // rhasspy/piper-voices catalog so users can lazily download any voice for
    // their target language. Both yield .onnx + .onnx.json URLs.
    const voice = findPiperVoice(voiceId) ?? resolvePiperVoice(voiceId);
    if (!voice) {
      throw new AppErrorException('TTS_VOICE_MISSING', `Unknown Piper voice id "${voiceId}".`, {
        remediation: 'Pick a voice from GET /setup/catalog (curated) or GET /setup/voices?language=… (full).',
      });
    }

    const piperDir = path.join(this.deps.config.modelsDir, 'piper');
    await fsp.mkdir(piperDir, { recursive: true });

    const onnxPath = path.join(piperDir, `${voiceId}.onnx`);
    const configPath = path.join(piperDir, `${voiceId}.onnx.json`);

    // Already on disk? Then this step needs no network at all.
    //
    // It used to download unconditionally, which broke the app's own offline
    // promise: in a BUNDLE_DEFAULT_MODELS build the shell seed-copies this exact
    // voice into <models>/piper at launch, yet the wizard still reached for
    // huggingface and failed the whole install with "Failed to reach voice
    // download" — for a file sitting right there. `installAll` aborts on the
    // first throw, so one unreachable voice discarded the rest of the run too.
    if (await bothFilesPresent(onnxPath, configPath)) {
      await this.deps.store.addPiperVoice(voiceId);
      this.emitProgress(item, 100, `Voice "${voice.label}" already present.`);
      this.deps.bus.emit({ type: 'item-done', item });
      return;
    }

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
   * Stream a remote file to disk, with retry + RESUME.
   *
   * Bytes land in `<dest>.download` and are renamed only once the transfer is
   * complete, so a partial never looks like an installed model. On a mid-stream
   * failure the partial is KEPT and the next attempt asks for
   * `Range: bytes=<size>-`, because the old behavior — one attempt, delete the
   * partial, collapse every failure into "(HTTP nnn)" — restarted a 64 MB voice
   * from zero on every hiccup and told the user nothing about why.
   *
   * A truncated-but-"ok" response (a proxy that cuts the connection after a 200)
   * is caught by the content-length check before the rename, instead of being
   * renamed into place as a valid-looking voice that fails much later as a
   * broken dub.
   */
  private async downloadFile(
    url: string,
    destPath: string,
    item: string,
    label: string,
    quiet = false,
  ): Promise<void> {
    const tmpPath = `${destPath}.download`;
    let lastError: AppErrorException | undefined;

    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      const resumeFrom = await fileSizeOrZero(tmpPath);
      try {
        await this.downloadAttempt(url, tmpPath, item, label, quiet, resumeFrom);
        await fsp.rename(tmpPath, destPath);
        return;
      } catch (err) {
        if (!(err instanceof AppErrorException)) throw err;
        lastError = err;
        // A permanent failure (moved/forbidden) is not worth four tries, and its
        // partial will never be resumable against the new address.
        if (permanentFailures.has(err)) {
          await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
          throw err;
        }
        if (attempt === DOWNLOAD_ATTEMPTS) break;
        const waitMs = DOWNLOAD_BACKOFF_MS[attempt - 1] ?? 8000;
        this.emitProgress(item, null, `Retrying "${label}" (attempt ${attempt + 1} of ${DOWNLOAD_ATTEMPTS})…`);
        await this.sleep(waitMs);
      }
    }
    // The partial stays on disk on purpose: the user's own retry resumes it.
    throw lastError ?? new AppErrorException('TTS_VOICE_MISSING', `Voice download failed for "${label}".`);
  }

  /** One transfer attempt, resuming from `resumeFrom` bytes when possible. */
  private async downloadAttempt(
    url: string,
    tmpPath: string,
    item: string,
    label: string,
    quiet: boolean,
    resumeFrom: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        redirect: 'follow',
        ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
      });
    } catch (err) {
      throw new AppErrorException('TTS_VOICE_MISSING', `Failed to reach the download for "${label}".`, {
        cause: err instanceof Error ? err.message : String(err),
        remediation: 'Check your network connection (or proxy/VPN) and retry.',
      });
    }

    if (!response.ok || !response.body) {
      const { message, remediation } = describeDownloadFailure(response.status);
      const error = new AppErrorException('TTS_VOICE_MISSING', `Could not download "${label}" — ${message}.`, {
        cause: url,
        remediation,
      });
      if (!isRetryableStatus(response.status)) permanentFailures.add(error);
      throw error;
    }

    // 206 = the server honored the range and is sending the REST of the file;
    // anything else (notably a plain 200) means it is sending the whole file
    // again, so the partial must be overwritten rather than appended to.
    const resuming = resumeFrom > 0 && response.status === 206;
    const startAt = resuming ? resumeFrom : 0;
    if (resuming) {
      this.emitProgress(item, null, `Resuming "${label}" at ${Math.round(startAt / 1_048_576)} MB…`);
    }

    const totalHeader = response.headers.get('content-length');
    const remaining = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
    const total = Number.isFinite(remaining) && remaining > 0 ? remaining + startAt : NaN;
    const hasTotal = Number.isFinite(total) && total > 0;

    let received = startAt;
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
        received += chunk.length;
        if (!quiet && hasTotal) {
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
      await streamPipeline(nodeStream, counter, createWriteStream(tmpPath, { flags: resuming ? 'a' : 'w' }));
    } catch (err) {
      // Keep the partial: the next attempt resumes from exactly here.
      throw new AppErrorException('TTS_VOICE_MISSING', `The download for "${label}" was interrupted.`, {
        cause: err instanceof Error ? err.message : String(err),
        remediation: 'It will resume automatically; if it keeps failing, check your network or proxy.',
      });
    }

    // Truncated-but-"ok": a proxy that cut the connection after a 200 leaves a
    // short file that would otherwise be renamed into place as a valid voice.
    if (hasTotal) {
      const onDisk = await fileSizeOrZero(tmpPath);
      if (onDisk < total) {
        throw new AppErrorException(
          'TTS_VOICE_MISSING',
          `The download for "${label}" ended early (${onDisk} of ${total} bytes).`,
          {
            cause: url,
            remediation: 'It will resume automatically; a proxy or VPN cutting connections is the usual cause.',
          },
        );
      }
    }
  }

  /** Backoff sleep (injected in tests so retries are instant). */
  private sleep(ms: number): Promise<void> {
    if (this.deps.sleepImpl) return this.deps.sleepImpl(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ----- Event helpers -----------------------------------------------------

  /**
   * Await a long, opaque worker download while keeping the UI visibly alive.
   * The worker `…/ensure` calls block for the whole download and report no
   * byte progress, so we tick a 1 Hz heartbeat carrying elapsed time. The bar
   * stays indeterminate (percent `null`), but the climbing timer proves work is
   * happening and sets the expectation that a large first-run model can take a
   * few minutes — without it the message sat frozen and looked hung.
   */
  private async withHeartbeat<T>(item: string, label: string, work: Promise<T>): Promise<T> {
    const start = Date.now();
    const timer = setInterval(() => {
      this.emitProgress(item, null, `${label}… ${formatElapsed(Date.now() - start)} elapsed`);
    }, 1000);
    try {
      return await work;
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Like {@link withHeartbeat}, but reports a TRUE percentage for the whisper
   * model by polling the HF cache dir the worker downloads into. The worker call
   * is one opaque blocking POST, so we watch `<cache>/<repo>/blobs` grow against
   * the catalog's approximate size. Caps at 99% (the bytes can hit 100% before
   * hf finishes verifying/renaming the `.incomplete` blob and the worker resolves)
   * and falls back to the elapsed-time heartbeat whenever a percentage can't be
   * computed yet (dir not created, unknown size, or a divergent cache path).
   */
  private async withWhisperProgress<T>(
    item: string,
    label: string,
    model: string,
    work: Promise<T>,
  ): Promise<T> {
    const blobsDir = path.join(
      this.deps.config.whisperCacheDir,
      whisperRepoDirName(model),
      'blobs',
    );
    const totalBytes = (findWhisperModel(model)?.approxSizeMb ?? 0) * 1024 * 1024;
    const start = Date.now();
    let ticking = false; // guard so a slow stat can't overlap the next tick
    let settled = false; // set when work resolves; suppress a late in-flight tick
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void dirSize(blobsDir)
        .then((bytes) => {
          if (settled) return; // the caller is about to emit the final 100%
          if (totalBytes > 0 && bytes > 0) {
            const percent = Math.min(99, Math.floor((bytes / totalBytes) * 100));
            this.emitProgress(item, percent, `${label}… ${percent}%`);
          } else {
            this.emitProgress(item, null, `${label}… ${formatElapsed(Date.now() - start)} elapsed`);
          }
        })
        .finally(() => {
          ticking = false;
        });
    }, 1000);
    try {
      return await work;
    } finally {
      settled = true;
      clearInterval(timer);
    }
  }

  private emitProgress(item: string, percent: number | null, message: string): void {
    this.deps.bus.emit({ type: 'progress', item, percent, message });
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.bus.emit({ type: 'log', level, message });
  }
}

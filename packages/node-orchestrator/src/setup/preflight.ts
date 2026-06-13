/**
 * First-run preflight (self-check).
 *
 * Produces a {@link PreflightResult} the onboarding wizard renders as a list of
 * pass/warn/fail checks. Verifies, in parallel:
 *   - ffmpeg / ffprobe answer `-version` (sidecars in bundled mode, PATH in dev)
 *   - each Python worker answers `GET /health`
 *   - basic network reachability (a HEAD to a known host, short timeout)
 *   - free disk space in the models directory (best-effort via fs.statfs)
 *
 * Network and disk are warnings (not hard failures): the user may be offline at
 * first launch yet still want to proceed, and statfs is not available on every
 * platform.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PreflightCheck, PreflightResult } from '@videodubber/shared';
import type { OrchestratorConfig } from '../config.js';
import { probeBinary } from '../health.js';
import { probeWorkerHealth } from '../providers/workerHttp.js';

/** A host used purely to test outbound network reachability. */
const NETWORK_PROBE_URL = 'https://huggingface.co';

/** Recommended free space (MB) for a comfortable first-run model download. */
const RECOMMENDED_FREE_MB = 5000;

/** Injectable hooks so preflight is unit-testable without real I/O. */
export interface PreflightDeps {
  /** Probe a binary by `-version`. Defaults to the health-module probe. */
  probeBinary?: typeof probeBinary;
  /** Probe a worker `/health`. Defaults to the workerHttp probe. */
  probeWorkerHealth?: typeof probeWorkerHealth;
  /** Network reachability probe (returns true if the host is reachable). */
  probeNetwork?: (url: string) => Promise<boolean>;
  /** Free-space probe for a directory, in megabytes (or undefined if unknown). */
  freeSpaceMb?: (dir: string) => Promise<number | undefined>;
  /**
   * How long (ms) to keep re-probing an unreachable worker before failing it.
   * The bundled Python workers (PyInstaller one-file) take several seconds to
   * boot on first launch — one-file extraction + heavy imports (ctranslate2,
   * argostranslate). Without this, the first self-check fires before they're up
   * and shows a scary "not reachable" that turns green on the next re-check.
   * Retrying makes the first check simply wait. Default 45000; tests pass 0.
   */
  workerReadyTimeoutMs?: number;
  /** Poll interval (ms) between worker readiness re-probes. Default 1000. */
  workerPollIntervalMs?: number;
}

/** Resolve after `ms` (never throws). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default network probe: a HEAD request with a short timeout. Never throws. */
async function defaultProbeNetwork(url: string): Promise<boolean> {
  const controller = new AbortController();
  // 8s (not 4s): on slow/flaky international links a short timeout false-negatives
  // as "offline". This is only a warning, so erring toward patience is cheap.
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default free-space probe using `fs.statfs` (Node 18.15+). Walks up to the
 * nearest existing ancestor so it works even before the models dir is created.
 * Returns undefined when statfs is unavailable on the platform.
 */
async function defaultFreeSpaceMb(dir: string): Promise<number | undefined> {
  const statfs = (fsp as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs;
  if (typeof statfs !== 'function') return undefined;

  let target = path.resolve(dir);
  // Walk up to an existing directory (statfs needs a real path).
  for (let i = 0; i < 16; i++) {
    try {
      await fsp.access(target);
      break;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
  }

  try {
    const stats = await statfs(target);
    const freeBytes = stats.bavail * stats.bsize;
    return Math.floor(freeBytes / (1024 * 1024));
  } catch {
    return undefined;
  }
}

/** Build a single binary check result. */
async function checkBinary(
  id: string,
  label: string,
  binPath: string | undefined,
  defaultName: string,
  probe: typeof probeBinary,
): Promise<PreflightCheck> {
  const result = await probe(binPath ?? defaultName);
  if (result.available) {
    return { id, label, status: 'ok', detail: result.detail };
  }
  return {
    id,
    label,
    status: 'fail',
    detail: result.detail ?? `${defaultName} not found`,
    remediation: `Ensure the bundled ${defaultName} sidecar is present, or install ${defaultName} and put it on PATH.`,
  };
}

/** Build a single worker health check result.
 *
 * Re-probes until the worker is reachable or `timeoutMs` elapses, so a worker
 * still booting on first launch resolves to "ok" rather than a transient "fail".
 */
async function checkWorker(
  id: string,
  label: string,
  url: string,
  workerName: string,
  probe: typeof probeWorkerHealth,
  timeoutMs: number,
  pollMs: number,
): Promise<PreflightCheck> {
  let result = await probe(url, workerName);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!result.available && Date.now() < deadline) {
    await delay(Math.max(1, pollMs));
    result = await probe(url, workerName);
  }
  if (result.available) {
    return { id, label, status: 'ok', detail: result.detail };
  }
  return {
    id,
    label,
    status: 'fail',
    detail: result.detail ?? `${workerName} unreachable at ${url}`,
    remediation: `Start the ${workerName} (in development run scripts/start-services.sh). In the installed app it runs as a bundled service — restart the app if it did not start.`,
  };
}

/**
 * Run all preflight checks and aggregate into a {@link PreflightResult}.
 * `ok` is true when no check has status "fail" (warnings do not block).
 */
export async function runPreflight(
  config: OrchestratorConfig,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const binProbe = deps.probeBinary ?? probeBinary;
  const workerProbe = deps.probeWorkerHealth ?? probeWorkerHealth;
  const netProbe = deps.probeNetwork ?? defaultProbeNetwork;
  const freeProbe = deps.freeSpaceMb ?? defaultFreeSpaceMb;
  // Give still-booting workers a window to come up before failing them (see
  // workerReadyTimeoutMs). Each worker check retries independently in parallel,
  // so the self-check returns as soon as all three are up (or the timeout hits).
  // 45s: measured one-file PyInstaller cold start is ~26s (3 workers extracting
  // to temp at once); leave headroom for slower disks. One-dir builds boot far
  // faster, so this ceiling is then only hit on a genuine failure.
  const workerTimeout = deps.workerReadyTimeoutMs ?? 45000;
  const workerPoll = deps.workerPollIntervalMs ?? 1000;

  const [ffmpeg, ffprobe, stt, translation, tts, reachable, freeMb] = await Promise.all([
    checkBinary('ffmpeg', 'FFmpeg', config.ffmpegPath, 'ffmpeg', binProbe),
    checkBinary('ffprobe', 'FFprobe', config.ffprobePath, 'ffprobe', binProbe),
    checkWorker('stt-worker', 'Speech-to-text service', config.sttWorkerUrl, 'STT worker', workerProbe, workerTimeout, workerPoll),
    checkWorker('translation-worker', 'Translation service', config.translationWorkerUrl, 'Translation worker', workerProbe, workerTimeout, workerPoll),
    checkWorker('tts-worker', 'Text-to-speech service', config.ttsWorkerUrl, 'TTS worker', workerProbe, workerTimeout, workerPoll),
    netProbe(NETWORK_PROBE_URL),
    freeProbe(config.modelsDir),
  ]);

  const network: PreflightCheck = reachable
    ? { id: 'network', label: 'Internet connection', status: 'ok', detail: 'Reachable' }
    : {
        id: 'network',
        label: 'Internet connection',
        status: 'warn',
        detail: 'Could not reach the model download host.',
        remediation: 'You can continue, but downloading models requires an internet connection.',
      };

  const disk = buildDiskCheck(freeMb);

  const checks: PreflightCheck[] = [ffmpeg, ffprobe, stt, translation, tts, network, disk];
  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks };
}

/** Build the disk-space check from a (possibly unknown) free-MB value. */
function buildDiskCheck(freeMb: number | undefined): PreflightCheck {
  if (freeMb === undefined) {
    return {
      id: 'disk',
      label: 'Free disk space',
      status: 'warn',
      detail: 'Could not determine free disk space on this platform.',
      remediation: 'Make sure you have at least a few GB free for the AI models.',
    };
  }
  if (freeMb < RECOMMENDED_FREE_MB) {
    return {
      id: 'disk',
      label: 'Free disk space',
      status: 'warn',
      detail: `${(freeMb / 1024).toFixed(1)} GB free (recommend ${(RECOMMENDED_FREE_MB / 1024).toFixed(0)} GB+).`,
      remediation: 'Free up disk space before downloading larger models.',
    };
  }
  return {
    id: 'disk',
    label: 'Free disk space',
    status: 'ok',
    detail: `${(freeMb / 1024).toFixed(1)} GB free`,
  };
}

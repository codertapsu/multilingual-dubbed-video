/**
 * Aggregate health checks for the `/workers/health` endpoint.
 *
 * Probes the three Python workers (STT / translation / TTS) over HTTP and the
 * two local binaries (ffmpeg / ffprobe) by spawning `<bin> -version`.
 *
 * Binary checks use argv arrays only (no shell). The media-worker package may
 * provide a richer `checkAvailability`, but this self-contained probe keeps the
 * orchestrator independent and testable.
 */
import { spawn } from 'node:child_process';
import type { OrchestratorConfig } from './config.js';
import { probeWorkerHealth } from './providers/workerHttp.js';

/** Availability result for one dependency. */
export interface AvailabilityResult {
  available: boolean;
  detail?: string;
}

/** Full health snapshot returned by GET /workers/health. */
export interface WorkersHealth {
  stt: AvailabilityResult;
  translation: AvailabilityResult;
  tts: AvailabilityResult;
  ffmpeg: AvailabilityResult;
  ffprobe: AvailabilityResult;
}

/** Probe a binary by running `<bin> -version`. Never throws. */
export function probeBinary(binPath: string, timeoutMs = 3000): Promise<AvailabilityResult> {
  return new Promise<AvailabilityResult>((resolve) => {
    let settled = false;
    const finish = (result: AvailabilityResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      finish({ available: false, detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false, detail: 'version check timed out' });
    }, timeoutMs);

    let firstLine = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (firstLine === '') firstLine = chunk.toString('utf8').split('\n')[0]?.trim() ?? '';
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ available: false, detail: err.message });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish(firstLine ? { available: true, detail: firstLine } : { available: true });
      } else {
        finish({ available: false, detail: `exited with code ${code}` });
      }
    });
  });
}

/** Run all health checks in parallel. */
export async function checkWorkersHealth(config: OrchestratorConfig): Promise<WorkersHealth> {
  const [stt, translation, tts, ffmpeg, ffprobe] = await Promise.all([
    probeWorkerHealth(config.sttWorkerUrl, 'STT worker'),
    probeWorkerHealth(config.translationWorkerUrl, 'Translation worker'),
    probeWorkerHealth(config.ttsWorkerUrl, 'TTS worker'),
    probeBinary(config.ffmpegPath ?? 'ffmpeg'),
    probeBinary(config.ffprobePath ?? 'ffprobe'),
  ]);
  return { stt, translation, tts, ffmpeg, ffprobe };
}

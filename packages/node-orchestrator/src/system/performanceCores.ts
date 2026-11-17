/**
 * How many threads a CPU-bound engine should use: the machine's PERFORMANCE
 * cores.
 *
 * Left to themselves llama.cpp counts every physical core on Windows, E-cores
 * included (10 on an i5-13400F with 6 P-cores), and whisper-server uses 4
 * whatever the machine. The STT worker measured what that costs: on that same
 * CPU, transcription on all 16 threads ran 12% slower than on the 6 P-cores,
 * because the work waits at every barrier for the slowest core.
 *
 * Counting P-cores needs a native API on Windows (GetLogicalProcessorInformationEx
 * efficiency classes) that Node does not expose, and the STT worker already
 * does it — tested per OS in workers/stt-worker/app/cpu.py — so it reports the
 * count in /health and this reads it. Unknown (an older worker, not running)
 * means "pass nothing": the engines keep their own default.
 */
import { getWorkerJson } from '../providers/workerHttp.js';

/** Reads the STT worker's performance-core count once, then remembers it. */
export function performanceCoresFromSttWorker(sttWorkerUrl: string): () => Promise<number | undefined> {
  let known: number | undefined;
  const url = `${sttWorkerUrl.replace(/\/$/, '')}/health`;
  return async () => {
    if (known !== undefined) return known;
    try {
      const health = await getWorkerJson<{ cpu_threads?: unknown }>(url, { timeoutMs: 3000, workerName: 'STT worker' });
      const n = health.cpu_threads;
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) known = n;
    } catch {
      /* not up yet, or an older worker: try again next time */
    }
    return known;
  };
}

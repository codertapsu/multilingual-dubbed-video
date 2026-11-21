/**
 * The backend's own health, and evidence for the day it dies.
 *
 * On 2026-11-21 the backend ended with 0xC0000409 (a fast-fail: a V8 fatal
 * error, an abort in native code) after 18 hours, mid-dub with two 2 GB
 * downloads running, and left nothing to say why: no stderr line, no report,
 * no memory figure. Two things change that:
 *
 * - {@link installNativeCrashEvidence}: Node writes a diagnostic report (heap,
 *   native stack, handles, resource usage) on a fatal error into
 *   `<config>/logs/crash/`, and stderr is made blocking so the last lines
 *   before an abort reach the log. The JavaScript errors already had their own
 *   report (server.ts `fatal`).
 * - {@link HealthMonitor}: every minute, memory and the event loop's delay,
 *   kept for the last hour (Settings → Diagnostics, the plugin's
 *   get_diagnostics) and logged while work runs, with a warning when the loop
 *   stalls for a second: a backend that is alive but not answering reads as
 *   "crashed" in the UI otherwise.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';

import type { BackendCrash, HealthSample } from '@videodubber/shared';

const MB = 1024 * 1024;
const round = (n: number): number => Math.round(n * 10) / 10;

/** Turn Node's crash reporting on, into `<logsDir>/crash`; returns the heap limit. */
export function installNativeCrashEvidence(logsDir: string, log: (message: string) => void = () => undefined): { heapLimitMb: number; dir: string } {
  const dir = path.join(logsDir, 'crash');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the report then goes to the working directory: better than nothing */
  }
  try {
    process.report.directory = dir;
    process.report.reportOnFatalError = true;
    process.report.compact = true;
  } catch {
    /* a runtime without diagnostic reports */
  }
  try {
    // Pipes are asynchronous on POSIX: the last words before an abort were lost.
    (process.stderr as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking?.(true);
  } catch {
    /* not a pipe */
  }
  const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / MB);
  log(`[orchestrator] heap limit ${heapLimitMb} MB; native crash reports go to ${dir}`);
  return { heapLimitMb, dir };
}

/**
 * The crash the shell restarted this backend after (it writes
 * `<logsDir>/backend-crash.json` before the restart). Read once: the file is
 * moved into `crash/` so the next start does not count it again.
 */
export function takeRecoveredCrash(logsDir: string): BackendCrash | undefined {
  const file = path.join(logsDir, 'backend-crash.json');
  if (!existsSync(file)) return undefined;
  let crash: BackendCrash | undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackendCrash>;
    if (typeof raw.at === 'string') {
      crash = {
        at: raw.at,
        ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
        ...(typeof raw.codeHex === 'string' ? { codeHex: raw.codeHex } : {}),
        ...(typeof raw.meaning === 'string' ? { meaning: raw.meaning } : {}),
        ...(typeof raw.uptimeSec === 'number' ? { uptimeSec: raw.uptimeSec } : {}),
      };
    }
  } catch {
    /* unreadable: still moved aside below */
  }
  try {
    mkdirSync(path.join(logsDir, 'crash'), { recursive: true });
    renameSync(file, path.join(logsDir, 'crash', `backend-crash-${(crash?.at ?? new Date().toISOString()).replace(/[:.]/g, '-')}.json`));
  } catch {
    /* a marker that stays is read again next start: harmless */
  }
  return crash;
}

/** One sample from Node's own figures. Pure. */
export function sampleOf(
  mem: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers'>,
  lag: { p99Ns: number; maxNs: number },
  freeRamShare: number,
  at: Date,
): HealthSample {
  return {
    at: at.toISOString(),
    rssMb: round(mem.rss / MB),
    heapUsedMb: round(mem.heapUsed / MB),
    heapTotalMb: round(mem.heapTotal / MB),
    externalMb: round(mem.external / MB),
    arrayBuffersMb: round(mem.arrayBuffers / MB),
    lagP99Ms: round(Math.max(0, lag.p99Ns) / 1e6),
    lagMaxMs: round(Math.max(0, lag.maxNs) / 1e6),
    freeRamShare: Math.round(Math.max(0, Math.min(1, freeRamShare)) * 1000) / 1000,
  };
}

/** When the app counts as short of breath (the download gate holds downloads then). */
export const PRESSURE_LAG_MS = 500;
export const PRESSURE_FREE_RAM_SHARE = 0.15;
/** A stall worth a warning in the log. */
export const STALL_WARN_MS = 1000;

export interface HealthMonitorDeps {
  logger?: { info(message: string): void; warn(message: string): void };
  /** Whether work is running (samples are logged then, not when idle). */
  busy?: () => boolean;
  intervalMs?: number;
  /** Samples kept (the default, 90 at a minute each, is an hour and a half). */
  keep?: number;
  heapLimitMb?: number;
}

export class HealthMonitor {
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly ring: HealthSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private peakValues = { rssMb: 0, heapUsedMb: 0, lagMaxMs: 0 };
  readonly startedAt = new Date();

  constructor(private readonly deps: HealthMonitorDeps = {}) {}

  get heapLimitMb(): number {
    return this.deps.heapLimitMb ?? Math.round(v8.getHeapStatistics().heap_size_limit / MB);
  }

  start(): void {
    if (this.timer) return;
    this.histogram.enable();
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.histogram.disable();
  }

  /** Take a sample now (the timer's job; tests call it). */
  tick(now = new Date()): HealthSample {
    const h = this.histogram;
    const lag = h.count > 0 ? { p99Ns: h.percentile(99), maxNs: h.max } : { p99Ns: 0, maxNs: 0 };
    const sample = sampleOf(process.memoryUsage(), lag, os.freemem() / Math.max(1, os.totalmem()), now);
    h.reset();
    this.ring.push(sample);
    const keep = this.deps.keep ?? 90;
    if (this.ring.length > keep) this.ring.splice(0, this.ring.length - keep);
    this.peakValues = {
      rssMb: Math.max(this.peakValues.rssMb, sample.rssMb),
      heapUsedMb: Math.max(this.peakValues.heapUsedMb, sample.heapUsedMb),
      lagMaxMs: Math.max(this.peakValues.lagMaxMs, sample.lagMaxMs),
    };
    if (sample.lagMaxMs >= STALL_WARN_MS) {
      this.deps.logger?.warn(`[health] the event loop stalled for ${Math.round(sample.lagMaxMs)} ms (p99 ${Math.round(sample.lagP99Ms)} ms) ${JSON.stringify(sample)}`);
    } else if (this.deps.busy?.()) {
      this.deps.logger?.info(`[health] ${JSON.stringify(sample)}`);
    }
    return sample;
  }

  samples(): HealthSample[] {
    return [...this.ring];
  }

  latest(): HealthSample | undefined {
    return this.ring.at(-1);
  }

  peak(): { rssMb: number; heapUsedMb: number; lagMaxMs: number } {
    return { ...this.peakValues };
  }

  /**
   * Short of breath right now: the loop's delay since the last sample, or
   * free memory. Fresh, unlike the minute-old sample.
   */
  pressure(): boolean {
    const h = this.histogram;
    const lagMs = h.count > 0 ? h.percentile(99) / 1e6 : 0;
    return lagMs > PRESSURE_LAG_MS || os.freemem() / Math.max(1, os.totalmem()) < PRESSURE_FREE_RAM_SHARE;
  }
}

/**
 * Safe process execution for FFmpeg / ffprobe.
 *
 * Hard rules enforced here:
 *  - We NEVER build a shell command string. Everything is spawned with an
 *    argv array (`spawn(bin, args)`), so untrusted paths/text can never be
 *    interpreted by a shell. `shell` is left at its default (false).
 *  - Binaries are resolved from FFMPEG_PATH / FFPROBE_PATH env vars, falling
 *    back to "ffmpeg"/"ffprobe" on PATH.
 *  - ENOENT (binary not found) is surfaced as a typed AppError.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  AppErrorException,
  toAppError,
  type AppError,
  type ErrorCode,
} from '@videodubber/shared';

/** Callback invoked for every stderr/stdout line while a process runs. */
export type LogCallback = (line: string) => void;

/** Options shared by runFfmpeg / runFfprobe. */
export interface RunOptions {
  /** Streamed line-by-line as the process emits stderr (ffmpeg progress) / stdout. */
  onLog?: LogCallback;
  /** Abort the running process (maps to a CANCELLED AppError). */
  signal?: AbortSignal;
  /** Hard timeout in ms. If exceeded the process is killed -> WORKER_TIMEOUT. */
  timeoutMs?: number;
  /** Working directory for the child process. */
  cwd?: string;
}

/** Result of a finished process. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DOCS_REF = 'docs/TROUBLESHOOTING.md#ffmpeg';

/** Resolve the ffmpeg binary path (env override -> PATH lookup). */
export function resolveFfmpegBinary(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

/** Resolve the ffprobe binary path (env override -> PATH lookup). */
export function resolveFfprobeBinary(): string {
  return process.env.FFPROBE_PATH?.trim() || 'ffprobe';
}

/** Convenience bundle for the orchestrator's /workers/health. */
export function resolveBinaries(): { ffmpeg: string; ffprobe: string } {
  return { ffmpeg: resolveFfmpegBinary(), ffprobe: resolveFfprobeBinary() };
}

/**
 * Split a chunk of process output into complete lines, keeping any trailing
 * partial line in `carry` for the next chunk. Returns [lines, newCarry].
 */
function splitLines(carry: string, chunk: string): [string[], string] {
  const combined = carry + chunk;
  const parts = combined.split(/\r?\n|\r/);
  // The last element is an incomplete line (no terminator yet).
  const remainder = parts.pop() ?? '';
  return [parts, remainder];
}

/**
 * Core spawn helper. Always argv-array based. `notFoundCode` lets the caller
 * map ENOENT to FFMPEG_NOT_FOUND vs FFPROBE_NOT_FOUND.
 */
function run(
  bin: string,
  args: string[],
  notFoundCode: ErrorCode,
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(
        new AppErrorException({
          code: 'CANCELLED',
          message: 'Operation was cancelled before it started.',
        }),
      );
      return;
    }

    // shell:false (default) — args are passed verbatim, no shell parsing.
    const child = spawn(bin, args, { cwd: opts.cwd, shell: false });

    let stdout = '';
    let stderr = '';
    let stdoutCarry = '';
    let stderrCarry = '';
    let timedOut = false;
    let settled = false;

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stdout += text;
      if (opts.onLog) {
        const [lines, carry] = splitLines(stdoutCarry, text);
        stdoutCarry = carry;
        for (const line of lines) opts.onLog(line);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      stderr += text;
      // ffmpeg writes ALL progress to stderr, so this is the primary log feed.
      if (opts.onLog) {
        const [lines, carry] = splitLines(stderrCarry, text);
        stderrCarry = carry;
        for (const line of lines) opts.onLog(line);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT') {
        reject(
          new AppErrorException({
            code: notFoundCode,
            message: `Could not find the "${bin}" binary on this system.`,
            cause: err.message,
            remediation:
              notFoundCode === 'FFMPEG_NOT_FOUND'
                ? 'Install FFmpeg and ensure it is on your PATH, or set the FFMPEG_PATH environment variable to the ffmpeg binary.'
                : 'Install FFmpeg (which ships ffprobe) and ensure it is on your PATH, or set the FFPROBE_PATH environment variable to the ffprobe binary.',
            docsRef: DOCS_REF,
          }),
        );
        return;
      }
      reject(
        new AppErrorException({
          code: 'UNKNOWN',
          message: `Failed to start "${bin}": ${err.message}`,
          cause: err.message,
          docsRef: DOCS_REF,
        }),
      );
    });

    child.on('close', (code, killSignal) => {
      if (settled) return;
      settled = true;
      cleanup();

      // Flush any trailing partial lines to the log callback.
      if (opts.onLog) {
        if (stdoutCarry) opts.onLog(stdoutCarry);
        if (stderrCarry) opts.onLog(stderrCarry);
      }

      if (timedOut) {
        reject(
          new AppErrorException({
            code: 'WORKER_TIMEOUT',
            message: `"${bin}" timed out after ${opts.timeoutMs}ms.`,
            docsRef: DOCS_REF,
          }),
        );
        return;
      }

      if (opts.signal?.aborted || killSignal === 'SIGKILL') {
        reject(
          new AppErrorException({
            code: 'CANCELLED',
            message: `"${bin}" was cancelled.`,
          }),
        );
        return;
      }

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new AppErrorException({
            code: 'UNKNOWN',
            message: `"${bin}" exited with code ${exitCode}.`,
            // Include the tail of stderr — that's where ffmpeg reports the real error.
            cause: tail(stderr, 4000),
            docsRef: DOCS_REF,
          }),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}

/** Keep only the last `n` characters of a string (for trimming long stderr). */
function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

/** Run ffmpeg with an argv array. ENOENT -> FFMPEG_NOT_FOUND. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(resolveFfmpegBinary(), args, 'FFMPEG_NOT_FOUND', opts);
}

/** Run ffprobe with an argv array. ENOENT -> FFPROBE_NOT_FOUND. */
export function runFfprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(resolveFfprobeBinary(), args, 'FFPROBE_NOT_FOUND', opts);
}

/**
 * Validate that an input file exists and is readable.
 * Throws an AppError (UNSUPPORTED_MEDIA) if not.
 */
export function assertInputReadable(inputPath: string): void {
  const abs = resolvePath(inputPath);
  try {
    accessSync(abs, fsConstants.R_OK);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new AppErrorException({
      code: 'UNSUPPORTED_MEDIA',
      message: `Input file does not exist or is not readable: ${inputPath}`,
      cause,
      remediation: 'Verify the file path is correct and that you have read permission.',
      docsRef: DOCS_REF,
    });
  }
}

/**
 * Validate that an output path's parent directory exists and is writable.
 * Throws OUTPUT_NOT_WRITABLE otherwise. (We do not create the directory here;
 * the orchestrator owns workspace creation.)
 */
export function assertOutputWritable(outputPath: string): void {
  const parent = dirname(resolvePath(outputPath));
  try {
    accessSync(parent, fsConstants.W_OK);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new AppErrorException({
      code: 'OUTPUT_NOT_WRITABLE',
      message: `Output directory is not writable: ${parent}`,
      cause,
      remediation: 'Ensure the destination folder exists and your user can write to it.',
      docsRef: 'docs/TROUBLESHOOTING.md#output',
    });
  }
}

/**
 * Cache of the set of available libavfilter names, keyed by the resolved ffmpeg
 * binary (so changing FFMPEG_PATH re-queries). `ffmpeg -filters` is parsed for
 * the name column. On any failure we cache an empty set; callers treat "unknown"
 * as "not available" and surface FFMPEG_NOT_FOUND/FFMPEG_FILTER_MISSING.
 */
const _filtersByBinary = new Map<string, Promise<Set<string>>>();

/**
 * Parse the name column out of `ffmpeg -filters` output. Pure (testable).
 * Rows look like: " T.. subtitles         V->V       <description>"
 * (3-char flag column, name, in->out signature, description).
 */
export function parseFfmpegFilters(stdout: string): Set<string> {
  const names = new Set<string>();
  // The flag column width varies across ffmpeg builds ("...", "T..", " .." etc.),
  // so don't anchor on it. Instead key off the "in->out" signature token (e.g.
  // "V->V", "N->A", "|->A"): the filter NAME is the token immediately before it.
  const SIGNATURE = /^[a-zA-Z|.]+->[a-zA-Z|.]+$/;
  for (const line of stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const sigIdx = tokens.findIndex((t) => SIGNATURE.test(t));
    if (sigIdx >= 1) {
      const name = tokens[sigIdx - 1];
      if (name && /^[A-Za-z0-9_]+$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** List the libavfilter filter names this ffmpeg build provides (cached). */
export async function listFfmpegFilters(opts: RunOptions = {}): Promise<Set<string>> {
  const bin = resolveFfmpegBinary();
  let cached = _filtersByBinary.get(bin);
  if (!cached) {
    cached = runFfmpeg(['-hide_banner', '-filters'], { timeoutMs: 10_000, ...opts })
      .then((r) => parseFfmpegFilters(r.stdout))
      .catch(() => new Set<string>());
    _filtersByBinary.set(bin, cached);
  }
  return cached;
}

/** True if this ffmpeg build exposes the named libavfilter filter. */
export async function ffmpegHasFilter(name: string, opts: RunOptions = {}): Promise<boolean> {
  return (await listFfmpegFilters(opts)).has(name);
}

/** Probe whether a binary is runnable (used by /workers/health). */
export async function checkBinaryAvailable(
  kind: 'ffmpeg' | 'ffprobe',
): Promise<{ available: boolean; detail?: string }> {
  const bin = kind === 'ffmpeg' ? resolveFfmpegBinary() : resolveFfprobeBinary();
  try {
    const result =
      kind === 'ffmpeg'
        ? await runFfmpeg(['-version'], { timeoutMs: 10_000 })
        : await runFfprobe(['-version'], { timeoutMs: 10_000 });
    // First line of -version output, e.g. "ffmpeg version 6.1.1 ...".
    const detail = result.stdout.split(/\r?\n/, 1)[0]?.trim() || `${bin} available`;
    return { available: true, detail };
  } catch (err) {
    // toAppError is the documented normalizer in @videodubber/shared; it
    // unwraps AppErrorException and wraps anything else into an AppError.
    const detail = toAppError(err).message;
    return { available: false, detail };
  }
}

/** Re-export so callers can build their own AppError without importing shared twice. */
export type { AppError };

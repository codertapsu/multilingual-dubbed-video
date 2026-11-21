/**
 * Log files the app keeps for itself (Phase 7 of
 * docs/plans/production-hardening-2026-11.md), each capped in size:
 *
 * - `logs/engines/<pack>.log`: everything an engine pack writes to stderr,
 *   with its start and exit. Speaker detection answered HTTP 500 after three
 *   hours on 2026-11-21, and its traceback was nowhere: the engine's output was
 *   kept only as a 4 KB tail for start-up failures.
 * - `logs/orchestrator.jsonl`: one JSON object per line (time, level, message,
 *   and the ids that tie lines together: project, run, HTTP request, the
 *   plugin's request), for support bundles and get_diagnostics.
 *
 * Writes are synchronous appends: a few lines a second at most, and a line
 * written just before a crash must be on disk.
 */
import { appendFileSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

/** An append-only text file that rolls over to `<name>.1` … when it grows past `maxBytes`. */
export class RotatingLog {
  private size: number;

  constructor(
    readonly file: string,
    private readonly maxBytes = 5 * MB,
    private readonly keep = 2,
  ) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* writes will fail quietly */
    }
    this.size = sizeOf(file);
    if (this.size > this.maxBytes) this.rotate();
  }

  write(text: string): void {
    if (!text) return;
    try {
      // Roll over BEFORE a write that would pass the cap: the newest lines
      // always stay in the file itself.
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.file, text, 'utf8');
      this.size += bytes;
    } catch {
      /* a log that cannot be written must never break the work it describes */
    }
  }

  private rotate(): void {
    try {
      for (let i = this.keep - 1; i >= 1; i--) renameQuiet(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      renameQuiet(this.file, `${this.file}.1`);
      rmSync(`${this.file}.${this.keep + 1}`, { force: true });
    } catch {
      /* keep appending to the big file rather than lose lines */
    }
    this.size = sizeOf(this.file);
  }
}

/** A file's size, 0 when it does not exist. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function renameQuiet(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    /* absent */
  }
}

/** The last `maxBytes` of a file (from a line start when it can), '' when absent. */
export function tailFile(file: string, maxBytes = 64 * 1024): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    if (length < size) {
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : text;
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Where an engine pack's output goes. */
export function engineLogFile(logsDir: string, packId: string): string {
  return path.join(logsDir, 'engines', `${packId.replace(/[^a-z0-9._-]/gi, '_')}.log`);
}

/** Each line of a chunk of engine output, stamped with the time it arrived. */
export function stampLines(chunk: string, now = new Date()): string {
  const at = now.toISOString();
  return chunk
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => `${at} ${l}\n`)
    .join('');
}

/** A line of the structured log. */
export interface LogRecord {
  level: 'info' | 'warn' | 'error';
  msg: string;
  projectId?: string;
  runId?: string;
  requestId?: string;
  /** The plugin's id for the tool call that caused it (X-Request-Id). */
  mcpRequestId?: string;
  [key: string]: unknown;
}

/** `logs/orchestrator.jsonl`: one JSON record per line, 5 files of 20 MB at most. */
export class StructuredLog {
  private readonly out: RotatingLog;

  constructor(logsDir: string, maxBytes = 20 * MB) {
    this.out = new RotatingLog(path.join(logsDir, 'orchestrator.jsonl'), maxBytes, 4);
  }

  get file(): string {
    return this.out.file;
  }

  write(record: LogRecord, now = new Date()): void {
    let line: string;
    try {
      line = JSON.stringify({ t: now.toISOString(), ...record });
    } catch {
      line = JSON.stringify({ t: now.toISOString(), level: record.level, msg: record.msg });
    }
    this.out.write(`${line}\n`);
  }

  /** The most recent records, newest last (for diagnostics). */
  recent(maxBytes = 256 * 1024): LogRecord[] {
    return tailFile(this.out.file, maxBytes)
      .split('\n')
      .flatMap((l) => {
        if (!l.trim()) return [];
        try {
          return [JSON.parse(l) as LogRecord];
        } catch {
          return [];
        }
      });
  }
}

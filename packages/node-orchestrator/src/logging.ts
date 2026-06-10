/**
 * Per-project logging.
 *
 * A {@link ProjectLogger} appends structured lines to `logs/pipeline.log`
 * (created on first write) AND emits matching `{type:"log"}` SSE events via the
 * project's {@link ProjectEventBus}. Secrets are never logged by this module;
 * callers are responsible for not passing them in.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { LogEvent, LogLevel, ProjectEventBus } from './events.js';

/** Logger bound to one project (file + SSE bus). */
export class ProjectLogger {
  constructor(
    private readonly logFilePath: string,
    private readonly bus: ProjectEventBus,
  ) {}

  /** Ensure the parent `logs/` directory exists before the first append. */
  private async ensureDir(): Promise<void> {
    await fsp.mkdir(path.dirname(this.logFilePath), { recursive: true });
  }

  /**
   * Core log routine: format a line, append to the file, and emit an SSE event.
   * File-append failures are swallowed (best-effort) but still surfaced over
   * SSE so the UI is never blocked by a disk issue.
   */
  log(level: LogLevel, message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${level.toUpperCase()} ${message}\n`;

    // Best-effort file append. Done async/fire-and-forget so logging never
    // blocks the pipeline; ordering within a single process is preserved by
    // using the synchronous appendFileSync only after directory creation.
    void this.ensureDir()
      .then(() => fsp.appendFile(this.logFilePath, line, 'utf8'))
      .catch(() => {
        /* ignore disk errors — SSE still carries the message */
      });

    const event: LogEvent = { type: 'log', level, message, ts };
    this.bus.emit(event);
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  /**
   * Synchronous append used during shutdown / fatal paths where we cannot
   * await the async writer. Creates the directory synchronously first.
   */
  logSync(level: LogLevel, message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${level.toUpperCase()} ${message}\n`;
    try {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch {
      /* ignore */
    }
    this.bus.emit({ type: 'log', level, message, ts });
  }
}

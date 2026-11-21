/**
 * A small client for the VideoDubber orchestrator's local HTTP API — the same
 * API the desktop UI uses, on 127.0.0.1:5100 by default. The MCP server is a
 * thin layer over it, so anything Claude does here the user can see (and undo)
 * in the app, and the pipeline's own safety rules (the readiness gate, atomic
 * writes, the run queue) apply to Claude exactly as to a click.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tool call an API request belongs to: sent as X-Request-Id, so the app's
 * structured log ties its lines to the call, and a tool's error can name them.
 */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** The orchestrator's error envelope (sendError in node-orchestrator/src/server.ts). */
interface ErrorEnvelope {
  error?: { code?: string; message?: string; remediation?: string; docsRef?: string };
}

/** An error the app reported: carries its code and, usually, how to fix it. */
export class VideoDubberApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'VideoDubberApiError';
  }
}

/** Nothing answers on the API port: the app (or `pnpm dev`) is not running. */
export class AppNotRunningError extends Error {
  constructor(readonly baseUrl: string) {
    super(`VideoDubber is not running (nothing answers at ${baseUrl}).`);
    this.name = 'AppNotRunningError';
  }
}

export interface ApiOptions {
  /** Default http://127.0.0.1:5100 (VIDEODUBBER_URL overrides it in stdio.ts). */
  baseUrl: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** Undici reports a refused connection as `TypeError: fetch failed` with the code on `cause`. */
function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'UND_ERR_SOCKET';
}

export class VideoDubberApi {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Is the orchestrator answering? Never throws. */
  async isUp(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  get<T>(path: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T>(path: string, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, opts);
  }

  put<T>(path: string, body: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  delete<T>(path: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }

  patch<T>(path: string, body: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('PATCH', path, body, opts);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      const requestId = requestContext.getStore()?.requestId;
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (isConnectionRefused(err)) throw new AppNotRunningError(this.baseUrl);
      throw err;
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const e = (parsed as ErrorEnvelope | undefined)?.error;
      throw new VideoDubberApiError(
        res.status,
        e?.code ?? `HTTP_${res.status}`,
        e?.message ?? `${method} ${path} failed with HTTP ${res.status}.`,
        e?.remediation,
      );
    }
    return parsed as T;
  }

  /**
   * Follow one of the app's Server-Sent-Event streams (`data: {...}` lines)
   * until `until` accepts an event, the stream ends, or the time runs out.
   * Returns the accepting event, or undefined on timeout/end.
   */
  async followEvents<E>(
    path: string,
    opts: {
      until: (event: E) => boolean;
      onEvent?: (event: E) => void;
      /** Called once the stream is open — subscribe-then-act callers wait for it. */
      onOpen?: () => void;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<E | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) return undefined;
        if (isConnectionRefused(err)) throw new AppNotRunningError(this.baseUrl);
        throw err;
      }
      if (!res.ok || !res.body) return undefined;
      opts.onOpen?.();
      const decoder = new TextDecoder();
      let buffered = '';
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return undefined;
          buffered += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (!data) continue; // a ": ping" heartbeat
            const event = safeJson(data) as E | undefined;
            if (event === undefined) continue;
            opts.onEvent?.(event);
            if (opts.until(event)) return event;
          }
        }
      } catch {
        return undefined; // aborted by the timeout or the caller
      } finally {
        reader.cancel().catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

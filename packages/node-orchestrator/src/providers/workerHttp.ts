/**
 * Shared HTTP helper for talking to the Python workers.
 *
 * Uses node:http / node:https rather than the global `fetch`. Why: Node's fetch
 * (undici) enforces an internal `headersTimeout` (~5 min) that fires independently
 * of our AbortController. A worker that sends no response until it finishes (e.g.
 * STT downloading a model + transcribing a long audio) gets killed at ~5 min and
 * surfaces as `TypeError: fetch failed`, which we then mis-map to WORKER_UNAVAILABLE
 * ("not reachable"). node:http has no such header timeout, so the only deadline is
 * our own AbortController (`workerRequestTimeoutMs`, default 30 min).
 *
 * Centralizes:
 *   - request timeouts via AbortController (the single source of truth)
 *   - mapping connection failures -> WORKER_UNAVAILABLE
 *   - mapping timeouts / cancellation -> WORKER_TIMEOUT / CANCELLED
 *   - decoding the workers' structured error envelope
 *     `{ error: { code, message, remediation, docsRef } }`
 */
import http from 'node:http';
import https from 'node:https';
import { AppErrorException, isAppError, type ErrorCode } from '@videodubber/shared';

/** Options for a worker JSON request. */
export interface WorkerRequestOptions {
  /** Absolute timeout in milliseconds. */
  timeoutMs: number;
  /** Optional AbortSignal to support pipeline cancellation. */
  signal?: AbortSignal;
  /** Friendly worker name for error messages (e.g. "STT worker"). */
  workerName: string;
}

/** Combine an optional caller signal with an internal timeout signal. */
function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * POST JSON to a worker and parse the JSON response, mapping failures into
 * structured {@link AppErrorException}s.
 */
export async function postWorkerJson<TResponse>(
  url: string,
  body: unknown,
  opts: WorkerRequestOptions,
): Promise<TResponse> {
  return requestWorkerJson<TResponse>('POST', url, body, opts);
}

/** GET JSON from a worker and parse the JSON response. */
export async function getWorkerJson<TResponse>(
  url: string,
  opts: WorkerRequestOptions,
): Promise<TResponse> {
  return requestWorkerJson<TResponse>('GET', url, undefined, opts);
}

/**
 * Pluggable worker transport. Production uses {@link sendJson} (node:http);
 * tests swap it via {@link setWorkerTransport} to avoid opening real sockets.
 */
export type WorkerTransport = (
  method: 'GET' | 'POST',
  url: string,
  payload: string | undefined,
  signal: AbortSignal,
) => Promise<RawWorkerResponse>;

let activeTransport: WorkerTransport = sendJson;

/**
 * Test seam: override the worker transport. Pass `null` to restore the default
 * node:http(s) transport. Intended for unit tests only.
 */
export function setWorkerTransport(transport: WorkerTransport | null): void {
  activeTransport = transport ?? sendJson;
}

/** Core request implementation shared by GET/POST helpers. */
async function requestWorkerJson<TResponse>(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  opts: WorkerRequestOptions,
): Promise<TResponse> {
  const { signal, cancel } = withTimeout(opts.timeoutMs, opts.signal);

  let raw: RawWorkerResponse;
  try {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    raw = await activeTransport(method, url, payload, signal);
  } catch (err) {
    cancel();
    // Distinguish a cancellation/timeout from a connection failure.
    if (opts.signal?.aborted) {
      throw new AppErrorException('CANCELLED', `${opts.workerName} request cancelled.`);
    }
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR');
    if (aborted) {
      throw new AppErrorException('WORKER_TIMEOUT', `${opts.workerName} did not respond within ${opts.timeoutMs}ms.`, {
        cause: url,
      });
    }
    throw new AppErrorException('WORKER_UNAVAILABLE', `${opts.workerName} is not reachable at ${url}.`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cancel();
  }

  const { text } = raw;
  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
    parseFailed = true;
  }

  // A 2xx with a non-JSON body is a malformed worker response — surfacing it
  // beats silently treating it as an empty result and failing downstream.
  if (raw.ok && parseFailed) {
    throw new AppErrorException('WORKER_UNAVAILABLE', `${opts.workerName} returned invalid JSON.`, {
      cause: text.slice(0, 300),
      remediation: 'Restart the worker; if it persists, check the worker logs for a crash during response serialization.',
    });
  }

  if (!raw.ok) {
    // Workers send `{ error: AppError }` on failure.
    const envelope = parsed as { error?: unknown } | undefined;
    if (envelope && isAppError(envelope.error)) {
      throw new AppErrorException(envelope.error);
    }
    const code: ErrorCode = raw.status === 503 ? 'WORKER_UNAVAILABLE' : 'UNKNOWN';
    throw new AppErrorException(code, `${opts.workerName} returned HTTP ${raw.status}.`, {
      cause: text.slice(0, 500),
    });
  }

  return parsed as TResponse;
}

/** Minimal response shape the JSON helpers need from a worker call. */
export interface RawWorkerResponse {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * Send a JSON request over node:http(s) and buffer the response body. Unlike
 * `fetch` (undici), this has NO internal header/body timeout — the only deadline
 * is `signal` (our AbortController), so legitimately long worker calls (model
 * downloads, big transcriptions) aren't killed mid-flight. Resolves with the raw
 * status + body text; rejects on transport/abort errors (mapped by the caller).
 */
function sendJson(
  method: 'GET' | 'POST',
  url: string,
  payload: string | undefined,
  signal: AbortSignal,
): Promise<RawWorkerResponse> {
  return new Promise<RawWorkerResponse>((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> =
      payload !== undefined
        ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
        : {};

    const req = transport.request(target, { method, headers, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Probe a worker `GET /health` endpoint. Returns availability plus an optional
 * detail string. Never throws — returns `{ available:false, detail }` instead.
 */
export async function probeWorkerHealth(
  baseUrl: string,
  workerName: string,
  timeoutMs = 3000,
): Promise<{ available: boolean; detail?: string }> {
  try {
    const data = await getWorkerJson<Record<string, unknown>>(`${baseUrl.replace(/\/$/, '')}/health`, {
      timeoutMs,
      workerName,
    });
    const status = typeof data?.status === 'string' ? data.status : undefined;
    const available = status === 'ok';
    // Surface a compact capability summary as the detail string.
    const detail = summarizeHealth(data);
    return detail !== undefined ? { available, detail } : { available };
  } catch (err) {
    const message = err instanceof AppErrorException ? err.appError.message : String(err);
    return { available: false, detail: message };
  }
}

/** Build a short detail string from a worker /health body (best-effort). */
function summarizeHealth(data: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'status') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Shared HTTP helper for talking to the Python workers.
 *
 * Uses the global `fetch` (Node 20+). Centralizes:
 *   - request timeouts via AbortController
 *   - mapping connection failures -> WORKER_UNAVAILABLE
 *   - mapping timeouts -> WORKER_TIMEOUT
 *   - decoding the workers' structured error envelope
 *     `{ error: { code, message, remediation, docsRef } }`
 */
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

/** Core request implementation shared by GET/POST helpers. */
async function requestWorkerJson<TResponse>(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  opts: WorkerRequestOptions,
): Promise<TResponse> {
  const { signal, cancel } = withTimeout(opts.timeoutMs, opts.signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    cancel();
    // Distinguish a cancellation/timeout from a connection failure.
    if (opts.signal?.aborted) {
      throw new AppErrorException('CANCELLED', `${opts.workerName} request cancelled.`);
    }
    const aborted = err instanceof Error && err.name === 'AbortError';
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

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    // Workers send `{ error: AppError }` on failure.
    const envelope = parsed as { error?: unknown } | undefined;
    if (envelope && isAppError(envelope.error)) {
      throw new AppErrorException(envelope.error);
    }
    const code: ErrorCode = response.status === 503 ? 'WORKER_UNAVAILABLE' : 'UNKNOWN';
    throw new AppErrorException(code, `${opts.workerName} returned HTTP ${response.status}.`, {
      cause: text.slice(0, 500),
    });
  }

  return parsed as TResponse;
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

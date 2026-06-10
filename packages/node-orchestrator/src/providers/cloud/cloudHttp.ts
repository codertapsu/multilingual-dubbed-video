/**
 * Shared HTTP plumbing for the cloud providers.
 *
 * Deliberately SDK-free: every cloud call is a plain `fetch`, so enabling a
 * cloud provider adds ZERO bundle weight and nothing is loaded until the user
 * actually selects a cloud provider for a phase (the lazy-loading rule for
 * optional dependencies).
 *
 * Error mapping:
 *   - missing key            -> CLOUD_CREDENTIALS_MISSING
 *   - 401/403/4xx/5xx        -> CLOUD_REQUEST_FAILED (with a trimmed body)
 *   - network failure        -> CLOUD_REQUEST_FAILED
 *   - timeout / caller abort -> WORKER_TIMEOUT / CANCELLED
 *
 * API keys must never appear in error messages or logs.
 */
import { AppErrorException, type CloudServiceId } from '@videodubber/shared';
import type { CredentialsStore, EffectiveCredential } from '../../credentials/credentialsStore.js';

/** Human names for error messages. */
export const SERVICE_LABELS: Record<CloudServiceId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
};

/** Resolve credentials or throw the structured "key missing" error. */
export async function requireCredential(
  store: CredentialsStore,
  service: CloudServiceId,
): Promise<EffectiveCredential & { apiKey: string }> {
  const cred = await store.get(service);
  if (!cred.apiKey) {
    throw new AppErrorException(
      'CLOUD_CREDENTIALS_MISSING',
      `${SERVICE_LABELS[service]} API key is not configured.`,
      {
        remediation: `Add your ${SERVICE_LABELS[service]} API key in Settings → Cloud API keys, or switch this phase to a local provider.`,
        docsRef: 'docs/PROVIDERS.md#cloud-api-keys',
      },
    );
  }
  return cred as EffectiveCredential & { apiKey: string };
}

/** Options for {@link cloudFetch}. */
export interface CloudFetchOptions {
  service: CloudServiceId;
  /** Request timeout in ms. */
  timeoutMs: number;
  /** Caller cancellation (pipeline cancel). */
  signal?: AbortSignal;
}

/**
 * `fetch` with timeout + caller-abort + structured error mapping. Returns the
 * raw Response on 2xx; throws AppErrorException otherwise.
 */
export async function cloudFetch(
  url: string,
  init: RequestInit,
  opts: CloudFetchOptions,
): Promise<Response> {
  const label = SERVICE_LABELS[opts.service];
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new AppErrorException('CANCELLED', 'The cloud request was cancelled.');
    }
    if (timeout.aborted) {
      throw new AppErrorException('WORKER_TIMEOUT', `${label} did not respond within ${Math.round(opts.timeoutMs / 1000)}s.`, {
        remediation: 'Retry the step; if it keeps timing out, check your network or switch the phase to a local provider.',
      });
    }
    throw new AppErrorException('CLOUD_REQUEST_FAILED', `Could not reach ${label}.`, {
      cause: String(err),
      remediation: 'Check your internet connection (cloud providers need network access), then retry.',
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const auth = response.status === 401 || response.status === 403;
    throw new AppErrorException(
      'CLOUD_REQUEST_FAILED',
      auth
        ? `${label} rejected the API key (HTTP ${response.status}).`
        : `${label} request failed (HTTP ${response.status}).`,
      {
        // Trim provider bodies: enough to diagnose, never huge, never a key.
        cause: body.slice(0, 500),
        remediation: auth
          ? `Verify the ${label} API key in Settings → Cloud API keys.`
          : `Retry the step; if it persists, check your ${label} plan/quota.`,
        docsRef: 'docs/PROVIDERS.md#cloud-troubleshooting',
      },
    );
  }

  return response;
}

/** POST JSON, parse JSON. The base of every chat-style call. */
export async function cloudPostJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: CloudFetchOptions,
): Promise<T> {
  const response = await cloudFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    opts,
  );
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppErrorException('CLOUD_REQUEST_FAILED', `${SERVICE_LABELS[opts.service]} returned a non-JSON response.`, {
      cause: text.slice(0, 300),
    });
  }
}

/**
 * Extract a JSON object from an LLM reply that may be wrapped in markdown
 * code fences or surrounded by prose. Returns undefined when nothing parses.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [trimmed, unfenced]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep trying */
    }
  }
  // Last resort: the first {...} block in the text.
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

/**
 * Live "does this API key work?" checks for POST /credentials/test.
 *
 * Each test is the cheapest authenticated call the service offers (model
 * listing) — no tokens are consumed. Failures come back as a CredentialTestResult
 * (ok=false + detail) rather than thrown errors, so the UI can render them
 * inline next to the key field.
 *
 * Claude through Mother Claude is the exception: it sends one tiny real
 * message. Listing models proves nothing there: Mother Claude 0.16.1 answered
 * GET /v1/models while every message failed with 503 runtime_unavailable (its
 * bridge host could not start on Windows, 2026-11-18), so a model listing would
 * have said "works" for a connection that could not translate a line.
 */
import {
  AppErrorException,
  MOTHER_CLAUDE_DEFAULT_URL,
  type CloudServiceId,
  type CredentialTestResult,
} from '@videodubber/shared';
import type { CredentialsStore, EffectiveCredential } from './credentialsStore.js';
import { SERVICE_LABELS } from '../providers/cloud/cloudHttp.js';
import { claudeMessage, DEFAULT_CLAUDE_MODEL, type ClaudeSend } from '../providers/cloud/claudeMessages.js';

const TEST_TIMEOUT_MS = 15_000;
/** Mother Claude may start a Claude Code session for the first message: seconds, not milliseconds. */
const MOTHER_CLAUDE_TEST_TIMEOUT_MS = 90_000;
/** Is Mother Claude's HTTP API up at all? Answered by a GET, so no tokens. */
const MOTHER_CLAUDE_PROBE_TIMEOUT_MS = 3_000;

/** Endpoint + headers for the cheapest authenticated request per service. */
function testRequest(service: CloudServiceId, apiKey: string, baseUrl?: string): { url: string; headers: Record<string, string> } {
  switch (service) {
    case 'openai':
      return {
        url: `${(baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case 'anthropic':
      return {
        url: `${(baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/models`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'gemini':
      return {
        url: `${(baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '')}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
  }
}

export interface CredentialTestDeps {
  /** The Claude transport (the SDK in production, a fake in tests). */
  claudeSend?: ClaudeSend;
  /** HTTP for the Mother Claude probe (global fetch in production). */
  fetchImpl?: typeof fetch;
}

/** Round-trip the service with the stored key; never throws. */
export async function testCloudCredential(
  store: CredentialsStore,
  service: CloudServiceId,
  deps: CredentialTestDeps = {},
): Promise<CredentialTestResult> {
  const label = SERVICE_LABELS[service];
  const cred = await store.get(service);
  if (service === 'anthropic' && cred.via === 'mother-claude') {
    return testMotherClaude(cred, deps);
  }
  if (!cred.apiKey) {
    return { service, ok: false, detail: `No API key configured for ${label}.` };
  }

  const { url, headers } = testRequest(service, cred.apiKey, cred.baseUrl);
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    if (response.ok) {
      return { service, ok: true, detail: `${label} accepted the key.` };
    }
    const body = await response.text().catch(() => '');
    return {
      service,
      ok: false,
      detail:
        response.status === 401 || response.status === 403
          ? `${label} rejected the key (HTTP ${response.status}).`
          : `${label} responded HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return { service, ok: false, detail: `Could not reach ${label}: ${String(err).slice(0, 200)}` };
  }
}

/** The fix for each way Mother Claude can be unreachable, in the words of its own screens. */
const MOTHER_CLAUDE_START_HINT =
  'Open Mother Claude, go to HTTP API, set Reachable from to This computer and press Start the API, then test again. If its Base URL differs, copy it here.';
const MOTHER_CLAUDE_KEY_HINT = 'Paste the key you set on its HTTP API into the Mother Claude key field here.';

/**
 * Probe first (3 s, no tokens), then one tiny real message on the code path
 * translation uses. The probe is what keeps a closed Mother Claude a quick
 * answer: the SDK alone retries a refused connection before giving up.
 */
async function testMotherClaude(cred: EffectiveCredential, deps: CredentialTestDeps): Promise<CredentialTestResult> {
  const url = cred.baseUrl ?? MOTHER_CLAUDE_DEFAULT_URL;
  const apiKey = cred.apiKey ?? '';
  const status = await probeMotherClaude(url, apiKey, deps.fetchImpl);
  if (!status.reachable) {
    return { service: 'anthropic', ok: false, detail: `Mother Claude's HTTP API is not running at ${url}. ${MOTHER_CLAUDE_START_HINT}` };
  }
  if (status.keyRejected) {
    return { service: 'anthropic', ok: false, detail: `Mother Claude refused the request: its HTTP API has a key. ${MOTHER_CLAUDE_KEY_HINT}` };
  }
  try {
    const reply = await claudeMessage(
      {
        apiKey,
        baseUrl: url,
        model: cred.model ?? DEFAULT_CLAUDE_MODEL,
        system: 'This is a connection test. Reply with the single word: ok',
        user: 'ok?',
        maxTokens: 16,
        timeoutMs: MOTHER_CLAUDE_TEST_TIMEOUT_MS,
        via: 'mother-claude',
      },
      deps.claudeSend,
    );
    return { service: 'anthropic', ok: true, detail: `Claude answered through Mother Claude (${reply.model}).`, model: reply.model };
  } catch (err) {
    const app = err instanceof AppErrorException ? err.appError : undefined;
    return {
      service: 'anthropic',
      ok: false,
      detail: app ? [app.message, app.remediation].filter(Boolean).join(' ') : String(err).slice(0, 300),
    };
  }
}

/** What GET /credentials/mother-claude reports. */
export interface MotherClaudeStatus {
  url: string;
  /** Something answers HTTP at that address. */
  reachable: boolean;
  /** It answered 401/403: its HTTP API has a key VideoDubber does not send (or sends a wrong one). */
  keyRejected?: boolean;
}

/** Is Mother Claude's HTTP API running at `url`? A GET of its model list: no tokens. */
export async function probeMotherClaude(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MotherClaudeStatus> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(MOTHER_CLAUDE_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return { url, reachable: true, ...(res.status === 401 || res.status === 403 ? { keyRejected: true } : {}) };
  } catch {
    return { url, reachable: false };
  }
}

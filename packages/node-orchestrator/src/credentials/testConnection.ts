/**
 * Live "does this API key work?" checks for POST /credentials/test.
 *
 * Each test is the cheapest authenticated call the service offers (model
 * listing) — no tokens are consumed. Failures come back as a CredentialTestResult
 * (ok=false + detail) rather than thrown errors, so the UI can render them
 * inline next to the key field.
 */
import type { CloudServiceId, CredentialTestResult } from '@videodubber/shared';
import type { CredentialsStore } from './credentialsStore.js';
import { SERVICE_LABELS } from '../providers/cloud/cloudHttp.js';

const TEST_TIMEOUT_MS = 15_000;

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

/** Round-trip the service with the stored key; never throws. */
export async function testCloudCredential(
  store: CredentialsStore,
  service: CloudServiceId,
): Promise<CredentialTestResult> {
  const label = SERVICE_LABELS[service];
  const cred = await store.get(service);
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

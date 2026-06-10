/**
 * Secure-ish local storage for cloud API keys (`<configDir>/credentials.json`).
 *
 * Design rules:
 *   - Keys NEVER leave this machine except in requests to the service they
 *     belong to. The HTTP API only ever returns MASKED keys.
 *   - The file is written atomically and chmod'ed 0600 (owner read/write) on
 *     POSIX systems.
 *   - Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *     GEMINI_API_KEY/GOOGLE_API_KEY) act as a read-only fallback so developers
 *     and CI can configure services without touching the store.
 *   - Keys are never logged; callers must not put them in error messages.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ALL_CLOUD_SERVICES,
  type CloudCredentialInfo,
  type CloudServiceId,
  type SaveCredentialRequest,
} from '@videodubber/shared';

/** Stored per-service entry (the full key lives only in this file). */
export interface StoredCredential {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Shape of credentials.json. */
export type CredentialsFile = Partial<Record<CloudServiceId, StoredCredential>>;

/** Resolved credentials for one service, ready for a provider to use. */
export interface EffectiveCredential {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  fromEnv: boolean;
}

/** Environment-variable fallbacks per service (first match wins). */
const ENV_KEYS: Record<CloudServiceId, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/** Mask an API key for display: keep a short prefix + the last 4 chars. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Read a non-empty env var from a list of candidates. */
function envKey(service: CloudServiceId): string | undefined {
  for (const name of ENV_KEYS[service]) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * File-backed credential store. All methods re-read the file so external
 * edits (or another process) are picked up without restarts; the file is tiny.
 */
export class CredentialsStore {
  private readonly filePath: string;

  constructor(configDir: string) {
    this.filePath = path.join(configDir, 'credentials.json');
  }

  /** Load the raw store (missing/corrupt file -> empty). */
  async load(): Promise<CredentialsFile> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : {};
    } catch {
      return {};
    }
  }

  /**
   * Effective credentials for a service: stored values first, environment
   * variable as the API-key fallback.
   */
  async get(service: CloudServiceId): Promise<EffectiveCredential> {
    const file = await this.load();
    const stored = file[service] ?? {};
    const fromStore = stored.apiKey?.trim();
    const fromEnv = fromStore ? undefined : envKey(service);
    return {
      apiKey: fromStore || fromEnv,
      baseUrl: stored.baseUrl?.trim() || undefined,
      model: stored.model?.trim() || undefined,
      fromEnv: Boolean(!fromStore && fromEnv),
    };
  }

  /** Persist one service's credentials (null/empty fields clear). */
  async save(request: SaveCredentialRequest): Promise<void> {
    const file = await this.load();
    const current = file[request.service] ?? {};
    const next: StoredCredential = { ...current };

    if (request.apiKey !== undefined) {
      const trimmed = request.apiKey?.trim();
      if (trimmed) next.apiKey = trimmed;
      else delete next.apiKey;
    }
    if (request.baseUrl !== undefined) {
      const trimmed = request.baseUrl?.trim();
      if (trimmed) next.baseUrl = trimmed;
      else delete next.baseUrl;
    }
    if (request.model !== undefined) {
      const trimmed = request.model?.trim();
      if (trimmed) next.model = trimmed;
      else delete next.model;
    }

    const updated: CredentialsFile = { ...file };
    if (Object.keys(next).length > 0) updated[request.service] = next;
    else delete updated[request.service];

    await this.writeAtomic(updated);
  }

  /** Masked, display-safe status for every known service. */
  async describe(): Promise<CloudCredentialInfo[]> {
    const result: CloudCredentialInfo[] = [];
    for (const service of ALL_CLOUD_SERVICES) {
      const eff = await this.get(service);
      result.push({
        service,
        configured: Boolean(eff.apiKey),
        ...(eff.apiKey ? { maskedKey: maskKey(eff.apiKey) } : {}),
        ...(eff.fromEnv ? { fromEnv: true } : {}),
        ...(eff.baseUrl ? { baseUrl: eff.baseUrl } : {}),
        ...(eff.model ? { model: eff.model } : {}),
      });
    }
    return result;
  }

  /** Atomic write (temp + rename) with 0600 permissions on POSIX. */
  private async writeAtomic(value: CredentialsFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.credentials.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, this.filePath);
    // Re-assert mode: rename preserves the temp file's 0600, but be explicit
    // in case an older file with looser permissions was replaced.
    await fsp.chmod(this.filePath, 0o600).catch(() => {
      /* best-effort on platforms without POSIX modes */
    });
  }
}

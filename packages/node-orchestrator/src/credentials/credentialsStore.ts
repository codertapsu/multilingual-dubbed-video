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
import { renameReplacing } from '../fsRename.js';
import {
  ALL_CLOUD_SERVICES,
  AppErrorException,
  MOTHER_CLAUDE_DEFAULT_URL,
  type CloudCredentialInfo,
  type CloudServiceId,
  type SaveCredentialRequest,
} from '@videodubber/shared';

/** Stored per-service entry (the full key lives only in this file). */
export interface StoredCredential {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Claude: reached through Mother Claude's HTTP API instead of the API key.
   * The key is kept, never overwritten: switching back uses it again.
   */
  via?: 'mother-claude';
  /** Claude: Mother Claude's base URL, when not the default port. */
  motherClaudeUrl?: string;
  /** Claude: the key set on Mother Claude's HTTP API, if its user set one. */
  motherClaudeKey?: string;
}

/** Shape of credentials.json. */
export type CredentialsFile = Partial<Record<CloudServiceId, StoredCredential>>;

/** Resolved credentials for one service, ready for a provider to use. */
export interface EffectiveCredential {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  fromEnv: boolean;
  /** Claude through Mother Claude: apiKey and baseUrl are Mother Claude's then. */
  via?: 'mother-claude';
}

/**
 * Sent as the API key to a Mother Claude HTTP API that has no key of its own:
 * it then accepts any key (only naming a folder by it), and the Anthropic SDK
 * will not send a request without one.
 */
export const MOTHER_CLAUDE_PLACEHOLDER_KEY = 'mother-claude';

/**
 * Mother Claude's Base URL as saved: http(s), without a trailing slash or /v1
 * (the SDK appends /v1/messages itself, and a pasted ".../v1" is a common slip).
 * Throws an error that says what is wrong, worded for its HTTP API screen.
 */
export function normalizeMotherClaudeUrl(raw: string): string {
  const trimmed = raw.trim();
  // Without these, the error code's generic "check the logs" advice is shown.
  const help = {
    remediation: `It is shown under Claude API on that page, for example ${MOTHER_CLAUDE_DEFAULT_URL}.`,
    docsRef: 'docs/PROVIDERS.md#claude-through-mother-claude',
  };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppErrorException('UNKNOWN', `"${trimmed}" is not an address. Copy the Base URL from Mother Claude's HTTP API page.`, help);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppErrorException('UNKNOWN', "Mother Claude's address starts with http://. Copy the Base URL from its HTTP API page.", help);
  }
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Where Mother Claude is and what key to send it, from the stored Claude entry. */
function motherClaudeTargetOf(stored: StoredCredential): { url: string; apiKey: string } {
  return {
    url: stored.motherClaudeUrl?.trim() || MOTHER_CLAUDE_DEFAULT_URL,
    apiKey: stored.motherClaudeKey?.trim() || MOTHER_CLAUDE_PLACEHOLDER_KEY,
  };
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
    // Claude through Mother Claude: the same Messages API at its base URL.
    // ANTHROPIC_API_KEY is not consulted: the user chose the plan over a key.
    if (service === 'anthropic' && stored.via === 'mother-claude') {
      const target = motherClaudeTargetOf(stored);
      return {
        apiKey: target.apiKey,
        baseUrl: target.url,
        model: stored.model?.trim() || undefined,
        fromEnv: false,
        via: 'mother-claude',
      };
    }
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
    // Claude through Mother Claude. Switching never touches the API key.
    if (request.service === 'anthropic') {
      if (request.via === 'mother-claude') next.via = 'mother-claude';
      else if (request.via === 'api-key') delete next.via;
      if (request.motherClaudeUrl !== undefined) {
        const trimmed = request.motherClaudeUrl?.trim();
        const url = trimmed ? normalizeMotherClaudeUrl(trimmed) : undefined;
        // The default is not stored: if Mother Claude's default ever moves, an
        // untouched setting follows it.
        if (url && url !== MOTHER_CLAUDE_DEFAULT_URL) next.motherClaudeUrl = url;
        else delete next.motherClaudeUrl;
      }
      if (request.motherClaudeKey !== undefined) {
        const trimmed = request.motherClaudeKey?.trim();
        if (trimmed) next.motherClaudeKey = trimmed;
        else delete next.motherClaudeKey;
      }
    }

    const updated: CredentialsFile = { ...file };
    if (Object.keys(next).length > 0) updated[request.service] = next;
    else delete updated[request.service];

    await this.writeAtomic(updated);
  }

  /**
   * Mother Claude's address and the key to send it, whether or not Claude goes
   * through it now: Settings checks the connection before the user switches.
   */
  async motherClaude(): Promise<{ url: string; apiKey: string }> {
    return motherClaudeTargetOf((await this.load()).anthropic ?? {});
  }

  /** Masked, display-safe status for every known service. */
  async describe(): Promise<CloudCredentialInfo[]> {
    const file = await this.load();
    const result: CloudCredentialInfo[] = [];
    for (const service of ALL_CLOUD_SERVICES) {
      const stored = file[service] ?? {};
      // The API key, whichever way Claude is reached: a key kept while Mother
      // Claude is chosen is still shown (masked), so the user knows it is there.
      const storedKey = stored.apiKey?.trim();
      const fromEnv = storedKey ? undefined : envKey(service);
      const apiKey = storedKey || fromEnv;
      const viaMotherClaude = service === 'anthropic' && stored.via === 'mother-claude';
      result.push({
        service,
        configured: viaMotherClaude || Boolean(apiKey),
        ...(apiKey ? { maskedKey: maskKey(apiKey) } : {}),
        ...(fromEnv ? { fromEnv: true } : {}),
        ...(stored.baseUrl?.trim() ? { baseUrl: stored.baseUrl.trim() } : {}),
        ...(stored.model?.trim() ? { model: stored.model.trim() } : {}),
        ...(viaMotherClaude ? { via: 'mother-claude' as const } : {}),
        ...(service === 'anthropic'
          ? { motherClaude: { url: motherClaudeTargetOf(stored).url, keySet: Boolean(stored.motherClaudeKey?.trim()) } }
          : {}),
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
    await renameReplacing(tmp, this.filePath);
    // Re-assert mode: rename preserves the temp file's 0600, but be explicit
    // in case an older file with looser permissions was replaced.
    await fsp.chmod(this.filePath, 0o600).catch(() => {
      /* best-effort on platforms without POSIX modes */
    });
  }
}

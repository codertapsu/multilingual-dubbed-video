/**
 * Optional Bilibili session cookie (`<configDir>/bilibili-session.json`).
 *
 * Bilibili serves a logged-out client roughly 480p; higher qualities need a
 * signed-in session. VideoDubber has no accounts and never logs in, so this is
 * strictly opt-in: the user pastes their own cookie to raise their own ceiling.
 *
 * Deliberately NOT part of {@link CredentialsStore}. That store's
 * `CloudServiceId` is a closed union of LLM providers which flows into the
 * cloud-provider settings list, the env-var fallback table and the providers
 * API; widening it would surface a "Bilibili" row throughout a UI that is about
 * something else entirely.
 *
 * Same handling rules as that store, because this is a MORE dangerous secret
 * than an API key, not a lesser one: SESSDATA is a live session that can act as
 * the account, and it cannot be scoped or rate-limited the way an API key can.
 *   - Written atomically, chmod 0600.
 *   - Only ever returned MASKED over the HTTP API.
 *   - Never logged, and never placed in an error message.
 *   - Sent to api.bilibili.com and its media hosts, and nowhere else.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Display-safe view of whether a session is configured. */
export interface BilibiliSessionInfo {
  configured: boolean;
  /** Masked cookie, for confirming the right value is stored. */
  masked?: string;
  /** True when the value came from the environment rather than the file. */
  fromEnv?: boolean;
}

interface SessionFile {
  sessdata?: string;
}

const FILE_NAME = 'bilibili-session.json';

/**
 * Mask a cookie for display.
 *
 * Shows less than {@link maskKey} does for API keys: an API key prefix is a
 * public-ish identifier, whereas any part of SESSDATA is purely secret, so this
 * shows only enough to tell two saved values apart.
 */
export function maskCookie(value: string): string {
  if (value.length <= 6) return '••••';
  return `••••${value.slice(-4)}`;
}

/**
 * Pull the raw cookie value out of whatever the user pasted.
 *
 * People copy this from browser devtools in several shapes: the bare value, a
 * `SESSDATA=…` pair, or an entire `Cookie:` header with a dozen other cookies
 * in it. Accepting only the bare value would look broken for the most common
 * paste, so normalise instead — and drop everything except SESSDATA, so a
 * pasted full header does not quietly persist the user's other cookies too.
 */
export function normalizeSessdata(input: string): string {
  const trimmed = input.trim().replace(/^Cookie:\s*/i, '');
  if (!trimmed) return '';
  const match = /(?:^|;\s*)SESSDATA=([^;]+)/i.exec(trimmed);
  if (match?.[1]) return match[1].trim();
  // No `SESSDATA=` marker: treat the whole thing as the bare value, unless it
  // still looks like a cookie jar (which would mean SESSDATA simply is absent).
  return trimmed.includes('=') || trimmed.includes(';') ? '' : trimmed;
}

export class BilibiliSessionStore {
  private readonly filePath: string;

  constructor(configDir: string) {
    this.filePath = path.join(configDir, FILE_NAME);
  }

  /** The effective cookie value, or undefined when not configured. */
  async get(): Promise<string | undefined> {
    const fromEnv = process.env['BILIBILI_SESSDATA']?.trim();
    if (fromEnv) return fromEnv;
    const file = await this.read();
    return file.sessdata?.trim() || undefined;
  }

  /** Save (or, given an empty value, clear) the cookie. */
  async set(raw: string): Promise<void> {
    const value = normalizeSessdata(raw);
    if (!value) {
      await this.writeAtomic({});
      return;
    }
    await this.writeAtomic({ sessdata: value });
  }

  /** Remove the stored cookie entirely. */
  async clear(): Promise<void> {
    await this.writeAtomic({});
  }

  /** Masked status, safe to send to the UI. */
  async describe(): Promise<BilibiliSessionInfo> {
    const fromEnv = process.env['BILIBILI_SESSDATA']?.trim();
    if (fromEnv) return { configured: true, masked: maskCookie(fromEnv), fromEnv: true };
    const value = (await this.read()).sessdata?.trim();
    return value ? { configured: true, masked: maskCookie(value) } : { configured: false };
  }

  private async read(): Promise<SessionFile> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as SessionFile;
    } catch {
      // Missing or corrupt file means "not configured" — never a hard failure,
      // or a bad file would block downloads that work fine anonymously.
      return {};
    }
  }

  /** Atomic write (temp + rename) with 0600 permissions on POSIX. */
  private async writeAtomic(value: SessionFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.bilibili-session.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, this.filePath);
    await fsp.chmod(this.filePath, 0o600).catch(() => {
      /* best-effort on platforms without POSIX modes */
    });
  }
}

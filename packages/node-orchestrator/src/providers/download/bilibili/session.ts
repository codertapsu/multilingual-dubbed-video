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

import { AppErrorException } from '@videodubber/shared';

import { renameReplacing } from '../../../fsRename.js';
import type { BrowserCookie } from '../types.js';

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
  /** The browser's device id cookie, when imported (see client.ts deviceCookie). */
  buvid3?: string;
}

/** The cookies the client sends, as stored. */
export interface BilibiliCookies {
  sessdata?: string;
  buvid3?: string;
}

/** True for a cookie domain of bilibili.com itself or one of its subdomains. */
export function isBilibiliCookieDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\./, '');
  return d === 'bilibili.com' || d.endsWith('.bilibili.com');
}

/**
 * The two cookies the client uses out of a browser's cookies: bilibili.com's
 * own only (a same-named cookie of another site is not Bilibili's), the rest
 * dropped. Pure.
 */
export function pickBilibiliCookies(cookies: readonly BrowserCookie[]): BilibiliCookies {
  const own = cookies.filter((c) => isBilibiliCookieDomain(c.domain) && c.value.trim() !== '');
  const sessdata = own.find((c) => c.name === 'SESSDATA')?.value.trim();
  const buvid3 = own.find((c) => c.name === 'buvid3')?.value.trim();
  return { ...(sessdata ? { sessdata } : {}), ...(buvid3 ? { buvid3 } : {}) };
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
    return (await this.getAll()).sessdata;
  }

  /** Both cookies the client sends (the environment's SESSDATA wins). */
  async getAll(): Promise<BilibiliCookies> {
    const file = await this.read();
    const sessdata = process.env['BILIBILI_SESSDATA']?.trim() || file.sessdata?.trim();
    const buvid3 = file.buvid3?.trim();
    return { ...(sessdata ? { sessdata } : {}), ...(buvid3 ? { buvid3 } : {}) };
  }

  /**
   * Save a pasted cookie, or clear it given an empty value.
   *
   * A paste that is not empty but holds no SESSDATA is refused: it used to
   * clear the saved login without a word, so a slip of the clipboard logged
   * the user out while the screen said "saved".
   */
  async set(raw: string): Promise<void> {
    if (!raw.trim()) {
      await this.writeAtomic({});
      return;
    }
    const value = normalizeSessdata(raw);
    if (!value) {
      throw new AppErrorException('INVALID_EDIT', 'There is no SESSDATA cookie in what was pasted.', {
        remediation:
          'Copy the value of the SESSDATA cookie (or the whole Cookie header) from a signed-in bilibili.com tab. The saved session was left as it was.',
      });
    }
    const jar = raw.trim().replace(/^Cookie:\s*/i, '');
    const buvid3 = /(?:^|;\s*)buvid3=([^;]+)/i.exec(jar)?.[1]?.trim() ?? (await this.read()).buvid3;
    await this.writeAtomic({ sessdata: value, ...(buvid3 ? { buvid3 } : {}) });
  }

  /**
   * Replace both cookies with what the user's browser holds (Mother Claude's
   * export). Logged out there means no SESSDATA: the stored login is cleared
   * and the device id kept, which is what a logged-out browser sends.
   */
  async importCookies(cookies: readonly BrowserCookie[]): Promise<BilibiliCookies> {
    const picked = pickBilibiliCookies(cookies);
    await this.writeAtomic(picked);
    return picked;
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
    await renameReplacing(tmp, this.filePath);
    // 0o600 is enforced on POSIX only. Windows does not implement these bits:
    // the mode above yields 0o666 and this chmod merely toggles the read-only
    // attribute. Confidentiality on Windows therefore rests entirely on the ACL
    // of the config directory this store lives in — in production that is
    // `~/VideoDubber` (C:\Users\<name>\VideoDubber), which Windows grants to that
    // user, SYSTEM and Administrators only. If the config dir is ever moved
    // somewhere world-readable (a shared drive, C:\ProgramData, a custom
    // VIDEODUBBER_CONFIG_DIR), this secret loses its protection on Windows with
    // nothing here to catch it.
    await fsp.chmod(this.filePath, 0o600).catch(() => {
      /* best-effort on platforms without POSIX modes */
    });
  }
}

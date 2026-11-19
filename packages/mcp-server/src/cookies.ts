/**
 * The cookies Mother Claude exports from the user's browser
 * (`browser_cookies {action:"export"}`), read by set_download_login.
 *
 * The export is a file so the values never pass through the model: the
 * conversation sees its path only. This process reads it, keeps the site's
 * own cookies, sends them to the app over localhost and deletes the file,
 * also when it cannot be read. No value is ever echoed, logged or put in an
 * error.
 */
import { readFile, rm, stat } from 'node:fs/promises';

/** A cookie as the app takes it (POST /download/providers/:id/session/import). */
export interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
}

/** Bigger than any cookie jar of one site; a larger file is not an export. */
export const MAX_COOKIE_FILE_BYTES = 64 * 1024;

/**
 * Netscape `cookies.txt` (the default: domain, subdomains flag, path, secure,
 * expires, name, value, tab-separated; `#HttpOnly_` before an HttpOnly
 * cookie's domain, as curl and yt-dlp write it) or a JSON array of
 * `{ name, value, domain }`. Pure.
 */
export function parseCookieExport(text: string): ExportedCookie[] {
  const trimmed = text.replace(/^\u{FEFF}/u, '').trim();
  if (trimmed.startsWith('[')) {
    const raw = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((c: unknown) => {
      const r = c as Partial<ExportedCookie>;
      return typeof r?.name === 'string' && typeof r.value === 'string' && typeof r.domain === 'string'
        ? [{ name: r.name, value: r.value, domain: r.domain }]
        : [];
    });
  }
  const out: ExportedCookie[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#') || !line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , , , , name, ...rest] = fields;
    if (!domain || !name) continue;
    out.push({ domain, name, value: rest.join('\t') });
  }
  return out;
}

/** The cookies of `site` (the domain or a subdomain of it) only. Pure. */
export function cookiesOfSite(cookies: readonly ExportedCookie[], site: string): ExportedCookie[] {
  return cookies.filter((c) => {
    const d = c.domain.trim().toLowerCase().replace(/^\./, '');
    return d === site || d.endsWith(`.${site}`);
  });
}

/**
 * Read an export and delete it, whatever happens: a file of cookie values is
 * not left behind because it could not be parsed.
 */
export async function takeCookieExport(file: string): Promise<ExportedCookie[]> {
  try {
    const size = (await stat(file)).size;
    if (size > MAX_COOKIE_FILE_BYTES) {
      throw new Error(`That file is ${Math.round(size / 1024)} KiB: too big for a cookie export (at most 64 KiB).`);
    }
    try {
      return parseCookieExport(await readFile(file, 'utf8'));
    } catch {
      // The parser's message could quote the file; say only what went wrong.
      throw new Error('That file is not a cookie export (Netscape cookies.txt or a JSON list of cookies).');
    }
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

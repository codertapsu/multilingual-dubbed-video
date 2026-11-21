/**
 * Reading the cookie file a browser extension saves, for "Sign in to
 * Bilibili" on the Download screen.
 *
 * The card used to ask for a pasted "SESSDATA", which means opening the
 * browser's developer tools, finding a cookie by its name and copying its
 * value: no first-time user gets there (UX audit, 2026-11). A cookie export is
 * a file any user can make with one click of an extension, and it is the same
 * thing Mother Claude hands the app (packages/mcp-server/src/cookies.ts, whose
 * two formats this reads too).
 *
 * The file holds every cookie of the site, and sometimes of every site. Only
 * the two Bilibili cookies the downloader sends leave this module, and no
 * value is ever returned in a message: the caller shows the reason, never the
 * content.
 */

/** A cookie as browser exports write it. */
export interface ExportedCookie {
  name: string;
  value: string;
  domain: string;
}

/**
 * Bigger than any sensible export. One site's cookies are a few KiB; a whole
 * browser's ("export all cookies") can reach a few hundred, and the site's are
 * picked out of it. Anything larger is not a cookie file.
 */
export const MAX_COOKIE_FILE_BYTES = 1024 * 1024;

/**
 * Netscape `cookies.txt` (domain, subdomains flag, path, secure, expires,
 * name, value, tab-separated; `#HttpOnly_` before the domain of an HttpOnly
 * cookie, which SESSDATA is) or a JSON array of `{ name, value, domain }`.
 * Throws on malformed JSON. Pure.
 */
export function parseCookieFile(text: string): ExportedCookie[] {
  const trimmed = text.replace(/^\u{FEFF}/u, '').trim();
  if (trimmed.startsWith('[')) {
    const raw = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((c: unknown) => {
      const r = c as Partial<ExportedCookie> | null;
      return r && typeof r.name === 'string' && typeof r.value === 'string' && typeof r.domain === 'string'
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

/** The cookies of `site` itself or one of its subdomains (never a look-alike such as notbilibili.com). Pure. */
export function cookiesOfSite(cookies: readonly ExportedCookie[], site: string): ExportedCookie[] {
  return cookies.filter((c) => {
    const d = c.domain.trim().toLowerCase().replace(/^\./, '');
    return d === site || d.endsWith(`.${site}`);
  });
}

/** Why a file cannot sign the app in (each has its own plain sentence on screen). */
export type CookieFileProblem = 'not-cookies' | 'no-site' | 'signed-out';

export type BilibiliLogin = { ok: true; cookie: string } | { ok: false; problem: CookieFileProblem };

/**
 * The Bilibili sign-in in a cookie export: SESSDATA (the login) and buvid3
 * (the device id), as the `Cookie` text PUT /download/providers/bilibili/session
 * takes (bilibili/session.ts keeps exactly these two). A file of the user
 * signed out has no SESSDATA: saying so beats saving a login that is not one.
 * Pure.
 */
export function bilibiliLoginFrom(text: string): BilibiliLogin {
  let cookies: ExportedCookie[];
  try {
    cookies = parseCookieFile(text);
  } catch {
    return { ok: false, problem: 'not-cookies' };
  }
  if (cookies.length === 0) return { ok: false, problem: 'not-cookies' };
  const own = cookiesOfSite(cookies, 'bilibili.com');
  if (own.length === 0) return { ok: false, problem: 'no-site' };
  const sessdata = own.find((c) => c.name === 'SESSDATA')?.value.trim();
  if (!sessdata) return { ok: false, problem: 'signed-out' };
  const buvid3 = own.find((c) => c.name === 'buvid3')?.value.trim();
  return { ok: true, cookie: `SESSDATA=${sessdata}${buvid3 ? `; buvid3=${buvid3}` : ''}` };
}

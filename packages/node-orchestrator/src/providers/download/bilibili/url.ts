/**
 * What the user pasted, turned into something we can query.
 *
 * People paste whatever the share sheet gave them: a full desktop URL, a
 * `b23.tv` short link, a mobile link with a tracking query string a hundred
 * characters long, or just the bare `BV` id from a comment. All of those name
 * the same video, so all of them are accepted rather than met with "invalid
 * URL" — the parse is the first thing a new user hits and the easiest place to
 * lose them.
 */

/** A video reference we know how to resolve. */
export interface BilibiliRef {
  /** Canonical `BV` id when we have one. */
  bvid?: string;
  /** Legacy numeric `av` id, when the link used one. */
  aid?: number;
  /** 1-based part number for multi-part videos (`?p=`). Defaults to 1. */
  page: number;
}

/** A short link we must follow before we can say anything about it. */
export interface BilibiliShortLink {
  kind: 'short-link';
  url: string;
}

export type BilibiliParse = ({ kind: 'ref' } & BilibiliRef) | BilibiliShortLink;

/**
 * `BV` ids are exactly 10 characters after the `BV`, from a restricted
 * alphabet. Anchoring the length matters: without it, a trailing path segment
 * or query string gets swallowed into the id and every later API call 404s with
 * nothing to explain why.
 */
const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /\bav(\d{1,12})\b/i;

/** Hosts whose links are short redirects rather than addressable pages. */
const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn']);

/** Parse a page number from `?p=`, clamped to something sane. */
function pageFrom(search: URLSearchParams): number {
  const raw = Number.parseInt(search.get('p') ?? '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Turn user input into a reference, or `null` when it names nothing we handle.
 *
 * Returns a `short-link` for `b23.tv` rather than resolving it here: resolution
 * is a network round trip, and this function stays pure so it can be tested
 * exhaustively without one.
 */
export function parseBilibiliInput(input: string): BilibiliParse | null {
  const text = input.trim();
  if (!text) return null;

  // A bare id, pasted out of a comment or a filename.
  if (/^BV[0-9A-Za-z]{10}$/.test(text)) return { kind: 'ref', bvid: text, page: 1 };
  if (/^av\d{1,12}$/i.test(text)) return { kind: 'ref', aid: Number(text.slice(2)), page: 1 };

  let url: URL;
  try {
    // Tolerate a pasted link with no scheme — browsers add it, humans do not.
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (SHORT_HOSTS.has(host)) return { kind: 'short-link', url: url.toString() };

  // Only bilibili hosts. Without this an arbitrary URL containing something
  // BV-shaped would be treated as a video and sent to the API.
  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) return null;

  const bv = BV_RE.exec(url.pathname);
  if (bv) return { kind: 'ref', bvid: bv[0], page: pageFrom(url.searchParams) };

  const av = AV_RE.exec(url.pathname);
  if (av?.[1]) return { kind: 'ref', aid: Number(av[1]), page: pageFrom(url.searchParams) };

  // Some Bilibili pages carry the video in the QUERY rather than the path:
  // campaign/festival pages (`/festival/<name>?bvid=…`) and list pages
  // (`/list/watchlater?bvid=…`) are ordinary free videos wearing a different
  // URL. Reading `bvid` from the query covers those, and any future page shape
  // that follows the same convention, without enumerating each one.
  const queryBvid = url.searchParams.get('bvid');
  if (queryBvid && new RegExp(`^${BV_RE.source}$`).test(queryBvid)) {
    return { kind: 'ref', bvid: queryBvid, page: pageFrom(url.searchParams) };
  }
  const queryAid = url.searchParams.get('aid');
  if (queryAid && /^\d{1,12}$/.test(queryAid)) {
    return { kind: 'ref', aid: Number(queryAid), page: pageFrom(url.searchParams) };
  }

  return null;
}

/** True when the input names a Bilibili video we can at least try to fetch. */
export function looksLikeBilibili(input: string): boolean {
  return parseBilibiliInput(input) !== null;
}

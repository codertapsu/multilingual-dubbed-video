/**
 * What the user pasted, turned into a Douyin video id.
 *
 * Douyin puts the id in a different place depending on where you copied it
 * from: the path on a permalink, a `modal_id` query param on the feed and
 * profile pages (which is what the share button actually produces), or behind a
 * `v.douyin.com` redirect. All of them name the same video.
 */

/** A video we know how to resolve. */
export interface DouyinRef {
  /** The numeric aweme id. */
  awemeId: string;
}

/** A short link that must be followed before it says anything. */
export interface DouyinShortLink {
  kind: 'short-link';
  url: string;
}

export type DouyinParse = ({ kind: 'ref' } & DouyinRef) | DouyinShortLink;

/**
 * Aweme ids are long numeric strings (19 digits at the time of writing).
 * Requiring a long run of digits is what makes a BARE id safe to accept: it
 * cannot collide with anything another provider claims, and it will not match
 * an incidental short number in a path.
 */
const AWEME_ID_RE = /^\d{15,25}$/;
const PATH_ID_RE = /\/(?:video|note|share\/video|slides)\/(\d{15,25})/;

/** Hosts that redirect rather than addressing a video directly. */
const SHORT_HOSTS = new Set(['v.douyin.com', 'v.iesdouyin.com']);

/** Hosts whose pages address a video. */
function isDouyinHost(host: string): boolean {
  return (
    host === 'douyin.com' ||
    host.endsWith('.douyin.com') ||
    host === 'iesdouyin.com' ||
    host.endsWith('.iesdouyin.com')
  );
}

/**
 * Turn user input into a reference, or `null` when it names nothing we handle.
 *
 * Pure, like the Bilibili parser: short links are reported rather than
 * followed, so the whole surface can be tested without a network.
 */
export function parseDouyinInput(input: string): DouyinParse | null {
  const text = input.trim();
  if (!text) return null;

  // A bare id, pasted out of a share sheet or a filename.
  if (AWEME_ID_RE.test(text)) return { kind: 'ref', awemeId: text };

  let url: URL;
  try {
    // Tolerate a pasted link with no scheme — browsers add it, humans do not.
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (SHORT_HOSTS.has(host)) return { kind: 'short-link', url: url.toString() };
  if (!isDouyinHost(host)) return null;

  const inPath = PATH_ID_RE.exec(url.pathname);
  if (inPath?.[1]) return { kind: 'ref', awemeId: inPath[1] };

  // The share button on a feed, profile or "jingxuan" page produces
  // `?modal_id=…` with no id in the path at all — the most common paste there
  // is, and invisible to a path-only parser.
  const modal = url.searchParams.get('modal_id');
  if (modal && AWEME_ID_RE.test(modal)) return { kind: 'ref', awemeId: modal };

  const legacy = url.searchParams.get('aweme_id') ?? url.searchParams.get('item_id');
  if (legacy && AWEME_ID_RE.test(legacy)) return { kind: 'ref', awemeId: legacy };

  return null;
}

/** True when the input names a Douyin video we can at least try to fetch. */
export function looksLikeDouyin(input: string): boolean {
  return parseDouyinInput(input) !== null;
}

import { AppErrorException } from '@videodubber/shared';

import { parseDouyinInput, type DouyinRef } from './url.js';

/**
 * Minimal Douyin client: enough to name a video and find its media file.
 *
 * Douyin's own web API requires a signed query parameter that has to be
 * recomputed from obfuscated site JavaScript, and which changes whenever that
 * script does. This avoids it entirely by reading the SHARE page, which embeds
 * the same item metadata as a plain JSON blob and needs no signature — the same
 * shape of shortcut as Bilibili's legacy pipe.
 *
 * Deliberately narrow, like the Bilibili client: public share pages for
 * ordinary videos, nothing account-gated.
 */

const SHARE_BASE = 'https://www.iesdouyin.com/share/video';
const PLAY_BASE = 'https://www.iesdouyin.com/aweme/v1/play';

/**
 * A MOBILE user agent is load-bearing, not decoration.
 *
 * Measured: with a desktop UA the same URL returns a perfectly valid 72 KB page
 * that simply does not contain the data blob, so the request "succeeds" and the
 * scrape finds nothing. That is a silent failure worth pinning down here rather
 * than rediscovering as an empty result.
 */
const MOBILE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};

/** Injectable fetch, so the client is testable and offline-safe. */
export type DouyinFetch = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'follow' | 'manual' },
) => Promise<{
  ok: boolean;
  status: number;
  url: string;
  text: () => Promise<string>;
}>;

/** What the share page tells us about one video. */
export interface DouyinVideoInfo {
  awemeId: string;
  title: string;
  coverUrl?: string;
  durationSec: number;
  ownerName?: string;
  /** Pixel height of the served file, when the page reports it. */
  heightPx?: number;
  /** Opaque media id used to build the play URL. */
  playUri: string;
}

/** The blob the share page embeds. */
const ROUTER_DATA_RE = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/is;

/** Follow a `v.douyin.com` short link to the page it points at. */
export async function resolveShortLink(fetchImpl: DouyinFetch, url: string): Promise<string> {
  const res = await fetchImpl(url, { headers: MOBILE_HEADERS });
  return res.url || url;
}

/** Resolve whatever the user pasted into a concrete reference. */
export async function resolveInput(fetchImpl: DouyinFetch, input: string): Promise<DouyinRef> {
  const parsed = parseDouyinInput(input);
  if (!parsed) {
    throw new AppErrorException('INVALID_VIDEO_LINK', 'That does not look like a Douyin video link.', {
      remediation:
        'Paste a link like https://www.douyin.com/video/… , a v.douyin.com share link, or the ' +
        'numeric video id.',
    });
  }
  if (parsed.kind === 'ref') return parsed;

  const finalUrl = await resolveShortLink(fetchImpl, parsed.url);
  const again = parseDouyinInput(finalUrl);
  if (!again || again.kind !== 'ref') {
    throw new AppErrorException('UNKNOWN', 'That share link did not lead to a video.', {
      remediation: 'Open the link in a browser and copy the full address from the address bar.',
    });
  }
  return again;
}

/** Pull a nested value out without a chain of optional accesses. */
function at(root: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Fetch the share page and extract the embedded item. */
export async function fetchVideoInfo(
  fetchImpl: DouyinFetch,
  ref: DouyinRef,
): Promise<DouyinVideoInfo> {
  let res;
  try {
    res = await fetchImpl(`${SHARE_BASE}/${encodeURIComponent(ref.awemeId)}`, {
      headers: MOBILE_HEADERS,
    });
  } catch (cause) {
    throw new AppErrorException('WORKER_UNAVAILABLE', 'Could not reach Douyin.', {
      remediation: 'Check your internet connection and try again.',
      cause: String(cause),
    });
  }
  if (!res.ok) {
    throw new AppErrorException('UNKNOWN', `Douyin returned HTTP ${res.status}.`, {
      remediation: 'Try again in a moment; the site may be rate-limiting requests.',
    });
  }

  const html = await res.text();
  const match = ROUTER_DATA_RE.exec(html);
  if (!match?.[1]) {
    // The page loaded but carried no data. Overwhelmingly this means the video
    // is gone or private — but it is also exactly what a changed page layout
    // looks like, so say both rather than guessing.
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'That Douyin video could not be read.', {
      remediation:
        'The video may be private, removed, or region-locked. Open the link in a browser to ' +
        'check it still plays. If it does, Douyin may have changed its page layout.',
    });
  }

  const trimmed = match[1].trim().replace(/;+\s*$/, '');
  const start = trimmed.indexOf('{');
  let data: unknown;
  try {
    data = JSON.parse(start > 0 ? trimmed.slice(start) : trimmed);
  } catch (cause) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'Douyin returned data we could not parse.', {
      cause: String(cause),
      remediation: 'Try again; if it persists, Douyin may have changed its page format.',
    });
  }

  // The key really does contain parentheses — it is a route pattern, not a typo.
  const item = at(data, ['loaderData', 'video_(id)/page', 'videoInfoRes', 'item_list', 0]);
  const playUri = at(item, ['video', 'play_addr', 'uri']);
  if (typeof playUri !== 'string' || !playUri) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'No downloadable video was offered.', {
      remediation:
        'Image posts and some restricted videos have no downloadable file. Try a different video.',
    });
  }

  const desc = at(item, ['desc']);
  const cover = at(item, ['video', 'cover', 'url_list', 0]);
  const owner = at(item, ['author', 'nickname']);
  const height = at(item, ['video', 'height']);
  // Douyin reports duration in MILLISECONDS, unlike Bilibili's seconds; getting
  // this wrong shows a 5-minute clip as 5 hours.
  const durationMs = at(item, ['video', 'duration']);

  return {
    awemeId: ref.awemeId,
    title: typeof desc === 'string' && desc.trim() ? desc.trim() : `douyin-${ref.awemeId}`,
    ...(typeof cover === 'string' && cover ? { coverUrl: cover } : {}),
    durationSec: typeof durationMs === 'number' ? Math.round(durationMs / 1000) : 0,
    ...(typeof owner === 'string' && owner.trim() ? { ownerName: owner.trim() } : {}),
    ...(typeof height === 'number' && height > 0 ? { heightPx: height } : {}),
    playUri,
  };
}

/**
 * The media URL for a video.
 *
 * `ratio=1080p` asks for the best the item has; Douyin serves a single
 * already-muxed MP4, so there is no adaptive ladder to choose from and no merge
 * to perform afterwards.
 */
export function playUrl(playUri: string): string {
  const params = new URLSearchParams({ video_id: playUri, ratio: '1080p', line: '0' });
  return `${PLAY_BASE}/?${params.toString()}`;
}

/**
 * Headers the media fetch carries.
 *
 * Measured: the play endpoint serves the file with no headers at all. They are
 * sent anyway for consistency with the parse request, but nothing here is
 * load-bearing — unlike Bilibili, which 403s without a Referer.
 */
export function mediaHeaders(): Record<string, string> {
  return { ...MOBILE_HEADERS };
}

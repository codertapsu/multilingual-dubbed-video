import { AppErrorException } from '@videodubber/shared';

import { mixinKey, signedQuery } from './wbi.js';
import {
  availableQualities,
  pickAudio,
  pickVideo,
  streamUrl,
  type DashAudio,
  type DashVideo,
  type QualityOption,
} from './quality.js';
import { parseBilibiliInput, type BilibiliRef } from './url.js';

/**
 * Minimal Bilibili web-API client: enough to name a video and find its media
 * streams, and nothing else.
 *
 * Deliberately narrow. This exists so a user can pull down a source video to
 * dub, so it speaks only to the public endpoints a logged-out browser uses for
 * ordinary videos. It does not touch paid-series or membership endpoints, and
 * it does not attempt to obtain anything an anonymous visitor could not already
 * play in a browser tab.
 */

const API = 'https://api.bilibili.com';

/**
 * Bilibili rejects media requests whose `Referer` is not one of its own pages —
 * this is hot-link protection, not an access control, and a browser sends the
 * same thing. Without it the metadata call succeeds and the media fetch 403s,
 * which looks like a mysterious mid-download failure.
 */
const BROWSER_HEADERS: Record<string, string> = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

/**
 * The opt-in session cookie, held in memory for the life of the process.
 *
 * Module-level rather than threaded through every call site because it is
 * cross-cutting and optional: an undefined value must behave EXACTLY like the
 * anonymous path did before this existed, which is easiest to guarantee when
 * there is one place that decides whether a Cookie header exists at all.
 */
let sessionCookie: string | undefined;

/** Set (or clear, with undefined) the session cookie used for all requests. */
export function setSessionCookie(sessdata: string | undefined): void {
  sessionCookie = sessdata?.trim() || undefined;
}

/** True when a session cookie is in force (for status display only). */
export function hasSessionCookie(): boolean {
  return sessionCookie !== undefined;
}

/**
 * Headers for a Bilibili request, with the session cookie when configured.
 *
 * Only SESSDATA is ever sent. The store already strips anything else out of a
 * pasted cookie jar; building the header from that single field means a future
 * change to the store cannot widen what leaves the machine.
 */
function requestHeaders(): Record<string, string> {
  return sessionCookie
    ? { ...BROWSER_HEADERS, Cookie: `SESSDATA=${sessionCookie}` }
    : { ...BROWSER_HEADERS };
}

/** One selectable part of a (possibly multi-part) video. */
export interface BilibiliPart {
  cid: number;
  /** 1-based part number, matching `?p=`. */
  page: number;
  title: string;
  durationSec: number;
}

/** What we can tell the user before they commit to a download. */
export interface BilibiliVideoInfo {
  bvid: string;
  title: string;
  /** Cover image URL, for the preview card. */
  coverUrl?: string;
  durationSec: number;
  ownerName?: string;
  parts: BilibiliPart[];
}

/** A resolved pair of media URLs plus what they cost to fetch. */
export interface BilibiliStreams {
  videoUrl: string;
  audioUrl: string;
  /** Height in pixels of the chosen video stream, for display. */
  heightPx?: number;
  /** Codec string, for display. */
  codec?: string;
  /** The `qn` actually being downloaded (may be lower than requested). */
  qn?: number;
  /** Everything this viewer can actually be served, best first. */
  qualities: QualityOption[];
}

/** Injectable fetch, so the client is testable and offline-safe. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  url: string;
}>;

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

/**
 * Bilibili answers with HTTP 200 and a non-zero `code` for most failures, so a
 * plain `res.ok` check reports success on a video that does not exist, is
 * region-locked, or needs an account. Unwrap the envelope and surface the
 * server's own message.
 */
async function callEnvelope<T>(fetchImpl: FetchLike, url: string): Promise<ApiEnvelope<T>> {
  let res;
  try {
    res = await fetchImpl(url, { headers: requestHeaders() });
  } catch (cause) {
    throw new AppErrorException('WORKER_UNAVAILABLE', 'Could not reach Bilibili.', {
      remediation: 'Check your internet connection and try again.',
      cause: String(cause),
    });
  }
  if (!res.ok) {
    throw new AppErrorException('UNKNOWN', `Bilibili returned HTTP ${res.status}.`, {
      remediation: 'Try again in a moment; the site may be rate-limiting requests.',
    });
  }
  return (await res.json()) as ApiEnvelope<T>;
}

async function callApi<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const body = await callEnvelope<T>(fetchImpl, url);
  if (body.code !== 0 || body.data === undefined) {
    throw new AppErrorException(
      'UNKNOWN',
      body.message?.trim() || `Bilibili rejected the request (code ${body.code}).`,
      {
        remediation:
          'The video may be private, removed, region-locked, or need an account to watch. ' +
          'Open the link in a browser to check it plays there.',
      },
    );
  }
  return body.data;
}

/** Follow a `b23.tv` short link to the page it points at. */
export async function resolveShortLink(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url, { headers: requestHeaders() });
  return res.url || url;
}

/**
 * Resolve whatever the user pasted into a concrete reference, following a short
 * link when necessary.
 */
export async function resolveInput(fetchImpl: FetchLike, input: string): Promise<BilibiliRef> {
  const parsed = parseBilibiliInput(input);
  if (!parsed) {
    throw new AppErrorException('INVALID_VIDEO_LINK', 'That does not look like a Bilibili video link.', {
      remediation: 'Paste a link like https://www.bilibili.com/video/BV… , a b23.tv link, or a BV id.',
    });
  }
  if (parsed.kind === 'ref') return parsed;

  const finalUrl = await resolveShortLink(fetchImpl, parsed.url);
  const again = parseBilibiliInput(finalUrl);
  if (!again || again.kind !== 'ref') {
    throw new AppErrorException('UNKNOWN', 'That short link did not lead to a video page.', {
      remediation: 'Open the link in a browser and copy the full address from the address bar.',
    });
  }
  return again;
}

/** Fetch title, cover, and the part list. */
export async function fetchVideoInfo(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
): Promise<BilibiliVideoInfo> {
  const query = ref.bvid ? `bvid=${encodeURIComponent(ref.bvid)}` : `aid=${ref.aid}`;
  const data = await callApi<{
    bvid: string;
    title: string;
    pic?: string;
    duration: number;
    owner?: { name?: string };
    pages?: { cid: number; page: number; part?: string; duration: number }[];
  }>(fetchImpl, `${API}/x/web-interface/view?${query}`);

  const pages = data.pages ?? [];
  return {
    bvid: data.bvid,
    title: data.title,
    ...(data.pic ? { coverUrl: data.pic } : {}),
    durationSec: data.duration,
    ...(data.owner?.name ? { ownerName: data.owner.name } : {}),
    parts: pages.map((p) => ({
      cid: p.cid,
      page: p.page,
      // Single-part videos carry an empty `part`; fall back to the video title
      // so the picker never shows a blank row.
      title: p.part?.trim() || data.title,
      durationSec: p.duration,
    })),
  };
}

/** Fetch and cache the signing key material (rotates rarely; per-process is fine). */
let cachedKey: { key: string; at: number } | null = null;
const KEY_TTL_MS = 30 * 60 * 1000;

export async function getWbiKey(fetchImpl: FetchLike, now = Date.now()): Promise<string> {
  if (cachedKey && now - cachedKey.at < KEY_TTL_MS) return cachedKey.key;

  // `nav` is an ACCOUNT endpoint that also happens to carry the public signing
  // material, so for a logged-out client it answers `code: -101 账号未登录`
  // ("not logged in") WITH a perfectly good `wbi_img` alongside it. Going
  // through the usual non-zero-code check would therefore reject the normal
  // anonymous case — i.e. every user of this feature. Judge it on whether the
  // key material actually arrived, not on the account status.
  const body = await callEnvelope<{ wbi_img?: { img_url?: string; sub_url?: string } }>(
    fetchImpl,
    `${API}/x/web-interface/nav`,
  );
  const key = mixinKey(body.data?.wbi_img?.img_url, body.data?.wbi_img?.sub_url);
  if (key.length < 32) {
    throw new AppErrorException('UNKNOWN', 'Could not prepare a signed request to Bilibili.', {
      cause: `nav code ${body.code}, key length ${key.length}`,
      remediation: 'Try again in a moment. If it persists, the site may have changed its API.',
    });
  }
  cachedKey = { key, at: now };
  return key;
}

/** What a session check found. */
export interface SessionCheck {
  valid: boolean;
  /** The account name, when the cookie is live. */
  uname?: string;
}

/**
 * Ask Bilibili whether the configured cookie is still live.
 *
 * Worth an explicit control rather than inferring it: an expired cookie does
 * not fail, it silently drops the user back to the anonymous ~480p ceiling
 * while the settings screen still reads "Saved". `nav` is the natural probe —
 * it is the account endpoint, and it is already the one we call for the
 * signing key.
 */
export async function checkSession(fetchImpl: FetchLike): Promise<SessionCheck> {
  if (!sessionCookie) return { valid: false };
  const body = await callEnvelope<{ isLogin?: boolean; uname?: string }>(
    fetchImpl,
    `${API}/x/web-interface/nav`,
  );
  const isLogin = body.data?.isLogin === true;
  const uname = body.data?.uname?.trim();
  return { valid: isLogin, ...(isLogin && uname ? { uname } : {}) };
}

/** Reset the cached signing key (tests). */
export function _resetWbiKeyCache(): void {
  cachedKey = null;
}

/**
 * Pick the media streams for one part.
 *
 * `fnval=4048` asks for the DASH response, where video and audio arrive as
 * SEPARATE streams — which is why a download always ends in an ffmpeg merge
 * rather than a straight file copy.
 */
export async function fetchStreams(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
  cid: number,
  wantQn?: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<BilibiliStreams> {
  const key = await getWbiKey(fetchImpl);
  const params: Record<string, string | number> = {
    cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    // `qn` asks for a ceiling; the server still decides what this viewer may
    // have. Sending it is what makes a lower pick possible at all — without it
    // the response is whatever the default tier is.
    ...(wantQn !== undefined ? { qn: wantQn } : {}),
    ...(ref.bvid ? { bvid: ref.bvid } : { avid: ref.aid ?? 0 }),
  };
  const data = await callApi<{
    dash?: { video?: DashVideo[]; audio?: DashAudio[] };
  }>(fetchImpl, `${API}/x/player/wbi/playurl?${signedQuery(params, key, nowSeconds)}`);

  const video = data.dash?.video ?? [];
  const audio = data.dash?.audio ?? [];
  if (video.length === 0 || audio.length === 0) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'No downloadable stream was offered for this video.', {
      remediation:
        'This can happen for paid, members-only, or interactive videos. Try a different video, ' +
        'or check it plays for a logged-out viewer in a browser.',
    });
  }

  const bestVideo = pickVideo(video, wantQn);
  const bestAudio = pickAudio(audio);
  const videoUrl = streamUrl(bestVideo);
  const audioUrl = streamUrl(bestAudio);
  if (!videoUrl || !audioUrl) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'Bilibili did not return a usable media URL.', {
      remediation: 'Try again; if it persists, the video may not be downloadable.',
    });
  }

  return {
    videoUrl,
    audioUrl,
    qualities: availableQualities(video),
    ...(bestVideo?.id !== undefined ? { qn: bestVideo.id } : {}),
    ...(bestVideo?.height ? { heightPx: bestVideo.height } : {}),
    ...(bestVideo?.codecs ? { codec: bestVideo.codecs } : {}),
  };
}

/**
 * Headers any media fetch must carry (see BROWSER_HEADERS).
 *
 * The cookie goes here too: media hosts check it for higher-quality streams,
 * and a URL obtained with a session but fetched without one can 403.
 */
export function mediaHeaders(): Record<string, string> {
  return requestHeaders();
}

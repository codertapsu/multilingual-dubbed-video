import { AppErrorException } from '@videodubber/shared';

import { mixinKey, signedQuery } from './wbi.js';
import {
  availableQualities,
  pickAudio,
  pickVideo,
  streamBackupUrls,
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
/**
 * The browser's device id cookie (`buvid3`), when one was imported from the
 * user's browser. Not a secret and not an account: Bilibili's risk control
 * expects a browser to carry one, and requests without it are refused (-352)
 * more readily, logged in or not.
 */
let deviceCookie: string | undefined;
/** Its companion (`buvid4`), when the id came from Bilibili itself. */
let deviceCookie4: string | undefined;
/** When a device id was last asked for, so a failing ask is not repeated on every call. */
let deviceAskedAt = 0;
const DEVICE_RETRY_MS = 10 * 60 * 1000;

/** Set (or clear, with undefined) the session cookie used for all requests. */
export function setSessionCookie(sessdata: string | undefined): void {
  sessionCookie = sessdata?.trim() || undefined;
}

/** Set both cookies at once (an import from the browser replaces both). */
export function setSessionCookies(cookies: { sessdata?: string; buvid3?: string }): void {
  sessionCookie = cookies.sessdata?.trim() || undefined;
  deviceCookie = cookies.buvid3?.trim() || undefined;
  deviceCookie4 = undefined;
  deviceAskedAt = 0;
}

/**
 * A device id for a client that has none from the user's browser.
 *
 * Bilibili's risk control answers HTTP 412 to API calls that carry no device
 * id, on some networks every time (measured 2026-11-19: every anonymous
 * lookup, and every download of 0.15.0, failed that way, while the same call
 * with an id passed). A browser always has one (`buvid3`, set on its first
 * visit), and Bilibili hands one to anyone who asks, which is what its own
 * pages do: `/x/frontend/finger/spi`. Not an account and not a secret.
 * Best effort: when the ask fails the call goes out without one, as before.
 */
async function ensureDeviceId(fetchImpl: FetchLike, now = Date.now()): Promise<void> {
  if (deviceCookie || now - deviceAskedAt < DEVICE_RETRY_MS) return;
  deviceAskedAt = now;
  try {
    const res = await fetchImpl(`${API}/x/frontend/finger/spi`, { headers: { ...BROWSER_HEADERS } });
    if (!res.ok) return;
    const body = (await res.json()) as { code?: number; data?: { b_3?: string; b_4?: string } };
    if (body.code === 0 && body.data?.b_3) {
      deviceCookie = body.data.b_3;
      deviceCookie4 = body.data.b_4 || undefined;
    }
  } catch {
    /* without it, the call may still pass */
  }
}

/** Forget the device id (tests). */
export function _resetDeviceId(): void {
  deviceCookie = undefined;
  deviceCookie4 = undefined;
  deviceAskedAt = 0;
}

/** True when a session cookie is in force (for status display only). */
export function hasSessionCookie(): boolean {
  return sessionCookie !== undefined;
}

/**
 * Headers for a Bilibili API request, with the cookies when configured.
 *
 * Only SESSDATA and buvid3 are ever sent. The store already drops everything
 * else from a pasted or imported cookie jar; building the header from those
 * two fields means a future change to the store cannot widen what leaves the
 * machine. Used for api.bilibili.com only: not for the b23.tv short-link
 * service nor the media hosts, which a browser would not send them to either.
 */
function requestHeaders(): Record<string, string> {
  const cookie = [
    ...(deviceCookie ? [`buvid3=${deviceCookie}`] : []),
    ...(deviceCookie4 ? [`buvid4=${deviceCookie4}`] : []),
    ...(sessionCookie ? [`SESSDATA=${sessionCookie}`] : []),
  ].join('; ');
  return cookie ? { ...BROWSER_HEADERS, Cookie: cookie } : { ...BROWSER_HEADERS };
}

/**
 * The typed error for a Bilibili API refusal (`code` in its JSON envelope), so
 * a batch can tell "wait and retry" from "this one will never download". Pure.
 */
export function bilibiliApiError(code: number, message: string | undefined): AppErrorException {
  const said = message?.trim() || `Bilibili refused the request (code ${code}).`;
  switch (code) {
    case -352: // risk control
    case -412: // request intercepted
    case -509: // too frequent
    case -799: // too frequent, try later
      return new AppErrorException('SOURCE_RATE_LIMITED', `Bilibili is limiting requests from this computer (${said}).`);
    case -101: // not logged in
    case -403: // access denied (members only)
    case 87007: // charging-exclusive
    case 87008:
      return new AppErrorException('SOURCE_LOGIN_REQUIRED', `Bilibili only plays this video to a signed-in account (${said}).`);
    case -10403:
      return new AppErrorException('SOURCE_UNAVAILABLE', `Bilibili does not play this video in your region (${said}).`);
    case -404:
    case 62002: // not visible
    case 62004: // under review
    case 62012: // visible to the uploader only
      return new AppErrorException('SOURCE_UNAVAILABLE', `Bilibili does not offer this video (${said}).`);
    default:
      return new AppErrorException('UNKNOWN', said, {
        remediation:
          'The video may be private, removed, region-locked, or need an account to watch. ' +
          'Open the link in a browser to check it plays there.',
      });
  }
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
  /** Mirrors of each stream, tried when the main host fails. */
  videoFallbackUrls: string[];
  audioFallbackUrls: string[];
  /** Expected size of both streams together, from their bitrates; unknown = undefined. */
  estimatedBytes?: number;
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
  await ensureDeviceId(fetchImpl);
  let res;
  try {
    res = await fetchImpl(url, { headers: requestHeaders() });
  } catch (cause) {
    throw new AppErrorException('WORKER_UNAVAILABLE', 'Could not reach Bilibili.', {
      remediation: 'Check your internet connection and try again.',
      cause: String(cause),
    });
  }
  if (res.status === 412) {
    // Risk control answers HTTP 412 before any JSON: too many requests too fast.
    throw new AppErrorException('SOURCE_RATE_LIMITED', 'Bilibili is limiting requests from this computer (HTTP 412).');
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
  if (body.code !== 0 || body.data === undefined) throw bilibiliApiError(body.code, body.message);
  return body.data;
}

/** Follow a `b23.tv` short link to the page it points at (no cookies: it is not Bilibili's API). */
export async function resolveShortLink(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url, { headers: { ...BROWSER_HEADERS } });
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
  /** A paid membership (大会员): 1080P60 and 4K where the video has them. */
  premium?: boolean;
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
  const body = await callEnvelope<{ isLogin?: boolean; uname?: string; vipStatus?: number }>(
    fetchImpl,
    `${API}/x/web-interface/nav`,
  );
  const isLogin = body.data?.isLogin === true;
  const uname = body.data?.uname?.trim();
  return {
    valid: isLogin,
    ...(isLogin && uname ? { uname } : {}),
    ...(isLogin ? { premium: body.data?.vipStatus === 1 } : {}),
  };
}

/** Reset the cached signing key (tests). */
export function _resetWbiKeyCache(): void {
  cachedKey = null;
}

/** A single already-muxed file from the legacy player endpoint. */
export interface BilibiliProgressiveStream {
  url: string;
  /** The `qn` the server actually served. */
  qn: number;
  /** Total bytes, when the response reported them. */
  sizeBytes?: number;
  /** Mirrors of the same file. */
  fallbackUrls: string[];
}

/**
 * Fetch the legacy single-file ("durl") stream for one part.
 *
 * Worth having ALONGSIDE the DASH path rather than instead of it, because the
 * two are gated differently. Measured on five current videos, a logged-out
 * client is served 480p on DASH but **720p** here — the adaptive path is the
 * more restricted one for anonymous viewers, which is the opposite of what you
 * would guess. The file also arrives already muxed, so it needs no ffmpeg step
 * at all.
 *
 * Deliberately unsigned: this endpoint is not a `wbi` one and takes no
 * signature. `fnval=0` is what selects the legacy response shape.
 */
export async function fetchProgressiveStream(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
  cid: number,
  wantQn = 80,
): Promise<BilibiliProgressiveStream | undefined> {
  const params = new URLSearchParams({
    otype: 'json',
    fnver: '0',
    fnval: '0',
    qn: String(wantQn),
    cid: String(cid),
    ...(ref.bvid ? { bvid: ref.bvid } : { avid: String(ref.aid ?? 0) }),
  });

  const data = await callApi<{
    quality?: number;
    durl?: { url?: string; size?: number; backup_url?: string[] | null }[];
  }>(fetchImpl, `${API}/x/player/playurl?${params.toString()}`);

  // Multi-segment durl responses exist for very old uploads; joining them would
  // need a concat step, so treat anything but a single segment as unavailable
  // and let the DASH path handle it rather than silently downloading a fragment.
  const parts = data.durl ?? [];
  const only = parts.length === 1 ? parts[0] : undefined;
  if (!only?.url || data.quality === undefined) return undefined;

  return {
    url: only.url,
    qn: data.quality,
    ...(only.size ? { sizeBytes: only.size } : {}),
    fallbackUrls: (only.backup_url ?? []).filter((u) => typeof u === 'string' && u !== only.url),
  };
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
    dash?: { duration?: number; video?: DashVideo[]; audio?: DashAudio[] };
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

  const duration = data.dash?.duration;
  const bitsPerSecond = (bestVideo?.bandwidth ?? 0) + (bestAudio?.bandwidth ?? 0);
  return {
    videoUrl,
    audioUrl,
    videoFallbackUrls: streamBackupUrls(bestVideo),
    audioFallbackUrls: streamBackupUrls(bestAudio),
    ...(duration && bitsPerSecond > 0 ? { estimatedBytes: Math.ceil((bitsPerSecond / 8) * duration) } : {}),
    qualities: availableQualities(video),
    ...(bestVideo?.id !== undefined ? { qn: bestVideo.id } : {}),
    ...(bestVideo?.height ? { heightPx: bestVideo.height } : {}),
    ...(bestVideo?.codecs ? { codec: bestVideo.codecs } : {}),
  };
}

/** A list of videos a link names: a collection (合集), a series list, favourites, an uploader's videos. */
export interface BilibiliListRef {
  kind: 'season' | 'series' | 'favourites' | 'uploader';
  /** The uploader (absent for a favourites link of the medialist form). */
  mid?: number;
  /** The season, series or favourites id (the uploader's mid for `uploader`). */
  id: number;
}

/** Recognise a list link; null for anything else. Pure. */
export function parseBilibiliList(input: string): BilibiliListRef | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const q = url.searchParams;
  const int = (v: string | null | undefined): number | undefined => (v && /^\d{1,19}$/.test(v) ? Number(v) : undefined);
  if (host === 'www.bilibili.com' || host === 'bilibili.com') {
    const ml = /^\/medialist\/detail\/ml(\d+)/.exec(url.pathname);
    return ml ? { kind: 'favourites', id: Number(ml[1]) } : null;
  }
  if (host !== 'space.bilibili.com') return null;
  const m = /^\/(\d+)(\/.*)?$/.exec(url.pathname);
  const mid = int(m?.[1]);
  if (!mid) return null;
  const rest = (m?.[2] ?? '').replace(/\/+$/, '');
  const sid = int(q.get('sid'));
  const lists = /^\/lists\/(\d+)$/.exec(rest);
  if (rest === '/channel/collectiondetail' && sid) return { kind: 'season', mid, id: sid };
  if (rest === '/channel/seriesdetail' && sid) return { kind: 'series', mid, id: sid };
  if (lists) return { kind: q.get('type') === 'series' ? 'series' : 'season', mid, id: Number(lists[1]) };
  if (rest === '/favlist') {
    const fid = int(q.get('fid'));
    return fid ? { kind: 'favourites', mid, id: fid } : null;
  }
  if (rest === '' || rest === '/video' || rest === '/upload/video') return { kind: 'uploader', mid, id: mid };
  return null;
}

/** "mm:ss" or "h:mm:ss" → seconds. */
function lengthToSec(length: unknown): number {
  if (typeof length === 'number') return length;
  if (typeof length !== 'string') return 0;
  return length.split(':').map(Number).reduce((acc, p) => acc * 60 + (Number.isFinite(p) ? p : 0), 0);
}

/**
 * What the uploader page's own requests add to its video search: a WebGL
 * renderer string (base64 with its last two characters cut, as the page
 * sends it) and the page's location. Without them risk control refuses an
 * anonymous search outright (HTTP 412 or -352, measured 2026-11-19); with them
 * it answers most of the time. Browser-shaped but arbitrary, as yt-dlp's are.
 */
const SPACE_SEARCH_FIELDS: Record<string, string | number> = {
  keyword: '',
  tid: 0,
  platform: 'web',
  order_avoided: 'true',
  web_location: 1550101,
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str:
    'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgRGlyZWN0M0QxMSB2c181XzAgcHNfNV8wLCBEM0QxMSlHb29nbGUgSW5jLiAoSW50ZW',
  dm_img_inter: '{"ds":[],"wh":[5231,6067,75],"of":[475,950,475]}',
};

type ListItem = { bvid?: string; title?: string; duration?: unknown; length?: unknown; attr?: number };

/**
 * One page of an uploader's videos, newest first. The page's own signed
 * search first; when risk control refuses it, the series API's keyword
 * search, which it judges apart: on 2026-11-19 each of the two was refused
 * for one uploader while the other answered. `via` keeps the switch for the
 * pages after.
 */
async function uploaderPage(
  fetchImpl: FetchLike,
  mid: number,
  page: number,
  via: { search: boolean },
): Promise<{ items: ListItem[]; total?: number; author?: string }> {
  if (via.search) {
    try {
      const key = await getWbiKey(fetchImpl);
      const d = await callApi<{ list?: { vlist?: (ListItem & { author?: string })[] }; page?: { count?: number } }>(
        fetchImpl,
        `${API}/x/space/wbi/arc/search?${signedQuery({ mid, pn: page, ps: 30, order: 'pubdate', ...SPACE_SEARCH_FIELDS }, key, Math.floor(Date.now() / 1000))}`,
      );
      const vlist = d.list?.vlist ?? [];
      return {
        items: vlist,
        ...(d.page?.count !== undefined ? { total: d.page.count } : {}),
        ...(vlist[0]?.author ? { author: vlist[0].author } : {}),
      };
    } catch (err) {
      if (!(err instanceof AppErrorException) || err.appError.code !== 'SOURCE_RATE_LIMITED') throw err;
      via.search = false;
    }
  }
  const d = await callApi<{ archives?: ListItem[]; page?: { total?: number } }>(
    fetchImpl,
    `${API}/x/series/recArchivesByKeywords?mid=${mid}&keywords=&ps=30&pn=${page}&orderby=pubdate`,
  );
  return { items: d.archives ?? [], ...(d.page?.total !== undefined ? { total: d.page.total } : {}) };
}

/** An uploader's name, for the list's title. Best effort: the second way in does not carry it. */
async function uploaderName(fetchImpl: FetchLike, mid: number): Promise<string> {
  try {
    const d = await callApi<{ card?: { name?: string } }>(fetchImpl, `${API}/x/web-interface/card?mid=${mid}`);
    return d.card?.name?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * The videos of a list link, oldest pages first, up to `max`. Paged through
 * Bilibili's own endpoints (the uploader's, signed); a deleted video in a
 * favourites list is left out.
 */
export async function fetchBilibiliList(
  fetchImpl: FetchLike,
  list: BilibiliListRef,
  max = 500,
): Promise<{ title: string; total: number; videos: { bvid: string; title: string; durationSec: number }[] }> {
  const videos: { bvid: string; title: string; durationSec: number }[] = [];
  let title = '';
  let total = 0;
  const via = { search: true };
  const add = (items: ListItem[]): number => {
    let n = 0;
    for (const it of items) {
      if (!it.bvid || videos.length >= max) continue;
      // attr 9: a favourite whose video was deleted ("已失效视频").
      if (it.attr === 9) continue;
      videos.push({ bvid: it.bvid, title: it.title?.trim() || it.bvid, durationSec: lengthToSec(it.duration ?? it.length) });
      n += 1;
    }
    return n;
  };
  for (let page = 1; videos.length < max && page <= 50; page++) {
    let got: number;
    if (list.kind === 'season') {
      const d = await callApi<{ archives?: { bvid?: string; title?: string; duration?: number }[]; meta?: { name?: string; total?: number } }>(
        fetchImpl,
        `${API}/x/polymer/web-space/seasons_archives_list?mid=${list.mid ?? 0}&season_id=${list.id}&sort_reverse=false&page_num=${page}&page_size=30`,
      );
      title ||= d.meta?.name ?? '';
      total = d.meta?.total ?? total;
      got = add(d.archives ?? []);
    } else if (list.kind === 'series') {
      const d = await callApi<{ archives?: { bvid?: string; title?: string; duration?: number }[]; page?: { total?: number } }>(
        fetchImpl,
        `${API}/x/series/archives?mid=${list.mid ?? 0}&series_id=${list.id}&only_normal=true&sort=asc&pn=${page}&ps=30`,
      );
      total = d.page?.total ?? total;
      got = add(d.archives ?? []);
    } else if (list.kind === 'favourites') {
      const d = await callApi<{
        info?: { title?: string; media_count?: number };
        medias?: { bvid?: string; title?: string; duration?: number; attr?: number }[] | null;
        has_more?: boolean;
      }>(fetchImpl, `${API}/x/v3/fav/resource/list?media_id=${list.id}&pn=${page}&ps=20&platform=web`);
      title ||= d.info?.title ?? '';
      total = d.info?.media_count ?? total;
      got = add(d.medias ?? []);
      if (!d.has_more) break;
    } else {
      const d = await uploaderPage(fetchImpl, list.id, page, via);
      title ||= d.author ?? '';
      total = d.total ?? total;
      got = add(d.items);
    }
    if (got === 0 || videos.length >= total) break;
  }
  if (!title && list.kind === 'uploader') title = await uploaderName(fetchImpl, list.id);
  return { title, total: Math.max(total, videos.length), videos };
}

/** What the player API adds about one part: the subtitles published for it, and its chapter marks. */
export interface BilibiliPlayerInfo {
  /** CC subtitles, and Bilibili's AI subtitles (`ai-zh`…) when signed in. */
  subtitles: { language: string; label: string; url: string; ai: boolean }[];
  /** 视频看点: the uploader's (or Bilibili's) chapter marks. */
  chapters: { startMs: number; title: string }[];
}

/**
 * The subtitles and chapters of one part (`/x/player/wbi/v2`, signed). Its
 * subtitle URLs are protocol-relative and signed; they are fetched without
 * cookies like media.
 */
export async function fetchPlayerInfo(
  fetchImpl: FetchLike,
  ref: BilibiliRef,
  cid: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<BilibiliPlayerInfo> {
  const key = await getWbiKey(fetchImpl);
  const params: Record<string, string | number> = { cid, ...(ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid ?? 0 }) };
  const data = await callApi<{
    subtitle?: { subtitles?: { lan?: string; lan_doc?: string; subtitle_url?: string; ai_type?: number }[] };
    view_points?: { from?: number; to?: number; content?: string }[];
  }>(fetchImpl, `${API}/x/player/wbi/v2?${signedQuery(params, key, nowSeconds)}`);
  const subtitles = (data.subtitle?.subtitles ?? []).flatMap((s) =>
    s.subtitle_url && s.lan
      ? [
          {
            language: s.lan,
            label: s.lan_doc?.trim() || s.lan,
            url: s.subtitle_url.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url,
            ai: s.lan.startsWith('ai-') || Boolean(s.ai_type),
          },
        ]
      : [],
  );
  const chapters = (data.view_points ?? []).flatMap((v) =>
    typeof v.from === 'number' && v.content?.trim() ? [{ startMs: Math.round(v.from * 1000), title: v.content.trim() }] : [],
  );
  return { subtitles, chapters };
}

/**
 * Headers any media fetch must carry (see BROWSER_HEADERS): the Referer the
 * hosts check, and no cookies. The media URLs are signed for the quality they
 * were issued at, and the hosts (bilivideo.com and mirrors) are other sites,
 * which a browser sends no bilibili.com cookie to.
 */
export function mediaHeaders(): Record<string, string> {
  return { ...BROWSER_HEADERS };
}

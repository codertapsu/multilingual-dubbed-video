import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBilibiliProvider, partBaseName } from './bilibiliProvider.js';
import { _resetWbiKeyCache, getWbiKey, type FetchLike } from './client.js';

/** A fetch stand-in that answers from a URL-substring -> payload map. */
function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return (url: string) => {
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      url,
      json: () => Promise.resolve(routes[hit]),
    });
  };
}

const VIEW_OK = {
  code: 0,
  data: {
    bvid: 'BV1GJ411x7h7',
    title: 'A test video',
    pic: 'https://example.invalid/cover.jpg',
    duration: 125,
    owner: { name: 'Someone' },
    pages: [
      { cid: 11, page: 1, part: 'Part one', duration: 60 },
      { cid: 22, page: 2, part: 'Part two', duration: 65 },
    ],
  },
};

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-bili-provider-'));
  _resetWbiKeyCache();
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('Bilibili provider', () => {
  it('claims Bilibili links and declines everything else', () => {
    // `matches` runs for every provider on every paste, so it must be cheap and
    // offline — and it is what stops an unrelated link reaching this API.
    const p = createBilibiliProvider({ configDir: dir, fetchImpl: fakeFetch({}) });
    expect(p.matches('https://www.bilibili.com/video/BV1GJ411x7h7')).toBe(true);
    expect(p.matches('BV1GJ411x7h7')).toBe(true);
    expect(p.matches('https://www.douyin.com/video/123')).toBe(false);
    expect(p.matches('https://example.com/video/BV1GJ411x7h7')).toBe(false);
  });

  it('translates cids and qn into opaque ids at the boundary', async () => {
    // Nothing above the provider should see Bilibili vocabulary; parts and
    // qualities cross as strings so a provider with UUID parts fits the same
    // contract without changing anything shared.
    const p = createBilibiliProvider({
      configDir: dir,
      fetchImpl: fakeFetch({
        '/x/web-interface/view': VIEW_OK,
        '/x/web-interface/nav': {
          code: -101,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        },
        '/x/player/wbi/playurl': {
          code: 0,
          data: {
            dash: {
              video: [{ id: 32, height: 480, codecid: 7, baseUrl: 'v', bandwidth: 1 }],
              audio: [{ id: 30280, baseUrl: 'a', bandwidth: 1 }],
            },
          },
        },
      }),
    });

    const info = await p.resolve('https://www.bilibili.com/video/BV1GJ411x7h7?p=2');
    expect(info.providerId).toBe('bilibili');
    expect(info.requestedPage).toBe(2);
    expect(info.parts.map((x) => x.id)).toEqual(['11', '22']);
    expect(info.qualities).toEqual([{ id: '32', label: '480p', heightPx: 480 }]);
  });

  it('still previews the video when the quality probe fails', async () => {
    // Title and part list are useful on their own, and the download falls back
    // to the best available quality anyway — so a probe failure must not sink
    // the whole preview.
    const p = createBilibiliProvider({
      configDir: dir,
      fetchImpl: fakeFetch({
        '/x/web-interface/view': VIEW_OK,
        '/x/web-interface/nav': { code: -101, data: {} },
      }),
    });
    const info = await p.resolve('BV1GJ411x7h7');
    expect(info.title).toBe('A test video');
    expect(info.qualities).toEqual([]);
  });

  it('surfaces the server’s own message when Bilibili refuses', async () => {
    // Bilibili answers HTTP 200 with a non-zero code for a removed or private
    // video; a plain res.ok check would report success on nothing.
    const p = createBilibiliProvider({
      configDir: dir,
      fetchImpl: fakeFetch({ '/x/web-interface/view': { code: -404, message: '啥都没有' } }),
    });
    await expect(p.resolve('BV1GJ411x7h7')).rejects.toThrow('啥都没有');
  });
});

describe('partBaseName', () => {
  const part = (page: number, title: string): { id: string; page: number; title: string; durationSec: number } => ({
    id: String(page),
    page,
    title,
    durationSec: 10,
  });

  it('uses the bare title for a single-part video', () => {
    expect(partBaseName({ title: 'A video', parts: [part(1, 'A video')] }, part(1, 'A video'))).toBe(
      'A video',
    );
  });

  it('distinguishes the parts of a multi-part video', () => {
    const info = { title: 'A video', parts: [part(1, 'Intro'), part(2, 'Main')] };
    expect(partBaseName(info, part(2, 'Main'))).toBe('A video - P2 Main');
  });

  it('does not repeat the title when a part has no name of its own', () => {
    // An unnamed part falls back to the video title upstream, which produced
    // the absurd "《雾海之下》… - P1 《雾海之下》…" seen in a real download.
    const info = { title: 'A video', parts: [part(1, 'A video'), part(2, 'Extras')] };
    expect(partBaseName(info, part(1, 'A video'))).toBe('A video - P1');
  });
});

describe('getWbiKey', () => {
  it('accepts the logged-out nav response, which carries the key but reports -101', async () => {
    // REGRESSION: `nav` is an account endpoint that also serves the public
    // signing material. Logged out it answers `-101 账号未登录` WITH a usable
    // wbi_img. Rejecting it on the code alone broke the feature for every
    // anonymous user — which is all of them — and surfaced a bewildering
    // "not logged in" error from a product that has no accounts.
    const key = await getWbiKey(
      fakeFetch({
        '/x/web-interface/nav': {
          code: -101,
          message: '账号未登录',
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        },
      }),
    );
    expect(key).toHaveLength(32);
  });

  it('still fails when the key material is genuinely absent', async () => {
    // The flip side: tolerating -101 must not become "tolerate anything",
    // or a real API change would surface as an unsigned request instead.
    await expect(
      getWbiKey(fakeFetch({ '/x/web-interface/nav': { code: -101, message: '账号未登录', data: {} } })),
    ).rejects.toThrow(/signed request/);
  });
});

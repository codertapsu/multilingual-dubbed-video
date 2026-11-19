import { describe, expect, it } from 'vitest';

import { looksLikeBilibili, parseBilibiliInput } from './url.js';
import { mixinKey, signWbi, signedQuery, wbiKeyPart } from './wbi.js';
import { safeFilename } from '../media.js';

describe('Bilibili input parsing', () => {
  it('accepts every shape a share sheet produces', () => {
    const desktop = parseBilibiliInput('https://www.bilibili.com/video/BV1GJ411x7h7');
    expect(desktop).toEqual({ kind: 'ref', bvid: 'BV1GJ411x7h7', page: 1 });

    // No scheme — what you get pasting from a chat app.
    expect(parseBilibiliInput('bilibili.com/video/BV1GJ411x7h7')).toEqual({
      kind: 'ref',
      bvid: 'BV1GJ411x7h7',
      page: 1,
    });

    // A bare id out of a comment or a filename.
    expect(parseBilibiliInput('BV1GJ411x7h7')).toEqual({ kind: 'ref', bvid: 'BV1GJ411x7h7', page: 1 });

    // Legacy numeric id.
    expect(parseBilibiliInput('https://www.bilibili.com/video/av170001')).toEqual({
      kind: 'ref',
      aid: 170001,
      page: 1,
    });
    expect(parseBilibiliInput('av170001')).toEqual({ kind: 'ref', aid: 170001, page: 1 });
  });

  it('keeps the part number from a multi-part link', () => {
    expect(parseBilibiliInput('https://www.bilibili.com/video/BV1GJ411x7h7?p=3')).toMatchObject({
      page: 3,
    });
    // A nonsense page falls back to 1 rather than producing NaN, which would
    // travel all the way to the API as `p=NaN`.
    expect(parseBilibiliInput('https://www.bilibili.com/video/BV1GJ411x7h7?p=abc')).toMatchObject({
      page: 1,
    });
    expect(parseBilibiliInput('https://www.bilibili.com/video/BV1GJ411x7h7?p=-2')).toMatchObject({
      page: 1,
    });
  });

  it('survives the tracking junk mobile shares append', () => {
    const messy =
      'https://m.bilibili.com/video/BV1GJ411x7h7?p=2&buvid=XY123&from_spmid=main.space&share_source=copy_web';
    expect(parseBilibiliInput(messy)).toEqual({ kind: 'ref', bvid: 'BV1GJ411x7h7', page: 2 });
  });

  it('defers short links instead of guessing', () => {
    // Resolving needs a network round trip, so the parser reports what it is
    // and lets the caller decide — that keeps this function pure.
    expect(parseBilibiliInput('https://b23.tv/aBcDeF')).toEqual({
      kind: 'short-link',
      url: 'https://b23.tv/aBcDeF',
    });
  });

  it('refuses things that merely look BV-ish', () => {
    // The host check is what stops an arbitrary link containing a BV-shaped
    // substring from being sent to the Bilibili API.
    expect(parseBilibiliInput('https://example.com/video/BV1GJ411x7h7')).toBeNull();
    expect(parseBilibiliInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseBilibiliInput('')).toBeNull();
    expect(parseBilibiliInput('   ')).toBeNull();
    expect(parseBilibiliInput('not a url at all')).toBeNull();
    // A BV id is exactly 10 chars after "BV"; a longer run is not an id.
    expect(parseBilibiliInput('BV1GJ411x7h7EXTRA')).toBeNull();
  });

  it('does not let a path segment bleed into the id', () => {
    const withTrailer = parseBilibiliInput('https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id=333');
    expect(withTrailer).toMatchObject({ bvid: 'BV1GJ411x7h7' });
  });

  it('accepts pages that carry the video in the query, not the path', () => {
    // Campaign/festival pages and list pages are ordinary free videos wearing a
    // different URL shape. Rejecting them looks like "this video is
    // unsupported" when it is merely a link we did not recognise.
    expect(parseBilibiliInput('https://www.bilibili.com/festival/2024ncdyj?bvid=BV1GJ411x7h7')).toEqual(
      { kind: 'ref', bvid: 'BV1GJ411x7h7', page: 1 },
    );
    expect(parseBilibiliInput('https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7&p=3')).toEqual(
      { kind: 'ref', bvid: 'BV1GJ411x7h7', page: 3 },
    );
    expect(parseBilibiliInput('https://www.bilibili.com/festival/x?aid=170001')).toEqual({
      kind: 'ref',
      aid: 170001,
      page: 1,
    });
  });

  it('does not accept a malformed bvid from the query', () => {
    // The query is attacker-adjacent free text; it gets the same length anchor
    // the path does, or a junk id travels to the API as though it were real.
    expect(parseBilibiliInput('https://www.bilibili.com/festival/x?bvid=NOTAVIDEO')).toBeNull();
    expect(parseBilibiliInput('https://www.bilibili.com/festival/x?bvid=BV1GJ411x7h7EXTRA')).toBeNull();
    // …and the host check still applies to query-carried ids.
    expect(parseBilibiliInput('https://evil.example.com/x?bvid=BV1GJ411x7h7')).toBeNull();
  });

  it('looksLikeBilibili mirrors the parser', () => {
    expect(looksLikeBilibili('BV1GJ411x7h7')).toBe(true);
    expect(looksLikeBilibili('https://example.com')).toBe(false);
  });
});

describe('WBI request signing', () => {
  it('takes the key material from the image filenames', () => {
    expect(wbiKeyPart('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
    expect(wbiKeyPart(undefined)).toBe('');
    expect(wbiKeyPart('')).toBe('');
  });

  it('derives the exact published mixin key (golden value)', () => {
    // A GOLDEN value, not a self-consistency check. The previous tests here
    // only asserted that signing was deterministic and stripped the right
    // characters — both of which stay true when the permutation table itself
    // is wrong, so they passed against a corrupt table. Worse, live downloads
    // also passed: Bilibili does not currently enforce the signature on the
    // anonymous playurl path (an omitted w_rid is accepted too), so nothing
    // downstream could catch it either.
    //
    // These constants are the key material Bilibili actually serves, and the
    // expectations are the key/signature both reference implementations
    // produce from it. Only a wrong table can break this.
    const key = mixinKey(
      'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    );
    expect(key).toBe('ea1db124af3c7062474693fa704f4ff8');

    const signed = signWbi({ bvid: 'BV1GJ411x7h7', cid: 123 }, key, 1_700_000_000);
    expect(signed['w_rid']).toBe('67adf87af6405bd364b6701f4b1782a0');
  });

  it('derives a 32-character mixin key', () => {
    const key = mixinKey(
      'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    );
    expect(key).toHaveLength(32);
    // Deterministic: the same inputs must always produce the same key, or
    // every signed request becomes a coin flip.
    expect(
      mixinKey(
        'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      ),
    ).toBe(key);
  });

  it('signs deterministically for a fixed timestamp', () => {
    const a = signWbi({ bvid: 'BV1GJ411x7h7', cid: 123 }, 'testkey', 1_700_000_000);
    const b = signWbi({ cid: 123, bvid: 'BV1GJ411x7h7' }, 'testkey', 1_700_000_000);
    // Key ORDER must not matter: the server hashes the sorted canonical form,
    // so two callers passing the same params differently must agree.
    expect(a['w_rid']).toBe(b['w_rid']);
    expect(a['wts']).toBe('1700000000');
    expect(a['w_rid']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes the signature when anything signed changes', () => {
    const base = signWbi({ cid: 1 }, 'k', 1_700_000_000)['w_rid'];
    expect(signWbi({ cid: 2 }, 'k', 1_700_000_000)['w_rid']).not.toBe(base);
    expect(signWbi({ cid: 1 }, 'k2', 1_700_000_000)['w_rid']).not.toBe(base);
    expect(signWbi({ cid: 1 }, 'k', 1_700_000_001)['w_rid']).not.toBe(base);
  });

  it("strips the characters the server ignores, so signature and request agree", () => {
    // !'()* are legal in a query but the server hashes them as absent. If we
    // sign the stripped form and send the raw one (or vice versa) the request
    // fails only for titles containing punctuation — a horrible partial bug.
    const signed = signWbi({ q: "a!b'c(d)e*f" }, 'k', 1_700_000_000);
    expect(signed['q']).toBe('abcdef');
    expect(signed['w_rid']).toBe(signWbi({ q: 'abcdef' }, 'k', 1_700_000_000)['w_rid']);
  });

  it('produces a query string carrying wts and w_rid', () => {
    const qs = new URLSearchParams(signedQuery({ cid: 7 }, 'k', 1_700_000_000));
    expect(qs.get('cid')).toBe('7');
    expect(qs.get('wts')).toBe('1700000000');
    expect(qs.get('w_rid')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('filename safety', () => {
  it('strips characters that are illegal on some platform', () => {
    // Windows refuses \ / : * ? " < > | outright; a Bilibili title containing
    // any of them would otherwise fail only on Windows, at write time.
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('refuses to end a name in a dot or space', () => {
    // Windows silently strips these, so a name ending that way does not round
    // trip — the file we wrote is not the file we later look for.
    expect(safeFilename('trailing dot.')).toBe('trailing dot');
    expect(safeFilename('trailing space   ')).toBe('trailing space');
  });

  it('bounds the length for long multi-byte titles', () => {
    expect(safeFilename('好'.repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeFilename('///')).toBe('source-video');
    expect(safeFilename('   ')).toBe('source-video');
  });

  it('keeps ordinary titles readable', () => {
    expect(safeFilename('【中文】How to dub a video')).toBe('【中文】How to dub a video');
  });
});

describe('bilibiliApiError', () => {
  it('tells waiting, signing in and gone apart', async () => {
    const { bilibiliApiError } = await import('./client.js');
    expect(bilibiliApiError(-352, '风控校验失败').appError.code).toBe('SOURCE_RATE_LIMITED');
    expect(bilibiliApiError(-412, undefined).appError.code).toBe('SOURCE_RATE_LIMITED');
    expect(bilibiliApiError(87008, '充电专属').appError.code).toBe('SOURCE_LOGIN_REQUIRED');
    expect(bilibiliApiError(-404, '啥都木有').appError.code).toBe('SOURCE_UNAVAILABLE');
    expect(bilibiliApiError(-10403, 'region').appError.message).toMatch(/region/);
    expect(bilibiliApiError(12345, 'odd').appError.code).toBe('UNKNOWN');
  });
});

describe('the device id Bilibili expects', () => {
  it('asks for one before the first call and sends it, and goes on without one when the ask fails', async () => {
    const { fetchVideoInfo, _resetDeviceId, setSessionCookies } = await import('./client.js');
    const view = { code: 0, data: { bvid: 'BV1xx411c7mD', title: 'T', duration: 10, pages: [] } };
    const seen: { url: string; cookie?: string }[] = [];
    const fetchWith = (spiOk: boolean) => async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, ...(init?.headers?.['Cookie'] ? { cookie: init.headers['Cookie'] } : {}) });
      const body = url.includes('/finger/spi') ? { code: 0, data: { b_3: 'dev-3', b_4: 'dev-4' } } : view;
      if (url.includes('/finger/spi') && !spiOk) throw new Error('offline');
      return { ok: true, status: 200, url, json: async () => body };
    };

    setSessionCookies({});
    _resetDeviceId();
    await fetchVideoInfo(fetchWith(true), { bvid: 'BV1xx411c7mD', page: 1 });
    expect(seen.map((s) => s.url.replace(/\?.*/, ''))).toEqual([
      'https://api.bilibili.com/x/frontend/finger/spi',
      'https://api.bilibili.com/x/web-interface/view',
    ]);
    expect(seen[1]?.cookie).toBe('buvid3=dev-3; buvid4=dev-4');

    // One from the user's browser wins, and is not asked for again.
    seen.length = 0;
    setSessionCookies({ buvid3: 'browser-dev' });
    await fetchVideoInfo(fetchWith(true), { bvid: 'BV1xx411c7mD', page: 1 });
    expect(seen).toEqual([{ url: expect.stringContaining('/view?'), cookie: 'buvid3=browser-dev' }]);

    // The ask failing costs nothing but the id.
    seen.length = 0;
    setSessionCookies({});
    await fetchVideoInfo(fetchWith(false), { bvid: 'BV1xx411c7mD', page: 1 });
    expect(seen.at(-1)).toEqual({ url: expect.stringContaining('/view?') });
    _resetDeviceId();
  });
});

describe('parseBilibiliList', () => {
  it('recognises collections, series lists, favourites and uploader pages, and nothing else', async () => {
    const { parseBilibiliList } = await import('./client.js');
    expect(parseBilibiliList('https://space.bilibili.com/123/channel/collectiondetail?sid=456')).toEqual({ kind: 'season', mid: 123, id: 456 });
    expect(parseBilibiliList('space.bilibili.com/123/lists/789?type=series')).toEqual({ kind: 'series', mid: 123, id: 789 });
    expect(parseBilibiliList('https://space.bilibili.com/123/lists/789?type=season')).toEqual({ kind: 'season', mid: 123, id: 789 });
    expect(parseBilibiliList('https://space.bilibili.com/123/favlist?fid=55&ftype=create')).toEqual({ kind: 'favourites', mid: 123, id: 55 });
    expect(parseBilibiliList('https://www.bilibili.com/medialist/detail/ml55')).toEqual({ kind: 'favourites', id: 55 });
    expect(parseBilibiliList('https://space.bilibili.com/123/video')).toEqual({ kind: 'uploader', mid: 123, id: 123 });
    expect(parseBilibiliList('https://space.bilibili.com/123')).toEqual({ kind: 'uploader', mid: 123, id: 123 });
    expect(parseBilibiliList('https://www.bilibili.com/video/BV1xx411c7mD')).toBeNull();
    expect(parseBilibiliList('https://space.bilibili.com/123/dynamic')).toBeNull();
  });

  it('pages through a list and leaves out deleted favourites', async () => {
    const { fetchBilibiliList } = await import('./client.js');
    const pages: Record<number, unknown> = {
      1: { code: 0, data: { info: { title: 'Mục yêu thích', media_count: 3 }, has_more: true, medias: [{ bvid: 'BV1aaaaaaaaa', title: 'A', duration: 60 }, { bvid: 'BV1bbbbbbbbb', title: '已失效视频', attr: 9 }] } },
      2: { code: 0, data: { info: { title: 'Mục yêu thích', media_count: 3 }, has_more: false, medias: [{ bvid: 'BV1ccccccccc', title: 'C', duration: 90 }] } },
    };
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      url,
      json: async () => (url.includes('finger/spi') ? { code: 0, data: { b_3: 'x' } } : pages[Number(/pn=(\d+)/.exec(url)![1])]),
    });
    const list = await fetchBilibiliList(fetchImpl, { kind: 'favourites', id: 55 });
    expect(list.title).toBe('Mục yêu thích');
    expect(list.videos.map((v) => v.bvid)).toEqual(['BV1aaaaaaaaa', 'BV1ccccccccc']);
  });

  it("takes an uploader's videos the second way when risk control refuses the page's search", async () => {
    const { fetchBilibiliList, _resetWbiKeyCache } = await import('./client.js');
    _resetWbiKeyCache();
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url.replace(/\?.*$/, ''));
      const body = url.includes('finger/spi')
        ? { code: 0, data: { b_3: 'x' } }
        : url.includes('/nav')
          ? { code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } }
          : url.includes('/arc/search')
            ? { code: -352, message: '风控校验失败' }
            : url.includes('recArchivesByKeywords')
              ? { code: 0, data: { archives: [{ bvid: 'BV1ddddddddd', title: 'D', duration: 61 }], page: { total: 1 } } }
              : { code: 0, data: { card: { name: 'UP主' } } };
      return { ok: true, status: 200, url, json: async () => body };
    };
    const list = await fetchBilibiliList(fetchImpl, { kind: 'uploader', mid: 7, id: 7 });
    expect(list).toEqual({ title: 'UP主', total: 1, videos: [{ bvid: 'BV1ddddddddd', title: 'D', durationSec: 61 }] });
    expect(asked).toContain('https://api.bilibili.com/x/space/wbi/arc/search');
    expect(asked.at(-1)).toBe('https://api.bilibili.com/x/web-interface/card');
  });
});

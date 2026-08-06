import { describe, expect, it } from 'vitest';

import { createDouyinProvider } from './douyinProvider.js';
import { playUrl, type DouyinFetch } from './client.js';
import { looksLikeDouyin, parseDouyinInput } from './url.js';

describe('Douyin input parsing', () => {
  it('accepts a permalink', () => {
    expect(parseDouyinInput('https://www.douyin.com/video/7507549841271147795')).toEqual({
      kind: 'ref',
      awemeId: '7507549841271147795',
    });
  });

  it('accepts the modal_id form the share button actually produces', () => {
    // Feed, profile and "jingxuan" pages carry no id in the path at all — a
    // path-only parser rejects the most common paste there is.
    expect(parseDouyinInput('https://www.douyin.com/jingxuan?modal_id=7507549841271147795')).toEqual(
      { kind: 'ref', awemeId: '7507549841271147795' },
    );
    expect(
      parseDouyinInput('https://www.douyin.com/user/MS4wLjABAAAA?modal_id=7507549841271147795'),
    ).toEqual({ kind: 'ref', awemeId: '7507549841271147795' });
  });

  it('accepts note, slides and share paths', () => {
    expect(parseDouyinInput('https://www.douyin.com/note/7507549841271147795')).toMatchObject({
      awemeId: '7507549841271147795',
    });
    expect(
      parseDouyinInput('https://www.iesdouyin.com/share/video/7507549841271147795'),
    ).toMatchObject({ awemeId: '7507549841271147795' });
  });

  it('accepts a bare numeric id', () => {
    expect(parseDouyinInput('7507549841271147795')).toEqual({
      kind: 'ref',
      awemeId: '7507549841271147795',
    });
  });

  it('defers short links instead of guessing', () => {
    expect(parseDouyinInput('https://v.douyin.com/iRNBho6G/')).toEqual({
      kind: 'short-link',
      url: 'https://v.douyin.com/iRNBho6G/',
    });
  });

  it('refuses short numbers, so an incidental id cannot be mistaken for a video', () => {
    // Requiring a long run of digits is what makes accepting a BARE id safe.
    expect(parseDouyinInput('12345')).toBeNull();
    expect(parseDouyinInput('https://www.douyin.com/video/123')).toBeNull();
  });

  it('refuses other hosts', () => {
    expect(parseDouyinInput('https://example.com/video/7507549841271147795')).toBeNull();
    expect(parseDouyinInput('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
    expect(parseDouyinInput('')).toBeNull();
    expect(parseDouyinInput('not a url')).toBeNull();
  });

  it('looksLikeDouyin mirrors the parser', () => {
    expect(looksLikeDouyin('7507549841271147795')).toBe(true);
    expect(looksLikeDouyin('https://example.com')).toBe(false);
  });
});

/** A share page carrying the blob, shaped like the real one. */
function sharePage(overrides: Record<string, unknown> = {}): string {
  const item = {
    desc: '职场小白升职记',
    author: { nickname: '陈翔六点半' },
    video: {
      height: 1080,
      width: 1920,
      // Milliseconds, as Douyin reports it.
      duration: 347094,
      play_addr: { uri: 'v0200fg10000d0o2nj7og65ivonaovug' },
      cover: { url_list: ['https://example.invalid/cover.jpg'] },
      ...(overrides['video'] as object | undefined),
    },
    ...overrides,
  };
  const blob = { loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [item] } } } };
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify(blob)};</script></html>`;
}

function fakeFetch(body: string, init: { ok?: boolean; status?: number; url?: string } = {}): DouyinFetch {
  return (url) =>
    Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      url: init.url ?? url,
      text: () => Promise.resolve(body),
    });
}

describe('Douyin provider', () => {
  it('claims Douyin links and declines everything else', () => {
    const p = createDouyinProvider({ fetchImpl: fakeFetch('') });
    expect(p.matches('https://www.douyin.com/video/7507549841271147795')).toBe(true);
    expect(p.matches('https://www.bilibili.com/video/BV1GJ411x7h7')).toBe(false);
  });

  it('reads title, author, cover and quality out of the share page', async () => {
    const p = createDouyinProvider({ fetchImpl: fakeFetch(sharePage()) });
    const info = await p.resolve('https://www.douyin.com/video/7507549841271147795');

    expect(info.providerId).toBe('douyin');
    expect(info.title).toBe('职场小白升职记');
    expect(info.ownerName).toBe('陈翔六点半');
    expect(info.coverUrl).toBe('https://example.invalid/cover.jpg');
    // Douyin reports duration in MILLISECONDS; treating it as seconds would
    // show a 6-minute clip as four days.
    expect(info.durationSec).toBe(347);
    expect(info.qualities).toEqual([{ id: '1080', label: '1080p', heightPx: 1080 }]);
    // One post, one video: the part picker must not appear.
    expect(info.parts).toHaveLength(1);
  });

  it('downloads a single muxed file, so no merge runs', async () => {
    const p = createDouyinProvider({ fetchImpl: fakeFetch(sharePage()) });
    const prepared = await p.prepare('7507549841271147795', 1);

    expect(prepared.videoUrl).toContain('video_id=v0200fg10000d0o2nj7og65ivonaovug');
    // Omitting audioUrl is what makes downloadMedia skip ffmpeg entirely.
    expect(prepared.audioUrl).toBeUndefined();
  });

  it('takes no credential, so the credentials card stays hidden for it', () => {
    // The capability being optional is what lets a source that needs nothing
    // simply not have one.
    expect(createDouyinProvider({ fetchImpl: fakeFetch('') }).session).toBeUndefined();
  });

  it('explains a page that loaded but carried no data', async () => {
    // The overwhelmingly common cause is a removed or private video, but it is
    // also exactly what a changed layout looks like — the message says both.
    const p = createDouyinProvider({ fetchImpl: fakeFetch('<html>no blob here</html>') });
    await expect(p.resolve('7507549841271147795')).rejects.toThrow(/could not be read/);
  });

  it('rejects an item with no playable file rather than downloading nothing', async () => {
    // Image posts parse fine and have no video; that must be a clear error, not
    // an empty download.
    const noPlay = sharePage({ video: { play_addr: {} } });
    const p = createDouyinProvider({ fetchImpl: fakeFetch(noPlay) });
    await expect(p.resolve('7507549841271147795')).rejects.toThrow(/No downloadable video/);
  });

  it('survives a trailing semicolon and surrounding junk in the blob', async () => {
    const messy = '<script>window._ROUTER_DATA = ' +
      JSON.stringify({
        loaderData: {
          'video_(id)/page': {
            videoInfoRes: { item_list: [{ desc: 'x', video: { play_addr: { uri: 'u' }, duration: 1000 } }] },
          },
        },
      }) +
      ';  \n</script>';
    const p = createDouyinProvider({ fetchImpl: fakeFetch(messy) });
    const info = await p.resolve('7507549841271147795');
    expect(info.title).toBe('x');
  });

  it('falls back to a usable title when the description is empty', async () => {
    const p = createDouyinProvider({ fetchImpl: fakeFetch(sharePage({ desc: '   ' })) });
    const info = await p.resolve('7507549841271147795');
    expect(info.title).toBe('douyin-7507549841271147795');
  });
});

describe('playUrl', () => {
  it('encodes the media id into the play endpoint', () => {
    const url = playUrl('abc/def');
    expect(url).toContain('video_id=abc%2Fdef');
    expect(url).toContain('ratio=1080p');
  });
});

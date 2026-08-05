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

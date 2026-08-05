import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BilibiliSessionStore, maskCookie, normalizeSessdata } from './session.js';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-bili-session-'));
  delete process.env['BILIBILI_SESSDATA'];
});

afterEach(async () => {
  delete process.env['BILIBILI_SESSDATA'];
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('normalizeSessdata', () => {
  it('accepts the bare value', () => {
    expect(normalizeSessdata('abc123%2Cdef')).toBe('abc123%2Cdef');
    expect(normalizeSessdata('  abc123  ')).toBe('abc123');
  });

  it('accepts a SESSDATA=… pair', () => {
    expect(normalizeSessdata('SESSDATA=abc123')).toBe('abc123');
    expect(normalizeSessdata('sessdata=abc123')).toBe('abc123');
  });

  it('takes ONLY SESSDATA out of a full pasted cookie jar', () => {
    // Copying "Cookie:" wholesale out of devtools is the most likely paste, and
    // it carries bili_jct, DedeUserID and friends. Storing the whole string
    // would persist credentials the feature never needs and never sends.
    const jar = 'buvid3=X; SESSDATA=abc123%2Cdef; bili_jct=secret; DedeUserID=42';
    expect(normalizeSessdata(jar)).toBe('abc123%2Cdef');
    expect(normalizeSessdata(`Cookie: ${jar}`)).toBe('abc123%2Cdef');
  });

  it('refuses a cookie jar that has no SESSDATA rather than storing junk', () => {
    // Treating "buvid3=X; bili_jct=y" as a bare value would send a nonsense
    // Cookie header and fail in a way that points nowhere.
    expect(normalizeSessdata('buvid3=X; bili_jct=y')).toBe('');
    expect(normalizeSessdata('')).toBe('');
    expect(normalizeSessdata('   ')).toBe('');
  });
});

describe('maskCookie', () => {
  it('reveals only enough to tell two values apart', () => {
    // Unlike an API key prefix, no part of SESSDATA is a public identifier.
    expect(maskCookie('abcdefghijklmnop')).toBe('••••mnop');
    expect(maskCookie('short')).toBe('••••');
  });
});

describe('BilibiliSessionStore', () => {
  it('round-trips a pasted cookie and reports it masked', async () => {
    const store = new BilibiliSessionStore(dir);
    expect(await store.describe()).toEqual({ configured: false });

    await store.set('SESSDATA=abcdefghijklmnop');
    expect(await store.get()).toBe('abcdefghijklmnop');
    expect(await store.describe()).toEqual({ configured: true, masked: '••••mnop' });
  });

  it('never writes the secret world-readable', async () => {
    const store = new BilibiliSessionStore(dir);
    await store.set('abcdefghijklmnop');
    const info = await fsp.stat(path.join(dir, 'bilibili-session.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('does not leak the raw value through describe()', async () => {
    const store = new BilibiliSessionStore(dir);
    await store.set('abcdefghijklmnop');
    // describe() feeds an HTTP response; the full cookie must never ride along.
    expect(JSON.stringify(await store.describe())).not.toContain('abcdefghijklmnop');
  });

  it('clears on an empty value, so the field doubles as the off switch', async () => {
    const store = new BilibiliSessionStore(dir);
    await store.set('abcdefghijklmnop');
    await store.set('   ');
    expect(await store.get()).toBeUndefined();
    expect(await store.describe()).toEqual({ configured: false });
  });

  it('clears explicitly', async () => {
    const store = new BilibiliSessionStore(dir);
    await store.set('abcdefghijklmnop');
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });

  it('treats a corrupt file as "not configured" rather than failing', async () => {
    // A broken file must not block downloads that work perfectly anonymously.
    await fsp.writeFile(path.join(dir, 'bilibili-session.json'), '{not json');
    const store = new BilibiliSessionStore(dir);
    expect(await store.get()).toBeUndefined();
    expect(await store.describe()).toEqual({ configured: false });
  });

  it('reports a missing store as unconfigured', async () => {
    const store = new BilibiliSessionStore(path.join(dir, 'nope'));
    expect(await store.get()).toBeUndefined();
  });

  it('lets an env var override the file, and says so', async () => {
    const store = new BilibiliSessionStore(dir);
    await store.set('fromfilevalue');
    process.env['BILIBILI_SESSDATA'] = 'fromenvvalue';
    expect(await store.get()).toBe('fromenvvalue');
    expect(await store.describe()).toMatchObject({ configured: true, fromEnv: true });
  });
});

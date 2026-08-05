import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadMedia, safeFilename, type DownloadProgress } from './media.js';

let dir: string;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-media-'));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await fsp.rm(dir, { recursive: true, force: true });
});

/** Serve fixed bytes for any URL, recording the headers it was given. */
function stubFetch(bytes = 'hello'): { seen: Record<string, string>[] } {
  const seen: Record<string, string>[] = [];
  globalThis.fetch = ((_url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return Promise.resolve(
      new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    );
  }) as unknown as typeof fetch;
  return { seen };
}

describe('downloadMedia', () => {
  it('skips ffmpeg entirely when the source is already muxed', async () => {
    // This is the case the provider seam exists for: a site serving one
    // complete file should not be forced to fake a second stream, and must
    // never invoke ffmpeg. `ffmpegPath` is deliberately a command that would
    // fail loudly if it were ever run.
    stubFetch('a muxed file');
    const progress: DownloadProgress[] = [];

    const out = await downloadMedia(
      {
        videoUrl: 'https://example.invalid/whole.mp4',
        destDir: dir,
        baseName: 'muxed source',
        ffmpegPath: '/nonexistent/ffmpeg-must-not-run',
        headers: {},
      },
      (p) => progress.push(p),
    );

    expect(out).toBe(path.join(dir, 'muxed source.mp4'));
    expect(await fsp.readFile(out, 'utf8')).toBe('a muxed file');
    // The bar must reach 100 on the single download rather than stalling at
    // the 85% reserved for the video half of an adaptive pair.
    expect(progress.at(-1)?.percent).toBe(100);
    expect(progress.some((p) => p.phase === 'audio')).toBe(false);
  });

  it('leaves no .part files behind on the muxed path', async () => {
    stubFetch();
    await downloadMedia(
      {
        videoUrl: 'https://example.invalid/whole.mp4',
        destDir: dir,
        baseName: 'clean',
        ffmpegPath: '/nonexistent/ffmpeg',
        headers: {},
      },
      () => undefined,
    );
    const left = (await fsp.readdir(dir)).filter((f) => f.includes('.part'));
    expect(left).toEqual([]);
  });

  it('passes the provider’s headers to the media fetch', async () => {
    // Hot-link protection means the metadata call can succeed while the media
    // fetch 403s; the headers come from the provider precisely so each source
    // can send what it needs.
    const { seen } = stubFetch();
    await downloadMedia(
      {
        videoUrl: 'https://example.invalid/whole.mp4',
        destDir: dir,
        baseName: 'hdrs',
        ffmpegPath: '/nonexistent/ffmpeg',
        headers: { Referer: 'https://example.invalid/', Cookie: 'SESSDATA=x' },
      },
      () => undefined,
    );
    expect(seen[0]).toMatchObject({ Referer: 'https://example.invalid/', Cookie: 'SESSDATA=x' });
  });

  it('cleans up partial files when a download fails', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 403 }))) as unknown as typeof fetch;

    await expect(
      downloadMedia(
        {
          videoUrl: 'https://example.invalid/whole.mp4',
          destDir: dir,
          baseName: 'doomed',
          ffmpegPath: '/nonexistent/ffmpeg',
          headers: {},
        },
        () => undefined,
      ),
    ).rejects.toThrow();

    // An interrupted download otherwise leaves multi-hundred-megabyte .part
    // files in the user's folder with no indication of what they are.
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});

describe('safeFilename', () => {
  it('strips characters that are illegal on some platform', () => {
    expect(safeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeFilename('///')).toBe('source-video');
  });
});

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadMediaJob, safeFilename, uniqueOutputPath, type DownloadProgress, type MediaJob } from './media.js';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-media-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** Serve fixed bytes for any URL, recording the headers it was given. */
function stubFetch(bytes = 'hello'): { fetchImpl: typeof fetch; seen: Record<string, string>[] } {
  const seen: Record<string, string>[] = [];
  const fetchImpl = ((_url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ ...(init?.headers ?? {}) });
    return Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** A muxed (single-file) job into `dir`. */
function job(name: string, extra: Partial<MediaJob> = {}): MediaJob {
  return {
    video: { urls: ['https://example.invalid/whole.mp4'], partialPath: path.join(dir, `.${name}.video.part`) },
    outputPath: path.join(dir, `${name}.mp4`),
    // `ffmpegPath` is a command that would fail loudly if it were ever run.
    ffmpegPath: '/nonexistent/ffmpeg-must-not-run',
    // Stub bytes are not real media; these tests are about the transfer, so
    // the playability check reads as "ffprobe missing" (unverified, allowed).
    ffprobePath: '/nonexistent/ffprobe',
    headers: {},
    ...extra,
  };
}

describe('downloadMediaJob', () => {
  it('skips ffmpeg entirely when the source is already muxed, and leaves nothing half-done', async () => {
    const { fetchImpl } = stubFetch('a muxed file');
    const progress: DownloadProgress[] = [];
    const out = await downloadMediaJob(job('muxed source'), (p) => progress.push(p), { fetchImpl });
    expect(await fsp.readFile(out, 'utf8')).toBe('a muxed file');
    expect(await fsp.readdir(dir)).toEqual(['muxed source.mp4']);
    // No merge happened, so the bar never claims one.
    expect(progress.some((p) => p.phase === 'merging')).toBe(false);
    expect(progress.at(-1)?.percent).toBe(100);
  });

  it('passes the provider’s headers to the media fetch', async () => {
    const { fetchImpl, seen } = stubFetch();
    await downloadMediaJob(job('h', { headers: { Referer: 'https://www.bilibili.com/' } }), () => undefined, { fetchImpl });
    expect(seen[0]?.['Referer']).toBe('https://www.bilibili.com/');
  });

  it('keeps no finished-looking file when a download fails, only its partial bytes for the retry', async () => {
    const fetchImpl = (() => Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;
    await expect(downloadMediaJob(job('doomed'), () => undefined, { fetchImpl, retryDelaysMs: [0] })).rejects.toThrow();
    const left = await fsp.readdir(dir);
    expect(left.filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });

  it('refuses to start when the drive cannot hold the download', async () => {
    const { fetchImpl } = stubFetch();
    await expect(
      downloadMediaJob(job('huge', { expectedBytes: 1e18 }), () => undefined, { fetchImpl }),
    ).rejects.toMatchObject({ appError: { code: 'DISK_FULL' } });
  });
});

describe('post-download verification', () => {
  it('rejects a file that is not readable media, even though the bytes arrived', async () => {
    // The download "succeeded" — bytes were written — but the result is not a
    // video. Catching it here beats discovering it at the transcribe step,
    // where the error points at the wrong part of the app.
    const { fetchImpl } = stubFetch('this is definitely not an mp4');
    await expect(
      downloadMediaJob(job('not-a-video', { ffprobePath: 'ffprobe' }), () => undefined, { fetchImpl }),
    ).rejects.toThrow(/could not be read back|no usable video/);
    // Complete or absent: nothing under the final name.
    expect((await fsp.readdir(dir)).filter((f) => f.endsWith('.mp4'))).toEqual([]);
  });
});

describe('uniqueOutputPath', () => {
  it('numbers a name that is taken on disk or by another download', async () => {
    await fsp.writeFile(path.join(dir, 'Clip.mp4'), 'x');
    const taken = new Set([path.join(dir, 'Clip (2).mp4')]);
    expect(await uniqueOutputPath(dir, 'Clip', (p) => taken.has(p))).toBe(path.join(dir, 'Clip (3).mp4'));
    expect(await uniqueOutputPath(dir, 'Other')).toBe(path.join(dir, 'Other.mp4'));
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

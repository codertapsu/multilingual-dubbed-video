import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException, type DownloadItem, type DownloadQueueEvent } from '@videodubber/shared';

import { parseContentRange } from './media.js';
import { DownloadQueue, type DownloadQueueDeps } from './queue.js';
import type { PreparedDownload, SourceProvider } from './types.js';

let dir: string;
let queues: DownloadQueue[];

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-queue-'));
  queues = [];
});

afterEach(async () => {
  for (const q of queues) await q.stop();
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The bytes each fake video serves. */
const bodyOf = (id: string): Buffer => Buffer.from(`video ${id} `.repeat(500));

/** A provider for `fake:<id>` links, whose media URLs answer through `media`. */
function fakeProvider(opts: { title?: (id: string) => string; prepare?: (id: string, page: number) => Promise<void> } = {}): SourceProvider & { prepared: string[] } {
  const prepared: string[] = [];
  return {
    id: 'fake',
    prepared,
    matches: (input) => input.startsWith('fake:'),
    sourceKey: (input, page) => `fake:${input.slice(5).split('?')[0]}:p${page ?? 1}`,
    resolve: () => Promise.reject(new Error('not used')),
    async prepare(input, page): Promise<PreparedDownload> {
      const id = input.slice(5).split('?')[0]!;
      prepared.push(`${id}:${page}`);
      await opts.prepare?.(id, page);
      const title = opts.title?.(id) ?? `Video ${id}`;
      return {
        videoUrl: `https://media.invalid/${id}/${prepared.length}`,
        videoFallbackUrls: [`https://mirror.invalid/${id}`],
        baseName: title,
        title,
        headers: { Referer: 'https://fake.invalid/' },
        source: { providerId: 'fake', sourceKey: `fake:${id}:p${page}`, url: `https://fake.invalid/${id}`, title, page, partCount: 1 },
      };
    },
  };
}

type Handler = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Response | Promise<Response>;

/** Serve each video's bytes, honouring Range, unless a test overrides a call. */
function media(overrides: Handler[] = []): { fetchImpl: typeof fetch; calls: { url: string; range?: string }[] } {
  const calls: { url: string; range?: string }[] = [];
  const fetchImpl = (async (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const range = init.headers?.['Range'];
    calls.push({ url, ...(range ? { range } : {}) });
    const special = overrides.shift();
    if (special) return special(url, init);
    const id = url.split('/')[3]!;
    const body = bodyOf(id);
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)![1]);
      if (from >= body.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.length}` } });
      const rest = body.subarray(from);
      return new Response(rest, {
        status: 206,
        headers: { 'content-length': String(rest.length), 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` },
      });
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A response that sends `n` bytes of the video and then drops the connection. */
function dropsAfter(n: number): Handler {
  return (url) => {
    const body = bodyOf(url.split('/')[3]!);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(body.subarray(0, n)));
        // A moment later, as on a real network: the bytes reach the disk first.
        setTimeout(() => c.error(new Error('connection reset')), 60);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
  };
}

function queueWith(provider: SourceProvider, fetchImpl: typeof fetch, extra: Partial<DownloadQueueDeps> = {}): DownloadQueue {
  const q = new DownloadQueue({
    file: path.join(dir, 'config', 'download-queue.json'),
    downloadsDir: () => path.join(dir, 'downloads'),
    providers: [provider],
    ffmpegPath: path.join(dir, 'no-ffmpeg'),
    ffprobePath: path.join(dir, 'no-ffprobe'), // unverified, as when ffprobe is missing
    pacingMs: 0,
    fetch: { fetchImpl, sleep: async () => undefined, retryDelaysMs: [0, 0, 0] },
    ...extra,
  });
  queues.push(q);
  return q;
}

async function settled(q: DownloadQueue, id: string, state: DownloadItem['state'] = 'done'): Promise<DownloadItem> {
  await vi.waitFor(() => expect(q.get(id)?.state).toBe(state), { timeout: 5000 });
  return q.get(id)!;
}

describe('DownloadQueue', () => {
  it('downloads a batch, two at a time, each to its own file', async () => {
    const { fetchImpl } = media();
    const q = queueWith(fakeProvider({ title: () => 'Same title' }), fetchImpl);
    const res = await q.add([{ input: 'fake:a' }, { input: 'fake:b' }, { input: 'fake:c' }]);
    expect(res.added).toHaveLength(3);
    const done = await Promise.all(res.added.map((i) => settled(q, i.id)));

    const names = done.map((d) => path.basename(d.filePath!)).sort();
    expect(names).toEqual(['Same title (2).mp4', 'Same title (3).mp4', 'Same title.mp4']);
    for (const d of done) {
      expect(await fsp.readFile(d.filePath!)).toEqual(bodyOf(d.source!.sourceKey.split(':')[1]!));
      expect(d.source?.sourceKey).toMatch(/^fake:[abc]:p1$/);
      expect(d.percent).toBe(100);
    }
    // Nothing half-written is left beside them.
    expect((await fsp.readdir(path.join(dir, 'downloads'))).filter((f) => f.includes('part'))).toEqual([]);
  });

  it('returns the existing download for a link asked for again, and retries one that failed', async () => {
    let fail = true;
    const q = queueWith(
      fakeProvider({
        prepare: async () => {
          if (fail) throw new AppErrorException('SOURCE_UNAVAILABLE', 'gone');
        },
      }),
      media().fetchImpl,
    );
    const first = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const failed = await settled(q, first.id, 'failed');
    expect(failed.error?.code).toBe('SOURCE_UNAVAILABLE');

    fail = false;
    const again = await q.add([{ input: 'fake:a?share=1' }, { input: 'fake:a' }]);
    expect(again.added).toHaveLength(0);
    expect(again.existing.map((i) => i.id)).toEqual([first.id, first.id]);
    expect((await settled(q, first.id)).attempts).toBe(2);
  });

  it('continues a dropped download from its bytes instead of starting over', async () => {
    const { fetchImpl, calls } = media([dropsAfter(1000)]);
    const q = queueWith(fakeProvider(), fetchImpl);
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const done = await settled(q, item.id);
    expect(await fsp.readFile(done.filePath!)).toEqual(bodyOf('a'));
    // The second request asked for the rest, from the mirror.
    expect(calls[1]).toEqual({ url: 'https://mirror.invalid/a', range: 'bytes=1000-' });
  });

  it('starts over when the server ignores the range, never splicing the bytes', async () => {
    const whole = (url: string): Response => {
      const body = bodyOf(url.split('/')[3]!);
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const { fetchImpl, calls } = media([dropsAfter(1000), whole]);
    const q = queueWith(fakeProvider(), fetchImpl);
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const done = await settled(q, item.id);
    expect(calls[1]?.range).toBe('bytes=1000-');
    expect(await fsp.readFile(done.filePath!)).toEqual(bodyOf('a'));
  });

  it('asks the site for fresh links when every link is refused as expired', async () => {
    const refused = (): Response => new Response(null, { status: 403 });
    const provider = fakeProvider();
    const q = queueWith(provider, media([refused, refused]).fetchImpl);
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const done = await settled(q, item.id);
    expect(provider.prepared).toEqual(['a:1', 'a:1']);
    expect(await fsp.readFile(done.filePath!)).toEqual(bodyOf('a'));
  });

  it('waits out a rate limit instead of failing, then gives up after the last wait', async () => {
    let limited = 1;
    const q = queueWith(
      fakeProvider({
        prepare: async () => {
          if (limited-- > 0) throw new AppErrorException('SOURCE_RATE_LIMITED', 'slow down');
        },
      }),
      media().fetchImpl,
      { rateLimitWaitsMs: [30] },
    );
    const events: DownloadQueueEvent[] = [];
    q.subscribe((e) => events.push(e));
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    expect((await settled(q, item.id)).filePath).toBeDefined();
    const waiting = events.find((e) => e.type === 'item' && e.item.state === 'queued' && e.item.retryAt);
    expect(waiting).toBeDefined();

    limited = 5;
    const second = (await q.add([{ input: 'fake:b' }])).added[0]!;
    expect((await settled(q, second.id, 'failed')).error?.code).toBe('SOURCE_RATE_LIMITED');
  });

  it('cancels a download and removes its partial files; a retry starts again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Handler = async (url) => {
      const body = bodyOf(url.split('/')[3]!);
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new Uint8Array(body.subarray(0, 500)));
          await gate;
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const q = queueWith(fakeProvider(), media([slow]).fetchImpl);
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    await vi.waitFor(async () => expect((await fsp.readdir(path.join(dir, 'downloads'))).some((f) => f.endsWith('.part'))).toBe(true));
    await q.cancel(item.id);
    release();
    await settled(q, item.id, 'cancelled');
    expect((await fsp.readdir(path.join(dir, 'downloads'))).filter((f) => f.endsWith('.part'))).toEqual([]);

    q.retry(item.id);
    expect(await fsp.readFile((await settled(q, item.id)).filePath!)).toEqual(bodyOf('a'));
  });

  it('pauses a download while a dub needs the machine, keeping its bytes, and goes on from them', async () => {
    let open = true;
    const stalls: Handler = (url, init) => {
      const body = bodyOf(url.split('/')[3]!);
      // 1200 bytes, then nothing until the download is stopped (as fetch does, the abort ends the body).
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(new Uint8Array(body.subarray(0, 1200)));
          init.signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const { fetchImpl, calls } = media([stalls]);
    const provider = fakeProvider();
    const q = queueWith(provider, fetchImpl, { gate: () => (open ? { limit: 2 } : { limit: 0, reason: 'gpu-heavy' }) });
    const item = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const part = path.join(dir, 'downloads', `.${item.id}.video.part`);
    await vi.waitFor(async () => expect((await fsp.stat(part)).size).toBe(1200));

    open = false;
    q.reconsider();
    await vi.waitFor(() => expect(q.get(item.id)).toMatchObject({ state: 'queued', heldBy: 'gpu-heavy' }));
    expect((await fsp.stat(part)).size).toBe(1200);

    open = true;
    q.reconsider();
    const done = await settled(q, item.id);
    expect(done.heldBy).toBeUndefined();
    // Fresh links first (they are signed and expire), then the rest of the bytes.
    expect(provider.prepared).toEqual(['a:1', 'a:1']);
    expect(calls.at(-1)?.range).toBe('bytes=1200-');
    expect(await fsp.readFile(done.filePath!)).toEqual(bodyOf('a'));
  });

  it('continues an interrupted download after a restart, from the bytes on disk', async () => {
    const q1 = queueWith(fakeProvider(), media([dropsAfter(1200), () => Promise.reject(new Error('offline'))]).fetchImpl, {
      fetch: { fetchImpl: media([dropsAfter(1200)]).fetchImpl, sleep: () => new Promise(() => undefined), retryDelaysMs: [0] },
    });
    const item = (await q1.add([{ input: 'fake:a' }])).added[0]!;
    await vi.waitFor(async () => {
      const part = path.join(dir, 'downloads', `.${item.id}.video.part`);
      expect((await fsp.stat(part)).size).toBe(1200);
    });
    await q1.stop(); // the app closes mid-download

    const { fetchImpl, calls } = media();
    const q2 = queueWith(fakeProvider(), fetchImpl);
    await q2.load();
    const done = await settled(q2, item.id);
    expect(calls[0]?.range).toBe('bytes=1200-');
    expect(await fsp.readFile(done.filePath!)).toEqual(bodyOf('a'));
  });

  it('turns away links no provider knows, naming what is supported', async () => {
    const q = queueWith(fakeProvider(), media().fetchImpl);
    const res = await q.add([{ input: 'https://example.com/x' }, { input: '' }]);
    expect(res.added).toEqual([]);
    expect(res.rejected.map((r) => r.error.code)).toEqual(['INVALID_VIDEO_LINK', 'INVALID_VIDEO_LINK']);
  });

  it('adds the other parts of a multi-part video when asked for all of them', async () => {
    const provider = fakeProvider();
    const parted: SourceProvider = {
      ...provider,
      async prepare(input, page, h) {
        const p = await provider.prepare(input, page, h);
        return { ...p, source: { ...p.source, partCount: 3, url: `fake:${input.slice(5).split('?')[0]}?p=${page}` } };
      },
    };
    const q = queueWith(parted, media().fetchImpl);
    await q.add([{ input: 'fake:m' }], { allParts: true });
    await vi.waitFor(() => expect(q.list().filter((i) => i.state === 'done')).toHaveLength(3));
    expect(q.list().map((i) => i.page).sort()).toEqual([1, 2, 3]);
  });

  it('removes a download with its file only when asked, and only from the downloads folder', async () => {
    const q = queueWith(fakeProvider(), media().fetchImpl);
    const a = (await q.add([{ input: 'fake:a' }])).added[0]!;
    const b = (await q.add([{ input: 'fake:b' }])).added[0]!;
    const fa = (await settled(q, a.id)).filePath!;
    const fb = (await settled(q, b.id)).filePath!;
    await q.remove(a.id);
    await q.remove(b.id, { deleteFile: true });
    expect(q.list()).toEqual([]);
    await expect(fsp.stat(fa)).resolves.toBeTruthy();
    await expect(fsp.stat(fb)).rejects.toThrow();
  });
});

describe('parseContentRange', () => {
  it('reads a range and an unsatisfiable answer', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, total: 1000 });
    expect(parseContentRange('bytes */1000')).toEqual({ total: 1000 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0 });
    expect(parseContentRange('nonsense')).toBeUndefined();
    expect(parseContentRange(null)).toBeUndefined();
  });
});

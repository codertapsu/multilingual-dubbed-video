import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppErrorException } from '@videodubber/shared';

import {
  DownloadBus,
  resolveVideo,
  startDownload,
  type DownloadDeps,
  type DownloadEvent,
} from './downloadService.js';
import type { PreparedDownload, ResolvedSourceVideo, SourceProvider } from './types.js';

/**
 * A stand-in provider.
 *
 * The point of the provider seam is that the job lifecycle can be tested
 * without touching a real site: everything here exercises the service, not
 * Bilibili.
 */
function fakeProvider(overrides: Partial<SourceProvider> = {}): SourceProvider {
  return {
    id: 'fake',
    matches: (input) => input.startsWith('fake:'),
    resolve: (): Promise<ResolvedSourceVideo> =>
      Promise.resolve({
        providerId: 'fake',
        title: 'A fake video',
        durationSec: 10,
        parts: [{ id: 'p1', page: 1, title: 'One', durationSec: 10 }],
        requestedPage: 1,
        qualities: [{ id: 'hd', label: 'HD' }],
      }),
    prepare: (): Promise<PreparedDownload> =>
      Promise.resolve({
        videoUrl: 'https://example.invalid/v',
        baseName: 'A fake video',
        title: 'A fake video',
        headers: {},
      }),
    ...overrides,
  };
}

function deps(providers: SourceProvider[], bus = new DownloadBus()): DownloadDeps {
  return { bus, destDir: '/tmp', ffmpegPath: 'ffmpeg', providers };
}

describe('DownloadBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays the latest state of a live job to a late subscriber', () => {
    // This is what makes navigating away and back mid-download work: without
    // replay the screen shows an idle form while bytes are still moving.
    const bus = new DownloadBus();
    bus.emit({ type: 'progress', jobId: 'j1', phase: 'video', percent: 10 });
    bus.emit({ type: 'progress', jobId: 'j1', phase: 'video', percent: 40 });

    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    // Only the LATEST state, not the whole history — a reconnecting client
    // wants the current percent, not a replay of every tick.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'progress', jobId: 'j1', phase: 'video', percent: 40 });
  });

  it('replays a terminal outcome so a reconnect still sees the result', () => {
    const bus = new DownloadBus();
    bus.emit({ type: 'done', jobId: 'j1', filePath: '/tmp/a.mp4', title: 'A' });

    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'done', filePath: '/tmp/a.mp4' });
  });

  it('forgets finished jobs once nobody could still care', () => {
    const bus = new DownloadBus();
    bus.emit({ type: 'done', jobId: 'old', filePath: '/tmp/a.mp4', title: 'A' });

    vi.advanceTimersByTime(6 * 60 * 1000);

    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    // Otherwise every finished download accumulates for the life of the
    // process and is replayed to every future subscriber.
    expect(seen).toEqual([]);
  });

  it('never forgets a job that is still running, however long it takes', () => {
    // A large download on a slow connection can easily outlive the retention
    // window; expiring it would blank the progress bar mid-download.
    const bus = new DownloadBus();
    bus.emit({ type: 'progress', jobId: 'slow', phase: 'video', percent: 3 });

    vi.advanceTimersByTime(60 * 60 * 1000);

    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ jobId: 'slow', percent: 3 });
  });

  it('marks catch-up events as replay, and live events as not', () => {
    // The flag is what lets a client resume a running download without also
    // resurrecting the previous job's outcome. See the client-side filter.
    const bus = new DownloadBus();
    bus.emit({ type: 'error', jobId: 'old', error: { code: 'UNKNOWN', message: 'boom' } });

    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(seen[0]).toMatchObject({ type: 'error', jobId: 'old', replay: true });

    bus.emit({ type: 'progress', jobId: 'new', phase: 'video', percent: 5 });
    expect(seen[1]?.replay).toBeUndefined();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new DownloadBus();
    const seen: DownloadEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    off();
    bus.emit({ type: 'progress', jobId: 'j1', phase: 'video', percent: 1 });
    expect(seen).toEqual([]);
  });
});

describe('resolveVideo', () => {
  it('dispatches to the provider that recognises the input', async () => {
    const info = await resolveVideo('fake:abc', deps([fakeProvider()]));
    expect(info.providerId).toBe('fake');
    expect(info.title).toBe('A fake video');
  });

  it('names the supported sources when nothing matches', async () => {
    // "Unsupported link" is useless when what IS supported depends on which
    // providers the build carries, so the message has to list them.
    await expect(resolveVideo('https://example.com/x', deps([fakeProvider()]))).rejects.toThrow(
      /not from a supported site/,
    );
    try {
      await resolveVideo('https://example.com/x', deps([fakeProvider()]));
      expect.unreachable('an unsupported link must reject');
    } catch (err) {
      expect((err as AppErrorException).appError.remediation).toContain('fake');
    }
  });

  it('picks the first provider that matches, so registry order is the tie-break', async () => {
    const first = fakeProvider({ id: 'first', matches: () => true });
    const second = fakeProvider({ id: 'second', matches: () => true });
    const info = await resolveVideo('anything', deps([first, second]));
    expect(info.providerId).toBe('fake'); // resolve() of `first` is used
    expect(first.matches('anything')).toBe(true);
    expect(second.matches('anything')).toBe(true);
  });
});

describe('startDownload', () => {
  it('reports an unsupported link as an error event rather than throwing', async () => {
    // The route returns 202 immediately, so a synchronous throw would be lost
    // and the UI would wait forever on a download that never started.
    const bus = new DownloadBus();
    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const jobId = startDownload('https://example.com/x', 1, deps([fakeProvider()], bus), 'job-1');
    expect(jobId).toBe('job-1');

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ type: 'error', jobId: 'job-1' });
  });

  it('surfaces a provider failure as an error event', async () => {
    const bus = new DownloadBus();
    const seen: DownloadEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const failing = fakeProvider({
      prepare: () => Promise.reject(new Error('provider exploded')),
    });
    startDownload('fake:abc', 1, deps([failing], bus), 'job-2');

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ type: 'error', jobId: 'job-2' });
  });

  it('passes the requested quality through to the provider', async () => {
    const prepare = vi.fn().mockResolvedValue({
      videoUrl: 'https://example.invalid/v',
      baseName: 'x',
      title: 'x',
      headers: {},
    });
    const provider = fakeProvider({ prepare });
    startDownload('fake:abc', 2, deps([provider]), 'job-3', 'sd');

    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledWith('fake:abc', 2, 'sd');
  });
});

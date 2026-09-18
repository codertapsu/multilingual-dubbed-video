import { describe, expect, it } from 'vitest';
import { describeStretch, MEDIA_SERVICE_METHODS, type PipelineMediaService } from './media.js';
import { createLazyMediaService } from './server.js';
import { FakeMediaService } from './test/fixtures.js';

/**
 * These tests exist because of a shipped bug: the orchestrator's lazy media
 * proxy forwarded six methods by hand and silently dropped `clip16kMono`, which
 * is the exact capability the runner tests to decide whether a long video gets
 * chunked STT. Chunking was therefore dead in every packaged build, and no
 * runner test could see it (the fixture media service implements the method).
 *
 * The invariant worth protecting is "the proxy's surface == the interface's
 * surface", so that is what we assert.
 */
describe('createLazyMediaService', () => {
  it('exposes EVERY method of PipelineMediaService (no capability may be dropped)', () => {
    const proxy = createLazyMediaService(async () => new FakeMediaService());
    expect(Object.keys(proxy).sort()).toEqual([...MEDIA_SERVICE_METHODS].sort());
    // The chunking gate specifically — the one that regressed.
    expect(typeof proxy.clip16kMono).toBe('function');
  });

  it('matches the real adapter surface, which the fixture service stands in for', () => {
    // FakeMediaService implements PipelineMediaService in full, exactly like the
    // ffmpeg adapter built by mediaAdapter.ts.
    const real: PipelineMediaService = new FakeMediaService();
    for (const name of MEDIA_SERVICE_METHODS) {
      expect(typeof real[name]).toBe('function');
    }
  });

  it('forwards arguments (including the cancellation signal) to the resolved service', async () => {
    const calls: unknown[][] = [];
    const controller = new AbortController();
    const fake = {
      clip16kMono: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ audioPath: 'clip.wav', sampleRate: 16000, channels: 1, durationMs: 500 });
      },
    } as unknown as PipelineMediaService;

    const proxy = createLazyMediaService(async () => fake);
    await proxy.clip16kMono?.('in.wav', 'clip.wav', 0, 500, controller.signal);

    expect(calls).toEqual([['in.wav', 'clip.wav', 0, 500, controller.signal]]);
  });

  it('resolves the real service once, lazily', async () => {
    let loads = 0;
    const proxy = createLazyMediaService(async () => {
      loads += 1;
      return new FakeMediaService();
    });
    expect(loads).toBe(0);
    await proxy.probe('video.mp4');
    await proxy.probe('video.mp4');
    expect(loads).toBe(1);
  });

  it('reports a clear error when the loaded worker lacks a method', async () => {
    const proxy = createLazyMediaService(async () => ({}) as unknown as PipelineMediaService);
    await expect(proxy.duckAndMix({} as never)).rejects.toThrow(/does not provide "duckAndMix"/);
  });
});

describe('describeStretch', () => {
  it('names the mechanism and the detected capabilities', () => {
    expect(
      describeStretch({
        stretched: 12,
        rubberbandFilter: 0,
        rubberbandCli: 0,
        atempo: 12,
        capabilities: { ffmpegFilter: false, cli: false },
      }),
    ).toBe('Time-stretch: 12 clip(s) stretched — 12 via atempo (rubberband available: filter=no, cli=no).');
  });

  it('reports a mixed run', () => {
    const line = describeStretch({
      stretched: 5,
      rubberbandFilter: 3,
      rubberbandCli: 1,
      atempo: 1,
      capabilities: { ffmpegFilter: true, cli: true },
    });
    expect(line).toContain('3 via the ffmpeg rubberband filter');
    expect(line).toContain('1 via the rubberband CLI');
    expect(line).toContain('1 via atempo');
  });

  it('says so when nothing needed stretching', () => {
    expect(
      describeStretch({
        stretched: 0,
        rubberbandFilter: 0,
        rubberbandCli: 0,
        atempo: 0,
        capabilities: { ffmpegFilter: true, cli: false },
      }),
    ).toBe('Time-stretch: no clip needed stretching.');
  });
});

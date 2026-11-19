import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Fake ffmpeg: each "mix" writes a file naming its inputs, so the test can see
// exactly which intermediates fed the final mix, in which order.
vi.mock('./exec.js', () => ({
  runFfmpeg: vi.fn(),
  assertInputReadable: vi.fn(),
  assertOutputWritable: vi.fn(),
}));
vi.mock('./probe.js', () => ({ probeDurationMs: vi.fn(async () => 1000) }));

import { runFfmpeg } from './exec.js';
import { buildTtsTimeline, MAX_INPUTS_PER_MIX } from './tts-timeline.js';

const runFfmpegMock = vi.mocked(runFfmpeg);
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Inputs (`-i` operands) of an ffmpeg argv. */
const inputsOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-i' ? [a] : []));

describe('buildTtsTimeline chunked mix (parallel)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vd-timeline-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => runFfmpegMock.mockReset());

  // 2 full chunks + 1 partial = 3 chunk mixes, then the final mix.
  const segments = Array.from({ length: MAX_INPUTS_PER_MIX * 2 + 6 }, (_, i) => ({
    audioPath: join('clips', `segment_${String(i).padStart(4, '0')}.wav`),
    startMs: i * 10,
  }));

  it('mixes chunks side by side but feeds the final mix in CHUNK order (byte-identical to sequential)', async () => {
    let inFlight = 0;
    let peak = 0;
    let finalInputs: string[] = [];
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      const out = args[args.length - 1]!;
      if (basename(out).startsWith('chunk_')) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Chunk 0 finishes LAST: completion order must not leak into the result.
        await tick(basename(out) === 'chunk_0000.wav' ? 30 : 5);
        inFlight -= 1;
      } else {
        finalInputs = inputsOf(args);
      }
      writeFileSync(out, inputsOf(args).join('\n'));
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    const outputPath = join(dir, 'tts_full.wav');
    await buildTtsTimeline({ segments, totalDurationMs: 1000, outputPath, mixConcurrency: 2 });

    expect(peak).toBe(2);
    expect(finalInputs.map((p) => basename(p))).toEqual(['chunk_0000.wav', 'chunk_0001.wav', 'chunk_0002.wav']);
    // Each chunk got its own 32 clips, in timeline order.
    const chunkCalls = runFfmpegMock.mock.calls.filter((c) => basename(c[0].at(-1)!).startsWith('chunk_'));
    const byName = new Map(chunkCalls.map((c) => [basename(c[0].at(-1)!), inputsOf(c[0])]));
    expect(byName.get('chunk_0001.wav')![0]).toBe(segments[MAX_INPUTS_PER_MIX]!.audioPath);
    expect(byName.get('chunk_0002.wav')).toHaveLength(6);
    // Final output published atomically.
    expect(readFileSync(outputPath, 'utf8')).toContain('chunk_0002.wav');
    // The scratch dir with the intermediates is gone.
    expect(existsSync(dirname(finalInputs[0]!))).toBe(false);
  });

  it('mixes each chunk over its own stretch only, and places it back where it starts', async () => {
    const graphs = new Map<string, string>();
    runFfmpegMock.mockImplementation((async (args: string[]) => {
      const out = args[args.length - 1]!;
      graphs.set(basename(out).replace(/\.partial/, ''), args[args.indexOf('-filter_complex') + 1]!);
      writeFileSync(out, inputsOf(args).join('\n'));
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await buildTtsTimeline({ segments, totalDurationMs: 60_000, outputPath: join(dir, 'tts_full.wav'), mixConcurrency: 1 });

    // Chunk 1 starts at its first clip (32 x 10 ms): relative delays from 0, and
    // no padding to the video's length (that made every intermediate full-length).
    const chunk1 = graphs.get('chunk_0001.wav')!;
    expect(chunk1).toContain('adelay=0|0');
    expect(chunk1).toContain('adelay=310|310');
    expect(chunk1).not.toContain('apad');
    // The final mix places each chunk at its start, unfaded, and pins the full length.
    const final = [...graphs.entries()].find(([name]) => !name.startsWith('chunk_'))![1];
    expect(final).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=320|320');
    expect(final).toContain('[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=640|640');
    expect(final).not.toContain('afade');
    expect(final).toContain('apad=whole_dur=60.000');
  });

  it('a failing chunk kills its siblings, skips the final mix, and cleans up', async () => {
    const signals: AbortSignal[] = [];
    let scratch = '';
    runFfmpegMock.mockImplementation((async (args: string[], opts: { signal?: AbortSignal }) => {
      const out = args[args.length - 1]!;
      scratch = dirname(out);
      signals.push(opts.signal!);
      if (basename(out) === 'chunk_0001.wav') throw new Error('ffmpeg exited with code 1');
      // A slow sibling that only stops when killed.
      await new Promise<void>((_res, rej) => opts.signal!.addEventListener('abort', () => rej(new Error('killed')), { once: true }));
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    const outputPath = join(dir, 'fails.wav');
    await expect(
      buildTtsTimeline({ segments, totalDurationMs: 1000, outputPath, mixConcurrency: 2 }),
    ).rejects.toThrow('ffmpeg exited with code 1');
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(runFfmpegMock).toHaveBeenCalledTimes(2); // chunk 0 + chunk 1; no chunk 2, no final mix
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
  });

  it('cancelling the run reaches every running chunk', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    runFfmpegMock.mockImplementation((async (_args: string[], opts: { signal?: AbortSignal }) => {
      signals.push(opts.signal!);
      if (signals.length === 2) controller.abort();
      if (opts.signal!.aborted) throw new Error('killed');
      await new Promise<void>((_res, rej) => opts.signal!.addEventListener('abort', () => rej(new Error('killed')), { once: true }));
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as never);

    await expect(
      buildTtsTimeline(
        { segments, totalDurationMs: 1000, outputPath: join(dir, 'cancel.wav'), mixConcurrency: 2 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

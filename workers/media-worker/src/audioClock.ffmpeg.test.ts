/**
 * The audio follows the picture's clock, on real ffmpeg with tiny generated
 * files (plan 1.1). Everything else in this package is tested without
 * ffmpeg; this is the one place where only the real thing can say whether
 * the filter keeps a long source's audio in step with its picture. Skipped
 * where ffmpeg/ffprobe are not installed.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBinaryAvailable, runFfmpeg, runFfprobe } from './exec.js';
import { measureAudioDrift } from './drift.js';
import { extract16kMono, extractAudio } from './extract.js';
import { detectSilences } from './silences.js';

const ffmpegHere = (await checkBinaryAvailable('ffmpeg')).available && (await checkBinaryAvailable('ffprobe')).available;

/** Samples in a WAV (its sample count, not a rounded duration). */
async function samplesOf(wav: string): Promise<number> {
  const { stdout } = await runFfprobe(['-v', 'error', '-show_entries', 'stream=duration_ts', '-of', 'csv=p=0', '-i', wav]);
  return Number(stdout.trim());
}

describe.skipIf(!ffmpegHere)('audio on the picture clock (real ffmpeg)', () => {
  let dir: string;
  const file = (name: string): string => path.join(dir, name);
  const ff = (...args: string[]): Promise<unknown> => runFfmpeg(['-y', '-v', 'error', ...args], { timeoutMs: 60_000 });

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-audio-clock-'));
    // A 10 s picture.
    await ff('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=10', '-c:v', 'mpeg4', '-q:v', '10', file('picture.mp4'));
    // 10 s of tone slowed 5 % with asetrate: 10.5 s of audio.
    await ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10,asetrate=45714.2857,aresample=48000', '-c:a', 'aac', '-b:a', '64k', file('slow.m4a'));
    // Runs long by its timestamps too.
    await ff('-i', file('picture.mp4'), '-i', file('slow.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', file('long.mp4'));
    // Part 4 of the 27.8-hour series: timestamps squeezed to the picture's
    // 10 s, the samples still 10.5 s. The container cannot tell.
    await ff('-i', file('picture.mp4'), '-itsscale', '0.952380952', '-i', file('slow.m4a'), '-map', '0:v', '-map', '1:a', '-c', 'copy', file('p4.mp4'));
    // A codec whose packets vary (FLAC): counted by decoding.
    await ff('-i', file('picture.mp4'), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10.5', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'flac', file('long.mkv'));
  }, 120_000);

  afterAll(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a source whose audio holds more samples than its timestamps: both WAVs are the picture, to the sample', async () => {
    const wav = await extractAudio(file('p4.mp4'), file('p4.original.wav'));
    const mono = await extract16kMono(file('p4.mp4'), file('p4.16k.wav'));
    expect(await samplesOf(wav.audioPath)).toBe(480_000);
    expect(await samplesOf(mono.audioPath)).toBe(160_000);
    expect(wav.durationMs).toBe(10_000);
  }, 60_000);

  it('a source whose audio runs past its picture: cut at the picture', async () => {
    const mono = await extract16kMono(file('long.mp4'), file('long.16k.wav'));
    expect(await samplesOf(mono.audioPath)).toBe(160_000);
  }, 60_000);

  it("a series part: its window's own length", async () => {
    const wav = await extractAudio(file('p4.mp4'), file('part.wav'), {}, { startMs: 2000, endMs: 6000 });
    expect(await samplesOf(wav.audioPath)).toBe(192_000);
    // The last part's window can end past the picture: it stops with the picture.
    const last = await extract16kMono(file('long.mp4'), file('last.16k.wav'), {}, { startMs: 8000, endMs: 10_500 });
    expect(await samplesOf(last.audioPath)).toBe(32_000);
  }, 60_000);

  it('measures the drift from the samples, where the container durations agree with the picture', async () => {
    const p4 = await measureAudioDrift(file('p4.mp4'));
    expect(p4).toMatchObject({ method: 'packets', pictureMs: 10_000, claimedAudioMs: 10_000 });
    // 494 packets x 1024 samples - 1024 priming = 10.517 s.
    expect(p4!.driftMs).toBeGreaterThanOrEqual(490);
    expect(p4!.driftMs).toBeLessThanOrEqual(540);
    expect(p4!.count).toMatchObject({ codec: 'aac', frameSize: 1024 });
    // The priming read from the first packet's time: squeezed like every timestamp here (975 for 1024), 1 ms.
    expect(p4!.count!.primingSamples).toBeGreaterThanOrEqual(975);
    expect(p4!.count!.primingSamples).toBeLessThanOrEqual(1024);

    const long = await measureAudioDrift(file('long.mp4'));
    expect(long!.driftMs).toBeGreaterThanOrEqual(490);
    expect(long!.driftMs).toBeLessThanOrEqual(540);
  }, 60_000);

  it('a window measures only its own samples; a varying codec is decoded and counted', async () => {
    const part = await measureAudioDrift(file('p4.mp4'), { range: { startMs: 2000, endMs: 6000 } });
    expect(part).toMatchObject({ method: 'packets', pictureMs: 4000, range: { startMs: 2000, endMs: 6000 } });
    // 5 % more samples than time: ~0.2 s over 4 s (plus a packet at the seek).
    expect(part!.driftMs).toBeGreaterThanOrEqual(150);
    expect(part!.driftMs).toBeLessThanOrEqual(300);

    const flac = await measureAudioDrift(file('long.mkv'));
    expect(flac).toMatchObject({ method: 'decode', pictureMs: 10_000 });
    expect(flac!.driftMs).toBeGreaterThanOrEqual(480);
    expect(flac!.driftMs).toBeLessThanOrEqual(520);
  }, 60_000);

  it('an audio-only input has no picture to follow: no drift to measure', async () => {
    expect(await measureAudioDrift(file('slow.m4a'))).toBeUndefined();
  }, 60_000);

  it('finds a minute of digital silence in a track', async () => {
    await ff(
      '-filter_complex',
      'sine=frequency=440:sample_rate=16000:duration=3[a];anullsrc=r=16000:cl=mono:d=65[b];sine=frequency=440:sample_rate=16000:duration=3[c];[a][b][c]concat=n=3:v=0:a=1',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      file('gap.wav'),
    );
    const found = await detectSilences(file('gap.wav'), { noiseDb: -80, minSilenceMs: 60_000 });
    expect(found.durationMs).toBe(71_000);
    expect(found.silences).toHaveLength(1);
    expect(found.silences[0]!.startMs).toBeGreaterThanOrEqual(2950);
    expect(found.silences[0]!.startMs).toBeLessThanOrEqual(3050);
    expect(found.silences[0]!.endMs).toBeGreaterThanOrEqual(67_950);
    expect(found.silences[0]!.endMs).toBeLessThanOrEqual(68_050);
    // Shorter than asked: nothing.
    expect((await detectSilences(file('gap.wav'), { noiseDb: -80, minSilenceMs: 70_000 })).silences).toEqual([]);
  }, 60_000);
});

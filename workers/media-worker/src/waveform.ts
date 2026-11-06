/**
 * Waveform peaks for the editor's audio tracks.
 *
 * ffmpeg decodes the source to low-rate MONO s16le on stdout, and the samples
 * are folded into (min, max) pairs on the fly — constant memory however long
 * the video is. A 2-hour programme at the default 100 peaks/s is 720k pairs =
 * 1.4 MB, small enough to send to the UI once and draw at any zoom.
 *
 * Why not decode in the webview: the original track can be an hour-plus at
 * 48 kHz stereo (~1.3 GB as PCM); WebAudio's decodeAudioData would have to hold
 * all of it in memory at once. Why 8 kHz: peaks only need the ENVELOPE, and
 * 8 kHz keeps everything up to 4 kHz — the whole speech band — while making the
 * pipe ~12x lighter than full rate.
 *
 * Like every media call: argv array (never a shell string), windowsHide (no
 * console window flashing on Windows), abortable, time-bounded.
 */
import { spawn } from 'node:child_process';
import { AppErrorException } from '@videodubber/shared';
import { assertInputReadable, resolveFfmpegBinary } from './exec.js';

/** Default resolution: 100 peaks per second = one per 10 ms. */
export const DEFAULT_PEAKS_PER_SECOND = 100;
/** Decode rate for the envelope (see module doc). */
export const WAVEFORM_DECODE_RATE = 8_000;

export interface WaveformOptions {
  peaksPerSecond?: number;
  signal?: AbortSignal;
  /** Hard ceiling for the decode (default 10 min). */
  timeoutMs?: number;
}

export interface WaveformPeaks {
  peaksPerSecond: number;
  /** Duration covered by the peaks (ms). */
  durationMs: number;
  /** Interleaved [min0, max0, min1, max1, …], each scaled to -127..127. */
  peaks: Int8Array;
}

/** ffmpeg argv: decode `input` to mono s16le at `sampleRate` on stdout. Pure. */
export function buildWaveformArgs(input: string, sampleRate: number = WAVEFORM_DECODE_RATE): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-i',
    input,
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    'pipe:1',
  ];
}

/**
 * Folds a stream of s16le bytes into (min, max) pairs, `samplesPerPeak` samples
 * per pair. Pure (no I/O) and chunk-boundary safe: a sample split across two
 * chunks is reassembled, and a trailing partial bucket is emitted by finish().
 */
export class PeakAccumulator {
  private readonly out: number[] = [];
  private carry: number | undefined;
  private count = 0;
  private min = 0;
  private max = 0;
  private total = 0;

  constructor(private readonly samplesPerPeak: number) {
    if (!(samplesPerPeak >= 1)) throw new RangeError('samplesPerPeak must be >= 1');
  }

  /** Total samples consumed so far. */
  get samples(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    let i = 0;
    if (this.carry !== undefined && chunk.length > 0) {
      this.sample(((chunk[0]! << 8) | this.carry) << 16 >> 16);
      this.carry = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) {
      // little-endian int16, sign-extended
      this.sample(((chunk[i + 1]! << 8) | chunk[i]!) << 16 >> 16);
    }
    if (i < chunk.length) this.carry = chunk[i];
  }

  private sample(v: number): void {
    if (this.count === 0) {
      this.min = v;
      this.max = v;
    } else {
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
    }
    this.count += 1;
    this.total += 1;
    if (this.count === this.samplesPerPeak) this.flush();
  }

  private flush(): void {
    this.out.push(scale(this.min), scale(this.max));
    this.count = 0;
  }

  finish(): Int8Array {
    if (this.count > 0) this.flush();
    return Int8Array.from(this.out);
  }
}

function scale(v: number): number {
  return Math.max(-127, Math.min(127, Math.round((v / 32768) * 127)));
}

/** Decode `input` and return its waveform peaks. */
export function computeWaveformPeaks(input: string, opts: WaveformOptions = {}): Promise<WaveformPeaks> {
  const peaksPerSecond = Math.max(1, Math.min(1000, Math.round(opts.peaksPerSecond ?? DEFAULT_PEAKS_PER_SECOND)));
  const samplesPerPeak = Math.max(1, Math.round(WAVEFORM_DECODE_RATE / peaksPerSecond));
  assertInputReadable(input);

  return new Promise<WaveformPeaks>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AppErrorException('CANCELLED', 'Waveform cancelled before it started.'));
      return;
    }
    const child = spawn(resolveFfmpegBinary(), buildWaveformArgs(input), { shell: false, windowsHide: true });
    const acc = new PeakAccumulator(samplesPerPeak);
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AppErrorException('WORKER_TIMEOUT', 'Building the waveform took too long.')));
    }, opts.timeoutMs ?? 10 * 60_000);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => reject(new AppErrorException('CANCELLED', 'Waveform cancelled.')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => acc.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new AppErrorException('FFMPEG_NOT_FOUND', 'ffmpeg was not found.')
            : new AppErrorException('UNKNOWN', `Could not start ffmpeg: ${err.message}`),
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        if (code !== 0) {
          reject(
            new AppErrorException('UNSUPPORTED_MEDIA', 'ffmpeg could not decode the audio for the waveform.', {
              cause: stderr.trim().slice(-800),
            }),
          );
          return;
        }
        resolve({
          peaksPerSecond,
          durationMs: Math.round((acc.samples / WAVEFORM_DECODE_RATE) * 1000),
          peaks: acc.finish(),
        });
      }),
    );
  });
}

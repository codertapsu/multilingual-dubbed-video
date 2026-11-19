import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppErrorException } from '@videodubber/shared';

import { renameReplacing } from '../../fsRename.js';

/** Progress for the whole job, 0–100, plus what it is currently doing. */
export interface DownloadProgress {
  phase: 'video' | 'audio' | 'merging';
  percent: number | null;
  bytesDone?: number;
  bytesTotal?: number;
}

export type ProgressFn = (p: DownloadProgress) => void;

/**
 * Strip characters that are illegal or awkward in a filename on ANY of the
 * platforms we ship to, then bound the length.
 *
 * Bilibili titles are frequently long, emoji-laden, and full of `/` and `|`.
 * Windows rejects several of those outright, and macOS treats `:` specially in
 * some contexts — so this is sanitised once, centrally, rather than hoping.
 */
export function safeFilename(title: string, fallback = 'source-video'): string {
  const cleaned = title
    // Illegal on Windows, awkward everywhere else.
    .replace(/[\\/:*?"<>|]/g, ' ')
    // Control characters: a title can carry them, and a filename must not.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // Windows also refuses names ending in a dot or space.
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  // 120 leaves room for a part suffix and an extension inside the 255-byte
  // limit most filesystems impose, even when the title is multi-byte.
  const bounded = cleaned.slice(0, 120).trim();
  return bounded || fallback;
}

/**
 * `<dir>/<base>.mp4`, or `<base> (2).mp4`… when that name is taken: on disk,
 * or by another download that has not finished yet (`taken`). Two videos with
 * the same title used to overwrite each other.
 */
export async function uniqueOutputPath(
  dir: string,
  base: string,
  taken: (candidate: string) => boolean = () => false,
): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? `${base}.mp4` : `${base} (${n}).mp4`);
    if (taken(candidate)) continue;
    const exists = await fsp.stat(candidate).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
}

/** A `Content-Range` header (`bytes 100-199/1000`, or `bytes *` then `/1000` for an unsatisfiable range). Pure. */
export function parseContentRange(header: string | null): { start?: number; total?: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)\s*$/i.exec(header.trim());
  if (!m) return undefined;
  return {
    ...(m[1] !== undefined ? { start: Number(m[1]) } : {}),
    ...(m[2] !== undefined && m[2] !== '*' ? { total: Number(m[2]) } : {}),
  };
}

/**
 * Every link for a stream refused it (403/404/410): media links are signed and
 * short-lived, so the download asks the site for fresh ones and continues.
 */
export class MediaLinkExpiredError extends Error {
  constructor(readonly status: number) {
    super(`The media link was refused (HTTP ${status}); it has probably expired.`);
    this.name = 'MediaLinkExpiredError';
  }
}

/** One stream: its links (main first, then mirrors) and where its bytes collect. */
export interface StreamSpec {
  urls: readonly string[];
  /** Kept between attempts, so a retry or a restart of the app continues from it. */
  partialPath: string;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Waits before the 2nd, 3rd… try of a stream. */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 8000];
const EXPIRED = new Set([403, 404, 410]);

async function sizeOf(file: string): Promise<number> {
  return fsp.stat(file).then(
    (s) => s.size,
    () => 0,
  );
}

function cancelled(): AppErrorException {
  return new AppErrorException('CANCELLED', 'The download was stopped.');
}

/**
 * Fetch one stream into its partial file, continuing from the bytes already
 * there.
 *
 * A resumed request is trusted only when the server answers `206` with a
 * `Content-Range` that starts exactly where the file ends; anything else (a
 * server that ignores ranges and sends the whole file as `200`, a range from
 * elsewhere) starts the file over, so bytes are never spliced in the wrong
 * place. A failed try moves on to the stream's next mirror. When every link is
 * refused as expired, {@link MediaLinkExpiredError} asks the caller for fresh
 * ones.
 */
export async function fetchStream(
  spec: StreamSpec,
  headers: Record<string, string>,
  onBytes: (done: number, total: number | null) => void,
  deps: FetchDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  if (spec.urls.length === 0) throw new AppErrorException('UNSUPPORTED_MEDIA', 'The site gave no link for this stream.');

  let failures = 0;
  let refused = 0;
  let next = 0;
  for (;;) {
    if (deps.signal?.aborted) throw cancelled();
    const url = spec.urls[next % spec.urls.length]!;
    next += 1;
    const have = await sizeOf(spec.partialPath);
    try {
      const res = await fetchImpl(url, {
        headers: have > 0 ? { ...headers, Range: `bytes=${have}-` } : headers,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      if (have > 0 && res.status === 416) {
        // Nothing left to send: complete when the file is exactly the size.
        await res.body?.cancel().catch(() => undefined);
        const total = parseContentRange(res.headers.get('content-range'))?.total;
        if (total === have) {
          onBytes(have, have);
          return;
        }
        await fsp.rm(spec.partialPath, { force: true });
        continue;
      }
      if (EXPIRED.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        refused += 1;
        if (refused >= spec.urls.length) throw new MediaLinkExpiredError(res.status);
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new AppErrorException('UNKNOWN', `The media host answered HTTP ${res.status}.`);
      }

      const range = res.status === 206 ? parseContentRange(res.headers.get('content-range')) : undefined;
      const resuming = have > 0 && range?.start === have;
      const lengthRaw = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      const total = resuming
        ? (range?.total ?? (Number.isFinite(lengthRaw) ? have + lengthRaw : null))
        : Number.isFinite(lengthRaw) && lengthRaw > 0
          ? lengthRaw
          : null;
      const base = resuming ? have : 0;
      let received = 0;
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onBytes(base + received, total);
      });
      await pipeline(source, createWriteStream(spec.partialPath, { flags: resuming ? 'a' : 'w' }));
      const size = await sizeOf(spec.partialPath);
      if (total !== null && size !== total) {
        throw new AppErrorException('UNKNOWN', `The connection dropped after ${size} of ${total} bytes.`);
      }
      return;
    } catch (err) {
      if (deps.signal?.aborted) throw cancelled();
      if (err instanceof MediaLinkExpiredError) throw err;
      failures += 1;
      const delay = delays[failures - 1];
      if (delay === undefined) {
        throw err instanceof AppErrorException
          ? err
          : new AppErrorException('UNKNOWN', 'The download kept failing.', {
              cause: String(err),
              remediation: 'Check the internet connection, then retry: it continues from where it stopped.',
            });
      }
      await sleep(delay);
    }
  }
}

/**
 * Mux the two streams into one file.
 *
 * `-c copy` on purpose: Bilibili already serves H.264/AAC in a container we can
 * remux, so this is a container rewrite rather than a re-encode. Re-encoding
 * here would cost minutes per video and lose quality before the dub even
 * starts — and the dubbing pipeline re-encodes at the end anyway.
 */
async function merge(
  ffmpeg: string,
  videoPath: string,
  audioPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', outPath],
      // windowsHide: the orchestrator is spawned with CREATE_NO_WINDOW and so
      // has no console of its own; a console-subsystem child without this flag
      // pops a black CMD window in the user's face. No-op off Windows.
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const onAbort = (): void => {
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppErrorException('FFMPEG_NOT_FOUND', 'Could not run ffmpeg to combine the video and audio.', {
          cause: String(err),
          remediation: 'Reinstall VideoDubber, or set FFMPEG_PATH if you run from source.',
        }),
      );
    });
    proc.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(cancelled());
      if (code === 0) return resolve();
      reject(
        new AppErrorException('UNKNOWN', 'ffmpeg could not combine the downloaded streams.', {
          cause: stderrTail.trim(),
          remediation: 'Try the download again; a truncated stream is the usual cause.',
        }),
      );
    });
  });
}

/**
 * Confirm the finished file is actually usable, not merely present.
 *
 * ffmpeg exiting 0 is NOT proof the output is sound: a stream copy into a
 * container that cannot carry the source codec can yield a file with a broken
 * or absent audio track and still report success. For a general downloader
 * that is a nuisance; here the file is the INPUT to a dubbing pipeline, so a
 * missing audio track surfaces much later as "no audio to transcribe" — an
 * error that points at the wrong step and looks like a bug in the dub.
 *
 * Checking here costs one cheap ffprobe and reports the problem where it was
 * caused.
 */
async function verifyPlayable(ffprobePath: string, filePath: string, expectAudio: boolean): Promise<void> {
  const probe = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const proc = spawn(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration',
       '-of', 'default=noprint_wrappers=1', filePath],
      // windowsHide: see merge() above.
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    // A missing ffprobe must not fail a download that is probably fine — this
    // is a safety net, not a gate. Report it as unverified rather than broken.
    proc.on('error', () => resolve({ code: null, out: '' }));
    proc.on('exit', (code) => resolve({ code, out }));
  });

  if (probe.code === null) return; // ffprobe unavailable; nothing to conclude
  if (probe.code !== 0) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'The downloaded file could not be read back.', {
      remediation: 'Try the download again, or pick a different quality.',
    });
  }

  const hasVideo = /codec_type=video/.test(probe.out);
  const hasAudio = /codec_type=audio/.test(probe.out);
  const duration = Number(/duration=([\d.]+)/.exec(probe.out)?.[1] ?? '0');

  if (!hasVideo || duration <= 0) {
    throw new AppErrorException('UNSUPPORTED_MEDIA', 'The downloaded file has no usable video.', {
      cause: probe.out.trim().slice(0, 200),
      remediation: 'Try the download again, or pick a different quality.',
    });
  }
  if (expectAudio && !hasAudio) {
    throw new AppErrorException('NO_AUDIO_STREAM', 'The downloaded file ended up with no audio.', {
      cause: probe.out.trim().slice(0, 200),
      remediation:
        'The video and audio streams did not combine correctly. Try again, or pick a different ' +
        'quality — dubbing needs an audio track to transcribe.',
    });
  }
}

/** Free bytes on the drive holding `dir`, or undefined when the platform cannot say. */
async function freeBytes(dir: string): Promise<number | undefined> {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

export interface MediaJob {
  video: StreamSpec;
  /** Second stream to mux in (adaptive sources); absent = the video file is already complete. */
  audio?: StreamSpec;
  /** The finished file: written as `<name>.partial.mp4` and renamed only once it checks out. */
  outputPath: string;
  ffmpegPath: string;
  /** ffprobe binary path, for the post-download sanity check. */
  ffprobePath?: string;
  /** Headers the fetch must carry (Referer, …), from the provider. */
  headers: Record<string, string>;
  /** Expected bytes of all streams, for the free-space check. */
  expectedBytes?: number;
}

/** The partial path the finished file is merged into before its rename. */
export function partialOutputPath(outputPath: string): string {
  const ext = path.extname(outputPath);
  return `${outputPath.slice(0, outputPath.length - ext.length)}.partial${ext}`;
}

/**
 * Download a job's streams (both at once), merge them and publish the file.
 *
 * Complete or absent, like every artifact the pipeline trusts: the merge
 * writes `<name>.partial.mp4` and only a file that ffprobe reads back is
 * renamed into place. A merge used to write the final name directly, so a
 * cancelled download left a truncated `.mp4` that looked finished. Stream
 * partials are left behind on failure (the next try continues from them) and
 * removed once the file is published.
 */
export async function downloadMediaJob(job: MediaJob, onProgress: ProgressFn, deps: FetchDeps = {}): Promise<string> {
  const dir = path.dirname(job.outputPath);
  await fsp.mkdir(dir, { recursive: true });

  if (job.expectedBytes) {
    const have = (await sizeOf(job.video.partialPath)) + (job.audio ? await sizeOf(job.audio.partialPath) : 0);
    // The streams, then the merged copy of them, side by side until the rename.
    const need = Math.max(0, job.expectedBytes - have) + (job.audio ? job.expectedBytes : 0);
    const free = await freeBytes(dir);
    if (free !== undefined && free < need * 1.05) {
      const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
      throw new AppErrorException('DISK_FULL', `Not enough free space for this download: it needs about ${gb(need)} GB, ${gb(free)} GB is free.`);
    }
  }

  const streams = job.audio ? [job.video, job.audio] : [job.video];
  const done = streams.map(() => 0);
  const totals: (number | null)[] = streams.map(() => null);
  const share = job.audio ? 95 : 100;
  const report = (): void => {
    const bytesDone = done.reduce((a, b) => a + b, 0);
    const known = totals.every((t) => t !== null);
    const bytesTotal = known ? (totals as number[]).reduce((a, b) => a + b, 0) : undefined;
    onProgress({
      phase: 'video',
      percent: bytesTotal ? Math.min(share, Math.floor((bytesDone / bytesTotal) * share)) : null,
      bytesDone,
      ...(bytesTotal !== undefined ? { bytesTotal } : {}),
    });
  };
  onProgress({ phase: 'video', percent: 0 });
  await Promise.all(
    streams.map((spec, i) =>
      fetchStream(
        spec,
        job.headers,
        (bytes, total) => {
          done[i] = bytes;
          totals[i] = total;
          report();
        },
        deps,
      ),
    ),
  );

  const partial = partialOutputPath(job.outputPath);
  try {
    if (job.audio) {
      onProgress({ phase: 'merging', percent: 95 });
      await merge(job.ffmpegPath, job.video.partialPath, job.audio.partialPath, partial, deps.signal);
    } else {
      await renameReplacing(job.video.partialPath, partial);
    }
    // A single served file is expected to carry its own audio; if it does not,
    // that is worth knowing now rather than at transcription.
    await verifyPlayable(job.ffprobePath ?? 'ffprobe', partial, true);
    await renameReplacing(partial, job.outputPath);
  } catch (err) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
  await Promise.allSettled(streams.map((s) => fsp.rm(s.partialPath, { force: true })));
  onProgress({ phase: job.audio ? 'merging' : 'video', percent: 100 });
  return job.outputPath;
}

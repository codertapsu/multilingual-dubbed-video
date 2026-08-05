import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppErrorException } from '@videodubber/shared';

/** Progress for the whole job, 0–100, plus what it is currently doing. */
export interface DownloadProgress {
  phase: 'video' | 'audio' | 'merging';
  percent: number | null;
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

/** Download one URL to a path, reporting progress when the server sends a length. */
async function fetchToFile(
  url: string,
  dest: string,
  headers: Record<string, string>,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new AppErrorException('UNKNOWN', `Media download failed (HTTP ${res.status}).`, {
      remediation: 'Try again; Bilibili media links are short-lived and may need re-fetching.',
    });
  }
  const totalRaw = res.headers.get('content-length');
  const total = totalRaw ? Number.parseInt(totalRaw, 10) : NaN;
  let received = 0;

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    // No content-length (chunked) means an indeterminate bar rather than a
    // fake one — a progress bar that lies is worse than one that admits it.
    onProgress(Number.isFinite(total) && total > 0 ? received / total : null);
  });

  await pipeline(source, createWriteStream(dest));
}

/**
 * Mux the two streams into one file.
 *
 * `-c copy` on purpose: Bilibili already serves H.264/AAC in a container we can
 * remux, so this is a container rewrite rather than a re-encode. Re-encoding
 * here would cost minutes per video and lose quality before the dub even
 * starts — and the dubbing pipeline re-encodes at the end anyway.
 */
async function merge(ffmpeg: string, videoPath: string, audioPath: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-shortest', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on('error', (err) =>
      reject(
        new AppErrorException('FFMPEG_NOT_FOUND', 'Could not run ffmpeg to combine the video and audio.', {
          cause: String(err),
          remediation: 'Reinstall VideoDubber, or set FFMPEG_PATH if you run from source.',
        }),
      ),
    );
    proc.on('exit', (code) => {
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

export interface DownloadRequest {
  videoUrl: string;
  /**
   * Second stream to mux in, when the source serves adaptive media.
   *
   * Optional because plenty of sites hand back one already-muxed file. Such a
   * provider omits this and skips the merge entirely rather than having to
   * fabricate a second stream.
   */
  audioUrl?: string;
  /** Directory the finished file lands in. */
  destDir: string;
  /** Base filename without extension; sanitised here. */
  baseName: string;
  /** ffmpeg binary path (the app bundles one). */
  ffmpegPath: string;
  /** Headers the fetch must carry (Referer, Cookie, …), from the provider. */
  headers: Record<string, string>;
}

/**
 * Download both streams and merge them, returning the finished file path.
 *
 * Partial files live beside the output and are removed on both success and
 * failure — an interrupted download otherwise leaves multi-hundred-megabyte
 * `.part` files in the user's folder with no indication of what they are.
 */
export async function downloadMedia(req: DownloadRequest, onProgress: ProgressFn): Promise<string> {
  await fsp.mkdir(req.destDir, { recursive: true });
  const base = safeFilename(req.baseName);
  const outPath = path.join(req.destDir, `${base}.mp4`);
  const videoTmp = path.join(req.destDir, `.${base}.video.part`);
  const audioTmp = path.join(req.destDir, `.${base}.audio.part`);

  // A single already-muxed stream needs no second fetch and no ffmpeg run, so
  // the whole bar belongs to one download and the file is simply moved.
  const muxed = req.audioUrl === undefined;

  try {
    // Video first and weighted heaviest in the bar: it is ~90% of the bytes,
    // so a naive 50/50 split would sit at "50%" for almost the whole job.
    const videoShare = muxed ? 100 : 85;
    onProgress({ phase: 'video', percent: 0 });
    await fetchToFile(req.videoUrl, videoTmp, req.headers, (f) =>
      onProgress({ phase: 'video', percent: f === null ? null : Math.round(f * videoShare) }),
    );

    if (muxed) {
      await fsp.rename(videoTmp, outPath);
      onProgress({ phase: 'merging', percent: 100 });
      return outPath;
    }

    onProgress({ phase: 'audio', percent: 85 });
    await fetchToFile(req.audioUrl as string, audioTmp, req.headers, (f) =>
      onProgress({ phase: 'audio', percent: f === null ? null : 85 + Math.round(f * 10) }),
    );

    onProgress({ phase: 'merging', percent: 95 });
    await merge(req.ffmpegPath, videoTmp, audioTmp, outPath);
    onProgress({ phase: 'merging', percent: 100 });
    return outPath;
  } finally {
    await Promise.allSettled([fsp.rm(videoTmp, { force: true }), fsp.rm(audioTmp, { force: true })]);
  }
}

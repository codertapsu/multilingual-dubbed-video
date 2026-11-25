/**
 * Reading burned-in subtitles, backed by the `ocr-rapid` engine pack
 * (workers/ocr-engine, RapidOCR / PP-OCRv4). The media worker cuts one grey
 * frame of the subtitle band per subtitle on screen into a raw file
 * (readBandFrames); the engine reads it in slices (POST /read), so a long
 * video reports progress and a slice that fails costs only its own frames.
 * Returns null when the pack isn't installed: the dub then transcribes the
 * speech, and says so (pipeline/burnedInTranscript.ts).
 */
import { AppErrorException } from '@videodubber/shared';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { pickInstalledPack } from '../../engines/packSelection.js';

import { postWorkerJson } from '../workerHttp.js';

/** The provider id the ocr-rapid pack enables (enginePackCatalog.ts). */
export const OCR_PROVIDER_ID = 'subtitle-ocr';
const WORKER_NAME = 'Subtitle reader';
/** Frames per request: about 90 ms each on the development PC, so about half a minute a slice. */
export const OCR_SLICE = 300;

/** A file of raw grey frames (media-worker readBandFrames). */
export interface FramesFile {
  path: string;
  width: number;
  height: number;
  count: number;
}

/** What one frame says. */
export interface SubtitleRead {
  /** The frame's place in the file. */
  index: number;
  text: string;
  /** 0–1, the recogniser's (mean over the frame's lines). */
  confidence: number;
  /** Lines of text found in the frame. */
  lines: number;
}

export interface SubtitleOcrService {
  /** Whether a reader is installed here. */
  available(): Promise<boolean>;
  /** Every frame of the file read, in file order; null when no reader is installed. */
  read(
    frames: FramesFile,
    opts?: { onProgress?: (done: number, total: number) => void },
    signal?: AbortSignal,
  ): Promise<SubtitleRead[] | null>;
}

/** A slice may take this long: 2 s a frame (twenty times the measured), never under 2 minutes (the first loads the model). */
export function sliceTimeoutMs(count: number): number {
  return Math.max(120_000, count * 2000);
}

/** The engine's answer for frames [offset, offset + count), checked item by item; a frame it skipped reads as nothing. Pure. */
export function cleanReads(raw: unknown, offset: number, count: number): SubtitleRead[] {
  const byIndex = new Map<number, SubtitleRead>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const r = item as { index?: unknown; text?: unknown; confidence?: unknown; lines?: unknown };
      const index = typeof r.index === 'number' && Number.isInteger(r.index) ? r.index : -1;
      if (index < offset || index >= offset + count) continue;
      byIndex.set(index, {
        index,
        text: typeof r.text === 'string' ? r.text.trim() : '',
        confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0,
        lines: typeof r.lines === 'number' && Number.isInteger(r.lines) && r.lines >= 0 ? r.lines : 0,
      });
    }
  }
  return Array.from({ length: count }, (_, k) => byIndex.get(offset + k) ?? { index: offset + k, text: '', confidence: 0, lines: 0 });
}

export class RapidOcrProvider implements SubtitleOcrService {
  constructor(
    private readonly engines: Pick<EngineManager, 'ensureRunning'>,
    private readonly store: EnginePackStore,
  ) {}

  async available(): Promise<boolean> {
    return (await pickInstalledPack(this.store, OCR_PROVIDER_ID)) !== undefined;
  }

  async read(
    frames: FramesFile,
    opts: { onProgress?: (done: number, total: number) => void } = {},
    signal?: AbortSignal,
  ): Promise<SubtitleRead[] | null> {
    const packId = await pickInstalledPack(this.store, OCR_PROVIDER_ID);
    if (!packId) return null;
    const out: SubtitleRead[] = [];
    opts.onProgress?.(0, frames.count);
    for (let offset = 0; offset < frames.count; offset += OCR_SLICE) {
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Reading the subtitles was cancelled.');
      // Asked before every slice: an engine that died between slices is started again.
      const url = (await this.engines.ensureRunning(packId)).replace(/\/$/, '');
      const count = Math.min(OCR_SLICE, frames.count - offset);
      const res = await postWorkerJson<{ results?: unknown }>(
        `${url}/read`,
        { framesPath: frames.path, width: frames.width, height: frames.height, offset, count },
        { timeoutMs: sliceTimeoutMs(count), workerName: WORKER_NAME, ...(signal ? { signal } : {}) },
      );
      out.push(...cleanReads(res?.results, offset, count));
      opts.onProgress?.(offset + count, frames.count);
    }
    return out;
  }
}

/**
 * From whatever the user brings to a reference a voice can be cloned from.
 *
 * 1. Decode (ffmpeg, argv, atomic): the first ten minutes at most, mono, at
 *    48 kHz for the engine and 16 kHz for the voice detector.
 * 2. Find the speech: the speech-to-text worker's voice detector (Silero), the
 *    same one the pipeline uses; if that worker is not running, levels alone.
 * 3. Measure and propose the best window (referenceAnalysis.ts).
 *
 * Nothing permanent is written: an analysis lives in <configDir>/voices/work
 * until a profile is made from it, and the folder of any analysis older than a
 * day is removed. Recordings uploaded from the app land there too.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, type VoiceReferenceChecks, type VoiceReferencePolicy } from '@videodubber/shared';
import type { PipelineMediaService } from '../media.js';
import type { SpeechMapService } from '../pipeline/speechMap.js';
import {
  checkReference,
  durationMs,
  energySpeechRegions,
  frameStats,
  parseWavPcm16,
  suggestWindow,
  waveformPeaks,
  type TimeRange,
} from './referenceAnalysis.js';

/** Imports decode at most this much (an hour-long film needs only a few seconds). */
export const REFERENCE_DECODE_MS = 10 * 60_000;
/** Recordings and uploads larger than this are refused. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Work folders older than this are removed. */
const WORK_TTL_MS = 24 * 60 * 60_000;
/** The level references are evened out to (VieNeu's training data was levelled to about -20 LUFS). */
export const REFERENCE_LUFS = -20;

const ANALYSIS_ID = /^va_[0-9a-f]{16}$/;
const UPLOAD_ID = /^up_[0-9a-f]{16}$/;
const UPLOAD_EXT = /^(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm|mp4|mov|mkv)$/;

export interface ReferenceAnalysis {
  analysisId: string;
  /** Length of what was decoded (at most ten minutes). */
  durationMs: number;
  /** Where the speech is. */
  regions: TimeRange[];
  /** How the speech was found: the voice detector, or levels when it was unavailable. */
  detector: 'vad' | 'energy';
  /** The proposed window. */
  window: TimeRange;
  checks: VoiceReferenceChecks;
  /** Waveform, 0..1 per bucket, for the window picker. */
  peaks: number[];
  sourceName?: string;
}

interface StoredAnalysis {
  analysisId: string;
  durationMs: number;
  regions: TimeRange[];
  detector: 'vad' | 'energy';
  sourceName?: string;
  createdAt: string;
}

export interface ReferencePrepDeps {
  /** <configDir>/voices/work */
  workRoot: string;
  media: Pick<PipelineMediaService, 'referenceClip'>;
  speechMap?: SpeechMapService;
  now?: () => number;
}

export class ReferencePrep {
  constructor(private readonly deps: ReferencePrepDeps) {}

  private dir(analysisId: string): string {
    if (!ANALYSIS_ID.test(analysisId)) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'That recording is no longer available; choose it again.');
    }
    return path.join(this.deps.workRoot, analysisId);
  }

  /** The decoded 48 kHz recording of an analysis (for playback and cutting). */
  sourcePath(analysisId: string): string {
    return path.join(this.dir(analysisId), 'source.wav');
  }

  /** Keep an uploaded recording (raw bytes) until it is analysed. */
  async saveUpload(bytes: Buffer, ext: string): Promise<string> {
    const clean = ext.toLowerCase().replace(/^\./, '');
    if (!UPLOAD_EXT.test(clean)) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', `".${clean}" files are not supported for voice recordings.`);
    }
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'The recording is empty or larger than 200 MB.');
    }
    const id = `up_${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(this.deps.workRoot, 'uploads');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.${clean}`), bytes);
    return id;
  }

  /** The file of an upload id (any of the accepted extensions). */
  async uploadPath(uploadId: string): Promise<string> {
    if (!UPLOAD_ID.test(uploadId)) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Unknown recording.');
    const dir = path.join(this.deps.workRoot, 'uploads');
    const name = (await fsp.readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith(`${uploadId}.`));
    if (!name) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'That recording is no longer available; record it again.');
    return path.join(dir, name);
  }

  async analyze(
    inputPath: string,
    policy: VoiceReferencePolicy,
    opts: { sourceName?: string; signal?: AbortSignal } = {},
  ): Promise<ReferenceAnalysis> {
    await this.sweep();
    const referenceClip = this.deps.media.referenceClip;
    if (!referenceClip) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'This build cannot prepare voice recordings (media worker too old).');
    }
    const analysisId = `va_${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(this.deps.workRoot, analysisId);
    await fsp.mkdir(dir, { recursive: true });
    const source = path.join(dir, 'source.wav');
    const source16k = path.join(dir, 'source16k.wav');
    try {
      await referenceClip(inputPath, source, { maxMs: REFERENCE_DECODE_MS, sampleRate: 48_000 }, opts.signal);
      await referenceClip(inputPath, source16k, { maxMs: REFERENCE_DECODE_MS, sampleRate: 16_000 }, opts.signal);
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'This file has no audio the app can read.', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const pcm = parseWavPcm16(await fsp.readFile(source));
    const stats = frameStats(pcm);
    const total = durationMs(pcm);
    let regions: TimeRange[] = [];
    let detector: 'vad' | 'energy' = 'energy';
    if (this.deps.speechMap) {
      try {
        regions = (await this.deps.speechMap.regions(source16k, opts.signal ?? new AbortController().signal)).filter(
          (r) => r.endMs > r.startMs,
        );
        detector = 'vad';
      } catch {
        /* the speech-to-text worker is not running: measure by level */
      }
    }
    if (detector === 'energy') regions = energySpeechRegions(stats.db);
    const window = suggestWindow(total, regions, stats.clipped, policy);
    const checks = checkReference(stats, pcm.sampleRate, regions, window, policy);
    const stored: StoredAnalysis = {
      analysisId,
      durationMs: total,
      regions,
      detector,
      ...(opts.sourceName ? { sourceName: opts.sourceName.slice(0, 200) } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    await fsp.writeFile(path.join(dir, 'analysis.json'), JSON.stringify(stored));
    return { ...stored, window, checks, peaks: waveformPeaks(pcm, 600) };
  }

  /** Measure a window the user chose. */
  async check(analysisId: string, window: TimeRange, policy: VoiceReferencePolicy): Promise<{ window: TimeRange; checks: VoiceReferenceChecks }> {
    const stored = await this.load(analysisId);
    const clamped = clampWindow(window, stored.durationMs, policy);
    const pcm = parseWavPcm16(await fsp.readFile(this.sourcePath(analysisId)));
    return { window: clamped, checks: checkReference(frameStats(pcm), pcm.sampleRate, stored.regions, clamped, policy) };
  }

  /** Cut the chosen window to a levelled 48 kHz reference. */
  async cut(analysisId: string, window: TimeRange, outPath: string, signal?: AbortSignal): Promise<void> {
    const referenceClip = this.deps.media.referenceClip;
    if (!referenceClip) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'This build cannot prepare voice recordings.');
    await referenceClip(
      this.sourcePath(analysisId),
      outPath,
      { startMs: window.startMs, endMs: window.endMs, sampleRate: 48_000, loudnessLufs: REFERENCE_LUFS },
      signal,
    );
  }

  async load(analysisId: string): Promise<StoredAnalysis> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir(analysisId), 'analysis.json'), 'utf8')) as StoredAnalysis;
    } catch (err) {
      if (err instanceof AppErrorException) throw err;
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'That recording is no longer available; choose it again.');
    }
  }

  async discard(analysisId: string): Promise<void> {
    await fsp.rm(this.dir(analysisId), { recursive: true, force: true });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Remove analyses and uploads older than a day. */
  private async sweep(): Promise<void> {
    const cutoff = this.now() - WORK_TTL_MS;
    for (const base of [this.deps.workRoot, path.join(this.deps.workRoot, 'uploads')]) {
      for (const name of await fsp.readdir(base).catch(() => [] as string[])) {
        if (!ANALYSIS_ID.test(name) && !UPLOAD_ID.test(name.split('.')[0] ?? '')) continue;
        const full = path.join(base, name);
        const st = await fsp.stat(full).catch(() => undefined);
        if (st && st.mtimeMs < cutoff) await fsp.rm(full, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

/** Keep a window inside the recording and within what the engine uses. */
export function clampWindow(window: TimeRange, totalMs: number, policy: Pick<VoiceReferencePolicy, 'maxMs'>): TimeRange {
  const startMs = Math.max(0, Math.min(Math.round(window.startMs), totalMs));
  // A little slack over the engine's maximum: it trims edge silence itself.
  const endMs = Math.max(startMs, Math.min(Math.round(window.endMs), totalMs, startMs + policy.maxMs + 1_000));
  return { startMs, endMs };
}

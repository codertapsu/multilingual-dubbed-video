/**
 * Cloud text-to-speech via OpenAI's /v1/audio/speech.
 *
 * One request per segment (the API is single-utterance), written to the same
 * `segment_NNNN.wav` naming convention the local TTS worker uses so alignment
 * and resume work identically regardless of provider. Limited concurrency
 * keeps long videos fast without tripping rate limits.
 *
 * Durations are measured from the WAV header locally (no ffprobe round-trip).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  type CloudServiceId,
  type TtsInput,
  type TtsResult,
  type TtsSegment,
} from '@videodubber/shared';
import type { CancellableTtsProvider } from '../types.js';
import type { CredentialsStore } from '../../credentials/credentialsStore.js';
import { cloudFetch, requireCredential } from '../cloud/cloudHttp.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
/** Parallel synth requests — fast without hammering the rate limit. */
const CONCURRENCY = 3;

/**
 * Read the duration of a PCM WAV file from its RIFF header.
 * Returns 0 for files we cannot parse (caller treats 0 as "unknown").
 */
export function wavDurationMs(buf: Buffer): number {
  // 'RIFF' .... 'WAVE', then chunks: 'fmt ' has byteRate at offset+8+8.
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return 0;
  }
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 20 <= buf.length) {
      byteRate = buf.readUInt32LE(offset + 16);
    } else if (chunkId === 'data') {
      if (byteRate <= 0) return 0;
      return Math.round((chunkSize / byteRate) * 1000);
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  return 0;
}

/**
 * Segment id -> WAV filename, mirroring the local TTS worker's convention
 * (trailing digits of the id, falling back to the 1-based ordinal).
 */
export function segmentFilename(segmentId: string, ordinal: number): string {
  const match = /(\d+)\s*$/.exec(segmentId ?? '');
  const number = match?.[1] ? Number.parseInt(match[1], 10) : ordinal;
  return `segment_${String(number).padStart(4, '0')}.wav`;
}

/** Run tasks with a fixed concurrency cap, preserving input order of results. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** OpenAI cloud TTS provider. */
export class OpenAiTtsProvider implements CancellableTtsProvider {
  readonly id = 'openai-tts';
  readonly displayName = 'OpenAI TTS (cloud)';
  readonly isLocal = false;
  /** The speech API accepts a native `speed` parameter (0.25–4.0). */
  readonly supportsSpeedControl = true;
  readonly credentialService: CloudServiceId = 'openai';

  constructor(
    private readonly credentials: CredentialsStore,
    private readonly timeoutMs: number,
  ) {}

  async synthesizeSegments(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const cred = await requireCredential(this.credentials, this.credentialService);
    const baseUrl = (cred.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = cred.model ?? DEFAULT_MODEL;
    const voice = input.voiceId?.trim() || DEFAULT_VOICE;

    await mkdir(input.outputDir, { recursive: true });

    const segments = await mapWithConcurrency(input.segments, CONCURRENCY, async (seg, i): Promise<TtsSegment> => {
      const response = await cloudFetch(
        `${baseUrl}/audio/speech`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.apiKey}` },
          body: JSON.stringify({
            model,
            voice,
            input: seg.text,
            response_format: 'wav',
            ...(input.speed && Math.abs(input.speed - 1) > 1e-3 ? { speed: input.speed } : {}),
          }),
        },
        { service: this.credentialService, timeoutMs: this.timeoutMs, signal },
      );

      const wav = Buffer.from(await response.arrayBuffer());
      const outPath = path.join(input.outputDir, segmentFilename(seg.id, i + 1));
      await writeFile(outPath, wav);

      const durationMs = wavDurationMs(wav) || (await measureFallback(outPath));
      return {
        segmentId: seg.id,
        text: seg.text,
        audioPath: outPath,
        durationMs,
        startMs: seg.startMs,
        endMs: seg.endMs,
        speedRatio: input.speed ?? 1.0,
      };
    });

    return { segments, engine: 'openai', fallbackSegments: 0 };
  }
}

/** Re-read a written WAV to measure duration (paranoid fallback path). */
async function measureFallback(filePath: string): Promise<number> {
  try {
    const buf = await readFile(filePath);
    const ms = wavDurationMs(buf);
    if (ms > 0) return ms;
    throw new Error('unparseable WAV header');
  } catch (err) {
    throw new AppErrorException('CLOUD_REQUEST_FAILED', `OpenAI TTS returned audio that could not be measured (${path.basename(filePath)}).`, {
      cause: String(err),
      remediation: 'Retry the step; if it persists, try the local Piper TTS provider.',
    });
  }
}

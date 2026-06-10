/**
 * Forced alignment + speaker diarization, backed by the `alignment-whisperx`
 * engine pack. Refines an existing transcript with word-accurate timestamps
 * (±50 ms via wav2vec2 forced alignment) and optionally tags each segment with
 * a diarized speaker id, enabling per-speaker TTS voices for multi-voice dubs.
 *
 * The pack runs a small FastAPI server (`vd_whisperx`) exposing
 * `POST /align { audioPath, segments, language, diarize } ->
 *  { segments: [{ id, startMs, endMs, sourceText, speakerId?, words? }] }`.
 *
 * Implements {@link AlignmentService}; returns null when the pack isn't
 * installed so the STT step keeps the original (DTW) timestamps.
 */
import type { LanguageCode, TranscriptSegment } from '@videodubber/shared';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { pickInstalledPack } from '../../engines/packSelection.js';
import { postWorkerJson } from '../workerHttp.js';

/** Refine + (optionally) diarize a transcript. Returns null when unavailable. */
export interface AlignmentService {
  align(
    audioPath: string,
    segments: TranscriptSegment[],
    language: LanguageCode,
    opts: { diarize: boolean },
    signal?: AbortSignal,
  ): Promise<TranscriptSegment[] | null>;
}

export class WhisperxAlignmentProvider implements AlignmentService {
  constructor(
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  async align(
    audioPath: string,
    segments: TranscriptSegment[],
    language: LanguageCode,
    opts: { diarize: boolean },
    signal?: AbortSignal,
  ): Promise<TranscriptSegment[] | null> {
    const packId = await pickInstalledPack(this.store, 'whisperx');
    if (!packId) return null;

    const baseUrl = (await this.engines.ensureRunning(packId, { exclusive: true })).replace(/\/$/, '');
    const data = await postWorkerJson<{ segments?: TranscriptSegment[] }>(
      `${baseUrl}/align`,
      { audioPath, segments, language, diarize: opts.diarize },
      { timeoutMs: this.timeoutMs, workerName: 'WhisperX alignment engine', signal },
    );
    return data.segments ?? null;
  }
}

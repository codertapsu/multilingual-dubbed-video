/**
 * STT provider backed by a local `whisper-server` (whisper.cpp), delivered as an
 * engine pack and managed by the {@link EngineManager}. This is the accelerated
 * path: CUDA on Windows, where the bundled faster-whisper runs on the CPU.
 *
 * Two packs make it run: the runtime (`whisper-cpp-*`) and the ggml model the
 * PROJECT picked (`whisper-model-*`, see resolveWhisperCppModel). The server
 * exposes an `/inference` endpoint that takes the audio as multipart form-data;
 * we ensure the engine is running (exclusively — it's a heavy phase) with that
 * model before transcribing.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppErrorException,
  normalizeLanguageCode,
  type SttInput,
  type SttResult,
  type TranscriptSegment,
} from '@videodubber/shared';
import type { CancellableSttProvider } from '../types.js';
import type { EngineManager } from '../../engines/engineManager.js';

/** whisper-server's `/inference` answer for `response_format=verbose_json`. */
export interface WhisperServerResponse {
  text?: string;
  segments?: { t0?: number; t1?: number; start?: number; end?: number; text: string }[];
  /** Per-language probabilities, keyed by CODE (`zh`, `en`, …) — the full-name
   * `language` field ("chinese") is no use to the rest of the pipeline. */
  language_probabilities?: Record<string, number>;
}

/** Convert a whisper-server segment's time (seconds or centiseconds) to ms. */
function toMs(seg: { t0?: number; t1?: number; start?: number; end?: number }, which: 'start' | 'end'): number {
  // verbose_json reports start/end in seconds; whisper.cpp's native t0/t1 are
  // centiseconds. Prefer seconds when present.
  const sec = which === 'start' ? seg.start : seg.end;
  if (typeof sec === 'number') return Math.max(0, Math.round(sec * 1000));
  const cs = which === 'start' ? seg.t0 : seg.t1;
  return typeof cs === 'number' ? Math.max(0, Math.round(cs * 10)) : 0;
}

/**
 * A segment that is nothing but a non-speech annotation: "[BLANK_AUDIO]",
 * "(音乐)", "♪♪". faster-whisper never emits these (it suppresses non-speech
 * tokens by default), but whisper.cpp can, and the dub would then translate
 * and voice them. whisper-server's own `-sns` suppression is not the fix: on a
 * real Chinese video it garbled names and produced a Russian hallucination, so
 * the decoder is left alone and only whole-annotation segments are dropped.
 */
const ANNOTATION_ONLY = /^(?:\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】|[♪♫\s])+$/u;

export function mapWhisperServerSegments(segments: WhisperServerResponse['segments']): TranscriptSegment[] {
  return (segments ?? [])
    .map((s) => ({ ...s, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0 && !ANNOTATION_ONLY.test(s.text))
    .map((s, index) => ({
      id: `seg_${String(index + 1).padStart(4, '0')}`,
      index,
      startMs: toMs(s, 'start'),
      endMs: toMs(s, 'end'),
      sourceText: s.text,
    }));
}

/** The most probable language CODE whisper-server detected, or undefined. */
export function detectedLanguageOf(data: WhisperServerResponse): string | undefined {
  const entries = Object.entries(data.language_probabilities ?? {});
  if (entries.length === 0) return undefined;
  return entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

export class WhisperCppProvider implements CancellableSttProvider {
  readonly id = 'whisper-cpp';
  readonly displayName = 'whisper.cpp (accelerated, local)';
  readonly isLocal = true;
  /** Logical pack family this provider needs (one of whisper-cpp-*). */
  readonly requiresEnginePack = 'whisper-cpp';

  constructor(
    private readonly engines: Pick<EngineManager, 'ensureRunning'>,
    /** Resolve the installed whisper.cpp pack id for this machine (per accel). */
    private readonly resolvePackId: () => Promise<string>,
    /** Absolute path of the ggml model for a project's speech model (resolveWhisperCppModel). */
    private readonly resolveModel: (sttModel: string) => Promise<string>,
    private readonly timeoutMs: number,
  ) {}

  async transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
    // The model first: a project whose model is not installed (or has no
    // whisper.cpp build) must fail with THAT explanation, not by starting a
    // server that has nothing to load.
    const model = await this.resolveModel(input.model);
    const packId = await this.resolvePackId();
    // Passing the model also makes EngineManager restart a server that is up
    // with a different one, instead of transcribing with the wrong weights.
    const baseUrl = await this.engines.ensureRunning(packId, { exclusive: true, model });

    const audio = await readFile(input.audioPath).catch((err: unknown) => {
      throw new AppErrorException('UNSUPPORTED_MEDIA', `Could not read audio for whisper.cpp: ${input.audioPath}`, {
        cause: String(err),
      });
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(input.audioPath));
    // NOT `json`: whisper-server answers that with `{ text }` alone, no segments,
    // so this provider returned an EMPTY transcript for every request (measured:
    // 0 segments for a 10-minute chunk that verbose_json splits into 157).
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    const lang = normalizeLanguageCode(input.language ?? '').split('-')[0];
    // Omitted = auto-detect: the engine is launched with `-l auto`.
    if (lang) form.append('language', lang);

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/inference`, { method: 'POST', body: form, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw new AppErrorException('CANCELLED', 'Transcription cancelled.');
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'whisper.cpp engine did not respond.', { cause: String(err) });
    }
    if (!res.ok) {
      throw new AppErrorException('ENGINE_UNAVAILABLE', `whisper.cpp returned HTTP ${res.status}.`, {
        cause: (await res.text().catch(() => '')).slice(0, 300),
      });
    }

    const data = (await res.json()) as WhisperServerResponse;
    const segments = mapWhisperServerSegments(data.segments);
    return {
      segments,
      detectedLanguage: normalizeLanguageCode(lang || detectedLanguageOf(data) || ''),
      durationMs: segments.at(-1)?.endMs ?? 0,
    };
  }
}

/**
 * STT provider backed by a local `whisper-server` (whisper.cpp), delivered as an
 * engine pack and managed by the {@link EngineManager}. This is the accelerated
 * path: Metal/CoreML on Apple Silicon, CUDA/Vulkan on Windows/Linux — where
 * CTranslate2/faster-whisper has no GPU backend (notably macOS).
 *
 * The server exposes an OpenAI-ish `/inference` endpoint that accepts the audio
 * as multipart form-data and returns timed segments. We ensure the engine is
 * running (exclusively — it's a heavy phase) before transcribing.
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

/** Raw whisper-server `/inference` response (transcription segments). */
interface WhisperServerResponse {
  text?: string;
  segments?: { t0?: number; t1?: number; start?: number; end?: number; text: string }[];
}

/** Convert a whisper-server segment's time (seconds or centiseconds) to ms. */
function toMs(seg: { t0?: number; t1?: number; start?: number; end?: number }, which: 'start' | 'end'): number {
  // whisper.cpp reports t0/t1 in centiseconds; the HTTP server build also emits
  // start/end in seconds. Prefer seconds when present.
  const sec = which === 'start' ? seg.start : seg.end;
  if (typeof sec === 'number') return Math.max(0, Math.round(sec * 1000));
  const cs = which === 'start' ? seg.t0 : seg.t1;
  return typeof cs === 'number' ? Math.max(0, Math.round(cs * 10)) : 0;
}

export function mapWhisperServerSegments(segments: WhisperServerResponse['segments']): TranscriptSegment[] {
  return (segments ?? [])
    .map((s) => ({ ...s, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0)
    .map((s, index) => ({
      id: `seg_${String(index + 1).padStart(4, '0')}`,
      index,
      startMs: toMs(s, 'start'),
      endMs: toMs(s, 'end'),
      sourceText: s.text,
    }));
}

export class WhisperCppProvider implements CancellableSttProvider {
  readonly id = 'whisper-cpp';
  readonly displayName = 'whisper.cpp (accelerated, local)';
  readonly isLocal = true;
  /** Logical pack family this provider needs (one of whisper-cpp-*). */
  readonly requiresEnginePack = 'whisper-cpp';

  constructor(
    private readonly engines: EngineManager,
    /** Resolve the installed whisper.cpp pack id for this machine (per accel). */
    private readonly resolvePackId: () => Promise<string>,
    private readonly timeoutMs: number,
  ) {}

  async transcribe(input: SttInput, signal?: AbortSignal): Promise<SttResult> {
    const packId = await this.resolvePackId();
    const baseUrl = await this.engines.ensureRunning(packId, { exclusive: true });

    const audio = await readFile(input.audioPath).catch((err: unknown) => {
      throw new AppErrorException('UNSUPPORTED_MEDIA', `Could not read audio for whisper.cpp: ${input.audioPath}`, {
        cause: String(err),
      });
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(input.audioPath));
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const lang = normalizeLanguageCode(input.language ?? '').split('-')[0];
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
      detectedLanguage: normalizeLanguageCode(input.language ?? lang ?? ''),
      durationMs: segments.at(-1)?.endMs ?? 0,
    };
  }
}

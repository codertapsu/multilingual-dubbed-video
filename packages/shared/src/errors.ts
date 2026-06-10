/**
 * Shared error model for VideoDubber.
 *
 * Every component (TS libraries, Node services, Python workers, Tauri shell)
 * speaks the same {@link AppError} shape. Workers serialize errors as JSON:
 * `{ "error": { code, message, remediation, docsRef } }` with an appropriate
 * HTTP status code.
 */

/**
 * Stable, machine-readable error codes used across the whole pipeline.
 *
 * These are intentionally coarse-grained so that the UI can map them to
 * friendly remediation hints (see {@link REMEDIATIONS}).
 */
export type ErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'FFMPEG_FILTER_MISSING'
  | 'PYTHON_NOT_FOUND'
  | 'STT_MODEL_MISSING'
  | 'TRANSLATION_PACKAGE_MISSING'
  | 'PIPER_MISSING'
  | 'TTS_VOICE_MISSING'
  | 'UNSUPPORTED_MEDIA'
  | 'NO_AUDIO_STREAM'
  | 'INVALID_LANGUAGE'
  | 'OUTPUT_NOT_WRITABLE'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_TIMEOUT'
  | 'CANCELLED'
  | 'UNKNOWN';

/**
 * The canonical serializable error object.
 *
 * - `code` is one of {@link ErrorCode}.
 * - `message` is a human-readable, user-facing summary.
 * - `cause` optionally carries the original/low-level error string.
 * - `remediation` tells the user how to fix it.
 * - `docsRef` points to a docs anchor (e.g. `docs/TROUBLESHOOTING.md#ffmpeg`).
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  cause?: string;
  remediation?: string;
  docsRef?: string;
}

/**
 * Default remediation + documentation references keyed by {@link ErrorCode}.
 *
 * `docsRef` values point at anchors in `docs/TROUBLESHOOTING.md`.
 */
export const REMEDIATIONS: Record<ErrorCode, { remediation: string; docsRef: string }> = {
  FFMPEG_NOT_FOUND: {
    remediation:
      'FFmpeg was not found. Install FFmpeg and ensure it is on PATH, or set the FFMPEG_PATH environment variable.',
    docsRef: 'docs/TROUBLESHOOTING.md#ffmpeg-not-found',
  },
  FFPROBE_NOT_FOUND: {
    remediation:
      'ffprobe was not found. Install FFmpeg (which bundles ffprobe) and ensure it is on PATH, or set the FFPROBE_PATH environment variable.',
    docsRef: 'docs/TROUBLESHOOTING.md#ffprobe-not-found',
  },
  FFMPEG_FILTER_MISSING: {
    remediation:
      'This FFmpeg build is missing a required filter (e.g. "subtitles" needs libass). Install an FFmpeg built with libass (on macOS: `brew install ffmpeg-full` then set FFMPEG_PATH/FFPROBE_PATH to it), or pick a subtitle mode that does not burn in (embedded-soft / srt-file / vtt-file).',
    docsRef: 'docs/TROUBLESHOOTING.md#ffmpeg-filter-missing',
  },
  PYTHON_NOT_FOUND: {
    remediation:
      'Python was not found. Install Python 3.10+ and ensure it is on PATH, or set the PYTHON_PATH environment variable.',
    docsRef: 'docs/TROUBLESHOOTING.md#python-not-found',
  },
  STT_MODEL_MISSING: {
    remediation:
      'The speech-to-text model is missing. Run scripts/setup-local-models.sh (or .ps1) to download the faster-whisper model, or set FASTER_WHISPER_MODEL.',
    docsRef: 'docs/MODEL_SETUP.md#stt-model',
  },
  TRANSLATION_PACKAGE_MISSING: {
    remediation:
      'The Argos Translate package for this language pair is not installed. Install it, e.g. `argospm install translate-<from>_<to>` or via the Argos Translate console GUI.',
    docsRef: 'docs/MODEL_SETUP.md#translation-package',
  },
  PIPER_MISSING: {
    remediation:
      'Piper TTS is not configured. Set PIPER_BINARY_PATH and PIPER_VOICE_MODEL_PATH, or rely on the system/fallback TTS engine.',
    docsRef: 'docs/MODEL_SETUP.md#piper',
  },
  TTS_VOICE_MISSING: {
    remediation:
      'The requested TTS voice is not available. Choose a different voice via GET /voices, or install the corresponding voice model.',
    docsRef: 'docs/MODEL_SETUP.md#tts-voice',
  },
  UNSUPPORTED_MEDIA: {
    remediation:
      'The input media format is not supported. Try a common container/codec (e.g. MP4/H.264/AAC) or re-encode the file with FFmpeg.',
    docsRef: 'docs/TROUBLESHOOTING.md#unsupported-media',
  },
  NO_AUDIO_STREAM: {
    remediation:
      'The input video has no audio stream to transcribe. Provide a video that contains an audio track.',
    docsRef: 'docs/TROUBLESHOOTING.md#no-audio-stream',
  },
  INVALID_LANGUAGE: {
    remediation:
      'The provided language code is invalid. Use a BCP-47 code such as "en", "en-US", or "vi-VN".',
    docsRef: 'docs/TROUBLESHOOTING.md#invalid-language',
  },
  OUTPUT_NOT_WRITABLE: {
    remediation:
      'The output location is not writable. Check the directory exists and you have write permission, or set VIDEODUBBER_PROJECTS_DIR to a writable path.',
    docsRef: 'docs/TROUBLESHOOTING.md#output-not-writable',
  },
  WORKER_UNAVAILABLE: {
    remediation:
      'A required worker service is not reachable. Start the workers (scripts/dev.sh or dev.ps1) and verify the *_WORKER_URL environment variables.',
    docsRef: 'docs/TROUBLESHOOTING.md#worker-unavailable',
  },
  WORKER_TIMEOUT: {
    remediation:
      'A worker did not respond in time. Retry the step; for large media consider a smaller STT model or more resources.',
    docsRef: 'docs/TROUBLESHOOTING.md#worker-timeout',
  },
  CANCELLED: {
    remediation: 'The operation was cancelled. Re-run the pipeline or retry the step when ready.',
    docsRef: 'docs/TROUBLESHOOTING.md#cancelled',
  },
  UNKNOWN: {
    remediation:
      'An unexpected error occurred. Check the logs in <project>/logs/pipeline.log for details.',
    docsRef: 'docs/TROUBLESHOOTING.md#unknown-error',
  },
};

/**
 * Type guard: returns true if `value` structurally matches {@link AppError}.
 */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * Build a fully-populated {@link AppError}, filling in default `remediation`
 * and `docsRef` from {@link REMEDIATIONS} when not explicitly provided.
 *
 * @param code    The stable error code.
 * @param message Human-readable summary.
 * @param extra   Optional overrides for `cause`, `remediation`, `docsRef`.
 */
export function makeAppError(
  code: ErrorCode,
  message: string,
  extra?: Partial<Pick<AppError, 'cause' | 'remediation' | 'docsRef'>>,
): AppError {
  const defaults = REMEDIATIONS[code] ?? REMEDIATIONS.UNKNOWN;
  return {
    code,
    message,
    cause: extra?.cause,
    remediation: extra?.remediation ?? defaults.remediation,
    docsRef: extra?.docsRef ?? defaults.docsRef,
  };
}

/**
 * An {@link Error} subclass that carries a structured {@link AppError}.
 *
 * Throw this anywhere an `AppError` is the right contract; consumers can read
 * `.appError` to serialize it across the HTTP/IPC boundary.
 */
export class AppErrorException extends Error {
  /** The structured, serializable error payload. */
  public readonly appError: AppError;

  constructor(appError: AppError);
  constructor(
    code: ErrorCode,
    message: string,
    extra?: Partial<Pick<AppError, 'cause' | 'remediation' | 'docsRef'>>,
  );
  constructor(
    arg: AppError | ErrorCode,
    message?: string,
    extra?: Partial<Pick<AppError, 'cause' | 'remediation' | 'docsRef'>>,
  ) {
    const appError: AppError =
      typeof arg === 'string' ? makeAppError(arg, message ?? arg, extra) : arg;
    super(appError.message);
    this.name = 'AppErrorException';
    this.appError = appError;
    // Restore prototype chain for instanceof checks after transpilation.
    Object.setPrototypeOf(this, AppErrorException.prototype);
  }

  /** Convenience accessor for the underlying error code. */
  get code(): ErrorCode {
    return this.appError.code;
  }
}

/**
 * Coerce any thrown/unknown value into a well-formed {@link AppError}.
 *
 * Handles {@link AppErrorException}, raw {@link AppError} objects, native
 * `Error`s, strings, and arbitrary values.
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof AppErrorException) {
    return value.appError;
  }
  if (isAppError(value)) {
    // Backfill defaults if the bare object omitted remediation/docsRef.
    const defaults = REMEDIATIONS[value.code] ?? REMEDIATIONS.UNKNOWN;
    return {
      code: value.code,
      message: value.message,
      cause: value.cause,
      remediation: value.remediation ?? defaults.remediation,
      docsRef: value.docsRef ?? defaults.docsRef,
    };
  }
  if (value instanceof Error) {
    return makeAppError('UNKNOWN', value.message || 'Unknown error', {
      cause: value.stack ?? value.name,
    });
  }
  if (typeof value === 'string') {
    return makeAppError('UNKNOWN', value);
  }
  return makeAppError('UNKNOWN', 'An unknown error occurred', {
    cause: safeStringify(value),
  });
}

/** Best-effort JSON stringify that never throws (handles cycles). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Mapping from {@link ErrorCode} to HTTP status codes, and a helper to turn any
 * thrown value into a `{ status, body:{ error } }` pair for the HTTP layer.
 */
import { toAppError, type AppError, type ErrorCode } from '@videodubber/shared';

/** HTTP status for each error code. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  FFMPEG_NOT_FOUND: 503,
  FFPROBE_NOT_FOUND: 503,
  FFMPEG_FILTER_MISSING: 422, // Unprocessable — build lacks a required filter
  PYTHON_NOT_FOUND: 503,
  STT_MODEL_MISSING: 424, // Failed Dependency
  TRANSLATION_PACKAGE_MISSING: 424,
  PIPER_MISSING: 424,
  TTS_VOICE_MISSING: 424,
  UNSUPPORTED_MEDIA: 415, // Unsupported Media Type
  NO_AUDIO_STREAM: 422, // Unprocessable Entity
  INVALID_LANGUAGE: 400,
  OUTPUT_NOT_WRITABLE: 500,
  WORKER_UNAVAILABLE: 503,
  WORKER_TIMEOUT: 504,
  CLOUD_CREDENTIALS_MISSING: 424, // Failed Dependency — key not configured
  CLOUD_REQUEST_FAILED: 502, // Bad Gateway — upstream cloud service failed
  ENGINE_PACK_MISSING: 424, // Failed Dependency — engine not installed
  ENGINE_PACK_FAILED: 502, // download/verify/build failure
  ENGINE_UNAVAILABLE: 503, // engine process not reachable
  CANCELLED: 409, // Conflict
  UNKNOWN: 500,
};

/** Resolve the HTTP status for an error code (defaults to 500). */
export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** Convert any thrown value into an HTTP `{ status, error }` payload. */
export function toHttpError(err: unknown): { status: number; error: AppError } {
  const appError = toAppError(err);
  return { status: statusForCode(appError.code), error: appError };
}

import { describe, it, expect } from 'vitest';
import {
  AppErrorException,
  toAppError,
  makeAppError,
  isAppError,
  REMEDIATIONS,
  type AppError,
  type ErrorCode,
} from './errors.js';

describe('makeAppError', () => {
  it('fills in default remediation and docsRef from REMEDIATIONS', () => {
    const err = makeAppError('FFMPEG_NOT_FOUND', 'no ffmpeg');
    expect(err.code).toBe('FFMPEG_NOT_FOUND');
    expect(err.message).toBe('no ffmpeg');
    expect(err.remediation).toBe(REMEDIATIONS.FFMPEG_NOT_FOUND.remediation);
    expect(err.docsRef).toBe(REMEDIATIONS.FFMPEG_NOT_FOUND.docsRef);
  });

  it('allows overriding remediation, docsRef, and cause', () => {
    const err = makeAppError('UNKNOWN', 'boom', {
      remediation: 'custom',
      docsRef: 'docs/X.md#y',
      cause: 'stack',
    });
    expect(err.remediation).toBe('custom');
    expect(err.docsRef).toBe('docs/X.md#y');
    expect(err.cause).toBe('stack');
  });
});

describe('REMEDIATIONS', () => {
  const codes: ErrorCode[] = [
    'FFMPEG_NOT_FOUND',
    'FFPROBE_NOT_FOUND',
    'PYTHON_NOT_FOUND',
    'STT_MODEL_MISSING',
    'TRANSLATION_PACKAGE_MISSING',
    'PIPER_MISSING',
    'TTS_VOICE_MISSING',
    'UNSUPPORTED_MEDIA',
    'NO_AUDIO_STREAM',
    'INVALID_LANGUAGE',
    'OUTPUT_NOT_WRITABLE',
    'WORKER_UNAVAILABLE',
    'WORKER_TIMEOUT',
    'CANCELLED',
    'UNKNOWN',
  ];

  it('has an entry for every error code', () => {
    for (const code of codes) {
      expect(REMEDIATIONS[code]).toBeDefined();
      expect(REMEDIATIONS[code].remediation.length).toBeGreaterThan(0);
      expect(REMEDIATIONS[code].docsRef.length).toBeGreaterThan(0);
    }
  });
});

describe('isAppError', () => {
  it('accepts a structurally valid AppError', () => {
    const err: AppError = { code: 'UNKNOWN', message: 'x' };
    expect(isAppError(err)).toBe(true);
  });
  it('rejects non-objects and partial shapes', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError('nope')).toBe(false);
    expect(isAppError({ code: 'UNKNOWN' })).toBe(false);
    expect(isAppError({ message: 'x' })).toBe(false);
  });
});

describe('AppErrorException', () => {
  it('wraps a code + message into an AppError', () => {
    const ex = new AppErrorException('WORKER_TIMEOUT', 'too slow');
    expect(ex).toBeInstanceOf(Error);
    expect(ex).toBeInstanceOf(AppErrorException);
    expect(ex.message).toBe('too slow');
    expect(ex.code).toBe('WORKER_TIMEOUT');
    expect(ex.appError.remediation).toBe(REMEDIATIONS.WORKER_TIMEOUT.remediation);
  });

  it('accepts a pre-built AppError', () => {
    const appErr: AppError = { code: 'CANCELLED', message: 'stopped' };
    const ex = new AppErrorException(appErr);
    expect(ex.appError).toBe(appErr);
    expect(ex.code).toBe('CANCELLED');
  });

  it('supports instanceof after construction', () => {
    try {
      throw new AppErrorException('NO_AUDIO_STREAM', 'silent');
    } catch (e) {
      expect(e instanceof AppErrorException).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });
});

describe('toAppError', () => {
  it('returns the embedded AppError from an AppErrorException', () => {
    const ex = new AppErrorException('PIPER_MISSING', 'no piper');
    expect(toAppError(ex)).toEqual(ex.appError);
  });

  it('backfills remediation/docsRef for a bare AppError', () => {
    const bare: AppError = { code: 'FFMPEG_NOT_FOUND', message: 'x' };
    const result = toAppError(bare);
    expect(result.remediation).toBe(REMEDIATIONS.FFMPEG_NOT_FOUND.remediation);
    expect(result.docsRef).toBe(REMEDIATIONS.FFMPEG_NOT_FOUND.docsRef);
  });

  it('preserves an explicit remediation on a bare AppError', () => {
    const bare: AppError = { code: 'UNKNOWN', message: 'x', remediation: 'do this' };
    expect(toAppError(bare).remediation).toBe('do this');
  });

  it('maps a native Error to UNKNOWN with cause from stack', () => {
    const result = toAppError(new Error('kaboom'));
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('kaboom');
    expect(result.cause).toBeDefined();
  });

  it('maps a string to UNKNOWN', () => {
    const result = toAppError('plain string error');
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('plain string error');
  });

  it('maps arbitrary values to UNKNOWN with a serialized cause', () => {
    const result = toAppError({ weird: true });
    expect(result.code).toBe('UNKNOWN');
    expect(result.cause).toContain('weird');
  });

  it('does not throw on circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toAppError(circular)).not.toThrow();
    expect(toAppError(circular).code).toBe('UNKNOWN');
  });
});

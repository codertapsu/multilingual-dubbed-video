import type { AppError } from '../../core/models';

/** The i18n keys of a download failure: what happened, and what to do about it. */
export interface SourceErrorKeys {
  message: string;
  fix: string;
}

/**
 * The download failures a user can act on, by code.
 *
 * The orchestrator's messages are sentences written for its log ("Bilibili
 * does not offer this video (-404)."), and the Download list printed them as
 * they came: English, to a Vietnamese user, with nothing to do about them (UX
 * audit, 2026-11). These four are the ones a site causes, so they are the ones
 * worth explaining; any other code keeps the server's message.
 */
const KEYS: Partial<Record<AppError['code'], SourceErrorKeys>> = {
  SOURCE_RATE_LIMITED: { message: 'source-video.error.rate-limited', fix: 'source-video.error.rate-limited-fix' },
  SOURCE_LOGIN_REQUIRED: { message: 'source-video.error.login-required', fix: 'source-video.error.login-required-fix' },
  SOURCE_UNAVAILABLE: { message: 'source-video.error.unavailable', fix: 'source-video.error.unavailable-fix' },
  INVALID_VIDEO_LINK: { message: 'source-video.error.invalid-link', fix: 'source-video.error.invalid-link-fix' },
};

/** The keys that explain `error` in the user's language, or null for a code without them. Pure. */
export function sourceErrorKeys(error: Pick<AppError, 'code'> | null | undefined): SourceErrorKeys | null {
  return (error && KEYS[error.code]) || null;
}

/** Every key this module can hand out (the spec checks both locales have them). */
export const SOURCE_ERROR_KEYS: readonly string[] = Object.values(KEYS).flatMap((k) => (k ? [k.message, k.fix] : []));

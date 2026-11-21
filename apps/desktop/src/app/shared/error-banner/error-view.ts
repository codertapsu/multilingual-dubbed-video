/**
 * What the error banner says about an error, as pure functions: a title and a
 * "what to do" in the user's language for every {@link ErrorCode}, with the
 * rest (the code, the server's own words, the cause, the guide) folded away
 * as technical details.
 *
 * The banner used to lead with the code as a pill (`WORKER_TIMEOUT`), print
 * the server's English sentence ("Could not reach the orchestrator at
 * http://127.0.0.1:5100."), a JS stack under "Why" and a raw
 * `docs/TROUBLESHOOTING.md#…` path: the only `error.*` keys were labels, so a
 * Vietnamese user read English, and jargon, at the moment they were stuck
 * (UX audit, 2026-11-21). Kept free of Angular so the rules are unit-tested.
 */
import type { AppError, ErrorCode } from '../../core/models';

/**
 * Every code the UI has words for. A Record over the shared union, so a code
 * added there without a title and a fix here is a compile error instead of an
 * English banner (the lazy media proxy's method table works the same way).
 * error-view.spec.ts checks that each one has both texts in every locale.
 */
const TRANSLATED: Record<ErrorCode, true> = {
  FFMPEG_NOT_FOUND: true,
  FFPROBE_NOT_FOUND: true,
  FFMPEG_FILTER_MISSING: true,
  PYTHON_NOT_FOUND: true,
  STT_MODEL_MISSING: true,
  TRANSLATION_PACKAGE_MISSING: true,
  PIPER_MISSING: true,
  TTS_VOICE_MISSING: true,
  UNSUPPORTED_MEDIA: true,
  NO_AUDIO_STREAM: true,
  INVALID_LANGUAGE: true,
  INVALID_VIDEO_LINK: true,
  SOURCE_RATE_LIMITED: true,
  SOURCE_LOGIN_REQUIRED: true,
  SOURCE_UNAVAILABLE: true,
  DISK_FULL: true,
  OUTPUT_NOT_WRITABLE: true,
  WORKER_UNAVAILABLE: true,
  WORKER_TIMEOUT: true,
  CLOUD_CREDENTIALS_MISSING: true,
  CLOUD_REQUEST_FAILED: true,
  ENGINE_PACK_MISSING: true,
  ENGINE_PACK_FAILED: true,
  ENGINE_UNAVAILABLE: true,
  ENGINE_BUSY: true,
  CANCELLED: true,
  RUN_IN_PROGRESS: true,
  INVALID_EDIT: true,
  VOICE_CONSENT_REQUIRED: true,
  VOICE_REFERENCE_REJECTED: true,
  VOICE_ENGINE_CANNOT_CLONE: true,
  UNKNOWN: true,
};

/** The codes, for the spec (every one needs its texts in every locale). */
export const TRANSLATED_ERROR_CODES = Object.keys(TRANSLATED) as ErrorCode[];

/**
 * The words a code alone carries nothing specific about: "Choose a folder
 * outside the current projects folder" arrives as UNKNOWN, and only the
 * server's own message says what is wrong. For these the banner shows that
 * message (and the server's advice) instead of hiding it in the details.
 */
const SAYS_NOTHING_SPECIFIC = new Set<string>(['UNKNOWN']);

/**
 * The message ProjectStore's toAppError gives a thrown value that is neither
 * an error nor a string. It says no more than the translated title does, so
 * the banner does not repeat it in English under that title.
 */
export const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred.';

/** Where the repository's docs are read online (an installed app has no docs/ folder). */
export const DOCS_BASE_URL = 'https://github.com/codertapsu/multilingual-dubbed-video/blob/main/';

/** The i18n stem of a code: `WORKER_TIMEOUT` -> `error.codes.worker-timeout`. */
export function errorKeyStem(code: string): string {
  const known = Object.prototype.hasOwnProperty.call(TRANSLATED, code) ? code : 'UNKNOWN';
  return `error.codes.${known.toLowerCase().replaceAll('_', '-')}`;
}

/** The translated title's key for an error (a toast or a list can show it alone). */
export function errorTitleKey(error: Pick<AppError, 'code'> | null | undefined): string {
  return `${errorKeyStem(typeof error?.code === 'string' ? error.code : 'UNKNOWN')}.title`;
}

/** What the banner shows. Keys are translated by the template; the rest is shown as it is. */
export interface ErrorView {
  /** The code as received: a newer backend may send one this build has no words for. */
  code: string;
  titleKey: string;
  fixKey: string;
  /** The server's message, shown under the title when the code says nothing specific. */
  message?: string;
  /** The server's advice, shown instead of the generic fix when the code says nothing specific. */
  advice?: string;
  /** Folded under "Technical details": whatever is not already shown above. */
  details: { message?: string; remediation?: string; cause?: string; docsRef?: string };
  /** Changes exactly when what the banner says changes: it then comes into view again. */
  signature: string;
}

/**
 * Describe whatever reached the banner. Typed AppError, but call sites cast
 * (`err as AppError`), so anything can arrive: a JS Error (its stack is for
 * the console, never the screen), a string, an object without a code.
 */
export function describeError(err: unknown): ErrorView | null {
  if (err === null || err === undefined) return null;
  const e = asErrorLike(err);
  const translated = Object.prototype.hasOwnProperty.call(TRANSLATED, e.code);
  const stem = errorKeyStem(e.code);
  const specific = translated && !SAYS_NOTHING_SPECIFIC.has(e.code);
  const shownMessage = !specific && e.message && e.message !== GENERIC_ERROR_MESSAGE ? e.message : undefined;
  const shownAdvice = !specific && e.remediation ? e.remediation : undefined;
  const details: ErrorView['details'] = {};
  if (e.message && !shownMessage && e.message !== GENERIC_ERROR_MESSAGE) details.message = e.message;
  if (e.remediation && !shownAdvice) details.remediation = e.remediation;
  if (e.cause) details.cause = e.cause;
  if (e.docsRef) details.docsRef = e.docsRef;
  return {
    code: e.code,
    titleKey: `${stem}.title`,
    fixKey: `${stem}.fix`,
    ...(shownMessage ? { message: shownMessage } : {}),
    ...(shownAdvice ? { advice: shownAdvice } : {}),
    details,
    signature: JSON.stringify([e.code, e.message, e.remediation ?? '', e.cause ?? '', e.docsRef ?? '']),
  };
}

interface ErrorLike {
  code: string;
  message: string;
  cause?: string;
  remediation?: string;
  docsRef?: string;
}

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err === 'string') return { code: 'UNKNOWN', message: err };
  if (typeof err !== 'object' || err === null) return { code: 'UNKNOWN', message: String(err) };
  const o = err as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  return {
    code: text(o['code']) ?? 'UNKNOWN',
    message: text(o['message']) ?? '',
    // An Error's `cause` is whatever it was chained to, and its stack is
    // never read: neither is something to print to a user.
    ...(err instanceof Error ? {} : optional('cause', text(o['cause']))),
    ...optional('remediation', text(o['remediation'])),
    ...optional('docsRef', text(o['docsRef'])),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** The docs page a `docsRef` ("docs/TROUBLESHOOTING.md#worker-timeout") names, online. */
export function docsUrl(docsRef: string): string {
  return DOCS_BASE_URL + docsRef.replace(/^\/+/, '');
}

// ------------------------------------------------------------ into view

/** The bits of `document.activeElement` the focus rule reads (testable without a DOM). */
export interface FocusedElementLike {
  tagName: string;
  type?: string;
  readOnly?: boolean;
  isContentEditable?: boolean;
}

/** Input types that take no typing: focus on them can move without losing anything. */
const NOT_TYPED = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden']);

/** The user is typing in this element: taking focus from it would swallow their next keys. */
export function isTextEntry(el: FocusedElementLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return !el.readOnly;
  if (tag === 'INPUT') return !el.readOnly && !NOT_TYPED.has((el.type || 'text').toLowerCase());
  return false;
}

/** How long after arriving on a page its banners are the page's state rather than news. */
export const PAGE_SETTLE_MS = 3000;

/**
 * Whether a banner appearing now may move the page: not while the page is
 * still arriving and the user has not touched it. Settings opens with a
 * banner under every pack or model that failed earlier, and jumping down to
 * the first of them each time the section opens answers nothing. Once the user
 * clicked or typed there, or the page has settled, an error is news.
 */
export function revealAllowed(t: { now: number; navigatedAt: number; gestureAt: number }): boolean {
  return t.gestureAt > t.navigatedAt || t.now - t.navigatedAt > PAGE_SETTLE_MS;
}

/** A banner that appeared, or whose error changed, in one render. */
export interface RevealCandidate {
  /** Its first line is on screen already. */
  visible: boolean;
  /** A modal dialog is open that does not contain it. */
  behindModal: boolean;
}

/**
 * Which of the banners that appeared together to bring into view, and how.
 *
 * On long pages (New project step 1, every Settings section, Voices,
 * Download) the banner sat at the top while the button was far below, so a
 * failed click looked like it "did nothing" (the Settings Download report,
 * 0.17.0). So one banner is brought into view and takes focus, which also has
 * a screen reader read it. One at most: Settings shows a banner at the top
 * and one under each pack, model and language pair, and several can appear in
 * the same moment. One already in sight wins and is not scrolled to (it is
 * usually the one under the button just pressed); else the first on the page.
 * Never one behind a modal dialog (focus must stay in it); no focus taken from
 * a field being typed in (the next keys would land nowhere) or from a banner
 * being read. Its role="alert" announces it either way.
 */
export function planReveal(
  candidates: readonly RevealCandidate[],
  ctx: { allowed: boolean; readingBanner: boolean; typing: boolean },
): { index: number; scroll: boolean; focus: boolean } | null {
  if (!ctx.allowed || ctx.readingBanner) return null;
  const eligible = candidates.map((c, index) => ({ ...c, index })).filter((c) => !c.behindModal);
  const target = eligible.find((c) => c.visible) ?? eligible[0];
  if (!target) return null;
  return { index: target.index, scroll: !target.visible, focus: !ctx.typing };
}

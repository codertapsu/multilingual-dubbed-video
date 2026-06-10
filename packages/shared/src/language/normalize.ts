/**
 * Language-code normalization utilities.
 *
 * All components MUST use these so that codes are compared/persisted
 * consistently. The most important invariants:
 *   - `"vi-VI"` (any case) normalizes to `"vi-VN"` (Vietnam locale).
 *   - `toWhisperLanguage` / `toArgosLanguage` reduce to the base subtag.
 */

import type { LanguageCode } from '../models/domain.js';

/** A curated entry in the {@link COMMON_LANGUAGES} list. */
export interface CommonLanguage {
  /** Normalized language code. */
  code: LanguageCode;
  /** Human-readable label for the UI. */
  label: string;
}

/**
 * Normalize a BCP-47-ish language code.
 *
 * - Trims surrounding whitespace and collapses underscores to hyphens.
 * - Lowercases the primary subtag; uppercases a 2-letter region; titlecases a
 *   4-letter script subtag (e.g. `zh-hant` -> `zh-Hant`).
 * - Applies the special rule: `vi-VI` (any case) -> `vi-VN`.
 *
 * Examples:
 *   "EN"      -> "en"
 *   "en-us"   -> "en-US"
 *   "vi-vn"   -> "vi-VN"
 *   "vi-VI"   -> "vi-VN"
 *   "zh-hant" -> "zh-Hant"
 *
 * @param code Raw, possibly messy language code.
 * @returns The normalized code, or `""` if input is empty/whitespace.
 */
export function normalizeLanguageCode(code: string): LanguageCode {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim();
  if (trimmed === '') return '';

  // Split on hyphen or underscore.
  const rawParts = trimmed.split(/[-_]/).filter((p) => p.length > 0);
  if (rawParts.length === 0) return '';

  const parts: string[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i] as string;
    if (i === 0) {
      // Primary language subtag: always lowercase.
      parts.push(part.toLowerCase());
    } else if (part.length === 2 || part.length === 3) {
      // 2-letter region (ISO 3166-1) or 3-digit-ish region: uppercase.
      // 3-letter subtags here are treated as region/extension and uppercased
      // to match common locale formatting (e.g. "vi-VN").
      parts.push(part.toUpperCase());
    } else if (part.length === 4) {
      // Script subtag (ISO 15924): titlecase, e.g. "Hant".
      parts.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    } else {
      parts.push(part.toLowerCase());
    }
  }

  let normalized = parts.join('-');

  // Special-case: Vietnamese "vi-VI" (a common mistake) must become "vi-VN".
  if (/^vi-VI$/i.test(normalized)) {
    normalized = 'vi-VN';
  }

  return normalized;
}

/**
 * Reduce a language code to the base subtag suitable for faster-whisper.
 *
 * Examples: "vi-VN" -> "vi", "en-US" -> "en", "EN" -> "en".
 *
 * @param code Any language code (normalized or not).
 * @returns Lowercased primary subtag, or `""` for empty input.
 */
export function toWhisperLanguage(code: string): string {
  const normalized = normalizeLanguageCode(code);
  if (normalized === '') return '';
  const base = normalized.split('-')[0] ?? '';
  return base.toLowerCase();
}

/**
 * Reduce a language code to the base subtag suitable for Argos Translate.
 *
 * Examples: "vi-VN" -> "vi", "en-US" -> "en".
 *
 * @param code Any language code (normalized or not).
 * @returns Lowercased primary subtag, or `""` for empty input.
 */
export function toArgosLanguage(code: string): string {
  // Argos uses the same base-subtag reduction as Whisper.
  return toWhisperLanguage(code);
}

/**
 * Basic BCP-47-ish validity check.
 *
 * Accepts a 2-3 letter primary subtag, optionally followed by a 4-letter
 * script subtag and/or a 2-letter or 3-digit region subtag.
 *
 * This is intentionally permissive (not a full RFC 5646 validator); it just
 * guards against obviously malformed input before sending to workers.
 *
 * @param code Code to validate (validated after normalization).
 */
export function isValidLanguageCode(code: string): boolean {
  if (typeof code !== 'string') return false;
  const normalized = normalizeLanguageCode(code);
  if (normalized === '') return false;
  // primary(2-3) [-Script(4)] [-Region(2 alpha | 3 digit)]
  return /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2,3}|\d{3}))?$/.test(normalized);
}

/**
 * Curated list of commonly supported languages for the UI dropdowns.
 *
 * Codes are already normalized; labels are English display names.
 */
export const COMMON_LANGUAGES: readonly CommonLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'en-US', label: 'English (United States)' },
  { code: 'vi-VN', label: 'Vietnamese (Vietnam)' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'th', label: 'Thai' },
] as const;

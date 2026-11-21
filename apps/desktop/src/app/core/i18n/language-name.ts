import { Pipe, inject, type PipeTransform } from '@angular/core';

import { TranslateService } from './translate.service';

const displayNames = new Map<string, Intl.DisplayNames | null>();

function namesFor(locale: string): Intl.DisplayNames | null {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  return names;
}

/**
 * A language's name in the reader's own language: `en-US` reads "Tiếng Anh
 * (Mỹ)" in the Vietnamese UI and "English (United States)" in the English one.
 *
 * The backend's language list carries English names only, so until 0.17.1 the
 * Vietnamese UI offered "English (United States)" / "Vietnamese (Vietnam)" in
 * its own language pickers, and showed raw codes ("en-US → vi-VN") elsewhere.
 * Falls back to `fallback` (the backend's label) or the code itself when the
 * platform cannot name it, and leaves non-language values ("auto") alone.
 */
export function languageName(code: string | null | undefined, locale: string, fallback?: string): string {
  if (!code) return fallback ?? '';
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) return fallback ?? code;
  try {
    const name = namesFor(locale)?.of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    /* a tag the platform rejects: the fallback below */
  }
  return fallback ?? code;
}

/**
 * `{{ lang.code | languageName: lang.label }}`: {@link languageName} in the
 * current UI language. Impure for the same reason as the translate pipe: a
 * language switch must rename every option without a reload; it memoizes on
 * (code, fallback, locale) so a change-detection pass costs a comparison.
 */
@Pipe({ name: 'languageName', standalone: true, pure: false })
export class LanguageNamePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);
  private last: { code: string | null | undefined; fallback: string | undefined; locale: string; value: string } | null = null;

  transform(code: string | null | undefined, fallback?: string): string {
    const locale = this.translate.locale();
    const last = this.last;
    if (last && last.code === code && last.fallback === fallback && last.locale === locale) return last.value;
    const value = languageName(code, locale, fallback);
    this.last = { code, fallback, locale, value };
    return value;
  }
}

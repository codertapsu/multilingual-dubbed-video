import { Injectable, computed, signal } from '@angular/core';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';

/** A nested translation tree, as loaded from `i18n/<locale>.json`. */
export type TranslationTree = { [key: string]: string | TranslationTree };

/** Values substituted into `{{ placeholder }}` slots. */
export type TranslateParams = Record<string, unknown>;

/** The locales VideoDubber ships. Vietnamese is the product's first language. */
export const SUPPORTED_LOCALES = ['vi', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Human labels for the language picker, each written in its own language. */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
};

/**
 * Default locale. Vietnamese, deliberately: this is a Vietnamese-first product,
 * and the fallback below means an untranslated key still renders English rather
 * than a raw key.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'vi';

/** Locale used when a key is missing from the active one. */
export const FALLBACK_LOCALE: SupportedLocale = 'en';

/** Where the chosen locale is remembered. */
const STORAGE_KEY = 'vd.locale';

const INTERPOLATION_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Bundled trees. Both locales ship in the binary — see the class comment. */
const BUNDLED: Record<SupportedLocale, TranslationTree> = {
  vi: vi as TranslationTree,
  en: en as TranslationTree,
};

function isTree(value: unknown): value is TranslationTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve `a.b.c` against a tree, tolerating a literal dotted key. */
function lookupPath(tree: TranslationTree | undefined, key: string): unknown {
  if (!tree) return undefined;
  if (Object.prototype.hasOwnProperty.call(tree, key)) return tree[key];
  let cursor: unknown = tree;
  for (const segment of key.split('.')) {
    if (!isTree(cursor)) return undefined;
    cursor = cursor[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (!params) return template;
  return template.replace(INTERPOLATION_PATTERN, (match, name: string) => {
    const value = params[name];
    // Leave the placeholder visible when a caller forgets to pass it: a
    // literal "{{ count }}" in the UI is a bug report, whereas "undefined"
    // reads as a product that is merely broken.
    return value === undefined || value === null ? match : String(value);
  });
}

/** Narrow an arbitrary string to a locale we actually ship. */
export function toSupportedLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const base = value.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base ?? '') ? (base as SupportedLocale) : null;
}

/**
 * Translation for the desktop app.
 *
 * Both locale trees are **bundled**, not fetched. VideoDubber is offline-first —
 * it dubs video on a machine that may never see the network — so an HTTP round
 * trip for UI text would be the one thing in the app that needs the internet.
 * They are small (tens of KB) and compress with the rest of the frontend.
 *
 * The active tree is a signal, so every `| translate` binding re-evaluates on a
 * language switch without a reload.
 */
@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly _locale = signal<SupportedLocale>(readStoredLocale() ?? DEFAULT_LOCALE);

  /** The active locale. */
  readonly locale = this._locale.asReadonly();

  private readonly activeTree = computed<TranslationTree>(() => BUNDLED[this._locale()] ?? {});
  private readonly fallbackTree: TranslationTree = BUNDLED[FALLBACK_LOCALE] ?? {};

  constructor() {
    // Keep <html lang> in step so the OS/webview picks the right font stack,
    // hyphenation and screen-reader voice.
    this.applyDocumentLang(this._locale());
  }

  /** Switch language and remember it for next launch. */
  use(locale: SupportedLocale): void {
    if (locale === this._locale()) return;
    this._locale.set(locale);
    this.applyDocumentLang(locale);
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Storage disabled: the switch still applies for this session.
    }
  }

  /**
   * Resolve a key: active locale → fallback locale → the key itself.
   *
   * Returning the KEY on a total miss is deliberate. It is ugly on screen,
   * which is the point — a missing string should be obvious in review rather
   * than silently rendering as blank space. `pnpm --filter videodubber-desktop
   * test` fails on any key that is missing from either bundled locale, so this
   * path should never reach a user.
   */
  instant(key: string, params?: TranslateParams): string {
    const active = lookupPath(this.activeTree(), key);
    if (typeof active === 'string') return interpolate(active, params);
    const fallback = lookupPath(this.fallbackTree, key);
    if (typeof fallback === 'string') return interpolate(fallback, params);
    return key;
  }

  private applyDocumentLang(locale: SupportedLocale): void {
    try {
      document.documentElement.setAttribute('lang', locale);
    } catch {
      /* non-browser context (tests) */
    }
  }
}

/** Read the remembered locale, ignoring anything we no longer ship. */
export function readStoredLocale(): SupportedLocale | null {
  try {
    return toSupportedLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * The Argos Translate language packs as Settings lists them
 * (components/argos-packs.component.ts). Pure, for the spec beside it.
 */
import type { ArgosPair } from '../../core/models/setup';
import { normalizeForSearch, queryTokens } from './settings-search';

/** One row in the Translation-packs manager (a pair + resolved names + state). */
export interface ArgosPackRow extends ArgosPair {
  key: string;
  installed: boolean;
  fromName: string;
  toName: string;
}

export interface ArgosRowOptions {
  /** What was typed in the filter box. */
  filter: string;
  /** A language code's name in the app's language ("en" -> "Tiếng Anh"). */
  nameOf: (code: string) => string;
  /** The app's language, for the alphabetical order. */
  locale: string;
}

export function argosPairKey(p: ArgosPair): string {
  return `${p.from}->${p.to}`;
}

/**
 * Installed ∪ available pairs as rows, installed first, then by name in the
 * app's language and alphabet.
 *
 * The names were always English (Intl.DisplayNames(['en'])), so a Vietnamese
 * user read "Chinese → Vietnamese" in an otherwise Vietnamese page. Named in
 * Vietnamese, the filter has to take what Vietnamese users type: without the
 * diacritics ("tieng nhat" for "Tiếng Nhật"), like the Settings search, every
 * word anywhere in the row.
 */
export function argosPackRows(
  installed: readonly ArgosPair[],
  available: readonly ArgosPair[],
  { filter, nameOf, locale }: ArgosRowOptions,
): ArgosPackRow[] {
  const installedKeys = new Set(installed.map(argosPairKey));
  const byKey = new Map<string, ArgosPair>();
  for (const p of installed) byKey.set(argosPairKey(p), p);
  for (const p of available) byKey.set(argosPairKey(p), p);

  const rows: ArgosPackRow[] = [...byKey.values()].map((p) => ({
    ...p,
    key: argosPairKey(p),
    installed: installedKeys.has(argosPairKey(p)),
    fromName: nameOf(p.from),
    toName: nameOf(p.to),
  }));
  const tokens = queryTokens(filter);
  const shown =
    tokens.length === 0
      ? rows
      : rows.filter((r) => {
          const text = normalizeForSearch(`${r.fromName} ${r.toName} ${r.from} ${r.to}`);
          return tokens.every((t) => text.includes(t));
        });
  return shown.sort(
    (a, b) =>
      Number(b.installed) - Number(a.installed) ||
      a.fromName.localeCompare(b.fromName, locale) ||
      a.toName.localeCompare(b.toName, locale),
  );
}

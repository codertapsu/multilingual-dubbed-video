/**
 * The Settings search box: which options match what was typed.
 *
 * Pure. The caller hands in the options already in the user's language (the
 * static ones from SETTINGS_OPTIONS through the translator, the engine packs
 * from the catalog), so a Vietnamese user searches Vietnamese text.
 */
import type { SettingsSectionId } from './settings-sections';

export interface SettingsSearchEntry {
  /** DOM id the result jumps to on its page. */
  anchor: string;
  section: SettingsSectionId;
  /** What the result is called, as displayed. */
  title: string;
  /** Its one-line explanation, as displayed. */
  hint?: string;
  /** Searched, never displayed: the section's name, synonyms, both languages. */
  keywords?: string;
}

/**
 * Lowercase, without accents: Vietnamese is very often typed without its
 * diacritics ("giong doc" for "giọng đọc"), and a search that needs them would
 * find nothing for most of the people it is for. đ is a letter of its own, not
 * d with a mark, so NFD leaves it alone; it is folded by hand.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a query, normalized; empty when nothing searchable was typed. */
export function queryTokens(query: string): string[] {
  return normalizeForSearch(query)
    .split(/[\s,;/]+/)
    .filter((t) => t.length > 0);
}

/**
 * The options matching every word of `query` (in the title, the explanation or
 * the keywords), best first: those whose TITLE has every word, then those whose
 * title starts with the first word, then the rest, each in page order.
 * An empty query matches nothing: the page shows its sections instead.
 */
export function searchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
  limit = 40,
): SettingsSearchEntry[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const scored: { entry: SettingsSearchEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const title = normalizeForSearch(entry.title);
    const all = `${title} ${normalizeForSearch(entry.hint ?? '')} ${normalizeForSearch(entry.keywords ?? '')}`;
    if (!tokens.every((t) => all.includes(t))) return;
    const score = (tokens.every((t) => title.includes(t)) ? 2 : 0) + (title.startsWith(tokens[0]!) ? 1 : 0);
    scored.push({ entry, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => s.entry);
}
